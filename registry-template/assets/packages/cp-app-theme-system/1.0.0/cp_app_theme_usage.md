# CPAppTheme 使用方式

## 文件位置

- `lib/theme/cp_app_theme.dart`

## 这个文件负责什么

`cp_app_theme.dart` 是当前项目主题系统的统一入口，主要负责：

- 注册主题方案
- 管理主题模式和主题方案切换
- 向组件树下发主题控制器
- 生成 `ThemeData`
- 提供 `BuildContext` 的主题快捷访问能力
- 提供文本样式 token

如果业务页面、组件或工作台要读取颜色、字号、圆角、阴影、间距、动效等主题能力，优先从这里取，不要在业务层再单独维护一套主题状态。

## 主要类型

### `CPAppThemeRegistry`

`CPAppThemeRegistry` 负责“根据主题方案枚举，找到对应的完整配置”。

当前内置方案：

- `CPAppThemeScheme.orange`
  - 橙色主题方案
- `CPAppThemeScheme.testBlue`
  - 测试蓝色主题方案

常用方法：

- `resolve(CPAppThemeScheme scheme)`
  - 根据传入的主题方案，返回对应的 `CPAppThemeSchemeConfig`
  - 适合在需要拿到整套方案配置时使用

### `CPAppThemeController`

`CPAppThemeController` 是主题系统的核心控制器，负责保存当前主题状态，并在状态变化时通知界面刷新。

它内部管理这几类状态：

- `themeMode`
  - 当前主题模式
  - 取值通常是 `ThemeMode.light`、`ThemeMode.dark`、`ThemeMode.system`
- `themeScheme`
  - 当前使用的主题方案
  - 用来决定是橙色方案还是蓝色方案
- `platformBrightness`
  - 当前系统亮度
  - 只有在 `ThemeMode.system` 下才会参与最终亮暗判断

它还会暴露已经解析好的 token：

- `color`
  - 当前生效的颜色 token 集合
- `size`
  - 当前生效的尺寸 token 集合
- `other`
  - 当前生效的其他 token 集合，例如阴影、动效、字体回退等
- `text`
  - 基于 `color / size / other` 组合生成的文本样式 token

常用属性：

- `themeMode`
  - 读取当前设置的主题模式
  - 适合做主题模式切换控件的选中态显示
- `themeScheme`
  - 读取当前设置的主题方案
  - 适合做方案切换器的选中态显示
- `platformBrightness`
  - 读取当前系统亮度
  - 一般用于调试或系统跟随逻辑判断
- `followsSystem`
  - 判断当前是否处于 `ThemeMode.system`
  - 适合在界面中区分“手动亮暗模式”与“跟随系统”
- `effectiveBrightness`
  - 读取当前真正生效的亮度
  - 如果 `themeMode` 是 `system`，这里会结合 `platformBrightness` 计算
- `isDark`
  - 判断当前实际是否为深色主题
  - 适合在业务组件中快速写亮暗分支
- `schemeConfig`
  - 返回当前方案对应的完整配置对象
  - 适合需要直接访问方案级配置时使用
- `themeSchemeLabel`
  - 返回当前主题方案的展示名称
  - 适合直接显示在 UI 上
- `color`
  - 返回当前生效的颜色 token
  - 组件取色时最常用
- `size`
  - 返回当前生效的尺寸 token
  - 组件读取圆角、间距、尺寸时最常用
- `other`
  - 返回当前生效的其他 token
  - 适合读取阴影、动画时长、字体回退、输入框 padding 等
- `text`
  - 返回当前生效的文本样式 token
  - 适合统一使用标题、正文、按钮文字样式

常用方法：

- `updateThemeMode(ThemeMode mode)`
  - 更新主题模式
  - 例如切换到亮色、暗色或跟随系统
- `updateThemeScheme(CPAppThemeScheme scheme)`
  - 更新主题方案
  - 例如从橙色方案切换到蓝色方案
