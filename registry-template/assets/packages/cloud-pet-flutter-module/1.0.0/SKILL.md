---
name: cloud-pet-flutter-module
description: 在处理 CloudPet Flutter 模块时使用，尤其适用于 OpenHarmony 兼容的 Flutter 改动、本地插件/路径依赖、生成的编解码或资源文件、设备功能页面，以及项目特定的验证步骤。
---

# CloudPet Flutter 模块

当任务涉及此仓库的应用结构、生成文件，或 OpenHarmony 适配的依赖配置时，请使用此 skill。

## 快速地图

- `pubspec.yaml`：依赖配置的唯一事实来源。该项目混合使用了托管包、本地 `path:` 包，以及面向 OHOS 的 `git:` 依赖。
- `lib/view/`：按设备或业务领域划分的功能页面。
- `lib/codec/`：设备/数据点编解码器。一些文件是生成的，包括 `codec_factory.g.dart`。
- `lib/generated/`：生成产物。除非任务明确要求修改，否则应视为生成文件。
- `lib/l10n/`：本地化 ARB 文件。
- `plugins/` 和 `pub_dep/`：该模块使用的本地 vendored 依赖。
- 根目录下的 `generate_*.py`：项目生成脚本，用于生成 codec、settings、UI 版本、资源及相关注册表。

## 工作规则

1. 修改代码前先阅读附近的功能目录。这个仓库包含许多设备专属流程以及名称相似的页面。
2. 优先更新源输入和对应生成器，而不是手动修改生成产物。
3. 修改依赖前，先检查当前包是否被有意固定到某个 OHOS 分支、本地路径或 vendored 插件。
4. 注意跨平台行为。这个模块看起来同时支持 Flutter module 嵌入以及 Harmony/OHOS 适配。
5. 除非任务明确要求，否则避免大范围重构。该仓库规模较大，并且按功能高度分段。

## 常见工作流

### UI 或功能改动

1. 检查 `lib/view/`、`lib/widgets/`、`lib/services/` 和 `lib/utils/` 下对应的目录。
2. 如果涉及导航，检查 `lib/config/routes.dart`、`lib/config/app_navigator.dart` 及相关常量中的路由或入口绑定。
3. 如果新增资源或文案，按需更新 `pubspec.yaml` 或 `lib/l10n/*.arb`。

### Codec 或设备能力改动

1. 检查 `lib/codec/`、`lib/enum/dp/`、`lib/device/`，以及仓库根目录中对应的生成脚本。
2. 如果任务影响到像 `codec_factory.g.dart` 这样的生成注册表，尽量通过项目脚本重新生成。
3. 命名应与现有 codec 文件及设备专属约定保持一致。

### 依赖或平台改动

1. 升级任何依赖前，先仔细检查 `pubspec.yaml` 中的 `path:` 和 OHOS `git:` 覆盖配置。
2. 检查同一个包是否也存在于 `plugins/` 或 `pub_dep/` 下。
3. 优先遵循仓库现有的依赖管理方式，不要用上游版本替换本地包，除非任务明确要求。

## 验证

针对任务选择最小但有效的验证方式：

- Dart 或 widget 改动使用 `flutter analyze`。
- 相关时运行 `test/` 下的定向测试。
- 修改生成源或其输入时，重新运行生成器。

如果某条命令因为依赖缺失或网络不可用而失败，请清楚说明，并总结本地仍然完成了哪些验证。
