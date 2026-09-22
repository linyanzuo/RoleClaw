#!/usr/bin/env python3
"""
aicm — AI Context Manager
扫描项目中所有带 frontmatter 标识的规范文件，提取各频率内容块注入到 AI 上下文。

判断逻辑：
  - 文件有 frontmatter（--- 包裹）且含 frontmatter: 字段 → 识别为规范文件，参与扫描
  - 文件无 frontmatter → 跳过（CLAUDE.md、README 等自动排除）

用法：
  aicm .                          # 注入高频规范
  aicm . --inject-high            # 注入高频规范（显式命令）
  aicm . --scan                   # 列出规范文件树
  aicm . --html                   # 生成可折叠/可搜索的规范文件树 HTML 报告
  aicm . --check                  # 检测与 CLAUDE.md 的相似重复（默认阈值 80%）
  aicm . --check --threshold=0.9  # 自定义相似度阈值
  aicm . --init                   # 初始化所有 CLAUDE.md，注入强制执行块
"""

import base64
import json
import re
import sys
import webbrowser
from difflib import SequenceMatcher
from pathlib import Path

# 白名单：这些文件不视为规范文件，扫描时跳过
WHITELIST = {"CLAUDE.md", "AGENTS.md"}

# 内置的 marked.js（Markdown → HTML 渲染），随包分发，--html 生成的文档预览页离线内联使用
ASSETS_DIR = Path(__file__).resolve().parent / "assets"
MARKED_JS_PATH = ASSETS_DIR / "marked.min.js"

FRONTMATTER_PATTERN = re.compile(r"^---\n(.*?)\n---(?:\n|$)", re.DOTALL)

INJECT_PATTERNS: dict[str, re.Pattern] = {
    "high": re.compile(r"<!-- inject:high -->\n(.*?)<!-- inject:end -->", re.DOTALL),
    # "medium": re.compile(r"<!-- inject:medium -->\n(.*?)<!-- inject:end -->", re.DOTALL),
}

MIN_LINE_LEN = 8
DEFAULT_THRESHOLD = 0.8

HELP_TEXT = """aicm — AI Context Manager

扫描项目中所有带 frontmatter 标识的规范文件，提取高频内容块注入到 AI 上下文。

用法：
  aicm [目录] [选项]
  aicm --help

参数：
  目录                         要扫描的项目目录，默认当前目录

选项：
  --scan                       列出带 frontmatter 标识的规范文件树
  --html[=<输出路径>]           生成可折叠/可搜索的规范文件树 HTML 报告（默认 aicm-report.html），自动打开浏览器
  --no-open                    配合 --html 使用，只生成文件不自动打开浏览器
  --inject-high                提取 inject:high 高频内容块并输出
  --check                      检测规范内容与 CLAUDE.md 的相似重复
  --threshold=<0.0~1.0>        设置 --check 相似度阈值，默认 0.8
  --init                       初始化所有 CLAUDE.md，注入强制执行块
  -h, --help                   显示帮助信息

示例：
  aicm .
  aicm . --inject-high
  aicm . --scan
  aicm . --html
  aicm . --html=/tmp/report.html --no-open
  aicm . --check
  aicm . --check --threshold=0.9
  aicm . --init
"""


# ── 核心工具函数 ────────────────────────────────────────────────────────────────

def cmd_help() -> None:
    """输出命令帮助信息。"""
    print(HELP_TEXT)


def parse_frontmatter(content: str) -> str | None:
    """
    检测文件头 frontmatter。
    返回 frontmatter 字段的描述文本；无 frontmatter 则返回 None（表示非规范文件）。
    """
    match = FRONTMATTER_PATTERN.match(content)
    if not match:
        return None
    for line in match.group(1).strip().splitlines():
        if line.startswith("frontmatter:"):
            return line.partition(":")[2].strip()
    return None


def extract_blocks(content: str, level: str) -> list[str]:
    """提取指定频率的所有内容块。"""
    pattern = INJECT_PATTERNS.get(level)
    if not pattern:
        return []
    return [m.strip() for m in pattern.findall(content)]


