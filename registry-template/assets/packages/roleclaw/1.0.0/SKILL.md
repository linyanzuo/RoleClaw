---
name: "roleclaw"
description: "RoleClaw CLI 操作指南：初始化、拉取、发布、同步 Skill/Rule 到 Registry 的完整流程与命令参考。"
---

# RoleClaw 操作 Skill

当用户需要执行 RoleClaw 相关操作时，按本 Skill 执行。RoleClaw 是岗位 AI 助手的 Skills/Rules 配置与同步工具。

## 使用时机

- 用户提到 roleclaw、skill、rule、registry、岗位配置
- 需要初始化项目、拉取/同步 skills、发布新 skill、更新 registry
- 需要查看或修改 `.roleclaw/config.json`、`.cursor/skills`、`.codex/rules` 等

## 命令入口

RoleClaw 通过 CLI 调用，入口为：

```bash
roleclaw <command> [args]
```

若项目内使用脚本：`node scripts/roleclaw.mjs <command> [args]`  
若全局安装：`roleclaw <command> [args]`

## 核心命令速查

| 命令 | 作用 |
|------|------|
| `init` | 交互式创建 `.roleclaw/config.json`，选择 IDE 与岗位 |
| `pull` | 从 Registry 安装声明的 skills/rules 到 `.<ide>/` |
| `list` | 查看声明与安装状态 |
| `update [name]` | 从 Registry 更新到最新版本 |
| `push [name] [-v]` | 将 IDE 中编辑的 skill/rule 回写到本地 Registry |
| `doctor` | 检查配置、Registry、岗位、本地安装 |

## Registry 管理命令（仅本地 Registry）

| 命令 | 作用 |
|------|------|
| `add-skill <name> [version] [--overwrite]` | 将 IDE 中新建的 skill 添加到 Registry |
| `add-rule <name> [version] [--overwrite]` | 将 IDE 中新建的 rule 添加到 Registry |
| `remove-skill <name>` | 从 Registry 删除 skill |
| `remove-rule <name>` | 从 Registry 删除 rule |
| `update-skill <name> [-v]` | 将 IDE 中 skill 同步到 Registry |
| `update-rule <name> [-v]` | 将 IDE 中 rule 同步到 Registry |

## 常用流程

### 1. 项目首次接入

```bash
# 在项目根目录执行，按提示选择 IDE 与岗位
roleclaw init

# 若项目内无 registry-template，需指定 Registry 路径
ROLECLAW_REGISTRY=/path/to/registry-template roleclaw init
# 或
roleclaw init --registry /path/to/registry-template

# 安装声明的 skills/rules
roleclaw pull
```

### 2. 编辑后同步回 Registry

```bash
# 同步所有已声明的 skills/rules
roleclaw push

# 仅同步指定项
roleclaw push git-workflow
roleclaw update-skill git-workflow
roleclaw update-rule engineering-rules-baseline

# 查看详细路径
roleclaw push --verbose
```

### 3. 新建 skill 并发布到 Registry

```bash
# 1. 在 .<ide>/skills/<name>/ 下创建 SKILL.md 等文件
# 2. 添加到 Registry
roleclaw add-skill <name> [version] [--overwrite]

# 若目标版本已存在，加 --overwrite
roleclaw add-skill my-skill 1.0.0 --overwrite
```

### 4. 新建 rule 并发布

```bash
# 在 .<ide>/rules/<name>/ 下创建 RULE.md 后
roleclaw add-rule <name> [version] [--overwrite]
```

### 5. 从 Registry 删除

```bash
roleclaw remove-skill <name>
roleclaw remove-rule <name>
```

## 路径与配置

- **IDE 目录**：由 `config.ide` 决定，`cursor` → `.cursor/`，`codex` → `.codex/`
- **Skill 安装路径**：`.<ide>/skills/<name>/`
- **Rule 安装路径**：`.<ide>/rules/<name>/`
- **配置入口**：`.roleclaw/config.json`
- **Registry**：`config.registry` 可为本地路径或远程 URL；`push`、`add-skill` 等仅支持本地

## 冲突处理

`pull`、`update` 遇文件冲突时可用：

- `--on-conflict=ask`：交互询问（默认）
- `--on-conflict=skip`：跳过
- `--on-conflict=overwrite`：强制覆盖

非交互环境（CI/管道）必须指定 `skip` 或 `overwrite`。

## 执行原则

1. 在**项目根目录**执行，确保 `.roleclaw/config.json` 存在
2. 涉及 Registry 写入时，确认 `config.registry` 为本地路径
3. 执行后提示用户：`git add` 与 `git commit` 以持久化 Registry 变更
