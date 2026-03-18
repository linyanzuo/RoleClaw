---
name: cp-component-system
description: 维护并扩展当前仓库中的 CP Flutter 组件体系。适用于修改 `lib/theme/widgets/` 下的组件、对齐本地 Figma HTML 视觉规范、补充组件状态和动效、扩展可配置 API，或更新组件测试。当前基线组件为 `CPThemeButton`。
---

# CP 组件体系

当你在这个 Flutter 项目里处理自定义 CP 组件时，优先使用这份 skill。尽量复用现有 CP 组件模式、主题 token 和视觉规则，不要退回系统业务组件，也不要在业务层零散写样式。

## 当前范围

- 当前已经落地的组件是 `CPThemeButton`
- 后续新增组件时，应沿用同样的命名方式、分层方式、状态处理方式和验证方式

## 关键文件

- `lib/theme/widgets/cp_theme_button.dart`
  - 当前的基线 CP 组件
  - 包含变体、禁用状态、按压缩放、内阴影、文本布局模式、样式覆盖和任意 `child` 内容支持
- `skills/cp-component-system/cp_theme_button_usage.md`
  - `CPThemeButton` 的使用文档
- `lib/theme/cp_app_theme.dart`
  - 颜色、尺寸、文本和其他 token 的主题访问入口
- `lib/theme/theme_tokens.dart`
  - CP 组件依赖的共享 token 模型
- `lib/theme/schemes/*.dart`
  - 不同主题方案对应的 token 配置
- `test/widget_test.dart`
  - 当前组件回归测试入口
- 仓库根目录中的本地 Figma HTML 规范文件
  - 视为视觉和交互的事实来源

## 工作规则

- 对外公开的组件、枚举、样式对象和 API 统一使用 `CP` 前缀
- 组件样式优先由主题 token 驱动，不要在业务层硬编码颜色、圆角、阴影和尺寸
- 如果规范要求“不使用系统组件”，则应通过基础布局和交互能力自行实现，而不是直接套用系统按钮或其他现成业务组件
- 组件状态分层应尽量完整保留：
  - normal
  - hover / focus
  - pressed
  - disabled
- 禁用视觉和点击能力需要拆开建模
  - `disabled` 负责控制是否显示为禁用态
  - 禁用态下是否还能点击、是否还有反馈，应由单独属性控制
- 默认值必须可预测
  - 不传覆盖属性时，要稳定回退到规范默认值
  - 局部覆盖不应破坏其他默认行为
- 组件内容优先支持两类模式：
  - 结构化文本模式，例如 `leading / label / trailing`
  - 任意 `child` 模式
- 如果组件包含按压反馈，动画触发条件应与业务回调解耦，避免“没有回调就完全没有反馈”
- 自定义类、字段和方法要保留 Dart 注释，方便后续组件继续沿用同样的维护标准

## CPThemeButton 基线能力

当前可以把 `CPThemeButton` 视为组件体系的 API 和结构基线。它已经支持：

- 视觉变体：
  - `primary`
  - `secondary`
  - `cancel`
  - `danger`
- 内容模式：
  - `label`
  - `child`
- 文本布局模式：
  - `groupCentered`
  - `labelCentered`
  - `labelCenteredCompact`
- 按状态覆盖的样式能力：
  - 背景
  - 边框
  - 文本颜色和文本样式
  - 图标颜色
  - 外阴影
  - 内阴影
- 按压反馈控制：
  - 启用态缩放
  - 禁用态缩放
  - 启用态内阴影
  - 禁用态内阴影
- 显式禁用状态：
  - `disabled`
- 禁用态点击回调：
  - `onDisabledTap`
- 文本模式最大行数：
  - `maxLines`

如果后续新增组件也需要状态动画、禁用处理、样式覆盖或内容插槽，优先复用这套思路，而不是再设计一套完全不同的 API。

当任务主要和 `CPThemeButton` 的接入方式、参数选择或状态组合有关时，优先先看 `cp_theme_button_usage.md`。

## 新增组件时怎么做

1. 在 `lib/theme/widgets/` 下新增 `cp_<component>.dart`
2. 先对齐视觉规范中的结构、状态和 token 语义
3. 设计公开 API 时，优先遵循 `CPThemeButton` 的习惯
4. 如果新增能力依赖新的 token：
   - 先更新 `theme_tokens.dart`
   - 再更新各个主题 scheme
   - 必要时补充 `cp_app_theme.dart`
5. 至少补一条可工作的 widget test
6. 如果组件需要展示给开发者或设计联调，补到 `theme_workbench_page.dart`

## 修改现有组件时怎么做

- 先确认现有公开参数是否已经能覆盖需求，避免重复加能力
- 新增属性时：
  - 尽量保持可选
  - 给出明确默认值
  - 保持旧用法兼容
- 新增状态逻辑时：
  - 明确启用态和禁用态是否一致
  - 明确没有回调时是否仍显示反馈
- 新增布局模式时：
  - 优先做成枚举值
  - 测试里尽量验证几何结果，而不是只验证属性存在

## 验证方式

组件改动完成后，运行：

```powershell
dart format lib/theme/widgets test/widget_test.dart skills/cp-component-system
flutter test
flutter analyze
```

如果 analyzer 最终只剩下 `lib/theme/cp_colors.dart` 里的既有命名风格 `info`，可以视为这次组件改动没有引入新的静态问题。
