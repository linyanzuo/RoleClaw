# RoleClaw Skills Registry Template

RoleClaw 阶段一的私有 Skills 仓库模板。

这个模板用于解决 `Step 2` 的 6 件事：

1. 建立私有 Skills 仓库基础结构
2. 统一 Skill 存储方式
3. 定义岗位配置文件格式
4. 定义 Skill 元数据格式
5. 约定命名、版本、资源文件规则
6. 明确提交与审核约定

## 文件分层

阶段一先把仓库文件分成两类：

### 1. 运行时文件

这些文件可能被 IDE / AI 直接读取，要求尽量稳定、简洁、少放治理信息。

- `assets/packages/<skill>/<version>/SKILL.md`
- `assets/packages/<skill>/<version>/*.md`

运行时原则：

- `SKILL.md` 只保留 AI 直接需要的信息
- frontmatter 只保留 `name` 和 `description`
- 正文只写使用时机、操作规则、参考资源

### 2. 治理文件

这些文件用于安装、检索、岗位绑定、版本管理和仓库维护，不要求 AI 直接消费。

- `registry.json`
- `organization/roles/*.json`
- `organization/rbac/roles.json`
- `schemas/*.json`
- `templates/*`

治理原则：

- 版本、标签、检索信息放到 `registry.json`
- 岗位与 Skill/Rule 的绑定关系放到 `organization/roles/*.json` 和 `organization/rbac/roles.json`
- 模板和 schema 只服务仓库维护，不进入运行时 Skill 内容

## 目录结构

```text
registry-template/
├── README.md
├── registry.json                          # 全量 Skill/Rule 索引
├── assets/
│   ├── packages/                          # Skill 实际发布目录
│   │   └── <skill-name>/
│   │       └── <version>/
│   │           ├── files.json
│   │           ├── SKILL.md
│   │           └── *.md
│   └── rules/                             # Rule 实际发布目录
│       └── <rule-name>/
│           └── <version>/
│               ├── files.json
│               ├── RULE.md
│               └── *.md
├── organization/
│   ├── roles/
│   │   └── <role-id>.json                 # 岗位配置样例与正式配置
│   └── rbac/
│       └── roles.json                     # RBAC 兼容聚合配置
├── templates/
│   ├── role-template.json
│   └── skill-template/
│       └── 1.0.0/
│           ├── files.json
│           └── SKILL.md
└── schemas/
    ├── registry.schema.json
    └── role.schema.json
```

说明：

- `assets/` 是统一资产层目录，后续升级资源管理能力时保持路径稳定。
- `organization/roles/` 是岗位配置源文件目录，用来表达“岗位定义”。
- `organization/rbac/roles.json` 是 RBAC 兼容聚合文件。

## Skill / Rule 存储规则

每个 Skill 使用如下目录结构：

```text
assets/packages/<skill-name>/<version>/
├── files.json
├── SKILL.md
└── <resource-files>
```

字段规则：

- `files.json`：声明这个版本实际包含的文件列表，必须包含 `SKILL.md`
- `SKILL.md`：Skill 主文件，只保留 AI 直接需要的最小信息
- `<resource-files>`：可选资源文件，如规范文档、示例、提示词片段

`files.json` 示例：

```json
["SKILL.md", "git.md"]
```

每个 Rule 使用如下目录结构：

```text
assets/rules/<rule-name>/<version>/
├── files.json
├── RULE.md
└── <resource-files>
```

## 岗位配置文件格式

岗位配置文件放在 `organization/roles/` 目录，文件名使用 `<role-id>.json`。

示例：

```json
{
  "roleId": "frontend-engineer",
  "name": "前端工程师",
  "department": "software",
  "description": "软件研发岗位，负责 Web 前端需求实现、组件维护与协作交付。",
  "requiredSkills": ["git-workflow"],
  "optionalSkills": ["frontend-coding-standard"],
  "requiredRules": ["engineering-rules-baseline"],
  "optionalRules": [],
  "extends": [],
  "status": "active"
}
```

