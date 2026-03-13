---
name: "git-workflow"
description: "Git 工作流规范：提交信息、分支/PR 规范与提交流程。规范内容优先通过 MCP 服务 TeamRules 获取，否则使用本地默认规范。"
---

# Git 工作流规范 (Git Workflow)

## 提交前检查 (Pre-commit Checks)

在提交代码前，**强烈建议**运行代码检查以确保代码质量。

### 推荐检查步骤

1.  **Lint 检查**: 运行项目的 lint 命令。
    -   如果项目中有 `npm run lint` 或 `npm run lint-fix`，请优先执行。
    -   对于 `Vue3` 项目，可以使用 `npm run lint-fix`。
2.  **类型检查**: 对于 TypeScript 项目，建议运行类型检查（如 `vue-tsc --noEmit`）。
3.  **测试**: 如果有测试用例，运行 `npm test`。

确保所有检查通过后再生成提交信息。

---

## 代码提交规范获取策略

在生成或校对提交信息、创建分支、撰写 PR 描述时，必须遵循以下步骤获取 Git 规范：

### 步骤 1：尝试通过 MCP 服务获取最新规范
优先尝试调用 MCP 服务 `TeamRules` 获取全局规范：
- MCP 服务名称: `TeamRules`
- 目标路径: `/rules/global/git.md` (或 `/rules/git.md`，按实际可用为准)
- 调用方式: 请使用对应的 MCP read 文本文件工具尝试读取以上路径。

### 步骤 2：降级使用本地默认规范（Fallback）
如果 MCP 服务不存在、未启动、无响应，或者读取文件失败，则**必须**降级使用本地自带的默认规范。
- 本地规范文件路径: `.cursor/skills/git-workflow/git.md` (请在当前项目的上述路径读取文件)

**注意：** 始终以成功获取到的那一份规范内容为准进行接下来的工作。
