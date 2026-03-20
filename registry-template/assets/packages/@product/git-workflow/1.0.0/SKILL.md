---
name: git-workflow
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
| refactor | 重构 |
| chore | 构建/工具 |

**示例：**
```
docs(prd): 更新登录模块需求说明
feat(spec): 添加支付流程 PRD
```

## 分支命名

- `feature/<short-desc>`：新功能
- `docs/<short-desc>`：文档更新

## PR 流程

1. 从 main/master 拉取最新
2. 在 feature 分支完成
3. 发起 PR，填写标题与描述
4. 通过 Review 后合并