def strip_markdown(text: str) -> str:
    """去除 Markdown 修饰符，提取纯文本用于相似度比较。"""
    text = re.sub(r"\*+", "", text)
    text = re.sub(r"`[^`]+`", "", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"[|>\-#]", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def similarity(a: str, b: str) -> float:
    """计算两段文本的相似度（0.0 ~ 1.0）。"""
    return SequenceMatcher(None, a, b).ratio()


def extract_lines(block_text: str, min_len: int = MIN_LINE_LEN) -> list[str]:
    """从内容块中提取有效行（去除 Markdown、过滤过短行）。"""
    lines = []
    for line in block_text.splitlines():
        clean = strip_markdown(line)
        if len(clean) >= min_len:
            lines.append(clean)
    return lines


# ── 文件处理 ────────────────────────────────────────────────────────────────────

def process_file(file_path: Path, search_dir: Path) -> tuple[str, list[str]] | None:
    """处理单个规范文件，返回 (来源标识, [inject:high 块列表]) 或 None。"""
    try:
        content = file_path.read_text(encoding="utf-8")
    except Exception as e:
        print(f"[警告] 无法读取 {file_path}: {e}", file=sys.stderr)
        return None

    description = parse_frontmatter(content)
    if description is None:
        return None

    sections = extract_blocks(content, "high")
    if not sections:
        return None

    rel = str(file_path.relative_to(search_dir))
    return (f"{rel}（{description}）", sections)


# ── 命令：注入 ──────────────────────────────────────────────────────────────────

def cmd_inject(search_dir: Path) -> None:
    """默认模式：输出高频规范内容。"""
    outputs: list[str] = []

    for file_path in sorted(search_dir.rglob("*.md")):
        if file_path.name in WHITELIST:
            continue
        result = process_file(file_path, search_dir)
        if result:
            source, sections = result
            outputs.append(f"### 来自 {source}\n\n" + "\n\n".join(sections))

    if not outputs:
        print("（未发现带 frontmatter 标识的规范文件，无内容注入）")
        return

    print("=" * 50)
    print("注入高频规范（以下内容与 CLAUDE.md 具有同等约束力）")
    print("=" * 50)
    print()
    print("\n\n---\n\n".join(outputs))
    print()
    print("=" * 50)


# ── 命令：相似度检测 ────────────────────────────────────────────────────────────

def cmd_check(search_dir: Path, threshold: float) -> None:
    """检测模式：比较高频内容与 CLAUDE.md 各行的相似度，超过阈值则报告。"""
    claude_path = search_dir / "CLAUDE.md"
    if not claude_path.exists():
        print(f"[错误] 未找到 CLAUDE.md：{claude_path}", file=sys.stderr)
        sys.exit(1)

    claude_content = claude_path.read_text(encoding="utf-8")
    claude_lines = extract_lines(claude_content)

    spec_lines: list[tuple[str, str]] = []
    for file_path in sorted(search_dir.rglob("*.md")):
        if file_path.name in WHITELIST:
            continue
        result = process_file(file_path, search_dir)
        if result:
            source, sections = result
            for section in sections:
                for line in extract_lines(section):
                    spec_lines.append((source, line))

    if not spec_lines:
        print("（未发现高频内容块，无需检测）")
        return

    findings: list[tuple[str, str, str, float]] = []
    for source, spec_line in spec_lines:
        best_score = 0.0
        best_claude_line = ""
        for claude_line in claude_lines:
            score = similarity(spec_line, claude_line)
            if score > best_score:
                best_score = score
                best_claude_line = claude_line
        if best_score >= threshold:
            findings.append((source, spec_line, best_claude_line, best_score))

    print("=" * 50)
    print(f"CLAUDE.md 相似内容检测报告（阈值：{int(threshold * 100)}%）")
    print("=" * 50)

    if not findings:
        print(f"\n✅ 未发现相似度 ≥ {int(threshold * 100)}% 的内容，无冗余。\n")
    else:
        print(f"\n⚠️  发现 {len(findings)} 处疑似重复，建议从 CLAUDE.md 中移除：\n")
        for source, spec_line, claude_line, score in findings:
            print(f"  相似度：{int(score * 100)}%")
            print(f"  规范来源：{source}")
            print(f"  规范内容：{spec_line}")
            print(f"  CLAUDE.md：{claude_line}")
            print()

    print("=" * 50)


# ── 命令：规范文件树 ────────────────────────────────────────────────────────────

def build_tree(entries: list[tuple[Path, str]]) -> dict:
    """将文件路径列表构建为嵌套字典树。"""
    tree: dict = {}
    for path, description in entries:
        node = tree
        for part in path.parts[:-1]:
            node = node.setdefault(part, {})
        node[path.parts[-1]] = description
    return tree


def render_tree(node: dict, prefix: str = "") -> list[str]:
    """递归渲染树节点，返回行列表。"""
    lines: list[str] = []
    items = sorted(node.items(), key=lambda x: (isinstance(x[1], dict), x[0]))
    for i, (name, value) in enumerate(items):
        is_last = i == len(items) - 1
        connector = "└── " if is_last else "├── "
        child_prefix = prefix + ("    " if is_last else "│   ")
        if isinstance(value, dict):
            lines.append(f"{prefix}{connector}{name}/")
            lines.extend(render_tree(value, child_prefix))
        else:
            lines.append(f"{prefix}{connector}{name}")
            lines.append(f"{child_prefix}└─ {value}")
    return lines


def cmd_scan(search_dir: Path) -> None:
    """扫描模式：列出所有规范文件，按目录层级输出文件树。"""
    entries: list[tuple[Path, str]] = []

    for file_path in sorted(search_dir.rglob("*.md")):
        if file_path.name in WHITELIST:
            continue
        try:
            content = file_path.read_text(encoding="utf-8")
        except Exception:
            continue
        description = parse_frontmatter(content)
        if description is not None:
            rel = file_path.relative_to(search_dir)
            entries.append((rel, description))

    print("=" * 50)
    print(f"规范文件树（共 {len(entries)} 个文件）")
    print("=" * 50)

    if not entries:
        print("\n（未发现带 frontmatter 标识的规范文件）\n")
        print("=" * 50)
        return

    tree = build_tree(entries)
    lines = render_tree(tree)
    print()
    print(f"{search_dir}/")
    for line in lines:
        print(line)
    print()
    print("=" * 50)


# ── 命令：HTML 报告 ─────────────────────────────────────────────────────────────

def build_html_tree(entries: list[tuple[Path, str, str]]) -> list:
    """将 (相对路径, 描述, file:// URI) 列表构建为前端渲染用的嵌套节点列表（文件优先，同级按名称排序）。"""
    tree: dict = {}
    for rel_path, description, uri in entries:
        node = tree
        for part in rel_path.parts[:-1]:
            node = node.setdefault(part, {})
        node[rel_path.parts[-1]] = (description, uri)  # 元组：与目录节点（dict）区分

    def convert(node: dict) -> list:
        items = sorted(node.items(), key=lambda x: (isinstance(x[1], dict), x[0]))
        result = []
        for name, value in items:
            if isinstance(value, dict):
                result.append({"type": "dir", "name": name, "children": convert(value)})
            else:
                description, uri = value
                result.append({"type": "file", "name": name, "desc": description, "uri": uri})
        return result

    return convert(tree)


HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>aicm 规范文件树 — __ROOT__</title>
<style>
  :root {
    --bg: #ffffff; --bg-alt: #f6f7f9; --border: #e2e4e8; --text: #1f2328;
    --text-dim: #6b7280; --accent: #2563eb; --mark: #fde68a; --mark-text: #1f2328;
    --badge-bg: #eef2ff; --badge-text: #3730a3; --shadow: rgba(0,0,0,0.06);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d1117; --bg-alt: #161b22; --border: #30363d; --text: #e6edf3;
      --text-dim: #8b949e; --accent: #58a6ff; --mark: #7c6f2b; --mark-text: #f0e6b8;
      --badge-bg: #1e2a4a; --badge-text: #a5b4fc; --shadow: rgba(0,0,0,0.4);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size: 14px; line-height: 1.5;
  }
  header {
    position: sticky; top: 0; z-index: 10; background: var(--bg);
    border-bottom: 1px solid var(--border); padding: 16px 20px; box-shadow: 0 2px 8px var(--shadow);
  }
  h1 { margin: 0 0 4px; font-size: 17px; }
  .subtitle { color: var(--text-dim); font-size: 12.5px; margin-bottom: 12px; }
  .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  #search {
    flex: 1; min-width: 200px; padding: 8px 12px; border-radius: 6px;
    border: 1px solid var(--border); background: var(--bg-alt); color: var(--text); font-size: 14px;
  }
  #search:focus { outline: none; border-color: var(--accent); }
  button.tbtn {
    padding: 8px 12px; border-radius: 6px; border: 1px solid var(--border);
    background: var(--bg-alt); color: var(--text); cursor: pointer; font-size: 13px; white-space: nowrap;
  }
  button.tbtn:hover { border-color: var(--accent); color: var(--accent); }
  .badge {
    display: inline-block; background: var(--badge-bg); color: var(--badge-text);
    border-radius: 999px; padding: 2px 10px; font-size: 12.5px; font-weight: 600;
  }
  main { padding: 12px 20px 60px; max-width: 980px; margin: 0 auto; }
  #tree { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13.5px; }
  details.dir-node { margin: 1px 0; }
  details.dir-node > summary {
    cursor: pointer; list-style: none; padding: 4px 6px; border-radius: 5px; user-select: none;
  }
  details.dir-node > summary::-webkit-details-marker { display: none; }
  details.dir-node > summary:hover { background: var(--bg-alt); }
  details.dir-node > summary .name { font-weight: 600; }
  details.dir-node > summary::before {
    content: "▸"; display: inline-block; width: 14px; color: var(--text-dim);
    transition: transform .12s ease;
  }
  details.dir-node[open] > summary::before { transform: rotate(90deg); }
  .children { margin-left: 18px; padding-left: 10px; border-left: 1px dashed var(--border); }
  .file-node {
    display: block; padding: 3px 6px 3px 20px; border-radius: 5px;
    color: inherit; text-decoration: none; cursor: pointer;
  }
  .file-node:hover { background: var(--bg-alt); }
  .file-node:hover .fname { color: var(--accent); text-decoration: underline; }
  .file-node:visited { color: inherit; }
  .file-row { display: flex; gap: 6px; align-items: baseline; }
  .fname { color: var(--text); }
  .fdesc {
    color: var(--text-dim); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
    font-size: 12.5px; margin: 1px 0 2px 20px;
  }
  mark { background: var(--mark); color: var(--mark-text); border-radius: 2px; padding: 0 1px; }
  #empty-state { display: none; color: var(--text-dim); padding: 24px 6px; }
  .icon { opacity: .8; }
