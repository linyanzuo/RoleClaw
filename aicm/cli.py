#!/usr/bin/env python3
"""
aicm — AI Context Manager
扫描项目中所有带 frontmatter 标识的规范文件，提取各频率内容块注入到 AI 上下文。

判断逻辑：
  - 文件有 frontmatter（--- 包裹）且含 frontmatter: 字段 → 识别为规范文件，参与扫描
  - 文件无 frontmatter → 跳过（CLAUDE.md、README 等自动排除）

用法：
  aicm .                          # 注入高频规范
  aicm . --scan                   # 列出规范文件树
  aicm . --check                  # 检测与 CLAUDE.md 的相似重复（默认阈值 80%）
  aicm . --check --threshold=0.9  # 自定义相似度阈值
  aicm . --init                   # 初始化所有 CLAUDE.md，注入强制执行块
"""

import re
import sys
from difflib import SequenceMatcher
from pathlib import Path

# 白名单：这些文件不视为规范文件，扫描时跳过
WHITELIST = {"CLAUDE.md", "AGENTS.md"}

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
  --check                      检测规范内容与 CLAUDE.md 的相似重复
  --threshold=<0.0~1.0>        设置 --check 相似度阈值，默认 0.8
  --init                       初始化所有 CLAUDE.md，注入强制执行块
  -h, --help                   显示帮助信息

示例：
  aicm .
  aicm . --scan
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

    threshold = DEFAULT_THRESHOLD
    for arg in args:
        if arg.startswith("--threshold="):
            try:
                threshold = float(arg.split("=", 1)[1])
            except ValueError:
                print("[错误] --threshold 值必须为 0.0~1.0 之间的小数", file=sys.stderr)
                sys.exit(1)

    dirs = [a for a in args if not a.startswith("--")]
    search_dir = Path(dirs[0]) if dirs else Path(".")

    if not search_dir.exists():
        print(f"[错误] 目录不存在: {search_dir}", file=sys.stderr)
        sys.exit(1)

    if init_mode:
        cmd_init(search_dir)
    elif scan_mode:
        cmd_scan(search_dir)
    elif check_mode:
        cmd_check(search_dir, threshold)
    else:
        cmd_inject(search_dir)


if __name__ == "__main__":
    main()
