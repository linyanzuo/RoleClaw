---
name: code-review-guide
description: 代码审查规范：正确性、安全、可维护性与 Vue/TS 最佳实践。在审查 PR、检查代码变更或用户请求 code review 时使用。
---

# 代码审查规范

## 触发场景

- 审查 Pull Request、检查代码变更
- 用户请求 code review 或代码质量检查

## 审查维度

### 1. 正确性与健壮性

- 逻辑是否正确，是否覆盖边界与异常
- 异步/竞态是否处理妥当
- 空值、undefined 是否有防护

### 2. 安全

- 用户输入是否校验与转义（防 XSS）
- 敏感信息是否暴露（token、密钥）
- 接口鉴权与权限校验是否到位

### 3. Vue + TypeScript

- 组件结构是否符合 vue-ts-coding-standard
- Props/Emits 是否有类型定义
- 是否避免 `any`，合理使用类型
- 响应式使用是否恰当（ref/reactive/computed）

### 4. 可维护性

- 函数职责单一、命名清晰
- 重复逻辑是否抽取
- 复杂逻辑是否有注释

## 反馈格式

- **Critical**：必须修复才能合并
- **Suggestion**：建议改进
- **Nice to have**：可选优化

## 审查清单

- [ ] 逻辑正确，边界与异常已考虑
- [ ] 无安全风险（XSS、敏感信息泄露）
- [ ] 符合 Vue + TS 编码规范
- [ ] 代码可读、可维护
- [ ] 有必要的测试或说明
