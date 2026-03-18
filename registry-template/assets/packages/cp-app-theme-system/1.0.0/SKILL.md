---
name: cp-app-theme-system
description: 维护并扩展此仓库中的 CP Flutter 主题系统。当 Codex 需要新增或重命名主题 token、添加或更新主题方案、使主题字段与仓库根目录中的本地 Figma HTML 视觉规范保持一致、更新 `CPAppThemeController` 或 `CPAppThemeText`、调整主题工作台演示页，或修复与主题相关的测试和集成代码时使用。
---

# CP 应用主题系统

维护这个 Flutter 项目所使用的自定义 CP 主题层。
优先修改 CP 主题抽象层，而不是引入零散的颜色、尺寸，或直接使用 Material `TextTheme`。

## 项目结构

- `lib/theme/cp_app_theme.dart`
  - 负责 `CPAppThemeController`、`CPAppThemeRegistry`、`CPAppThemeData`、`CPAppThemeText`、`CPAppThemeScope` 以及 `BuildContext` 扩展。
  - 运行时访问应统一通过 `context.cpAppTheme`、`context.cpAppColor`、`context.cpAppSize`、`context.cpAppOther` 和 `context.cpAppText`。
- `lib/theme/theme_tokens.dart`
  - 负责共享 token 模型：`CPAppThemeScheme`、`CPAppThemeSchemeConfig`、`CPAppThemeColor`、`CPAppThemeSize`、`CPAppThemeOther`。
  - 这里放共享的 token 结构，不放某个具体方案的取值。
- `lib/theme/schemes/*.dart`
  - 每个文件存放一个完整的主题方案。
  - 每个方案都必须提供浅色和深色的 `CPAppThemeColor`、一个 `CPAppThemeSize`，以及浅色和深色的 `CPAppThemeOther`。
  - 方案文件应保持自包含，这样后续新增主题时只需要增加一个新文件并接入注册表。
- `lib/theme/theme_workbench_page.dart`
  - 作为 token 使用、方案切换和示例组件的实时演示页与回归验证页面。
- `lib/main.dart`
  - 将 `CPAppThemeController` 接入应用，并提供 `CPAppThemeData.light/dark`。
- `test/widget_test.dart`
  - 至少保留一个覆盖主题模式和主题方案切换的冒烟测试。
- 仓库根目录中的本地 Figma HTML 视觉规范文件
  - 将其视为命名、token 含义、颜色、间距、圆角和组件意图的唯一事实来源。

## 工作规则

- 保持 CP 命名一致。在类、枚举、文件和公开 API 中使用 `CP` 前缀。
- 所有主题访问都应保留在自定义主题层中。不要重新引入对系统 `TextTheme` 的直接依赖来处理业务文本样式。
- 当方案切换时，必须切换整套配置：
  - `color`
  - `size`
  - `other`
  - 派生出的 `text`
- 每个新方案都单独放在 `lib/theme/schemes/` 下的一个文件中。
- 添加方案时，更新 `lib/theme/cp_app_theme.dart` 中的注册表。
- 在可能的情况下遵循视觉规范中的命名。避免为了方便而给同一个 token 起多个重复含义的别名。
- 编辑 token 定义时，注释和字段说明要与视觉规范保持一致。

## 常见任务

### 添加新的主题方案

1. 创建 `lib/theme/schemes/<scheme_name>_theme_scheme.dart`。
2. 定义一个 `const CPAppThemeSchemeConfig`。
3. 填写以下内容：
   - `scheme`
   - `label`
   - `lightColor`
   - `darkColor`
   - `size`
   - `lightOther`
   - `darkOther`
4. 在 `CPAppThemeRegistry` 中注册新方案。
5. 如果用户需要在演示页中切换到该方案，则在 `theme_workbench_page.dart` 中暴露该方案。
6. 如果可见标签或切换行为发生变化，更新测试。

### 添加或重命名 token

1. 更新 `lib/theme/theme_tokens.dart` 中的 token 模型。
2. 更新所有方案文件，确保所有配置依然完整。
3. 如果新 token 会影响派生样式或组件主题，在 `lib/theme/cp_app_theme.dart` 中更新 `CPAppThemeText` 或 `CPAppThemeData`。
4. 更新 `lib/theme/theme_workbench_page.dart` 中的演示使用方式。
5. 如果可见文本或行为发生变化，更新测试。

### 对齐视觉规范

1. 先阅读仓库根目录中的本地 Figma HTML 视觉规范。
2. 只要能自然映射到代码，就使用规范中的术语作为字段名。
3. 如果规范中有定义，不仅要编码颜色，还要编码间距、圆角、排版、阴影、动效和组件尺寸。
4. 当规范对含义描述清晰时，为 token 字段添加简洁的中文注释。

### 更新运行时主题行为

将 `CPAppThemeController` 作为以下内容的唯一入口：
- `themeMode`
- `themeScheme`
- 解析当前激活的 `schemeConfig`
- 暴露 `color`、`size`、`other` 和 `text`

如果行为发生变化，保持 `CPAppThemeData.light()` 和 `CPAppThemeData.dark()` 与控制器驱动的方案选择逻辑同步。

## 实现说明

- 优先使用 token 驱动组件样式，而不是写内联值。
- 保持工作台组件通过 `context.cpAppColor`、`context.cpAppSize`、`context.cpAppOther` 和 `context.cpAppText` 读取主题。
- 如果演示组件需要阴影或尺寸，应从 token 中读取，而不是硬编码。
- 保持以下层次分离：
  - token 定义
  - 方案数据
  - 控制器 / 运行时解析
  - 演示层

## 验证

完成主题修改后，运行：

```powershell
dart format lib/theme lib/main.dart test/widget_test.dart skills/cp-app-theme-system
flutter analyze
flutter test
```

如果重命名影响了生成路径，或分析器状态陈旧，也请运行：

```powershell
flutter clean
flutter pub get
```

## cp_app_theme_usage

- 使用说明文档，覆盖 `CPAppTheme` 初始化、`Scope` 包裹、token 读取、主题模式切换和主题方案切换