- `syncPlatformBrightness(Brightness brightness)`
  - 同步系统亮度
  - 当主题模式是 `ThemeMode.system` 时，它会影响最终亮暗主题
  - 一般在应用入口或监听系统亮度变化时调用

### `CPAppThemeScope`

`CPAppThemeScope` 是一个 `InheritedNotifier`，负责把 `CPAppThemeController` 放进组件树中，让子组件都能访问它。

常用方法：

- `of(BuildContext context)`
  - 从当前上下文中读取 `CPAppThemeController`
  - 如果组件树里没有包裹 `CPAppThemeScope`，会直接报错

适用场景：

- 在应用根部包裹整个 `MaterialApp`
- 在页面、组件和子组件中统一读取主题控制器

### `CPAppThemeData`

`CPAppThemeData` 负责把 CP 主题 token 转换成 Flutter 原生的 `ThemeData`。

常用方法：

- `light([CPAppThemeScheme scheme = CPAppThemeScheme.orange])`
  - 根据指定方案生成浅色主题的 `ThemeData`
  - 一般给 `MaterialApp.theme` 使用
- `dark([CPAppThemeScheme scheme = CPAppThemeScheme.orange])`
  - 根据指定方案生成深色主题的 `ThemeData`
  - 一般给 `MaterialApp.darkTheme` 使用

适用场景：

- 配置应用级 `MaterialApp`
- 给某个独立模块临时构建一套主题数据

### `CPAppThemeText`

`CPAppThemeText` 是文本样式 token 封装，用统一方式根据颜色、尺寸和其他 token 生成文本样式。

常用文本样式：

- `h1`
  - 一级标题样式
  - 适合页面主标题
- `h2`
  - 二级标题样式
  - 适合模块标题、卡片标题
- `h3`
  - 三级标题样式
  - 适合小标题、列表卡片标题
- `body`
  - 标准正文样式
  - 适合普通正文内容
- `bodyMid`
  - 中号正文样式
  - 适合需要比 `bodySmall` 更明显、又不想用标题的文本
- `bodySmall`
  - 小号正文样式
  - 适合说明、提示、副标题
- `auxiliary`
  - 辅助信息样式
  - 适合标签、次级信息
- `micro`
  - 更小的辅助文本样式
  - 适合极弱提示或元信息
- `button({Color? fontColor})`
  - 按钮文字样式
  - `fontColor` 不传时会使用默认按钮前景色

### `CPContextX`

`CPContextX` 是 `BuildContext` 扩展，用来减少手动写 `CPAppThemeScope.of(context)` 的次数。

可直接读取：

- `context.cpAppTheme`
  - 返回当前的 `CPAppThemeController`
  - 适合切换主题模式、切换主题方案、判断当前是否深色
- `context.cpAppColor`
  - 返回当前颜色 token
  - 适合组件直接读取颜色
- `context.cpAppSize`
  - 返回当前尺寸 token
  - 适合读取圆角、间距、按钮尺寸、页面 padding
- `context.cpAppOther`
  - 返回当前其他 token
  - 适合读取阴影、时长、曲线、字体回退等
- `context.cpAppText`
  - 返回当前文本样式 token
  - 适合统一使用标题、正文、按钮文字样式

## 最基础接入方式

项目入口推荐这样接：

```dart
class MyApp extends StatefulWidget {
  const MyApp({super.key});

  @override
  State<MyApp> createState() => _MyAppState();
}

class _MyAppState extends State<MyApp> {
  late final CPAppThemeController _themeController;

  @override
  void initState() {
    super.initState();
    _themeController = CPAppThemeController();
  }

  @override
  void dispose() {
    _themeController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    _themeController.syncPlatformBrightness(
      WidgetsBinding.instance.platformDispatcher.platformBrightness,
    );

    return CPAppThemeScope(
      controller: _themeController,
      child: AnimatedBuilder(
        animation: _themeController,
        builder: (context, _) {
          return MaterialApp(
            theme: CPAppThemeData.light(_themeController.themeScheme),
            darkTheme: CPAppThemeData.dark(_themeController.themeScheme),
            themeMode: _themeController.themeMode,
            home: const ThemeWorkbenchPage(),
          );
        },
      ),
    );
  }
}
```

