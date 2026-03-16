# RoleClaw CLI 实现说明（Step 3）

本文说明 `scripts/roleclaw.mjs` 的核心实现逻辑，方便后续维护与扩展。

## 1) 核心职责

`roleclaw` 在阶段一聚焦 5 个核心命令：

| 命令 | 作用 | 备注 |
|---|---|---|
| `pull` | 把声明的 Skills/Rules 安装到目标 IDE 目录 | Cursor -> `.cursor/`，Codex -> `.codex/` |
| `list` | 查看声明与安装状态 | 同时展示缺失与额外安装项 |
| `update` | 更新到最新版本 | 支持指定单个 artifact 或全部更新 |
| `push` | 把 IDE 中的 Skill/Rule 编辑回写到本地 Registry | **仅支持本地 Registry**，远程 URL 需直接编辑仓库并提 PR |
| `add-skill` | 将 IDE 中新建的 Skill 添加到 Registry | 从 `.<ide>/skills/<name>/` 读取，创建版本目录并更新 registry.json |
| `add-rule` | 将 IDE 中新建的 Rule 添加到 Registry | 从 `.<ide>/rules/<name>/` 读取，创建版本目录并更新 registry.json |
| `remove-skill` | 从 Registry 删除 Skill | 删除 assets/packages 与 registry.json 条目 |
| `remove-rule` | 从 Registry 删除 Rule | 删除 assets/rules 与 registry.json 条目 |
| `update-skill` | 将 IDE 中 Skill 同步到 Registry | 等同于 `push <name>` 针对 skill |
| `update-rule` | 将 IDE 中 Rule 同步到 Registry | 等同于 `push <name>` 针对 rule |
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

### 配置与岗位读取策略

项目配置入口统一为 `.roleclaw/config.json`，阶段一岗位来源优先级如下：

1. `.roleclaw/config.json` 的 `roleProfiles`
2. `registry-template/organization/roles/<role>.json`
3. `registry-template/organization/rbac/roles.json`（兼容）

```js
async function fetchRoleConfig(baseRef, config, role) {
  if (config.roleProfiles?.[role]) {
    return config.roleProfiles[role]
  }
  try {
    return await readJsonResource(baseRef, `organization/roles/${role}.json`)
  } catch {
    const rbac = await fetchRbacRoles(baseRef) // organization/rbac/roles.json
    // ... fallback 到 rbac.roles[role]
  }
}
```

### 安装策略（覆盖式写入，避免脏文件）

每次安装某个 Skill/Rule 时先删除旧目录，再按 `files.json` 重新写入：

```js
const artifactDir = join(installRoot, name)
rmSync(artifactDir, { recursive: true, force: true })
mkdirSync(artifactDir, { recursive: true })
```

### Skills + Rules 合并策略

项目配置中的显式声明优先，岗位必备作为补充：

```js
const skills = { ...(config.skills ?? {}) }
const rules = { ...(config.rules ?? {}) }
for (const [name, version] of Object.entries(roleConfig.requiredSkills)) {
  if (!skills[name]) skills[name] = version
}
for (const [name, version] of Object.entries(roleConfig.requiredRules)) {
  if (!rules[name]) rules[name] = version
}
```

## 3) push：IDE 编辑回写 Registry

当 Registry 为**本地路径**（如 `./registry-template` 或项目内绝对路径）时，用户可在 IDE 中直接编辑 `.cursor/skills/<name>/` 或 `.cursor/rules/<name>/`，然后执行：

```bash
roleclaw push              # 回写所有已声明的 skills/rules
roleclaw push git-workflow # 仅回写指定 artifact
```

`push` 会：

1. 从 IDE 安装目录读取文件
2. 按 `files.json` 规范写入 Registry 对应版本目录
3. 自动生成/更新 `files.json`（主文件 SKILL.md/RULE.md 置前）

完成后提示用户执行 `git add` 和 `git commit` 以持久化变更。其他伙伴通过 `git pull` + `roleclaw pull` 即可获得更新。

当 Registry 为远程 URL 时，`push` 会报错并提示直接编辑仓库、提交 PR。

### add-skill / add-rule：添加新 Skill/Rule 到 Registry

当在 IDE 的 `.<ide>/skills/<name>/` 或 `.<ide>/rules/<name>/` 下新建目录和主文件后，执行：

```bash
roleclaw add-skill <name> [version] [--overwrite]
roleclaw add-rule <name> [version] [--overwrite]
```

会创建版本目录、生成 `files.json`、更新 `registry.json` 并写入 config。若目标版本已存在，需加 `--overwrite`。

### remove-skill / remove-rule：从 Registry 删除

```bash
roleclaw remove-skill <name>
roleclaw remove-rule <name>
```

会删除 `assets/packages/<name>/` 或 `assets/rules/<name>/`，并更新 `registry.json` 与 config。

### update-skill / update-rule：同步 IDE 修改到 Registry

```bash
roleclaw update-skill <name> [-v]
roleclaw update-rule <name> [-v]
```

等同于 `push <name>`，将 IDE 中的修改写回 Registry。

## 4) 目录创建与冲突处理

### 目录自动创建

`pull` 和 `update` 执行时，若 `.cursor/` 或 `.codex/` 不存在，会自动创建：

- `.<ide>/`（如 `.cursor/`、`.codex/`）
- `.<ide>/skills/`
- `.<ide>/rules/`

`init` 仅创建 `.roleclaw/config.json`，不创建 IDE 目录；首次安装需执行 `roleclaw pull`。

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

1. 配置层：`.roleclaw/config.json` / registry / role 是否可读
2. 索引层：registry 中是否存在目标 skill/rule 版本
3. 本地层：`.<ide>/skills/<name>/SKILL.md` 与 `.<ide>/rules/<name>/RULE.md` 是否存在

只要有失败项，命令会以非 0 退出，方便接入 CI 或脚本化验收。

## 6) 维护建议

- 继续保持 `SKILL.md` 仅包含 AI 运行时最小信息
- `RULE.md` 同样保持最小运行时信息，不混入治理字段
- 元数据扩展优先加在 `registry.json` / `organization/roles/*.json`
- 新增命令时先补 `doctor` 对应检查项，避免功能可用但不可诊断
- 命令行为变更后，同步更新“核心命令表”和示例代码片段
