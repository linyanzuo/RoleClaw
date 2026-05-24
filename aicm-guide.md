---
frontmatter: aicm 使用指南，全局规范匹配工具的命令说明与工作原理
---

# aicm 使用指南

> AI Context Manager：从各规范文件中自动提取高频内容，注入到 AI 上下文。
> 全局命令，无需安装到项目目录，任意项目中均可使用。

---

## 快速开始

在项目根目录执行：

```bash
aicm .
```

---

## 使用方式

### 注入高频规范（默认）

```bash
aicm .
```

### 扫描规范文件树

```bash
aicm . --scan
```

### 检测与 CLAUDE.md 的重复内容

```bash
aicm . --check                  # 默认阈值 80%
aicm . --check --threshold=0.9  # 自定义阈值
```

### 初始化所有 CLAUDE.md（注入强制执行块）

```bash
aicm . --init
```

### 扫描指定子项目

```bash
aicm ./CloudPet-Server
aicm ./MoeCmsServer
```

### 输出到文件（用于对比验证）

```bash
aicm . > /tmp/rules-check.txt
cat /tmp/rules-check.txt
```

---

## 输出示例

```
==================================================
注入高频规范（以下内容与 CLAUDE.md 具有同等约束力）
==================================================

### 来自 context/git-workflow.md（Git 分支策略...）

| 分支 | 用途 | 操作限制 |
...

==================================================
```

- 每个来源文件单独分组，显示相对路径便于溯源
- 若无任何规范文件，输出提示「未发现带 frontmatter 标识的规范文件，无内容注入」

---

## 向规范文件添加高频标记

在任意 `.md` 规范文件中，用以下格式标记高频内容：

```markdown
<!-- inject:high -->
- 规范条目 A
- 规范条目 B
<!-- inject:end -->
```

添加后运行一次工具验证输出正确，再提交。
详细写作规范见 `spec-standard.md`（同目录）。

---

## 工作原理

```
执行命令
  → 递归扫描指定目录下所有 .md 文件
  → 跳过 CLAUDE.md / AGENTS.md（白名单）
  → 检测文件头 frontmatter（--- 包裹，含 frontmatter: 字段）
  → 提取每个文件中的 inject:high 块
  → 按文件路径排序后拼接输出
```

---

## 常见问题

**Q：新增了标记但输出中没有出现？**
检查两点：①文件头有正确的 frontmatter；②`<!-- inject:high -->` 和 `<!-- inject:end -->` 各自独占一行，行首无空格。

**Q：支持子目录吗？**
支持，工具使用 `rglob("*.md")` 递归扫描，子目录内的文件会被自动发现。

**Q：aicm 源码在哪里？**
`/Users/zed/Developer/RoleClaw/aicm/`，以 editable 模式安装，直接修改源码即时生效。
