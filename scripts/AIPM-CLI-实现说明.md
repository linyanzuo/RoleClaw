# AIPM CLI 实现说明

本文说明 `scripts/aipm.mjs` 的核心实现逻辑，方便后续维护与扩展。

## 1) 核心职责

`aipm` 有两个核心作用：

1. **Package 生命周期**：创建 package（init-skill/init-rule）、发布至 Registry（publish）
2. **IDE 管理**：根据 profile 配置，确保 IDE 内安装的 package 与声明版本一致

### 命令一览

| 命令 | 作用 | 备注 |
|---|---|---|
| `init` | 交互式创建 aipm_profile.json | 选择 registry、IDE、profile |
| `install` | 按 profile 把声明的 Skills/Rules 安装到目标 IDE 目录 | 支持 cursor/codex/trae/windsurf |
| `list` | 查看声明与安装状态 | 同时展示缺失与额外安装项 |
| `update [name]` | 更新到最新版本 | 支持指定单个 artifact 或全部更新 |
| `use [profile-id]` | 切换配置单 | 无参数时列出可用 profile |
| `publish [name]` | 把 IDE 中的 Skill/Rule 回写到 Registry | **本地路径**直接写盘；**HTTP（aipm-registry）** 使用 **tgz + multipart** 上传，已发布版本不可覆盖 |
| `init-skill` | 交互式创建新 Skill | 提示 name、description、version |
| `init-rule` | 交互式创建新 Rule | 同上 |
| `install-skill <name> [version]` | 添加 skill 到 config 并从 Registry 安装 | |
| `install-rule <name> [version]` | 添加 rule 到 config 并从 Registry 安装 | |
| `uninstall-skill <name>` | 从 config 和 IDE 移除 skill | |
| `uninstall-rule <name>` | 从 config 和 IDE 移除 rule | |
| `unpublish-skill <name>` | 从 Registry 删除 Skill | 删除 assets/packages 与 registry.json 条目 |
| `unpublish-rule <name>` | 从 Registry 删除 Rule | 删除 assets/rules 与 registry.json 条目 |
| `doctor` | 做可用性自检 | 失败项返回非 0 退出码 |
| `search [query]` | 在 registry 中搜索 skills/rules | |

**维护约定**：新增、删除或调整 CLI 命令时，必须同步更新本表与对应说明。

---

## 2) 配置与 Registry

### 配置来源（优先级）

1. **package.json** 的 `aipm` 字段（若存在）
2. **aipm_profile.json**（项目根目录）

两者通过 `mergeConfig` 合并，后者字段覆盖前者。若两者都不存在，`readConfig()` 抛错；`readConfigOrDefault()` 返回默认配置。

### 配置结构

```json
{
  "registry": null,
  "registries": [],
  "ide": "cursor",
  "profile": "frontend-engineer",
  "skills": {},
  "rules": {}
}
```

| 字段 | 说明 |
|------|------|
| `registry` | 单个 registry（与 registries 二选一） |
| `registries` | registry 列表，支持多源 |
| `ide` | 目标 IDE：cursor、codex、trae、windsurf |
| `profile` | 配置单 ID，从 registry 的 profiles/ 加载 |
| `skills` | 显式声明的 skills（name → version），覆盖 profile |
| `rules` | 显式声明的 rules（name → version），覆盖 profile |

### Registry 顺序

`getRegistries(config)` 返回有序列表：

1. 项目 `registries` 或 `registry`
2. 全局 `~/.aipm/config.json` 的 `registries`
3. 默认仓库 `http://localhost:9005/`（aipm-registry；若未包含在列表中则自动追加）

### Registry 目录结构

```
<registry>/
├── registry.json           # 全量索引 { packages: {}, rules: {} }
├── profiles/               # 配置单
│   ├── frontend-engineer.json
│   └── ...
└── assets/
    ├── packages/           # Skills
    │   └── @<scope>/<name>/<version>/
    │       ├── package.json
    │       ├── SKILL.md
    │       └── ...
    └── rules/              # Rules
        └── @<scope>/<name>/<version>/
            ├── package.json
            ├── RULE.md
            └── ...
```

