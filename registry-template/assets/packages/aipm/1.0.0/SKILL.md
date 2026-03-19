---
name: "aipm"
description: "AIPM CLI 操作指南：初始化、拉取、发布、同步 Skill/Rule 到 Registry 的完整流程与命令参考。"
---

# AIPM 操作 Skill

当用户需要执行 AIPM 相关操作时，按本 Skill 执行。AIPM 是 AI 助手的 Skills/Rules 配置与同步工具，**完全参照 npm 包管理模型**。

## 使用时机

- 用户提到 aipm、skill、rule、registry
- 需要初始化项目、拉取/同步 skills、发布新 skill、更新 registry
- 需要查看或修改 `.aipm/config.json`、`.cursor/skills`、`.codex/rules` 等

## 命令入口

AIPM 通过 CLI 调用，入口为：

```bash
aipm <command> [args]
```

若项目内使用脚本：`node scripts/aipm.mjs <command> [args]`  
若全局安装：`aipm <command> [args]`

### 安装 AIPM

- **macOS/Linux**：`./scripts/install-aipm.sh`
- **Windows**：`scripts\install-aipm.bat`（需 Node.js）
  - 安装后若 `aipm` 无法识别，请**关闭并重新打开终端**，或执行：
    - PowerShell：`$env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")`
    - CMD：`set "PATH=%USERPROFILE%\bin;%PATH%"`

## 核心命令速查

| 命令 | 作用 |
|------|------|
| `init` | 交互式创建配置（选择 IDE） |
| `pull` | 从 Registry 安装声明的 skills/rules 到 `.<ide>/` |
| `list` | 查看声明与安装状态 |
| `update [name]` | 从 Registry 更新到最新版本 |
| `push [name] [-v]` | 将 IDE 中编辑的 skill/rule 回写到本地 Registry |
| `doctor` | 检查配置、Registry、本地安装 |
| `use [profile-id]` | 切换配置单，无参数时列出可用配置单 |

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
# 在项目根目录执行，按提示选择 IDE
aipm init

# 若项目内无 registry-template，需指定 Registry 路径
AIPM_REGISTRY=/path/to/registry-template aipm init
# 或
aipm init --registry /path/to/registry-template

# 安装声明的 skills/rules
aipm pull
```

### 2. 编辑后同步回 Registry

```bash
# 同步所有已声明的 skills/rules
aipm push

# 仅同步指定项
aipm push git-workflow
aipm update-skill git-workflow
aipm update-rule engineering-rules-baseline

# 查看详细路径
aipm push --verbose
```

### 3. 新建 skill 并发布到 Registry

```bash
# 1. 在 .<ide>/skills/<name>/ 下创建 SKILL.md 等文件
# 2. 添加到 Registry
aipm add-skill <name> [version] [--overwrite]

# 若目标版本已存在，加 --overwrite
aipm add-skill my-skill 1.0.0 --overwrite
```

### 4. 新建 rule 并发布

```bash
# 在 .<ide>/rules/<name>/ 下创建 RULE.md 后
aipm add-rule <name> [version] [--overwrite]
```

### 5. 从 Registry 删除

```bash
aipm remove-skill <name>
aipm remove-rule <name>
```

## 路径与配置

- **IDE 目录**：由 `config.ide` 决定，`cursor` → `.cursor/`，`codex` → `.codex/`
- **Skill 安装路径**：`.<ide>/skills/<name>/` 或 `.<ide>/skills/@scope/<name>/`
- **Rule 安装路径**：`.<ide>/rules/<name>/` 或 `.<ide>/rules/@scope/<name>/`
- **版本标记**：每个已安装 artifact 目录下有 `.aipm`（JSON `{"version":"x.y.z"}`），用于 pull 时版本感知跳过；AI 工具不扫描此文件，不修改 SKILL/RULE 本身
- **配置入口**：`package.json` 的 `aipm` 字段或 `.aipm/config.json`
- **配置单模式**：设置 `profile` 时，从 `profiles/<profile>.json` 加载配置单；显式 `skills/rules` 可覆盖
- **Registry**：`config.registry` 可为本地路径或远程 URL；`push`、`add-skill` 等仅支持本地

## 命名规范（npm 风格）

- **无 scope**：`git-workflow`、`frontend-coding-standard`（全局唯一）
- **有 scope**：`@frontend-eng/git-workflow`（多租户，`@租户/包名`）

**命名约束**：因 `_` 用于 scope 与 name 分隔，二者均不能含 `_`；scope ≤ 16 字符，name ≤ 24 字符；仅允许 `a-z0-9-`。

## 冲突处理

`pull`、`update` 遇文件冲突时可用：

- `--on-conflict=ask`：交互询问（默认）
- `--on-conflict=skip`：跳过
- `--on-conflict=overwrite`：强制覆盖

非交互环境（CI/管道）必须指定 `skip` 或 `overwrite`。

## 执行原则

1. 在**项目根目录**执行，确保 `.aipm/config.json` 存在
2. 涉及 Registry 写入时，确认 `config.registry` 为本地路径
3. 执行后提示用户：`git add` 与 `git commit` 以持久化 Registry 变更