</style>
</head>
<body>
<header>
  <h1>📋 aicm 规范文件树</h1>
  <div class="subtitle">扫描目录：<code>__ROOT__</code> &nbsp;·&nbsp; <span class="badge">__COUNT__ 个规范文件</span> &nbsp;·&nbsp; 生成时间 __GENERATED__</div>
  <div class="toolbar">
    <input id="search" type="text" placeholder="搜索文件名 / 路径 / 描述…（Esc 清空）" autofocus>
    <button class="tbtn" id="expand-all">展开全部</button>
    <button class="tbtn" id="collapse-all">折叠全部</button>
  </div>
</header>
<main>
  <div id="tree"></div>
  <div id="empty-state">没有匹配的文件</div>
</main>
<script>
const DATA = __TREE_JSON__;

function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function renderNode(node, container) {
  if (node.type === "dir") {
    const details = el("details", "dir-node");
    details.open = true;
    const summary = el("summary");
    const icon = el("span", "icon"); icon.textContent = "📁 ";
    const name = el("span", "name"); name.textContent = node.name;
    summary.appendChild(icon); summary.appendChild(name);
    details.appendChild(summary);
    const children = el("div", "children");
    node.children.forEach((c) => renderNode(c, children));
    details.appendChild(children);
    details.dataset.name = node.name.toLowerCase();
    container.appendChild(details);
  } else {
    const wrap = el("a", "file-node");
    wrap.href = node.uri;
    wrap.target = "_blank";
    wrap.rel = "noopener";
    wrap.title = "点击在新标签页中打开该文件";
    wrap.dataset.name = node.name.toLowerCase();
    wrap.dataset.desc = (node.desc || "").toLowerCase();
    const row = el("div", "file-row");
    const icon = el("span", "icon"); icon.textContent = "📄";
    const fname = el("span", "fname"); fname.textContent = node.name; fname.dataset.original = node.name;
    row.appendChild(icon); row.appendChild(fname);
    wrap.appendChild(row);
    if (node.desc) {
      const fdesc = el("div", "fdesc"); fdesc.textContent = node.desc; fdesc.dataset.original = node.desc;
      wrap.appendChild(fdesc);
    }
    container.appendChild(wrap);
  }
}