字段说明：

- `roleId`：岗位唯一标识，需与文件名一致
- `name`：岗位中文名称
- `department`：所属部门标识，阶段一统一为 `software`
- `description`：岗位职责简述
- `requiredSkills`：默认必备 Skills
- `optionalSkills`：可按团队情况启用的 Skills
- `requiredRules`：默认必备 Rules
- `optionalRules`：可按团队情况启用的 Rules
- `extends`：继承的上级岗位模板，阶段一可为空
- `status`：岗位状态，建议使用 `active` / `draft`

## Skill 元数据放置规则

阶段一不追求把所有信息都塞进一个文件，而是按用途拆开：

1. `SKILL.md`：只放给 AI 用的最小信息
2. `registry.json`：只放索引、检索、版本信息
3. `organization/roles/*.json` / `organization/rbac/roles.json`：只放岗位绑定关系（Skills + Rules）

`SKILL.md` frontmatter 规范：

```yaml
---
name: "git-workflow"
description: "Git 工作流规范：提交、分支、PR 与提交前检查。"
---
```

原则：

- `SKILL.md` 会被 IDE / AI 直接读取，字段越少越稳
- 不把版本、标签、岗位范围、维护人这类治理信息写进 `SKILL.md`
- `SKILL.md` 的正文重点放在使用时机、操作规则、参考资源

`registry.json` 索引规范：

```json
{
  "packages": {
    "git-workflow": {
      "latest": "1.0.0",
      "versions": ["1.0.0"],
      "description": "Git 工作流规范：提交信息、分支命名规范与提交前检查流程",
      "tags": ["git", "workflow", "commit"]
    }
  }
}
```

建议分工：

- `SKILL.md`：面向 AI 运行时消费，尽量简洁稳定
- `registry.json`：面向安装、搜索、版本解析、标签管理
- `organization/roles/*.json` / `organization/rbac/roles.json`：面向岗位与 Skill/Rule 的绑定关系

不建议写入 `SKILL.md` 的字段：

- `version`：已经由目录版本和 `registry.json` 表达
- `tags`：用于检索，应放在 `registry.json`
- `roleScope`：属于岗位绑定，应放在 `organization/roles/*.json` 或 `organization/rbac/roles.json`
- `owner`：属于治理信息，阶段一先不进入运行时文件

一句话原则：

- `SKILL.md` 是给 AI 看的
- `registry.json` 是给安装和检索逻辑看的
- `organization/roles/*.json` 是给岗位配置逻辑看的（技能与规则）

## 命名规则

### Skill 命名

- 使用小写英文加中划线：`git-workflow`
- 名称应直接表达用途，不带团队缩写或个人前缀
- 避免过宽泛名称，如 `best-practice`、`assistant-helper`

推荐模式：

- `domain-action`
- `role-topic`
- `tool-usage`

### 岗位命名

- 使用小写英文加中划线：`frontend-engineer`
- 阶段一统一采用岗位级命名，不引入层级编码

## 版本规则

- 使用语义化版本：`major.minor.patch`
- `major`：结构或使用方式不兼容
- `minor`：新增内容、规则扩展、兼容性增强
- `patch`：错别字修正、示例修正、非结构性调整

阶段一建议：

- 首版统一从 `1.0.0` 开始
- 未经审核不要直接覆盖旧版本目录
- 发布新版本时，必须同步更新 `registry.json`

## 资源文件规则

- 所有资源文件必须列入 `files.json`
- 资源文件名尽量语义化，如 `git.md`、`review-checklist.md`
- 一个 Skill 目录下不要混放无关资源
- 资源文件优先使用 Markdown、JSON、YAML 这类可审阅文本格式

## 提交与审核约定

阶段一先采用轻量流程：

1. 新建或修改 Skill 时，必须同时更新对应版本目录与 `registry.json`
2. 若变更岗位绑定关系，必须同步更新 `organization/roles/*.json` 和 `organization/rbac/roles.json`
3. 提交说明中必须写清楚变更原因，而不只是“更新 Skill”
4. 至少由 1 位岗位负责人或维护人完成审核
5. 未经验证的临时经验，不直接进入 `requiredSkills` / `requiredRules`

