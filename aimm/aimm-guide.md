# aimm 使用指南

> AI Memory Manager：个人 AI 资产的记录、提炼与保存。
> 格式与规则以 [AI 资产标准](../docs/AI资产标准.md) 为准；整体路线见 [AI 资产演进规划](../docs/AI资产演进规划.md)。

只依赖 Python 标准库，Python 3.9 及以上可用。

---

## 安装

免安装，直接运行：

```bash
python3 aimm/bin/aimm --help
```

或安装为全局命令 `aimm`（在 `aimm/` 目录下）：

```bash
pip install -e .
```

---

## 快速开始

```bash
aimm init ~/Desktop/AI-Assets          # 创建个人资产仓库，并记为默认仓库
aimm add --name prefer-chinese-commit --description "提交信息使用中文" \
         --type feedback --body "提交信息用中文书写。"
aimm list
aimm lint
aimm sync --dry-run                    # 预览将写入各工具入口文件的内容
aimm sync                              # 实际写入
```

仓库定位顺序：`--repo` 参数 > `AIMM_REPO` 环境变量 > `init` 时记录的默认仓库（`~/.config/aimm/config.json`）。

---

## 命令

| 命令 | 作用 |
|---|---|
| `init <路径>` | 创建仓库：`memory/`、`assets/{rules,skills,docs}/`、`aimm.json`，并初始化 Git |
| `add` | 记录一条记忆；`--update` 覆盖同名记忆；正文可用 `--body`、`--file` 或标准输入 |
| `list` | 列出记忆与资产；`--asset`、`--type` 过滤，`--json` 供程序读取 |
| `show <name>` | 查看一条记忆或资产的主文件 |
| `remove <name>…` | 删除记忆：删文件、去掉索引条目、提交并刷新工具入口文件；需要确认，`--dry-run` 预览 |
| `refine <记忆> --as rule\|skill\|doc` | 把记忆提炼为资产草稿；`--file` 传入整理好的正文，`--dry-run` 预览 |
| `lint` | 按标准第七节校验；有错误级别问题时退出码为 1 |
| `index` | 检查 `MEMORY.md` 与记忆文件是否一致；`--rebuild` 重建 |
| `sync` | 把记忆索引写入各工具的全局入口文件；`--tool` 指定单个工具，`--dry-run` 预览 |
| `link claude --project <目录>` | 把该项目的 Claude 记忆目录换成指向仓库 `memory/` 的软链接 |

---

## 记忆如何到达各工具

### 入口文件托管块（Claude、Codex 通用）

`aimm sync` 在工具的全局入口文件里维护一段由标记包裹的内容：

| 工具 | 入口文件 |
|---|---|
| Claude | `~/.claude/CLAUDE.md` |
| Codex | `~/.codex/AGENTS.md` |

- 只改写 `<!-- aimm:begin … -->` 与 `<!-- aimm:end -->` 之间的内容，块外的内容原样保留。
- 首次写入已有文件前，会在同目录留一份 `.aimm-backup-<时间>` 备份。
- 块里只有索引（名称、摘要、文件路径）和写入方法，正文由 AI 按需读取。
- 写入方法里的命令示例按工具生成，带 `--source <工具名>`，因此各工具写入的记忆会自动记上来源。
- `add`、`remove`、`refine`、`index --rebuild`、`link` 之后会自动刷新**已经装过托管块**的入口文件；从未执行过 `aimm sync` 的入口文件不会被写入。加 `--no-sync` 可跳过刷新。

### 已打开的会话

入口文件只在会话开始时加载一次，所以已打开的会话拿到的是当时的索引快照，之后的增删它不会自动知道。应对方式：

- 托管块要求工具在引用记忆前先读取它的文件；文件不存在就说明已被删除，不再引用。
- 在会话里说"重新读取 aimm 记忆"，或让它执行 `aimm list`，它读到的是磁盘上的最新内容。
- 重开会话最彻底。

### Claude 记忆目录链接

Claude 按项目把记忆存在 `~/.claude/projects/<项目标识>/memory/`。`aimm link claude --project <目录>` 的步骤：

1. 检查该目录里的记忆文件：秘密扫描、与仓库同名文件比对。
2. 有任何问题（疑似秘密、同名但内容不同、非 `.md` 条目）就停止，不做任何改动。
3. 把记忆文件复制进仓库 `memory/` 并补索引。
4. 原目录改名为同级的 `memory.aimm-backup-<时间>`，原位置建立软链接。

链接之后，Claude 在该项目里读写的就是仓库里的同一份记忆。Claude 直接写入的记忆不经过 `aimm add`，因此写入后需要手动运行一次 `aimm sync`，其他工具的索引才会更新。

---

## 提炼

```bash
aimm refine prefer-chinese-commit --as rule --dry-run   # 预览
aimm refine prefer-chinese-commit --as rule             # 交互确认后创建
```

- 默认以记忆正文作为草稿；通常做法是让 AI 先把内容整理成规范或技能的写法，存成文件后用 `--file` 传入。
- 提炼是新建资产，原记忆保留，并在记忆上记下 `promoted`。资产一侧不回指记忆。
- 新资产默认 `visibility: local-only`。要发布必须手工改为 `shareable`，工具不会自动改。
- 规范资产会同时写 `description` 和 `frontmatter` 两个字段，后者是 aicm 目前识别规范文件所需的过渡字段。
- 文档集只创建主文件 `DOC.md`；索引由 aicm 生成（尚未实现）。

---

## 安全

- `add`、`refine`、`link` 写入前都会做秘密扫描，命中即拒绝，且报错只给规则名和行号，不回显内容。
- 需要指代凭据时，只写登记 ID 或读取位置。
- 写进托管块的索引会随会话发送给对应的模型服务商，`description` 里不要放不能外发的信息。

---

## Git

`init` 默认执行 `git init`，并在 `aimm.json` 里开启 `auto_commit`：每次 `add`、`refine`、`index --rebuild`、`link` 之后自动提交仓库内的改动，只提交到本地，不推送。把 `auto_commit` 改为 `false` 可关闭；`init --no-git` 则完全不使用 Git。

---

## 测试

```bash
cd aimm && python3 -m unittest discover -s tests
```

测试把 `AIMM_HOME` 指向临时目录，不会触碰真实的 `~/.claude`、`~/.codex` 或用户配置。手动试用时也可以用同样的方式隔离：

```bash
AIMM_HOME=/tmp/aimm-home python3 aimm/bin/aimm init /tmp/aimm-home/repo
```

---

## 当前范围

已实现：仓库初始化、记忆的记录、删除与索引、提炼为资产草稿、校验、Claude 与 Codex 的入口文件同步、Claude 记忆目录链接。

未实现：Cursor、Qoder、GrokBot 适配；MCP 服务；文档集索引生成（属于 aicm）；发布（属于 aipm）。
