# AIPM CLI 实现说明（Step 3）

本文说明 `scripts/aipm.mjs` 的核心实现逻辑，方便后续维护与扩展。

## 1) 核心职责

`aipm` 有两个核心作用：

1. **Package 生命周期**：创建 package（init-skill/init-rule）、发布至 Registry（publish）
2. **IDE 管理**：根据 profile 配置，确保 IDE 内安装的 package 与声明版本一致

| 命令 | 作用 | 备注 |
|---|---|---|
| `install` | 按 profile 把声明的 Skills/Rules 安装到目标 IDE 目录 | Cursor -> `.cursor/`，Codex -> `.codex/` |
| `list` | 查看声明与安装状态 | 同时展示缺失与额外安装项 |
| `update` | 更新到最新版本 | 支持指定单个 artifact 或全部更新 |
| `publish` | 把 IDE 中的 Skill/Rule 编辑回写到本地 Registry | **仅支持本地 Registry**，远程 URL 需直接编辑仓库并提 PR |
| `init-skill` | 交互式创建新 Skill | 提示 name、description、version，生成 package.json、.aipm、SKILL.md |
| `init-rule` | 交互式创建新 Rule | 同上 |
| `install-skill <name> [version]` | 添加 skill 到 config 并从 Registry 安装 | |
| `install-rule <name> [version]` | 添加 rule 到 config 并从 Registry 安装 | |
| `uninstall-skill <name>` | 从 config 和 IDE 移除 skill | |
| `uninstall-rule <name>` | 从 config 和 IDE 移除 rule | |
| `unpublish-skill <name>` | 从 Registry 删除 Skill | 删除 assets/packages 与 registry.json 条目 |
| `unpublish-rule <name>` | 从 Registry 删除 Rule | 删除 assets/rules 与 registry.json 条目 |
| `doctor` | 做可用性自检 | 失败项返回非 0 退出码 |

维护约定：

- 后续新增、删除或调整 CLI 命令时，必须同步更新本表与对应说明。

## 2) 关键设计

### 双来源 Registry（本地/远程）

Registry 既可以是远程 URL，也可以是本地目录，便于阶段一快速迭代：

```js
function defaultRegistryRef() {
  const localRegistry = join(ROOT, 'registry-template')
  if (existsSync(localRegistry)) return './registry-template'
  return 'https://raw.githubusercontent.com/YOUR_ORG/cursor-skills-registry/main'
}
```

### 配置与配置单读取策略

配置入口统一为 `.aipm/config.json`，配置单来源优先级如下：

1. `.aipm/config.json` 的 `profiles[profileId]`
2. `registry-template/organization/profiles/<profileId>.json`
3. `registry-template/organization/rbac/roles.json`（兼容）

```js
async function fetchProfileConfig(baseRef, config, profileId) {
  if (config.profiles?.[profileId]) {
    return config.profiles[profileId]
  }
  try {
    return await readJsonResource(baseRef, `organization/profiles/${profileId}.json`)
  } catch {
    const rbac = await fetchRbacRoles(baseRef) // organization/rbac/roles.json
    // ... fallback 到 rbac.roles[profileId]
  }
}
```

### 共享与配置专属目录

- **共享**：`packages/shared/<skill>/`、`rules/shared/<rule>/`，安装到 IDE 为 `<skill>`
- **配置专属**：`packages/<profileId>/<skill>/`、`rules/<profileId>/<rule>/`，安装到 IDE 为 `<profileId>_<skill>`
- 解析优先级：配置专属 > 共享

### 安装策略（版本感知 + 覆盖式写入）

每个已安装的 artifact 目录下会写入隐藏文件 `.aipm`，JSON 格式记录版本与配置单。格式约束见 `registry-template/schemas/aipm-marker.schema.json`：

```json
{"version":"1.0.0"}
{"version":"1.0.0","profile":"frontend-engineer"}
```

安装前检查 `artifactDir` 是否存在且为目录：

- **存在 `.aipm` 且版本相同**：跳过，不重装
- **存在 `.aipm` 且目标版本更高**：提示「有新版本，是否覆盖？」
- **存在 `.aipm` 且目标版本更低**：提示并跳过，不覆盖
- **存在目录但无 `.aipm`**：视为非 AIPM 安装（重名），提示「是否覆盖？」

