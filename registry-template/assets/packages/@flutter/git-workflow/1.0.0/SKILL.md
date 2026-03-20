---
name: "@flutter/git-workflow"
description: Git 工作流规范：提交信息、分支命名、PR 流程与提交流程。规范内容优先通过 MCP 服务 TeamRules 获取，否则使用本地默认规范。
---

# Git 工作流规范

## 触发场景

- 编写提交信息、创建分支、发起或审查 PR
- 用户提及 Git、commit、分支、PR、合并

## 提交信息格式（Conventional Commits）

```
<type>(<scope>): <subject>

<body>
```

| type | 说明 |
|------|------|
| feat | 新功能 |
| fix | 修复 bug |
| docs | 文档 |
| style | 格式（不影响逻辑） |
| refactor | 重构 |
| perf | 性能优化 |
| test | 测试 |
| chore | 构建/工具 |

**示例：**
```
feat(auth): 添加 JWT 登录
fix(table): 修复分页在空数据时的异常
refactor(api): 统一请求错误处理
```

## 分支命名

- `feature/<short-desc>`：新功能
- `fix/<short-desc>`：bug 修复
- `hotfix/<short-desc>`：紧急修复
- `refactor/<short-desc>`：重构

示例：`feature/user-login`、`fix/table-pagination`

## PR 流程

1. 从 `main`/`master` 拉取最新
2. 在 feature/fix 分支完成开发
3. 发起 PR，填写标题与描述
4. 通过 CI 与 Code Review 后合并
5. 合并后删除对应分支

## 规范来源

- **优先**：通过 MCP 服务 TeamRules 获取团队自定义规范
- **默认**：使用本 Skill 中的规范