包名支持 `@scope/name` 或 `name`，安装时 scope 转为 `scope_name` 以适配 IDE 目录命名。

---

## 3) 配置单（Profile）

### 加载策略

配置单从 **registry 的 `profiles/<profileId>.json`** 加载，按 `getRegistries` 顺序在第一个包含该 profile 的 registry 中查找。

**不支持**在 `aipm_profile.json` 中内嵌 profile 内容；仅支持通过 `config.profile` 指定 ID，从 registry 拉取。

### 合并策略

`resolveDesiredArtifacts(config)`：

1. 若 `config.profile` 存在，从 registry 加载 `profiles/<profileId>.json` 得到 `skills`、`rules`
2. 用 `config.skills`、`config.rules` 覆盖/补充，显式声明优先

```js
skills = { ...profileSkills, ...explicitSkills }
rules = { ...profileRules, ...explicitRules }
```

---

## 4) 安装逻辑

### 版本感知

安装前检查目标目录 `.<ide>/skills/<name>/` 或 `.<ide>/rules/<name>/`：

- **存在 package.json 且含 aipm 字段**：
  - 版本相同 → 跳过
  - 已安装版本更高 → 跳过（不降级）
  - 已安装版本更低 → 询问是否覆盖
- **无 package.json 或缺少 aipm 字段** → 视为非 aipm 安装，询问是否覆盖

确认覆盖后：删除旧目录 → 按 `package.json.files` 重新写入。

### 冲突处理

| 选项 | 说明 |
|------|------|
| `--on-conflict=ask` | 交互式询问（默认，仅 TTY） |
| `--on-conflict=skip` | 跳过冲突项 |
| `--on-conflict=overwrite` | 强制覆盖 |

非交互环境遇冲突且未指定时，报错并提示使用 `skip` 或 `overwrite`。

### Profile 切换时的清理

当 `config.profile` 存在时，`install` 会移除**不在当前 profile 中**且**由 aipm 安装**的 artifact。显式声明的 `config.skills`/`config.rules` 会保留。

### Lock 文件

`aipm_profile.lock.json` 记录已解析的 version 与 registry，保证可复现安装。格式：

```json
{
  "lockfileVersion": 1,
  "skills": { "@frontend/git-workflow": { "version": "1.0.0", "registry": "..." } },
  "rules": { ... }
}
```

---

## 5) IDE 支持

### 配置方式

通过 `IDE_DIR_MAP` 映射 IDE 标识到项目内目录：

| IDE | 根目录 | skills | rules |
|-----|--------|--------|-------|
| cursor | `.cursor` | `.cursor/skills/` | `.cursor/rules/` |
| codex | `.codex` | `.codex/skills/` | `.codex/rules/` |
| trae | `.trae` | `.trae/skills/` | `.trae/rules/` |
| windsurf | `.windsurf` | `.windsurf/skills/` | `.windsurf/rules/` |

新增 IDE：在 `IDE_DIR_MAP` 中添加 `ide: '.ide'` 即可，前提是该 IDE 使用 `skills/`、`rules/` 子目录结构。

### 目录自动创建

`install`、`update` 执行时，若 IDE 根目录不存在，会自动创建 `.<ide>/`、`.<ide>/skills/`、`.<ide>/rules/`。

---

## 6) publish：IDE 回写 Registry

### 前置条件

- **本地 Registry**：目标为磁盘路径时直接写入 `assets/` 与 `registry.json`
- **远程 Registry（HTTP）**：目标为 **aipm-registry** 等已实现 `POST /api/publish` 的服务时，客户端在临时目录组装文件后 **`tar -czf` 打包**，以 **multipart** 上传：`manifest`（JSON，含 `filesSha256`）+ `artifact`（`.tgz`）。需本机 PATH 中有 **`tar`**（Windows 10+ 自带 `tar.exe`）
- 目标版本**未在 registry 中发布**（已发布版本不可覆盖）