确认覆盖后执行：删除旧目录 → 按 `files.json` 重新写入 → 写入 `.aipm`，避免脏文件。

### Skills + Rules 合并策略

配置中的显式声明优先，配置单必备作为补充：

```js
const skills = { ...(config.skills ?? {}) }
const rules = { ...(config.rules ?? {}) }
for (const [name, version] of Object.entries(profileConfig.requiredSkills)) {
  if (!skills[name]) skills[name] = version
}
for (const [name, version] of Object.entries(profileConfig.requiredRules)) {
  if (!rules[name]) rules[name] = version
}
```

## 3) publish：IDE 编辑回写 Registry

当 Registry 为**本地路径**（如 `./registry-template` 或项目内绝对路径）时，用户可在 IDE 中直接编辑 `.cursor/skills/<name>/` 或 `.cursor/rules/<name>/`，然后执行：

```bash
aipm publish              # 回写所有已声明的 skills/rules
aipm publish git-workflow # 仅回写指定 artifact
```

`publish` 会：

1. 从 IDE 安装目录读取文件
2. 按 `files.json` 规范写入 Registry 对应版本目录
3. 自动生成/更新 `files.json`（主文件 SKILL.md/RULE.md 置前）

完成后提示用户执行 `git add` 和 `git commit` 以持久化变更。其他伙伴通过 `git pull` + `aipm install` 即可获得更新。

当 Registry 为远程 URL 时，`publish` 会报错并提示直接编辑仓库、提交 PR。

### init-skill / init-rule：创建新 Skill/Rule

交互式创建新 package，提示输入 name、description、version：

```bash
aipm init-skill   # 创建 skill，自动生成 package.json、.aipm、SKILL.md
aipm init-rule    # 创建 rule
```

创建后编辑 SKILL.md/RULE.md，再执行 `aipm publish <name>` 发布到 Registry。

### install-skill / install-rule：添加 package 并安装

```bash
aipm install-skill <name> [version]   # 添加 skill 到 config 并从 Registry 安装
aipm install-rule <name> [version]   # 添加 rule 到 config 并从 Registry 安装
```

### uninstall-skill / uninstall-rule：从 config 和 IDE 移除

```bash
aipm uninstall-skill <name>
aipm uninstall-rule <name>
```

会删除 IDE 目录并更新 config。

### unpublish-skill / unpublish-rule：从 Registry 删除

```bash
aipm unpublish-skill <name>
aipm unpublish-rule <name>
```

会删除 `assets/packages/<name>/` 或 `assets/rules/<name>/`，并更新 `registry.json` 与 config。

## 4) 目录创建与冲突处理

### 目录自动创建

`install` 和 `update` 执行时，若 `.cursor/` 或 `.codex/` 不存在，会自动创建：

- `.<ide>/`（如 `.cursor/`、`.codex/`）
- `.<ide>/skills/`
- `.<ide>/rules/`

`init` 仅创建 `.aipm/config.json`，不创建 IDE 目录；首次安装需执行 `aipm install`。

### 文件冲突处理

当目标路径已存在（文件或非目录）时，支持：

| 选项 | 说明 |
|------|------|
| `--on-conflict=ask` | 交互式询问（默认，仅 TTY） |
| `--on-conflict=skip` | 跳过冲突项 |
| `--on-conflict=overwrite` | 强制覆盖 |

非交互环境（CI/管道）下若遇冲突且未指定 `--on-conflict`，会报错并提示使用 `skip` 或 `overwrite`。

## 5) doctor 的检查层次

`doctor` 从外到内检查三层：

1. 配置层：`.aipm/config.json` / registry / profile 是否可读
2. 索引层：registry 中是否存在目标 skill/rule 版本
3. 本地层：`.<ide>/skills/<name>/SKILL.md` 与 `.<ide>/rules/<name>/RULE.md` 是否存在

只要有失败项，命令会以非 0 退出，方便接入 CI 或脚本化验收。

## 6) 维护建议

- 继续保持 `SKILL.md` 仅包含 AI 运行时最小信息
- `RULE.md` 同样保持最小运行时信息，不混入治理字段
- 元数据扩展优先加在 `registry.json` / `organization/profiles/*.json`
- 新增命令时先补 `doctor` 对应检查项，避免功能可用但不可诊断
- 命令行为变更后，同步更新“核心命令表”和示例代码片段
