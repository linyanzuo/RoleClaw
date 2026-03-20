---
name: "aipm"
description: "AIPM CLI 操作指南：package 创建与发布、按 profile 管理 IDE 内 skills/rules 的完整流程。"
---

# AIPM 操作 Skill

当用户需要执行 AIPM 相关操作时，按本 Skill 执行。AIPM 有两个核心作用：

1. **Package 生命周期**：创建 package（init-skill/init-rule）、发布至 Registry（publish）
2. **IDE 管理**：根据 profile 配置，确保 IDE 内安装的 package 与声明版本一致

## 使用时机

- 用户提到 aipm、skill、rule、registry
- 需要初始化项目、安装/同步 skills、发布新 skill、更新 registry
- 需要查看或修改 `aipm_profile.json`、`.cursor/skills`、`.codex/rules` 等

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
| `install [--on-conflict=..]` | 按 profile 从 Registry 安装声明的 skills/rules 到 `.<ide>/` |
| `list` | 查看声明与安装状态 |
| `update [name]` | 从 Registry 更新到最新版本 |
| `publish [name] [-v]` | 将 IDE 中编辑的 skill/rule 同步到本地 Registry |
| `doctor` | 检查配置、Registry、本地安装 |
| `use [profile-id]` | 切换配置单，无参数时列出可用配置单 |

## 创建新 package（交互式）

| 命令 | 作用 |
|------|------|
| `init-skill` | 交互式创建新 skill（提示 name、description、version） |
| `init-rule` | 交互式创建新 rule |

## 向 profile 添加 package 并安装

| 命令 | 作用 |
|------|------|
| `install-skill <name> [version]` | 添加 skill 到 config 并从 Registry 安装 |
| `install-rule <name> [version]` | 添加 rule 到 config 并从 Registry 安装 |

## 从 config 和 IDE 移除 package

| 命令 | 作用 |
|------|------|
| `uninstall-skill <name>` | 从 config 和 IDE 移除 skill |
| `uninstall-rule <name>` | 从 config 和 IDE 移除 rule |

## Registry 管理命令（仅本地 Registry）

| 命令 | 作用 |
|------|------|
| `unpublish-skill <name>` | 从 Registry 删除 skill |
| `unpublish-rule <name>` | 从 Registry 删除 rule |

## 常用流程

### 1. 项目首次接入

```bash
# 在项目根目录执行，按提示选择 IDE
aipm init

# 若项目内无 registry-template，需指定 Registry 路径
AIPM_REGISTRY=/path/to/registry-template aipm init
# 或
aipm init --registry /path/to/registry-template

# 按 profile 安装声明的 skills/rules
aipm install
```

### 2. 编辑后同步回 Registry

```bash
# 同步所有已声明的 skills/rules
aipm publish

# 仅同步指定项
aipm publish git-workflow

# 查看详细路径
aipm publish --verbose
```

### 3. 新建 skill 并发布到 Registry

```bash
# 1. 交互式创建（提示 name、description、version）
aipm init-skill

# 2. 编辑 .<ide>/skills/<installName>/SKILL.md

# 3. 发布到 Registry
aipm publish @scope/name
```

### 4. 新建 rule 并发布

```bash
aipm init-rule
# 编辑 RULE.md 后
aipm publish @scope/name
```

### 5. 从 Registry 删除

```bash
aipm unpublish-skill <name>
aipm unpublish-rule <name>
```

## 路径与配置

- **IDE 目录**：由 `config.ide` 决定，`cursor` → `.cursor/`，`codex` → `.codex/`
- **Skill 安装路径**：`.<ide>/skills/<name>/` 或 `.<ide>/skills/@scope/<name>/`
- **Rule 安装路径**：`.<ide>/rules/<name>/` 或 `.<ide>/rules/@scope/<name>/`
- **版本标记**：每个已安装 artifact 目录下有 `.aipm`（JSON `{"version":"x.y.z"}`），用于 install 时版本感知跳过；AI 工具不扫描此文件，不修改 SKILL/RULE 本身
- **配置入口**：`package.json` 的 `aipm` 字段或项目根目录的 `aipm_profile.json`
- **配置单模式**：设置 `profile` 时，从 `profiles/<profile>.json` 加载配置单；显式 `skills/rules` 可覆盖
- **Registry**：`config.registry` 可为本地路径或远程 URL；`publish`、`init-skill` 等仅支持本地

## 命名规范（npm 风格）

- **无 scope**：`git-workflow`、`frontend-coding-standard`（全局唯一）
- **有 scope**：`@frontend-eng/git-workflow`（多租户，`@租户/包名`）

**命名约束**：因 `_` 用于 scope 与 name 分隔，二者均不能含 `_`；scope ≤ 16 字符，name ≤ 24 字符；仅允许 `a-z0-9-`。

## 冲突处理

`install`、`update` 遇文件冲突时可用：

- `--on-conflict=ask`：交互询问（默认）
- `--on-conflict=skip`：跳过
- `--on-conflict=overwrite`：强制覆盖

非交互环境（CI/管道）必须指定 `skip` 或 `overwrite`。

## 执行原则

1. 在**项目根目录**执行，确保 `aipm_profile.json` 存在
2. 涉及 Registry 写入时，确认 `config.registry` 为本地路径
3. 执行后提示用户：`git add` 与 `git commit` 以持久化 Registry 变更
