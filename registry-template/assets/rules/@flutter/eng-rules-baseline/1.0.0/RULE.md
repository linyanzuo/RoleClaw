---
name: eng-rules-baseline
description: Flutter 工程通用规范基线：错误处理、依赖管理、可维护性
globs: "**/*.dart"
alwaysApply: false
---

# Flutter 工程规范基线

## 错误处理

```dart
// ❌ 避免
try {
  await fetchData();
} catch (e) {}

// ✅ 推荐
try {
  await fetchData();
} catch (e, stack) {
  logger.error('Failed to fetch', error: e, stackTrace: stack);
  rethrow;
}
```

## 依赖与导入

- 按类型分组：dart → package → 相对路径
- 避免循环依赖
- 未使用的导入及时移除

## 可维护性

- 单文件/函数职责单一
- 魔法数字与字符串提取为常量
- 复杂逻辑添加注释说明意图
