---
name: "@frontend/vue-ts-coding-standard"
description: Vue 3 + TypeScript 编码规范：组件结构、命名、类型、注释与代码风格。在编写、审查或重构 Vue/TS 代码时使用。
---

# Vue + TypeScript 编码规范

## 触发场景

- 编写、审查或重构 Vue 3 + TypeScript 代码
- 用户提及 Vue、TypeScript、组件、前端编码规范

## 组件结构

单文件组件（SFC）推荐顺序：

```vue
<script setup lang="ts">
// 1. imports
// 2. props / emits
// 3. composables
// 4. reactive state
// 5. computed
// 6. watchers
// 7. lifecycle
// 8. methods
</script>

<template>
  <!-- 模板 -->
</template>

<style scoped>
/* 样式 */
</style>
```

## 命名规范

| 类型 | 规范 | 示例 |
|------|------|------|
| 组件文件 | PascalCase | `UserProfile.vue` |
| 组合式函数 | camelCase，use 前缀 | `useUserAuth` |
| Props / Emits | camelCase | `userId`, `onUpdate` |
| 常量 | UPPER_SNAKE_CASE | `MAX_RETRY_COUNT` |
| 类型/接口 | PascalCase | `UserProfile`, `ApiResponse` |

## TypeScript 类型

- 为 props、emits、ref、reactive 显式声明类型
- 避免 `any`，必要时用 `unknown` 并做类型收窄
- 使用 `defineProps<T>()` 与 `defineEmits<T>()` 泛型

```typescript
// ✅ 推荐
interface Props {
  userId: string
  count?: number
}
const props = defineProps<Props>()
const emit = defineEmits<{ submit: [value: string] }>()

// ❌ 避免
const props = defineProps(['userId'])
```

## 注释规范

- 文件头：简要说明组件/模块职责
- 复杂逻辑：说明意图与边界条件
- 公共 API：JSDoc 注释（`@param`、`@returns`）

```typescript
/**
 * 根据用户 ID 获取 profile
 * @param userId - 用户唯一标识
 * @returns 用户 profile 或 null
 */
async function fetchProfile(userId: string): Promise<UserProfile | null> {
  // ...
}
```

## 代码风格

- 使用 `<script setup>`，避免 Options API 混用
- 优先 `computed` 与 `watchEffect`，减少手写 `watch`
- 异步逻辑用 `async/await`，错误用 `try/catch` 处理
- 样式使用 `scoped`，避免全局污染