const treeRoot = document.getElementById("tree");
DATA.forEach((n) => renderNode(n, treeRoot));

function highlight(elem, q) {
  if (!elem) return;
  const original = elem.dataset.original || "";
  if (!q) { elem.textContent = original; return; }
  const idx = original.toLowerCase().indexOf(q);
  if (idx === -1) { elem.textContent = original; return; }
  elem.textContent = "";
  elem.appendChild(document.createTextNode(original.slice(0, idx)));
  const mark = document.createElement("mark");
  mark.textContent = original.slice(idx, idx + q.length);
  elem.appendChild(mark);
  elem.appendChild(document.createTextNode(original.slice(idx + q.length)));
}

function walk(node, q) {
  if (node.classList.contains("file-node")) {
    const match = !q || node.dataset.name.includes(q) || node.dataset.desc.includes(q);
    node.style.display = match ? "" : "none";
    highlight(node.querySelector(".fname"), q);
    highlight(node.querySelector(".fdesc"), q);
    return match;
  }
  if (node.tagName === "DETAILS") {
    const children = node.querySelector(":scope > .children");
    let any = false;
    Array.from(children.children).forEach((c) => { if (walk(c, q)) any = true; });
    node.style.display = any ? "" : "none";
    if (q && any) node.open = true;
    return any;
  }
  return false;
}

