---
name: eng-rules-baseline
description: 前端工程通用规范基线：错误处理、依赖管理、安全与可维护性
globs: "**/*.{ts,tsx,vue,js,jsx}"
alwaysApply: false
---

# 工程规范基线

## 错误处理

```typescript
// ❌ 避免
try {
  await fetchData()
} catch (e) {}

// ✅ 推荐
try {
  await fetchData()
} catch (e) {
  logger.error('Failed to fetch', { error: e })
  throw new DataFetchError('Unable to retrieve data', { cause: e })
}
```

## 依赖与导入

- 按类型分组：第三方 → 内部模块 → 相对路径
- 避免循环依赖
- 未使用的导入及时移除

## 安全

- 用户输入必须校验与转义
- 敏感信息不硬编码，使用环境变量
- API 调用需鉴权与错误处理

## 可维护性

- 单文件/函数职责单一
- 魔法数字与字符串提取为常量
- 复杂逻辑添加注释说明意图