这个接法里每一部分的作用是：

- `CPAppThemeController()`
  - 创建整套主题状态控制器
- `syncPlatformBrightness(...)`
  - 把系统亮度同步进控制器
- `CPAppThemeScope`
  - 把控制器下发到整个组件树
- `AnimatedBuilder(animation: _themeController, ...)`
  - 当主题模式或主题方案变化时，让 `MaterialApp` 自动重建
- `CPAppThemeData.light(...)`
  - 生成浅色主题数据
- `CPAppThemeData.dark(...)`
  - 生成深色主题数据
- `themeMode: _themeController.themeMode`
  - 告诉 `MaterialApp` 当前应该使用哪种模式

## 页面里如何读取主题

在页面或组件中，优先通过 `BuildContext` 扩展取值：

```dart
@override
Widget build(BuildContext context) {
  final theme = context.cpAppTheme;
  final color = context.cpAppColor;
  final size = context.cpAppSize;
  final other = context.cpAppOther;
  final text = context.cpAppText;

  return Container(
    padding: EdgeInsets.all(size.cardPadding),
    decoration: BoxDecoration(
      color: color.surface,
      borderRadius: BorderRadius.circular(size.radiusLarge),
      boxShadow: other.shadowS.toBoxShadow(),
    ),
    child: Text(
      'Theme Demo',
      style: text.h2.copyWith(color: color.textPrimary),
    ),
  );
}
```

推荐做法：

- `context.cpAppTheme`
  - 当你需要“读主题状态”或“切换主题”时使用
- `context.cpAppColor`
  - 当你需要颜色值时使用
- `context.cpAppSize`
  - 当你需要圆角、间距、宽高、字号等尺寸值时使用
- `context.cpAppOther`
  - 当你需要阴影、动效时长、字体回退、输入控件 padding 等其他 token 时使用
- `context.cpAppText`
  - 当你需要直接拿项目统一文本样式时使用

## 切换亮暗模式

```dart
final theme = context.cpAppTheme;

theme.updateThemeMode(ThemeMode.light);
theme.updateThemeMode(ThemeMode.dark);
theme.updateThemeMode(ThemeMode.system);
```

相关属性的用途：

- `theme.themeMode`
  - 当前设置的是亮色、暗色还是跟随系统
- `theme.followsSystem`
  - 当前是否在跟随系统
- `theme.effectiveBrightness`
  - 当前真正生效的亮度结果
- `theme.isDark`
  - 当前 UI 是否处于深色主题

推荐理解方式：

- 需要显示“用户当前选择了什么模式”，看 `themeMode`
- 需要判断“当前界面到底是亮还是暗”，看 `effectiveBrightness` 或 `isDark`

## 切换主题方案

```dart
final theme = context.cpAppTheme;

theme.updateThemeScheme(CPAppThemeScheme.orange);
theme.updateThemeScheme(CPAppThemeScheme.testBlue);
```

切换后会一起变化的内容：

- `context.cpAppColor`
  - 颜色 token 会切到新方案
- `context.cpAppSize`
  - 尺寸 token 会切到新方案
- `context.cpAppOther`
  - 其他 token 会切到新方案
- `context.cpAppText`
  - 文本样式 token 会跟着新方案重新生成
- `MaterialApp.theme`
  - 浅色主题数据会跟着新方案变化
- `MaterialApp.darkTheme`
  - 深色主题数据会跟着新方案变化

如果页面上有方案切换器，一般就是调用 `updateThemeScheme(...)`。

## 跟随系统亮度

