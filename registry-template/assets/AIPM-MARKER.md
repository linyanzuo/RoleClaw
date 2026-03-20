# .aipm 版本标记说明

本说明适用于 `assets/packages/` 下的 Skill 与 `assets/rules/` 下的 Rule。

## 概述

`.aipm` 是版本标记文件，用于版本感知的 install/update 逻辑。

- **Registry 中**：每个 Skill/Rule 版本目录必须包含 `.aipm`，并列入 `files.json`，作为该资源的配置声明
- **安装目录中**：`aipm install` 会复制或写入 `.aipm` 到 `.cursor/skills/<name>/`、`.cursor/rules/<name>/`

- **AI 工具不扫描此文件**，不影响 Skill/Rule 的识别与加载
- **不修改 SKILL.md / RULE.md**，保持 artifact 内容纯净

## 文件格式

- **路径**：`<install-dir>/<artifact-name>/.aipm`
- **格式**：JSON
- **Schema**：`../schemas/aipm-marker.schema.json`

### 配置约束

| 字段 | 类型 | 必填 | 约束 |
|------|------|------|------|
| `version` | string | 是 | 语义化版本 `x.y.z`，与 registry 中该 artifact 版本一致 |
| `installedAt` | string | 否 | ISO 8601 日期时间 |
| `source` | string | 否 | Registry 来源标识 |

### 示例

```json
{"version":"1.0.0"}
```

## 版本感知逻辑

`aipm install` 安装前会检查目标目录：

- **存在 `.aipm` 且版本相同** → 跳过
- **存在 `.aipm` 且目标版本更高** → 提示是否覆盖
- **存在 `.aipm` 且目标版本更低** → 跳过，不覆盖
- **无 `.aipm`** → 视为非 aipm 安装，提示是否覆盖

## 维护说明

- Registry 中每个 Skill/Rule 版本目录**必须包含** `.aipm` 文件，并列入 `files.json`
- 该文件仅存在于 IDE 安装目录，由 CLI 自动管理
- 如需扩展字段，请同步更新 `schemas/aipm-marker.schema.json`