### 版本来源

publish 使用的 version 来自：`config.skills[packageName]` 或 `config.rules[packageName]` 或 profile，**不是**从已安装 artifact 的 `package.json` 读取。若本地修改了 version，需同步更新 config 或 profile。

### 流程

1. **校验**：frontmatter（name、description 必填）、package.json（name、version、files 与目录一致）
2. 从 IDE 安装目录读取文件（并规范化 `package.json` 的 `files` 列表）
3. **远程**：写入临时目录 → `tar -czf` → `POST /api/publish`（服务端 gunzip + 解压并校验 SHA-256、`package.json`、marker）
4. **本地**：写入 `assets/packages/<path>/<version>/` 或 `assets/rules/<path>/<version>/`
5. 更新 `registry.json` 的 `versions`、`latest`
6. 更新 `aipm_profile.json` 的 skills/rules

### init-skill / init-rule

交互式创建，生成 `package.json`、`SKILL.md`/`RULE.md`。创建后编辑内容，再执行 `aipm publish <name>` 发布。

---

## 7) doctor 检查层次

从外到内检查三层：

1. **配置层**：aipm_profile.json / registry / profile 是否可读
2. **索引层**：registry 中是否存在目标 skill/rule 版本
3. **本地层**：`.<ide>/skills/<name>/SKILL.md`、`.<ide>/rules/<name>/RULE.md` 是否存在

有失败项时以非 0 退出，便于 CI 或脚本验收。

---

## 8) 当前缺陷与限制

### 高优先级

| 缺陷 | 说明 |
|------|------|
| **publish 版本来源** | version 来自 config/profile，不读取已安装 artifact 的 package.json。本地修改 version 后需手动同步 config。 |
| **无 aipm diff** | 无法在 update 前对比本地与远程目标版本的差异（见 TODO.md）。 |
| **无 update --preview** | 无法在 update 前预览变更（见 TODO.md）。 |

### 中优先级

| 缺陷 | 说明 |
|------|------|
| **Profile 不可内嵌** | 无法在 aipm_profile.json 中直接定义 profile 内容，必须依赖 registry 的 profiles/。离线或私有场景不便。 |
| **Windsurf Rules 格式** | Windsurf 期望 `.windsurf/rules/*.md`（单文件），当前安装为 `.<ide>/rules/<name>/RULE.md`（目录）。部分 IDE 可能需额外适配。 |
| **init 时 profile 仅本地** | `listAvailableProfiles` 仅扫描本地 registry，init 时若 registry 为远程 URL，无法列出 profile 供选择。 |

### 低优先级

| 缺陷 | 说明 |
|------|------|
| **无 registry.json 校验** | publish 未对 registry.json 做 schema 校验，错误结构可能导致异常。 |
| **aipm use 清空显式声明** | `aipm use <profile>` 会清空 `config.skills`、`config.rules`，之前的显式覆盖会丢失。 |
| **Help 中 ide 列表硬编码** | `ide` 说明为 `cursor|codex|trae|windsurf`，新增 IDE 时需手动更新，可改为 `Object.keys(IDE_DIR_MAP).join('|')`。 |

### 设计取舍（非缺陷）

| 项目 | 说明 |
|------|------|
| **非 aipm-registry 的远程 URL** | 仅支持实现了兼容 `POST /api/publish` 的服务；其它 URL 需本地 registry 或自建网关。 |
| **已发布版本不可覆盖** | 符合「已发布不可变」约定，需发新版本才能更新。 |

---

## 9) 维护建议

- 保持 `SKILL.md`、`RULE.md` 仅包含 AI 运行时最小信息
- 元数据扩展优先放在 `registry.json`、`profiles/*.json`
- 新增命令时同步补充 `doctor` 对应检查项
- 命令行为变更后，同步更新本表与示例
