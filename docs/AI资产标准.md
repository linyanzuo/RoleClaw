# AI 资产标准 v1

> 版本：v1 草案　最后更新：2026-11-19
> 上位文档：[AI资产演进规划.md](AI资产演进规划.md)
> 下位文档：规范正文的写法见 [aicm/spec-standard.md](../aicm/spec-standard.md)，本标准不重复其内容。

本标准是 aimm、aicm、aipm 三个工具之间的唯一契约。三个工具只通过符合本标准的文件对接，不互相调用代码。

---

## 一、适用对象

| 对象 | `asset` 值 | 单位 | AI 的加载方式 |
|---|---|---|---|
| 原始记忆 | `memory` | 单个文件 | 由 aimm 同步给各工具，索引常驻、正文按需 |
| 规范 | `rule` | 一个规范目录 | 高频块常驻注入 |
| 技能 | `skill` | 一个技能目录 | 按 `description` 触发 |
| 文档 | `doc` | 一个文档集目录 | 先读索引，再按需读正文 |

原始记忆不是资产，是资产的原料；规范、技能、文档统称 AI 资产。

归类判据：每次任务都要遵守的进规范；某类任务才用到的操作流程进技能；背景知识、业务说明等大体量内容进文档。规范必须保持精简，放不下的内容一律进文档。

---

## 二、元数据

### 1. 格式

每个对象有一个**主文件**，主文件以 frontmatter 开头：

```markdown
---
name: git-commit-rule
description: Git 提交信息格式与分支命名约定，适用于所有代码仓库
metadata:
  asset: rule
  status: curated
  scope: personal
  visibility: local-only
  update: 2026-11-19
  source: claude
---
```

格式限制（三个工具都用简单解析器，不依赖完整 YAML）：

- 顶层只允许标量字段；扩展字段全部放在 `metadata` 下，且只有一层。
- 值写在同一行，不用多行文本、列表或嵌套。
- `metadata` 下的未知字段必须原样保留，不得删除。

把扩展字段放进 `metadata` 是为了兼容：技能主文件遵循 Agent Skills 标准，Claude 的记忆文件也使用 `metadata`，两者都能直接容纳这些字段。

### 2. 字段

| 字段 | 位置 | 必填 | 取值 | 默认 |
|---|---|---|---|---|
| `name` | 顶层 | 是 | 小写字母、数字、连字符；与目录名或文件名一致 | 无 |
| `description` | 顶层 | 是 | 一句话，说明内容和适用场景 | 无 |
| `asset` | metadata | 资产必填 | `memory` / `rule` / `skill` / `doc` | `memory/` 目录下默认 `memory` |
| `status` | metadata | 否 | `raw` / `curated` / `deprecated` | 记忆为 `raw`，资产为 `curated` |
| `scope` | metadata | 否 | `personal` / `role:<角色ID>` / `team` | `personal` |
| `visibility` | metadata | 否 | `local-only` / `shareable` | `local-only` |
| `update` | metadata | 否 | `YYYY-MM-DD` | 无 |
| `expires` | metadata | 否 | `YYYY-MM-DD`，到期后校验给出提醒 | 无 |
| `source` | metadata | 否 | 写入它的工具，如 `claude`、`codex`、`manual` | 无 |
| `type` | metadata | 仅记忆 | `user` / `feedback` / `project` / `reference` | 无 |
| `promoted` | metadata | 仅记忆 | 由它提炼出的资产 `name` | 无 |

说明：

- 默认值的作用是让 Claude 原生写出的记忆文件不加任何字段也合规。
- `asset` 表示对象类别，`type` 只表示记忆的分类，两者不混用。
- **版本号不写在 frontmatter 里。** 版本只存在于 aipm 的 `package.json` 和 Registry 中。
- **"已发布"不是 `status` 的取值。** 一个资产是否已发布，以 Registry 中是否存在它的版本为准，不在源文件里重复记录。

### 3. 旧格式兼容

现有规范文件使用顶层 `frontmatter:`（描述）和 `update:`（日期），aicm 靠 `frontmatter:` 字段识别规范文件。过渡期规则：

- 规范主文件**同时**写 `description` 和 `frontmatter`，内容相同，直到 aicm 支持按 `description` + `asset: rule` 识别。
- 顶层 `update` 与 `metadata.update` 同时存在时，以 `metadata.update` 为准。

---

## 三、各类对象的结构

