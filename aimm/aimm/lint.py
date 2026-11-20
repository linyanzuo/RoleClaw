"""校验项 A01–A12，对应《AI 资产标准 v1》第七节。"""

from __future__ import annotations

import difflib
import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path

from . import secrets
from .core import (
    ASSETS, DATE_RE, INDEX_NAME, MEMORY_TYPES, NAME_RE, SCOPE_RE, STATUSES, VISIBILITIES,
    Item, Repo, today,
)

ERROR, WARNING, INFO = "error", "warning", "info"
LEVEL_LABEL = {ERROR: "错误", WARNING: "警告", INFO: "提示"}

SIMILARITY_THRESHOLD = 0.85
MAX_HIGH_ITEMS = 10
MAX_SCAN_BYTES = 1_000_000
DOC_GENERATED = ("INDEX.md", "index.json")

_INDEX_LINK_RE = re.compile(r"\]\(([^)#\s]+\.md)\)")
_WIKI_LINK_RE = re.compile(r"\[\[([^\]\n]+)\]\]")
_MEMORY_PATH_RE = re.compile(r"(?:^|[\s(\[\"'`/])memory/[\w.-]+\.md")
_HIGH_BLOCK_RE = re.compile(r"<!-- inject:high -->\n(.*?)<!-- inject:end -->", re.DOTALL)
_LIST_ITEM_RE = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+", re.MULTILINE)


@dataclass
class Finding:
    code: str
    level: str
    path: str
    message: str


def _text_files(item: Item) -> list:
    """对象包含的全部可读文本文件：记忆是单文件，资产是整个目录。"""
    if item.asset == "memory":
        return [item.path]
    root = item.path if item.path.is_dir() else item.path.parent
    return [p for p in sorted(root.rglob("*")) if p.is_file() and p.stat().st_size <= MAX_SCAN_BYTES]


