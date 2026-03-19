# AIPM Skills Registry Template

AIPM 私有 Skills 仓库模板，**完全参照 npm 包管理模型**。

## 核心设计（npm 风格）

1. **唯一标识**：包名全局唯一，`git-workflow` 或 `@scope/git-workflow`（多租户）
2. **无 shared/ 区分**：所有包平铺，通过命名区分
3. **多租户**：`@租户名/包名` 格式，每个岗位对应一个租户，如 `@frontend/vue-ts-coding-standard`（scope ≤16 字符）
4. **配置**：支持 `package.json` 的 `aipm` 字段或 `.aipm/config.json`，结构类似 `dependencies`

## 目录结构

```text
registry-template/
├── README.md
├── registry.json                    # 全量 Skill/Rule 索引（npm registry 风格）
├── profiles/                        # 配置单（不同配置对应不同 skills/rules 组合）
│   ├── frontend-engineer.json
│   ├── flutter-engineer.json
│   ├── ui-designer.json
│   ├── test-engineer.json
│   └── product-manager.json
├── assets/
│   ├── AIPM-MARKER.md
│   ├── packages/                    # Skill 发布目录
│   │   ├── <name>/<version>/       # 无 scope：git-workflow
│   │   └── @<scope>/<name>/<version>/  # 有 scope：@frontend/vue-ts-coding-standard
│   └── rules/                      # Rule 发布目录
│       ├── <name>/<version>/
│       └── @<scope>/<name>/<version>/
├── templates/
│   └── skill-template/
│       └── 1.0.0/
└── schemas/
    ├── aipm-marker.schema.json
    └── role-config.schema.json
```

## registry.json 格式

```json
{
  "packages": {
    "git-workflow": {
      "latest": "1.0.0",
      "versions": ["1.0.0"],
      "description": "...",
      "tags": ["git", "workflow"]
    },
    "@frontend/vue-ts-coding-standard": {
      "latest": "1.0.0",
      "versions": ["1.0.0"],
      "description": "Vue 3 + TypeScript 编码规范",
      "tags": ["vue", "frontend"]
    }
  },
  "rules": {
    "@frontend/eng-rules-baseline": { ... }
  }
}
```

## 配置单（Profiles）

`profiles/` 目录存放配置单，每个配置单对应一份 skills/rules 组合。AIPM 根据当前选中的配置单，将 Registry 中的库同步到 IDE。配置单可用于角色、项目或任意场景——在 AIPM 中它们只是不同的配置，无特殊含义。

### 配置单格式

文件路径：`profiles/<profile-id>.json`

```json
{
  "profile": "frontend-engineer",
  "skills": {
    "aipm": "1.0.0",
    "@frontend/vue-ts-coding-standard": "1.0.0",
    "@frontend/git-workflow": "1.0.0",
    "@frontend/code-review-guide": "1.0.0"
  },
  "rules": {
    "@frontend/eng-rules-baseline": "1.0.0"
  }
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `profile` | 否 | 配置单 ID，与文件名一致时可省略 |
| `skills` | 是 | 该配置的 Skills 及版本 |
| `rules` | 是 | 该配置的 Rules 及版本，可为 `{}` |
| `name` | 否 | 显示名称（供 RoleClaw 等上层使用） |

### 配置单如何切换

1. 在 `profiles/` 下新建 `<profile-id>.json`
2. 填写 `skills`、`rules`
3. 执行 `aipm use <profile-id>` 切换配置单
4. 执行 `aipm pull` 按当前配置单同步到 IDE

---

## 配置格式（npm 风格）

### 方式一：package.json

```json
{
  "name": "my-project",
  "aipm": {
    "registry": "./registry-template",
    "ide": "cursor",
    "skills": {
      "git-workflow": "^1.0.0",
      "@frontend-eng/git-workflow": "1.0.0"
    },
    "rules": {
      "engineering-rules-baseline": "^1.0.0"
    }
  }
}
```

### 方式二：.aipm/config.json

```json
{
  "registry": "./registry-template",
  "ide": "cursor",
  "skills": {
    "git-workflow": "1.0.0",
    "@frontend-eng/git-workflow": "1.0.0"
  },
  "rules": {
    "engineering-rules-baseline": "1.0.0"
  }
}
```

## 包元数据（package.json）

每个 Skill/Rule 版本目录包含 `package.json`：

```json
{
  "name": "git-workflow",
  "version": "1.0.0",
  "description": "Git 工作流规范",
  "aipm": { "type": "skill" }
}
```

scoped 包：

```json
{
  "name": "@frontend-eng/git-workflow",
  "version": "1.0.0",
  "description": "前端工程师 Git 工作流",
  "aipm": { "type": "skill" }
}
```

## 安装目录（转换层：Registry → IDE）

Registry 使用 `@scope/name`，IDE 安装时转换为扁平唯一名，避免与 Agent Skills 的 `name=父目录` 冲突：

- 无 scope：`git-workflow` → `.cursor/skills/git-workflow/`
- 有 scope：`@frontend-eng/git-workflow` → `.cursor/skills/frontend-eng_git-workflow/`（`/` 替换为 `_`）

SKILL.md 的 `name` 在安装时会被改写为 installName，保证 AI 能正确识别。

## 命名约束（@scope）

因 `_` 用于 scope 与 name 的分隔（`@scope/name` → `scope_name`），故：

| 约束 | 说明 |
|------|------|
| 禁止 `_` | scope 与 name 均不能包含下划线 |
| scope 长度 | ≤ 16 个字符 |
| name 长度 | ≤ 24 个字符 |
| 字符集 | 小写字母、数字、连字符（`a-z0-9-`） |

示例：`@frontend-eng/git-workflow` ✓（scope 11 字符），`@my_team/skill` ✗（含 `_`）

## 常用命令

```bash
aipm init              # 创建配置
aipm pull              # 安装声明的 skills/rules
aipm list              # 查看声明与安装状态
aipm add git-workflow  # 添加并安装
aipm add @frontend-eng/git-workflow
aipm remove <name>     # 移除
aipm push              # 回写 IDE 编辑到 Registry
```

## 与 npm 对照

| 维度 | npm | AIPM |
|------|-----|----------|
| 唯一标识 | `name` / `@scope/name` | 同左 |
| 多租户 | `@org/` scope | `@租户/` scope |
| 配置 | package.json dependencies | aipm.skills / aipm.rules |
| 安装目录 | node_modules | .cursor/skills, .cursor/rules |
| 版本 | semver | semver |