### 1. 原始记忆

```
memory/
├── MEMORY.md            索引，每条记忆一行：- [标题](文件名) — 一句话
└── <name>.md            记忆文件，平铺存放，不分子目录
```

分类写在 `metadata.type` 里，不用目录表达：

| `type` | 内容 |
|---|---|
| `user` | 关于使用者：角色、偏好 |
| `feedback` | 对 AI 工作方式的纠正与认可 |
| `project` | 进行中的工作、目标、约束 |
| `reference` | 外部资源的指针 |

平铺是为了与 Claude 原生记忆目录的布局一致，使该目录可以直接链接到本仓库。

- 一个文件只记一件事。`feedback` 和 `project` 类正文要写明原因和适用方式。
- 记忆之间用 `[[name]]` 互相引用。
- `MEMORY.md` 只放索引，不放记忆正文。
- 记忆一律 `visibility: local-only`，不可发布；要共享必须先提炼为资产。

### 2. 规范

```
assets/rules/<name>/
└── <name>.md            主文件（也接受旧文件名 RULE.md）
```

- 正文写法、`inject:high` 标记、高频块不超过 10 条等要求，全部遵循 [spec-standard.md](../aicm/spec-standard.md)。
- 一个规范目录只有一个主文件；示例和补充说明写在主文件的非高频部分。

### 3. 技能

```
assets/skills/<name>/
├── SKILL.md             主文件
├── scripts/             可选，可执行脚本
├── references/          可选，按需读取的补充资料
└── assets/              可选，模板等静态文件
```

- 遵循 Agent Skills 标准；`description` 必须写清楚触发场景，因为工具靠它决定是否加载。
- 脚本不得内嵌凭据，凭据只能运行时从约定位置读取。

### 4. 文档集

```
assets/docs/<name>/
├── DOC.md               主文件：文档集的范围、读者、目录结构说明
├── INDEX.md             人读索引，工具生成
├── index.json           机器读索引，工具生成
└── <多层目录>/*.md       正文
```

规则：

- `INDEX.md` 和 `index.json` 由 aicm 生成，文件头注明"生成文件，勿手工编辑"，正文变更后重新生成。
- 正文文件可以带 frontmatter 的 `description` 作为摘要；没有时取第一个一级标题作标题，摘要留空。
- 正文之间只用文档集内的相对路径互相引用，不引用文档集以外的路径。
- 目录层级建议不超过 4 层；单个文件过长时拆分，而不是靠索引补救。
- AI 工具的入口文件里只写一行指向 `INDEX.md` 的指针，不注入正文。

`index.json` 结构：

```json
{
  "schema": 1,
  "name": "cloudpets-business",
  "generated": "2026-11-19",
  "entries": [
    {
      "path": "order/refund.md",
      "title": "退款流程",
      "summary": "退款的状态流转与各环节责任方",
      "update": "2026-11-10",
      "sha256": "…"
    }
  ]
}
```

`sha256` 用于判断索引是否过期：正文哈希与索引不一致即视为索引过期。

---

## 四、个人资产仓库布局

```
<个人资产仓库>/
├── aimm.json            仓库配置：standard（标准版本）、tools（启用的工具）、auto_commit（是否自动提交）
├── memory/              原始记忆
└── assets/
    ├── rules/
    ├── skills/
    └── docs/
```

约束（为以后拆分公开与私有数据留余地）：

1. `assets/` 下的任何内容不得引用 `memory/` 的路径。
2. 记忆提炼为资产时，关联关系只记在记忆一侧（`promoted` 字段），资产一侧不回指记忆。
3. 同一 `name` 在同一类别下唯一。

---

## 五、生命周期

```
            提炼（人确认）              发布（人确认）
  记忆 raw ─────────────▶ 资产 curated ─────────────▶ Registry 中的版本
                              │
                              └──▶ deprecated
```

| 动作 | 执行工具 | 前置条件 | 结果 |
|---|---|---|---|
| 记录 | aimm | 通过秘密扫描 | 在 `memory/` 新增文件并更新 `MEMORY.md` |
| 提炼 | aimm | 人确认草稿 | 在 `assets/` 新增资产；原记忆写入 `promoted` |
| 梳理 | aicm | 无 | 去重与分布报告、文档集索引；不改正文 |
| 发布 | aipm | `visibility: shareable`、校验通过、秘密扫描通过、人确认 | Registry 新增一个不可覆盖的版本 |
| 废弃 | aimm / aipm | 人确认 | `status: deprecated`；已发布版本按 aipm 的下架流程处理 |

