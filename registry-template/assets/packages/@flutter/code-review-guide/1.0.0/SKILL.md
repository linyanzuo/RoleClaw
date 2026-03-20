---
name: "@flutter/code-review-guide"
description: Flutter/Dart 代码审查规范：正确性、性能、可维护性与最佳实践。在审查 PR、检查代码变更或用户请求 code review 时使用。
---

# Flutter 代码审查规范

## 触发场景

- 审查 Pull Request、检查 Flutter/Dart 代码变更
- 用户请求 code review 或代码质量检查

## 审查维度

### 1. 正确性与健壮性

- 逻辑是否正确，是否覆盖边界与异常
- 异步/竞态是否处理妥当
- 空值、null 是否有防护

### 2. 性能

- 是否避免在 build 中创建新对象
- 是否合理使用 `const`
- 列表是否使用 `ListView.builder` 等懒加载

### 3. Flutter + Dart

- 组件结构是否符合 flutter-coding-standard
- 状态管理是否规范
- 是否遵循 effective_dart

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
- [ ] 无性能隐患（const、build 内无新建对象）
- [ ] 符合 Flutter + Dart 编码规范
- [ ] 代码可读、可维护
