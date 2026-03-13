---
name: "frontend-coding-standard"
description: "Contains frontend coding standards for comments and code style (TypeScript/JavaScript, Vue). Invoke when writing, reviewing, or refactoring code."
---

# 前端编码规范 (Frontend Coding Standard)

此 Skill 包含了项目的前端编码规范，涵盖注释规范和代码风格规范（TypeScript/JavaScript, Vue）。在进行任何代码编写、重构或审查时，请参考此规范。

> **注意**: Git 提交规范已迁移至独立的 Skill: `git-commit-standard`。

# 组件开发规范

## 组件结构与定义
在 `admin-ui` 等组件库开发中，必须遵循以下文件结构与定义规范：

### 文件结构
组件必须拆分为**实现文件** (`.vue`) 和**定义文件** (`.ts`)。

```text
| 组件名称（小写，下划线分割）
| -- 组件名称.ts	(组件定义，大写驼峰)
| -- 组件名称.vue	(组件实现，大写驼峰)

示例 (Button 组件):
| -- button
| -- | -- Button.ts
| -- | -- Button.vue
```

### 组件定义 (.ts)
组件的 Props、Emits 和其他类型定义应放在 `.ts` 文件中，并使用 Namespace 封装。

```typescript
// Button.ts
import { ICommonProps, CommonProps } from "../common/CommonProps"

namespace Button {
    // 【规范】组件参数定义
    export interface IProps extends ICommonProps {
      // 尺寸
      size: 'small' | 'medium' | 'large'
    }

    // 组件默认参数值
    export class Props extends CommonProps implements IProps {
        public size: IProps['size'] = 'medium'
        
        constructor(props?: Partial<Props>) {
            super(props)
            if (props) { Object.assign(this, props) }
        }
        
        public getDefaultProps() {
            return {
                ...this,
                ...super.getDefaultProps(),
            }
        }
    }

    // 组件绑定事件
    export interface IEmits {
      (e: "onClick"): void
    }
}
export default Button
```

### 组件实现 (.vue)
在 `.vue` 文件中引入定义并使用。

```vue
<!-- Button.vue -->
<script lang="ts" setup name="MoeButton">
import Button from './Button'

// 使用定义的 Props 和默认值
const props = withDefaults(defineProps<Button.IProps>(), new Button.Props().getDefaultProps())
const emits = defineEmits<Button.IEmits>()
</script>
```

---

# 代码注释规范
遵循简洁、可读、可维护的原则，为团队协作与代码长期演进服务。

## 通用原则
- **位置**: 文件首、模块/函数首、复杂逻辑/边界条件处；避免在模板与样式中堆叠无效注释。
- **语言**: 所有代码注释统一使用**中文**，以便于团队协作与维护（包括业务代码、公共库及接口文档）。
- **长度**: 单行精炼（80–120 字符），避免与代码实现重复叙述。
- **禁止**: 无意义注释、遗留的注释掉代码、与实现不同步的误导性注释。

## TypeScript / JavaScript
- **有参函数**: 使用标准 JSDoc 格式，包含 `@param` 与 `@returns` 说明。
- **无参函数/属性**: 使用单行 `/** ... */` 进行精炼说明。
- **示例**:
  - **有参函数 (标准 JSDoc)**:
    ```ts
    /**
     * OSS 上传
     * @param dir 上传目录
     * @param file 文件对象
     * @returns 上传后的文件地址
     */
    export const uploadFile = async (dir: string, file: File): Promise<string> => {
      // ... 实现
      return ''
    }
    ```
  - **无参函数/属性 (单行)**:
    ```ts
    /** 获取当前用户凭证 */
    export const getCredentials = () => { ... }

    /** 最大重试次数 */
    const MAX_RETRY = 3
    ```

## Vue SFC (.vue)
- **文件顶部**: 使用 HTML 注释块（作者、版权、模块名称）。
- **组件简述**: 在 `<script setup>` 顶部使用单行 `/** */` 进行组件简述。
- **模板结构**:
  - **模块注释**: 页面内主要功能区块（如顶部栏、侧边栏、内容区）开头必须添加 HTML 注释说明，如 `<!-- 顶部操作区 -->`。
  - **紧凑布局**: 功能区块之间 **不建议** 使用空行分隔，保持代码紧凑。
- **示例**:
  - **文件顶部**:
    ```html
    <!--
      -- Created by zed on 2022/3/13
      -- Copyright © 2017 www.moemone.com. All rights reserved.
      --
      -- 网站类别管理
    -->
    ```
  - **Script Setup**:
    ```ts
    /** 通知栏组件：支持滚动/关闭/链接模式，事件 close/link */
    ```

---

# 代码风格规范

## CSS / Tailwind
- **布局/原子样式**: 优先使用 Tailwind Utility Classes (如 `flex`, `w-full`, `p-5`)。
- **组件定制/复杂覆盖**:
  - 避免在 HTML 中堆叠过深的 Tailwind 任意值选择器 (如 `[&_.el-table__header...]`)。
  - **强制**将复杂的组件覆盖样式提取到 `<style scoped lang="scss">` 中。
  - 使用 `:deep()` 选择器处理深层样式覆盖。

## TypeScript / JavaScript
- **类/命名空间定义**: 类或命名空间定义与内部第一行代码之间不换行，保持代码紧凑与视觉内聚性。
- **示例**:
  ```ts
  export namespace OssApi {
    /** STS临时访问凭证 */
    export interface Resp {
      // ...
    }
  }
  ```