如果 `themeMode` 是 `ThemeMode.system`，需要同步系统亮度：

```dart
_themeController.syncPlatformBrightness(
  WidgetsBinding.instance.platformDispatcher.platformBrightness,
);
```

这个方法的作用是：

- 把系统当前亮度同步到主题控制器中
- 让 `effectiveBrightness` 的结果保持正确
- 让跟随系统模式下的界面在亮暗切换时及时刷新

当前项目是在 `MyApp.build` 里同步的。

如果后续接入系统亮度监听，也应该继续调用这个方法，而不是直接改内部字段。

## 使用文本样式 token

```dart
final text = context.cpAppText;
final color = context.cpAppColor;

Column(
  crossAxisAlignment: CrossAxisAlignment.start,
  children: [
    Text('Title', style: text.h1),
    Text('Section', style: text.h2),
    Text('Body', style: text.body),
    Text(
      'Button Text',
      style: text.button(fontColor: color.textInverse),
    ),
  ],
)
```

推荐使用方式：

- `text.h1 / text.h2 / text.h3`
  - 用于标题层级
- `text.body / text.bodyMid / text.bodySmall`
  - 用于正文层级
- `text.auxiliary / text.micro`
  - 用于弱提示、辅助信息、元信息
- `text.button(...)`
  - 用于按钮文本
  - 当按钮前景色特殊时，可以显式传 `fontColor`

## 什么时候直接用 `ThemeData`

`CPAppThemeData.light()` 和 `CPAppThemeData.dark()` 主要用于：

- `MaterialApp.theme`
  - 配置应用级浅色主题
- `MaterialApp.darkTheme`
  - 配置应用级深色主题
- 独立模块需要单独生成一份主题数据时
  - 例如做演示页、嵌入式模块或隔离环境

示例：

```dart
MaterialApp(
  theme: CPAppThemeData.light(CPAppThemeScheme.orange),
  darkTheme: CPAppThemeData.dark(CPAppThemeScheme.orange),
  themeMode: ThemeMode.system,
)
```

日常业务组件内部不要频繁自己构建 `ThemeData`，优先读：

- `context.cpAppTheme`
- `context.cpAppColor`
- `context.cpAppSize`
- `context.cpAppOther`
- `context.cpAppText`

## 新增主题方案时要改哪些地方

如果后面要继续扩展主题方案，通常按这个顺序：

1. 在 `theme_tokens.dart` 的 `CPAppThemeScheme` 中新增枚举值
   - 作用：让系统知道又多了一种可切换方案
2. 在 `lib/theme/schemes/` 下新增对应的 scheme 文件
   - 作用：提供这套方案完整的颜色、尺寸和其他 token
3. 在 `CPAppThemeRegistry._configs` 中注册新方案
   - 作用：让控制器能根据枚举找到这套配置
4. 确认 `CPAppThemeData.light()` / `dark()` 能正常读取
   - 作用：保证 Flutter 原生 `ThemeData` 也能切到新方案
5. 在业务切换入口或工作台页面补上切换项
   - 作用：让用户或开发者能真正切换到新方案

## 使用约束

- 不要在业务层硬编码一套新的颜色和尺寸体系
- 不要绕开 `CPAppThemeController` 自己维护另一份亮暗模式状态
- 不要在组件里直接判断固定方案名来写死样式
- 优先面向 token 编码，而不是面向某个具体颜色值编码

## 与组件系统的关系

`CPThemeButton` 等 CP 组件默认就是基于这套主题 token 工作的。

如果后续新增：

- `CPInput`
- `CPCard`
- `CPTag`
- `CPDialog`

这些组件也应该优先依赖：

- `context.cpAppColor`
  - 用来读取颜色
- `context.cpAppSize`
  - 用来读取尺寸
- `context.cpAppOther`
  - 用来读取阴影、时长等其他 token
- `context.cpAppText`
  - 用来读取统一文本样式

而不是各自维护独立的主题逻辑。