建议审核关注点：

- 这个 Skill 是否解决真实工作问题
- 规则是否足够具体，可直接被 AI 使用
- 是否与现有 Skill 重复
- 是否应该进入必备还是可选

## 发布新 Skill

1. 基于 `templates/skill-template/1.0.0/` 复制一个新目录
2. 补全 `SKILL.md` 和资源文件
3. 更新 `files.json`
4. 在 `registry.json` 中登记元数据
5. 如需要绑定岗位，更新 `organization/roles/*.json` 与 `organization/rbac/roles.json`

## 项目中接入

### 首次初始化

在项目根目录执行 `roleclaw init`，按提示选择 IDE 和岗位。若项目内无 `registry-template` 目录，需指定 Registry 路径：

```bash
# 方式一：环境变量
ROLECLAW_REGISTRY=/path/to/registry-template roleclaw init

# 方式二：命令行参数
roleclaw init --registry /path/to/registry-template
```

### 配置

在项目根目录的 `.roleclaw/config.json` 中配置：

```json
{
  "registry": "https://raw.githubusercontent.com/YOUR_ORG/cursor-skills-registry/main",
  "ide": "cursor",
  "role": "frontend-engineer",
  "rules": {
    "engineering-rules-baseline": "1.0.0"
  },
  "skills": {
    "git-workflow": "1.0.0"
  }
}
```

### 引用关系流程图（文本版）

```text
.roleclaw/config.json
  ├─ registry
  ├─ ide (cursor | codex)
  ├─ role
  ├─ skills (项目显式声明)
  ├─ rules  (项目显式声明)
  └─ roleProfiles (可选：项目内岗位定义，优先级最高)
        │
        ├─ 若 roleProfiles[role] 存在 -> 直接取该岗位 skills/rules
        │
        └─ 否则从 registry 读取岗位定义
             ├─ organization/roles/<role>.json (主路径)
             └─ organization/rbac/roles.json   (兼容回退)
                    │
                    └─ 得到岗位 requiredSkills / requiredRules
                           │
                           └─ 与 config.skills / config.rules 合并
                              （项目显式声明优先，岗位默认补齐）
                                    │
                                    └─ roleclaw sync
                                         ├─ 读 registry.json（packages + rules 索引）
                                         ├─ 解析版本（latest / ^major / 精确版本）
                                         ├─ 拉取 assets/packages/<skill>/<ver>/files.json
                                         ├─ 拉取 assets/rules/<rule>/<ver>/files.json
                                         ├─ Cursor: 安装到 .cursor/skills/<skill>/ 与 .cursor/rules/<rule>/
                                         └─ Codex:  安装到 .codex/skills/<skill>/ 与 .codex/rules/<rule>/
```

一句话理解：

- `.roleclaw/config.json` 决定“这个项目要用什么”；
- `organization/roles/*.json` / `organization/rbac/roles.json` 决定“这个岗位默认应带什么”；
- `registry.json` + `assets/packages/` + `assets/rules/` 决定“具体版本和文件从哪里来”。

然后运行：

```bash
roleclaw sync
```

或者按岗位配置：

```bash
roleclaw use-role frontend-engineer
```

## IDE 编辑回写 Registry（push）

当 Registry 为**本地路径**（如 `./registry-template`）时，用户可在 IDE 中直接编辑 `.cursor/skills/<name>/` 或 `.cursor/rules/<name>/`，然后执行：

```bash
roleclaw push              # 回写所有已声明的 skills/rules
roleclaw push git-workflow # 仅回写指定 artifact
```

`push` 会将 IDE 中的修改写回 Registry 对应版本目录，并更新 `files.json`。完成后执行 `git add` 和 `git commit` 持久化变更，其他伙伴通过 `git pull` + `roleclaw sync` 即可获得更新。