def _read_text(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _check_item(repo: Repo, item: Item, out: list) -> None:
    rel = repo.rel(item.path)

    def add(code: str, level: str, message: str, path: str = rel) -> None:
        out.append(Finding(code, level, path, message))

    # A01
    if not item.has_main:
        add("A01", ERROR, "目录缺少主文件")
        return
    if not item.front.present:
        add("A01", ERROR, "缺少 frontmatter")
    else:
        for key in ("name", "description"):
            if not item.front.top.get(key):
                add("A01", ERROR, f"缺少 {key}")

    # A02
    if item.name:
        if not NAME_RE.match(item.name):
            add("A02", ERROR, "name 只能用小写字母、数字和连字符")
        if item.name != item.key:
            level = WARNING if item.asset == "memory" else ERROR
            add("A02", level, f"name（{item.name}）与{'文件' if item.asset == 'memory' else '目录'}名（{item.key}）不一致")

    # A03
    meta = item.front.meta
    declared = meta.get("asset", "")
    if item.asset != "memory" and item.front.present and not declared:
        add("A03", ERROR, f"资产必须声明 metadata.asset（应为 {item.asset}）")
    elif declared and (declared not in ASSETS or declared != item.asset):
        add("A03", ERROR, f"metadata.asset 为 {declared}，与所在位置（{item.asset}）不符")
    if meta.get("status") and meta["status"] not in STATUSES:
        add("A03", ERROR, f"status 取值无效：{meta['status']}")
    if meta.get("scope") and not SCOPE_RE.match(meta["scope"]):
        add("A03", ERROR, f"scope 取值无效：{meta['scope']}")
    if meta.get("visibility") and meta["visibility"] not in VISIBILITIES:
        add("A03", ERROR, f"visibility 取值无效：{meta['visibility']}")
    for key in ("update", "expires"):
        if meta.get(key) and not DATE_RE.match(meta[key]):
            add("A03", ERROR, f"{key} 应为 YYYY-MM-DD")
    if item.asset == "memory" and meta.get("type") and meta["type"] not in MEMORY_TYPES:
        add("A03", ERROR, f"type 取值无效：{meta['type']}")

    # A04 / A05
    for path in _text_files(item):
        text = _read_text(path)
        if text is None:
            continue
        found = secrets.scan(text)
        if found:
            add("A04", ERROR, "疑似包含秘密：" + secrets.describe(found), repo.rel(path))
        if item.asset != "memory" and path.name not in DOC_GENERATED and _MEMORY_PATH_RE.search(text):
            add("A05", ERROR, "资产不得引用 memory/ 下的路径", repo.rel(path))

    # A06
    if item.asset == "memory" and meta.get("visibility") == "shareable":
        add("A06", ERROR, "记忆不可标为 shareable；要共享请先提炼为资产")

    # A09
    expires = meta.get("expires", "")
    if DATE_RE.match(expires) and expires < today():
        add("A09", WARNING, f"已过期（expires: {expires}）")

    # A11
    if item.asset == "rule":
        text = _read_text(item.path) or ""
        for number, block in enumerate(_HIGH_BLOCK_RE.findall(text), start=1):
            count = len(_LIST_ITEM_RE.findall(block))
            if count > MAX_HIGH_ITEMS:
                add("A11", WARNING, f"第 {number} 个高频块有 {count} 条，超过 {MAX_HIGH_ITEMS} 条")


def _check_duplicates(repo: Repo, items: list, out: list) -> None:
    seen: dict = {}
    for item in items:
        if not item.name:
            continue
        key = (item.asset, item.name)
        if key in seen:
            out.append(Finding("A02", ERROR, repo.rel(item.path), f"name 与 {repo.rel(seen[key].path)} 重复"))
        else:
            seen[key] = item


def _check_index(repo: Repo, memories: list, out: list) -> None:
    rel = repo.rel(repo.index_path)
    if not repo.index_path.is_file():
        if memories:
            out.append(Finding("A07", WARNING, rel, f"缺少 {INDEX_NAME}，运行 `aimm index --rebuild` 生成"))
        return
    linked = set(_INDEX_LINK_RE.findall(repo.index_text()))
    files = {item.path.name for item in memories}
    for name in sorted(files - linked):
        out.append(Finding("A07", WARNING, rel, f"索引缺少条目：{name}"))
    for name in sorted(linked - files):
        out.append(Finding("A07", WARNING, rel, f"索引条目悬空：{name}"))


def _check_doc_index(repo: Repo, item: Item, out: list) -> None:
    root = item.path.parent
    rel = repo.rel(root)
    actual = {
        str(p.relative_to(root)): p
        for p in root.rglob("*.md")
        if p.is_file() and p.name not in ("DOC.md", "INDEX.md")
    }
    if not actual:
        return
    index_json = root / "index.json"
    if not index_json.is_file() or not (root / "INDEX.md").is_file():
        out.append(Finding("A08", WARNING, rel, "文档集缺少索引（INDEX.md / index.json）"))
        return
    try:
        entries = json.loads(index_json.read_text(encoding="utf-8")).get("entries", [])
        recorded = {entry["path"]: entry.get("sha256", "") for entry in entries}
    except (ValueError, KeyError, TypeError, AttributeError):
        out.append(Finding("A08", WARNING, rel, "index.json 无法解析"))
        return
    stale = set(actual) ^ set(recorded)
    stale |= {path for path in set(actual) & set(recorded) if _sha256(actual[path]) != recorded[path]}
    if stale:
        out.append(Finding("A08", WARNING, rel, f"索引已过期，{len(stale)} 个文件与索引不一致"))


def _check_links(repo: Repo, memories: list, out: list) -> None:
    names = {item.name for item in memories} | {item.key for item in memories}
    for item in memories:
        for target in sorted(set(_WIKI_LINK_RE.findall(item.front.body))):
            if target.strip() not in names:
                out.append(Finding("A10", INFO, repo.rel(item.path), f"[[{target}]] 指向尚不存在的记忆"))


def _check_similarity(repo: Repo, items: list, out: list) -> None:
    by_asset: dict = {}
    for item in items:
        if item.has_main and len(item.front.body.strip()) >= 40:
            by_asset.setdefault(item.asset, []).append(item)
    for group in by_asset.values():
        for i, left in enumerate(group):
            for right in group[i + 1:]:
                matcher = difflib.SequenceMatcher(None, left.front.body, right.front.body, autojunk=False)
                if matcher.real_quick_ratio() < SIMILARITY_THRESHOLD or matcher.quick_ratio() < SIMILARITY_THRESHOLD:
                    continue
                ratio = matcher.ratio()
                if ratio >= SIMILARITY_THRESHOLD:
                    out.append(Finding(
                        "A12", INFO, repo.rel(left.path),
                        f"与 {repo.rel(right.path)} 内容相似（{ratio:.0%}）",
                    ))


def run(repo: Repo) -> list:
    memories = repo.memories()
    assets = repo.assets()
    out: list = []
    for item in memories + assets:
        _check_item(repo, item, out)
    _check_duplicates(repo, memories + assets, out)
    _check_index(repo, memories, out)
    for item in assets:
        if item.asset == "doc" and item.has_main:
            _check_doc_index(repo, item, out)
    _check_links(repo, memories, out)
    _check_similarity(repo, memories + assets, out)
    order = {ERROR: 0, WARNING: 1, INFO: 2}
    return sorted(out, key=lambda f: (order[f.level], f.path, f.code))


def has_errors(findings: list) -> bool:
    return any(f.level == ERROR for f in findings)