function applyFilter() {
  const q = document.getElementById("search").value.trim().toLowerCase();
  let anyVisible = false;
  Array.from(treeRoot.children).forEach((n) => { if (walk(n, q)) anyVisible = true; });
  document.getElementById("empty-state").style.display = anyVisible ? "none" : "block";
}

document.getElementById("search").addEventListener("input", applyFilter);
document.getElementById("search").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.target.value = ""; applyFilter(); }
});
document.getElementById("expand-all").addEventListener("click", () => {
  document.querySelectorAll("details.dir-node").forEach((d) => (d.open = true));
});
document.getElementById("collapse-all").addEventListener("click", () => {
  document.querySelectorAll("details.dir-node").forEach((d) => (d.open = false));
});
</script>
</body>
</html>
"""


DOC_TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>__TITLE__</title>
<style>
  :root {
    --bg: #ffffff; --bg-alt: #f6f7f9; --border: #e2e4e8; --text: #1f2328;
    --text-dim: #6b7280; --accent: #2563eb; --code-bg: #f6f7f9; --quote-border: #d0d7de;
    --table-stripe: #f6f7f9; --shadow: rgba(0,0,0,0.06);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d1117; --bg-alt: #161b22; --border: #30363d; --text: #e6edf3;
      --text-dim: #8b949e; --accent: #58a6ff; --code-bg: #161b22; --quote-border: #30363d;
      --table-stripe: #161b22; --shadow: rgba(0,0,0,0.4);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size: 15px; line-height: 1.65;
  }
  header {
    position: sticky; top: 0; z-index: 10; background: var(--bg);
    border-bottom: 1px solid var(--border); padding: 14px 24px; box-shadow: 0 2px 8px var(--shadow);
  }
  header h1 { margin: 0 0 4px; font-size: 15px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  header .desc { color: var(--text-dim); font-size: 12.5px; margin-bottom: 8px; }
  header a { color: var(--accent); font-size: 12.5px; text-decoration: none; }
  header a:hover { text-decoration: underline; }
  main { max-width: 860px; margin: 0 auto; padding: 24px 24px 80px; }
  #content h1, #content h2, #content h3, #content h4 { border-bottom: 1px solid var(--border); padding-bottom: .3em; }
  #content h1 { font-size: 1.7em; } #content h2 { font-size: 1.4em; } #content h3 { font-size: 1.15em; border-bottom: none; }
  #content h4, #content h5, #content h6 { border-bottom: none; }
  #content a { color: var(--accent); }
  #content code { background: var(--code-bg); padding: .15em .4em; border-radius: 4px; font-size: .9em; }
  #content pre { background: var(--code-bg); padding: 12px 14px; border-radius: 6px; overflow-x: auto; border: 1px solid var(--border); }
  #content pre code { background: none; padding: 0; }
  #content blockquote { margin: 0; padding: 0 1em; color: var(--text-dim); border-left: .25em solid var(--quote-border); }
  #content table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  #content th, #content td { border: 1px solid var(--border); padding: 6px 12px; text-align: left; }
  #content tr:nth-child(2n) { background: var(--table-stripe); }
  #content img { max-width: 100%; }
  #content ul, #content ol { padding-left: 1.6em; }
  #content hr { border: none; border-top: 1px solid var(--border); margin: 1.5em 0; }
  #content { display: none; }
  #fallback { color: var(--text-dim); font-size: 13px; }
</style>
</head>
<body>
<header>
  <h1>__TITLE__</h1>
  <div class="desc">__DESC__</div>
  <a href="__RAW_URI__" target="_blank" rel="noopener">查看原始 Markdown 源文件</a>
</header>
<main>
  <div id="content"></div>
  <div id="fallback">正在渲染…（若长时间无内容，说明浏览器阻止了本地脚本运行，点上方链接查看原始文件）</div>
</main>
<script>__MARKED_JS__</script>
<script>
function b64ToUtf8(b64) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}
const raw = b64ToUtf8("__CONTENT_B64__");
const html = marked.parse(raw, { gfm: true, breaks: false });
const content = document.getElementById("content");
content.innerHTML = html;
content.style.display = "block";
document.getElementById("fallback").style.display = "none";
</script>
</body>
</html>
"""