原则：

- 提升是单向的。高层资产的变更不自动回写低层。
- `local-only` 改为 `shareable` 必须是显式的人工修改，工具不得自动改。
- 提炼是"新建资产"，不是"移动记忆"；原记忆保留。

---

## 六、安全

1. 任何对象都禁止包含密码、私钥、访问密钥、令牌等秘密正文；需要指代凭据时只写登记 ID 或读取位置。
2. 记录、提炼、发布三个动作执行前都必须做秘密扫描，命中即拒绝，且报错信息不得回显命中的内容。
3. 同步给外部 AI 工具的内容会被发送给对应的模型服务商；`memory/` 中不应记录不能外发的信息。
4. 文档集的正文同样受第 1 条约束，业务文档中的连接串、账号等一律改写为引用。

---

## 七、校验项

`aimm lint` 与 aicm 的校验使用同一组规则：

| 编号 | 级别 | 规则 |
|---|---|---|
| A01 | 错误 | 主文件缺少 frontmatter，或缺 `name` / `description` |
| A02 | 错误 | `name` 含非法字符、同类别下重名，或资产的 `name` 与目录名不一致（记忆的 `name` 与文件名不一致只报警告，因为工具原生写入的文件名不受控） |
| A03 | 错误 | 字段取值不在允许范围内 |
| A04 | 错误 | 命中秘密扫描 |
| A05 | 错误 | `assets/` 下的内容引用了 `memory/` 路径 |
| A06 | 错误 | 记忆被标为 `shareable` |
| A07 | 警告 | `MEMORY.md` 与 `memory/` 下的文件不一致（缺条目或悬空条目） |
| A08 | 警告 | 文档集索引缺失或过期 |
| A09 | 警告 | 已过 `expires` 日期 |
| A10 | 提示 | 记忆中的 `[[name]]` 指向尚不存在的记忆（允许先引用后补写） |
| A11 | 警告 | 规范的高频块超过 10 条 |
| A12 | 提示 | 同类别下存在内容高度相似的对象 |

错误级别阻止提炼和发布；警告和提示只报告。

---

## 八、三个工具的读写边界

| 位置 | aimm | aicm | aipm |
|---|---|---|---|
| `memory/` | 读写 | 只读 | 不访问 |
| `assets/rules`、`assets/skills` | 读写 | 只读 | 只读（发布时） |
| `assets/docs` 正文 | 读写 | 只读 | 只读（发布时） |
| `assets/docs` 索引 | 不写 | 生成 | 只读 |
| 各 AI 工具的记忆与入口文件 | 写（同步） | 写（注入块） | 不访问 |
| 各 AI 工具的技能、规范安装目录 | 不访问 | 只读 | 读写 |
| Registry | 不访问 | 不访问 | 读写 |

---

## 九、现有工具与本标准的差距

| 工具 | 需要的改动 | 所属阶段 |
|---|---|---|
| aimm | MVP 已实现（见 [aimm-guide.md](../aimm/aimm-guide.md)）；其余工具适配与 MCP 服务待做 | 阶段 1–2 |
| aicm | 支持按 `description` + `metadata.asset` 识别对象；读取 `metadata` 字段；实现第七节的校验项 | 阶段 1 |
| aicm | 为文档集生成 `INDEX.md` 与 `index.json` | 阶段 1 |
| aipm | 发布前检查 `visibility` 并做秘密扫描 | 阶段 1 |
| aipm | 新增 `doc` 包类型，以文档集为单位发布与安装 | 阶段 2 |

已核实的兼容情况：

- aicm 目前逐行查找顶层 `frontmatter:` 字段，新增的 `name`、`description`、`metadata` 不会影响它现有的识别。已实测：`aicm . --scan` 能识别 aimm 生成的规范文件，并跳过记忆文件。
- aipm 目前从技能和规范主文件的 frontmatter 读取 `name` 与 `description`，版本与完整性信息在 `package.json` 中，与本标准一致。
- aipm 的规范主文件名解析已支持 `RULE.md` 与 `<name>.md` 两种写法。

---

## 十、版本

- 本标准的版本记录在个人资产仓库 `aimm.json` 的标准版本字段中。
- 不兼容的变更升主版本，并在本节写明迁移方法。
