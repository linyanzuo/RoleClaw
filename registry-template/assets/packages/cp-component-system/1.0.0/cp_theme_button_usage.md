# CPThemeButton 使用方式

## 文件位置

- `lib/theme/widgets/cp_theme_button.dart`

## 基本规则

- `CPThemeButton` 是自定义按钮组件，视觉实现不依赖系统按钮组件
- `label` 和 `child` 至少传一个
- 如果不传样式覆盖，组件会回退到 CP 主题 token 的默认值
- `disabled: true` 会强制按钮显示为禁用状态

## 最基础用法

```dart
CPThemeButton(
  label: 'Add Device',
  onPressed: () {},
)
```

## 视觉变体

当前支持四种变体：

- `CPThemeButtonVariant.primary`
  - 主按钮，适合主要操作
- `CPThemeButtonVariant.secondary`
  - 次按钮，适合次级操作
- `CPThemeButtonVariant.cancel`
  - 取消类按钮，适合关闭、返回、放弃类操作
- `CPThemeButtonVariant.danger`
  - 危险按钮，适合删除、移除、清空类操作

```dart
CPThemeButton(
  label: 'Delete Device',
  variant: CPThemeButtonVariant.danger,
  onPressed: () {},
)
```

## 禁用状态

只显示禁用视觉，不处理点击：

```dart
CPThemeButton(
  label: 'Submit',
  disabled: true,
)
```

保持禁用外观，但点击后仍处理逻辑：

```dart
CPThemeButton(
  label: 'Submit',
  disabled: true,
  onDisabledTap: () {
    debugPrint('当前不可用');
  },
)
```

兼容旧逻辑：

如果不传 `disabled`，但 `onPressed` 为 `null`，按钮仍会显示为禁用态。

```dart
CPThemeButton(
  label: 'Submit',
  onDisabledTap: () {},
)
```

## 按压反馈控制

`CPThemeButton` 把缩放和内阴影拆成了启用态和禁用态两套开关。

默认行为：

- 启用态：
  - 缩放开启
  - 内阴影开启
- 禁用态：
  - 缩放默认关闭
  - 内阴影默认开启

相关属性：

- `pressScale`
  - 控制按下时的缩放比例
- `enablePressedScale`
  - 控制启用态是否启用按压缩放
- `enableDisabledPressedScale`
  - 控制禁用态是否启用按压缩放
- `enablePressedInnerShadow`
  - 控制启用态是否显示按压内阴影
- `enableDisabledPressedInnerShadow`
  - 控制禁用态是否显示按压内阴影

```dart
CPThemeButton(
  label: 'Disabled Button',
  disabled: true,
  enableDisabledPressedScale: true,
  enableDisabledPressedInnerShadow: true,
)
```

## 文本布局模式

当使用 `label` 模式时，可以同时传入：

- `leading`
- `trailing`
- `textLayoutMode`

支持三种布局模式：

- `CPThemeButtonTextLayoutMode.groupCentered`
  - 整组内容一起居中
- `CPThemeButtonTextLayoutMode.labelCentered`
  - 文本保持在按钮视觉中心，内容区域占满可用宽度
- `CPThemeButtonTextLayoutMode.labelCenteredCompact`
  - 文本保持在按钮视觉中心，但整体按内容宽度收缩

```dart
CPThemeButton(
  label: 'Delete',
  leading: const Icon(Icons.pets),
  trailing: const Icon(Icons.chevron_right),
  textLayoutMode: CPThemeButtonTextLayoutMode.labelCenteredCompact,
  onPressed: () {},
)
```

## 多行文本

`maxLines` 支持动态传入，默认值是 `1`。

```dart
CPThemeButton(
  label: 'This is a button label that may wrap',
  maxLines: 2,
  onPressed: () {},
)
```

适用场景：

- 按钮文案较长
- 移动端窄屏下可能换行
- 中英文混排按钮文案

## 自定义内容

按钮内部不一定必须是文字，也可以直接传任意 `child`。

```dart
CPThemeButton(
  onPressed: () {},
  semanticLabel: 'Custom Child Button',
  child: const Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      Icon(Icons.pets),
      SizedBox(width: 8),
      Text('Pet Action'),
    ],
  ),
)
```

适合用 `child` 的场景：

- 图标和文字组合
- 富文本
- 加载中状态
- 任意自定义布局

## 自定义尺寸和内边距

```dart
CPThemeButton(
  label: 'Custom Size',
  width: 240,
  height: 52,
  padding: const EdgeInsets.symmetric(horizontal: 20),
  onPressed: () {},
)
```

相关属性作用：

- `width`
  - 自定义按钮宽度
- `height`
  - 自定义按钮高度
- `padding`
  - 自定义按钮内部内容的内边距

## 样式覆盖

可以通过 `styleOverrides` 覆盖默认样式，不传时会继续使用规范默认值。

常见可覆盖项包括：

- 文本样式
- 文本颜色
- 图标颜色
- 背景色
- 边框
- 外阴影
- 内阴影
- 圆角

```dart
CPThemeButton(
  label: 'Custom Button',
  onPressed: () {},
  styleOverrides: const CPThemeButtonStyleOverrides(
    backgroundColor: Colors.black,
    foregroundColor: Colors.white,
    borderRadius: 18,
    border: Border.fromBorderSide(
      BorderSide(color: Colors.green, width: 3),
    ),
    textStyle: TextStyle(
      fontSize: 20,
      fontWeight: FontWeight.w700,
    ),
  ),
)
```

## 按状态覆盖文本颜色和文本样式

可以针对不同状态单独传文本颜色和文本样式：

- `foregroundColor`
  - 默认前景色
- `hoverForegroundColor`
  - 悬停或聚焦时的前景色
- `pressedForegroundColor`
  - 按下时的前景色
- `disabledForegroundColor`
  - 禁用时的前景色
- `textStyle`
  - 默认文本样式
- `hoverTextStyle`
  - 悬停或聚焦时的文本样式
- `pressedTextStyle`
  - 按下时的文本样式
- `disabledTextStyle`
  - 禁用时的文本样式

```dart
CPThemeButton(
  label: 'Submit',
  onPressed: () {},
  styleOverrides: const CPThemeButtonStyleOverrides(
    foregroundColor: Colors.white,
    pressedForegroundColor: Colors.yellow,
    disabledForegroundColor: Colors.white70,
    textStyle: TextStyle(
      fontSize: 16,
      fontWeight: FontWeight.w600,
    ),
    pressedTextStyle: TextStyle(
      fontSize: 16,
      fontWeight: FontWeight.w700,
    ),
  ),
)
```

## 按状态覆盖图标颜色

图标颜色也支持按状态覆盖：

- `iconColor`
  - 默认图标颜色
- `hoverIconColor`
  - 悬停时图标颜色
- `pressedIconColor`
  - 按下时图标颜色
- `disabledIconColor`
  - 禁用时图标颜色

## 后续扩展建议

如果后面继续扩展 `CPThemeButton`，建议优先保持这些方向一致：

- 继续由 token 驱动视觉样式
- 继续把视觉状态和交互状态拆开处理
- 继续使用可选覆盖属性，而不是要求调用方重配整套样式
- 继续为新布局和新状态补 widget test
