---
name: "@flutter/flutter-coding-standard"
description: Flutter + Dart 编码规范：组件结构、命名、状态管理、注释与代码风格。在编写、审查或重构 Flutter/Dart 代码时使用。
---

# Flutter + Dart 编码规范

## 触发场景

- 编写、审查或重构 Flutter/Dart 代码
- 用户提及 Flutter、Dart、Widget、状态管理

## 文件结构

- 按功能模块拆分，单文件职责单一
- Widget 文件：`<name>_widget.dart` 或 `widgets/<name>.dart`
- 状态/逻辑：`<name>_controller.dart` 或 `providers/<name>.dart`

## 命名规范

| 类型 | 规范 | 示例 |
|------|------|------|
| 组件/Widget | PascalCase | `UserProfileCard` |
| 文件 | snake_case | `user_profile_card.dart` |
| 变量/函数 | camelCase | `userId`, `fetchUser` |
| 常量 | lowerCamelCase 或 UPPER_SNAKE | `maxRetryCount` |
| 私有 | `_` 前缀 | `_handleTap` |

## 状态管理

- 明确选用方案（Provider、Riverpod、Bloc 等）并保持一致性
- 业务逻辑与 UI 分离，避免在 Widget 中写复杂逻辑
- 异步用 `async/await`，错误用 `try/catch` 处理

## 注释规范

- 文件头：简要说明模块职责
- 公共 API：`///` 文档注释
- 复杂逻辑：说明意图与边界条件

## 代码风格

- 遵循 `effective_dart` 与 `flutter_lints`
- 使用 `const` 构造函数
- 避免在 build 中创建新对象