def render_markdown_doc(content: str, title: str, description: str, raw_uri: str, marked_js: str) -> str:
    """把单个 Markdown 文件内容渲染为一份独立、内联 marked.js 的静态 HTML 预览页。"""
    content_b64 = base64.b64encode(content.encode("utf-8")).decode("ascii")
    return (
        DOC_TEMPLATE
        .replace("__MARKED_JS__", marked_js)  # 先替换，避免库代码里的 __TITLE__ 等占位符误命中
        .replace("__TITLE__", title)
        .replace("__DESC__", description)
        .replace("__RAW_URI__", raw_uri)
        .replace("__CONTENT_B64__", content_b64)
    )


def cmd_html(search_dir: Path, output_path: Path, auto_open: bool) -> None:
    """HTML 报告模式：生成可折叠/可搜索的规范文件树静态页面；点击文件名打开该文件渲染后的 Markdown 预览。"""
    entries: list[tuple[Path, str, str]] = []

    try:
        marked_js = MARKED_JS_PATH.read_text(encoding="utf-8")
    except Exception as e:
        print(f"[警告] 无法读取内置 marked.js（{MARKED_JS_PATH}）：{e}，预览页将回退为原始文件链接", file=sys.stderr)
        marked_js = None

    assets_dir = output_path.parent / f"{output_path.stem}_files"

    for file_path in sorted(search_dir.rglob("*.md")):
        if file_path.name in WHITELIST:
            continue
        try:
            content = file_path.read_text(encoding="utf-8")
        except Exception:
            continue
        description = parse_frontmatter(content)
        if description is None:
            continue

        rel = file_path.relative_to(search_dir)
        raw_uri = file_path.resolve().as_uri()

        if marked_js is None:
            entries.append((rel, description, raw_uri))
            continue

        body = FRONTMATTER_PATTERN.sub("", content, count=1)
        doc_html = render_markdown_doc(body, title=str(rel), description=description, raw_uri=raw_uri, marked_js=marked_js)
        doc_path = assets_dir / (str(rel) + ".html")
        doc_path.parent.mkdir(parents=True, exist_ok=True)
        doc_path.write_text(doc_html, encoding="utf-8")
        entries.append((rel, description, doc_path.resolve().as_uri()))

    tree_json = json.dumps(build_html_tree(entries), ensure_ascii=False)

    from datetime import datetime

    html = (
        HTML_TEMPLATE
        .replace("__TREE_JSON__", tree_json)
        .replace("__COUNT__", str(len(entries)))
        .replace("__ROOT__", str(search_dir.resolve()))
        .replace("__GENERATED__", datetime.now().strftime("%Y-%m-%d %H:%M"))
    )

    output_path.write_text(html, encoding="utf-8")
    print(f"✅ 已生成 {len(entries)} 个规范文件的可视化报告：{output_path.resolve()}")
    if marked_js is not None:
        print(f"   点击文件名会打开渲染后的 Markdown 预览（源文件在 {assets_dir.resolve()}/）")

    if auto_open:
        webbrowser.open(output_path.resolve().as_uri())


# ── 命令：初始化 CLAUDE.md ──────────────────────────────────────────────────────

_INIT_BLOCK = (
    "## 任务开始前（强制）\n\n"
    "开始**任何任务**前，第一步必须执行规范匹配器，将输出内容视为与本文件同等约束力的规范：\n\n"
    "```bash\n"
    "aicm .\n"
    "```\n\n"
)

# 同时兼容旧格式（rule-matcher.py）和新格式（aicm）
_INIT_MARKERS = {"aicm .", "rule-matcher.py"}


def inject_into_claude(content: str) -> str:
    """将强制执行块注入到 CLAUDE.md，注入位置：第一个 ## 标题之前。"""
    lines = content.splitlines(keepends=True)
    for i, line in enumerate(lines):
        if line.startswith("## "):
            lines.insert(i, _INIT_BLOCK)
            return "".join(lines)
    if not content.endswith("\n"):
        content += "\n"
    return content + "\n" + _INIT_BLOCK


def cmd_init(search_dir: Path) -> None:
    """初始化模式：扫描所有 CLAUDE.md，注入 aicm 强制执行块。"""
    claude_files = sorted(search_dir.rglob("CLAUDE.md"))

    if not claude_files:
        print("（未发现任何 CLAUDE.md 文件）")
        return

    print("=" * 50)
    print("CLAUDE.md 初始化报告")
    print("=" * 50)
    print()

    for file_path in claude_files:
        rel = file_path.relative_to(search_dir)
        try:
            content = file_path.read_text(encoding="utf-8")
        except Exception as e:
            print(f"  ⚠️  无法读取 {rel}: {e}")
            continue

        if any(m in content for m in _INIT_MARKERS):
            print(f"  ✅ 已有  {rel}")
            continue

        new_content = inject_into_claude(content)
        file_path.write_text(new_content, encoding="utf-8")
        print(f"  ✏️  已注入 {rel}")

    print()
    print("=" * 50)


# ── 入口 ────────────────────────────────────────────────────────────────────────

def main() -> None:
    args = sys.argv[1:]

    if "--help" in args or "-h" in args:
        cmd_help()
        return

    check_mode = "--check" in args
    scan_mode  = "--scan"  in args
    init_mode  = "--init"  in args
    inject_high_mode = "--inject-high" in args
    html_mode = "--html" in args or any(a.startswith("--html=") for a in args)
    no_open = "--no-open" in args

    threshold = DEFAULT_THRESHOLD
    html_output: str | None = None
    for arg in args:
        if arg.startswith("--threshold="):
            try:
                threshold = float(arg.split("=", 1)[1])
            except ValueError:
                print("[错误] --threshold 值必须为 0.0~1.0 之间的小数", file=sys.stderr)
                sys.exit(1)
        elif arg.startswith("--html="):
            html_output = arg.split("=", 1)[1]

    dirs = [a for a in args if not a.startswith("--")]
    search_dir = Path(dirs[0]) if dirs else Path(".")

    if not search_dir.exists():
        print(f"[错误] 目录不存在: {search_dir}", file=sys.stderr)
        sys.exit(1)

    if init_mode:
        cmd_init(search_dir)
    elif scan_mode:
        cmd_scan(search_dir)
    elif html_mode:
        output_path = Path(html_output) if html_output else search_dir / "aicm-report.html"
        cmd_html(search_dir, output_path, auto_open=not no_open)
    elif check_mode:
        cmd_check(search_dir, threshold)
    elif inject_high_mode:
        cmd_inject(search_dir)
    else:
        cmd_inject(search_dir)


if __name__ == "__main__":
    main()
