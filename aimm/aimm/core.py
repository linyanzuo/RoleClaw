"""aimm 核心：frontmatter 解析、个人资产仓库布局、对象加载。

实现《AI 资产标准 v1》（docs/AI资产标准.md）。只用标准库，兼容 Python 3.9。
"""

from __future__ import annotations

import datetime
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

STANDARD = 1
CONFIG_NAME = "aimm.json"
INDEX_NAME = "MEMORY.md"
INDEX_HEADER = "# 记忆索引\n\n"

ASSETS = ("memory", "rule", "skill", "doc")
STATUSES = ("raw", "curated", "deprecated")
VISIBILITIES = ("local-only", "shareable")
MEMORY_TYPES = ("user", "feedback", "project", "reference")
TOOLS = ("claude", "codex")

NAME_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
SCOPE_RE = re.compile(r"^(personal|team|role:[a-z0-9]+(-[a-z0-9]+)*)$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

_FM_RE = re.compile(r"\A---[ \t]*\n(.*?)\n---[ \t]*(?:\n|\Z)", re.DOTALL)
_TOP_RE = re.compile(r"^([A-Za-z_][\w-]*):[ \t]*(.*)$")
_SUB_RE = re.compile(r"^[ \t]+([A-Za-z_][\w-]*):[ \t]*(.*)$")
_NEEDS_QUOTE_RE = re.compile(r"^[\[\]{}&*!|>'\"%@`#-]|: | #|^\s|\s$")


class AimmError(Exception):
    """面向用户的错误：只打印信息，不打印堆栈。"""


def home() -> Path:
    """用户主目录；测试时用 AIMM_HOME 重定向，避免触碰真实的工具目录。"""
    return Path(os.environ.get("AIMM_HOME") or Path.home())


def today() -> str:
    return datetime.date.today().isoformat()


def timestamp() -> str:
    return datetime.datetime.now().strftime("%Y%m%dT%H%M%S")


# ---------------------------------------------------------------- frontmatter


def _unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] == '"':
        try:
            return str(json.loads(value))
        except ValueError:
            return value[1:-1]
    if len(value) >= 2 and value[0] == value[-1] == "'":
        return value[1:-1].replace("''", "'")
    return value


def _quote(value: str) -> str:
    if value == "" or _NEEDS_QUOTE_RE.search(value):
        return json.dumps(value, ensure_ascii=False)
    return value


@dataclass
class Front:
    """受限 frontmatter：顶层标量 + 一层 metadata；其余行原样保留在 extra。"""

    top: dict = field(default_factory=dict)
    meta: dict = field(default_factory=dict)
    extra: list = field(default_factory=list)
    body: str = ""
    present: bool = False

    def dump(self) -> str:
        lines = ["---"]
        lines += [f"{k}: {_quote(v)}" for k, v in self.top.items()]
        lines += self.extra
        if self.meta:
            lines.append("metadata:")
            lines += [f"  {k}: {_quote(v)}" for k, v in self.meta.items()]
        lines.append("---")
        body = self.body.strip("\n")
        return "\n".join(lines) + "\n\n" + (body + "\n" if body else "")


def parse_front(text: str) -> Front:
    text = text.lstrip("﻿").replace("\r\n", "\n")
    match = _FM_RE.match(text)
    if not match:
        return Front(body=text)
    front = Front(body=text[match.end():].lstrip("\n"), present=True)
    mode = "top"  # top | meta | raw
    for line in match.group(1).split("\n"):
        if not line.strip():
            continue
        if line[0] not in " \t":
            m = _TOP_RE.match(line)
            if m and m.group(1) == "metadata" and not m.group(2).strip():
                mode = "meta"
            elif m and m.group(2).strip():
                front.top[m.group(1)] = _unquote(m.group(2))
                mode = "top"
            else:  # 嵌套结构或无法识别的行：原样保留
                front.extra.append(line)
                mode = "raw"
            continue
        m = _SUB_RE.match(line)
        if mode == "meta" and m:
            front.meta[m.group(1)] = _unquote(m.group(2))
        else:
            front.extra.append(line)
    return front


# ---------------------------------------------------------------------- 对象


@dataclass
class Item:
    asset: str   # memory / rule / skill / doc
    key: str     # 记忆为文件名（不含扩展名），资产为目录名
    path: Path   # 主文件；资产目录缺主文件时为目录本身
    front: Front
    has_main: bool = True

    @property
    def name(self) -> str:
        return self.front.top.get("name", "")

    @property
    def description(self) -> str:
        return self.front.top.get("description", "")

    def meta(self, key: str) -> str:
        value = self.front.meta.get(key, "")
        if value:
            return value
        if key == "asset":
            return self.asset
        if key == "status":
            return "raw" if self.asset == "memory" else "curated"
        if key == "scope":
            return "personal"
        if key == "visibility":
            return "local-only"
        if key == "update":  # 兼容旧格式的顶层 update
            return self.front.top.get("update", "")
        return ""

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(self.front.dump(), encoding="utf-8")


def _read(path: Path) -> Front:
    try:
        return parse_front(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError):
        return Front()


def rule_main_file(directory: Path) -> Path | None:
    """规范主文件：<name>.md 优先，其次 RULE.md，再次唯一的非 README .md（与 aipm 一致）。"""
    for candidate in (directory / f"{directory.name}.md", directory / "RULE.md"):
        if candidate.is_file():
            return candidate
    others = [p for p in sorted(directory.glob("*.md")) if p.name.lower() != "readme.md"]
    return others[0] if len(others) == 1 else None


class Repo:
    def __init__(self, root: Path):
        self.root = Path(root).expanduser().resolve()
        self.memory_dir = self.root / "memory"
        self.assets_dir = self.root / "assets"
        self.config_path = self.root / CONFIG_NAME

    # 配置
    def config(self) -> dict:
        try:
            data = json.loads(self.config_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            raise AimmError(f"不是 aimm 仓库（缺少 {CONFIG_NAME}）：{self.root}")
        except ValueError as exc:
            raise AimmError(f"{CONFIG_NAME} 不是合法 JSON：{exc}")
        if not isinstance(data, dict):
            raise AimmError(f"{CONFIG_NAME} 顶层必须是对象")
        return data

    def save_config(self, data: dict) -> None:
        self.config_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def rel(self, path: Path) -> str:
        try:
            return str(Path(path).relative_to(self.root))
        except ValueError:
            return str(path)

    # 记忆
    @property
    def index_path(self) -> Path:
        return self.memory_dir / INDEX_NAME

    def memories(self) -> list:
        if not self.memory_dir.is_dir():
            return []
        return [
            Item("memory", p.stem, p, _read(p))
            for p in sorted(self.memory_dir.glob("*.md"))
            if p.name != INDEX_NAME
        ]

    def find_memory(self, name: str) -> Item | None:
        for item in self.memories():
            if name in (item.name, item.key):
                return item
        return None

    def index_text(self) -> str:
        try:
            return self.index_path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return ""

    def index_line(self, item: Item) -> str:
        return f"- [{item.name or item.key}]({item.path.name}) — {item.description}"

    def append_index(self, item: Item) -> None:
        """追加或替换一条索引；保留索引中其他手写条目的原貌。"""
        text = self.index_text() or INDEX_HEADER
        link = f"]({item.path.name})"
        lines = [line for line in text.split("\n") if link not in line]
        while lines and not lines[-1].strip():
            lines.pop()
        if lines and lines[-1].startswith("#"):  # 标题与第一条之间保留空行
            lines.append("")
        lines.append(self.index_line(item))
        self.memory_dir.mkdir(parents=True, exist_ok=True)
        self.index_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def remove_index(self, filename: str) -> None:
        """删除指向某个文件的索引条目；其余条目原样保留。"""
        text = self.index_text()
        if not text:
            return
        link = f"]({filename})"
        lines = [line for line in text.split("\n") if link not in line]
        self.index_path.write_text("\n".join(lines).rstrip("\n") + "\n", encoding="utf-8")

    def rebuild_index(self) -> None:
        lines = [self.index_line(item) for item in self.memories() if item.front.present]
        self.memory_dir.mkdir(parents=True, exist_ok=True)
        self.index_path.write_text(INDEX_HEADER + "\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")

    # 资产
    def asset_dir(self, asset: str) -> Path:
        return self.assets_dir / (asset + "s")

    def assets(self, asset: str | None = None) -> list:
        items = []
        for kind in ("rule", "skill", "doc"):
            if asset and asset != kind:
                continue
            base = self.asset_dir(kind)
            if not base.is_dir():
                continue
            for directory in sorted(p for p in base.iterdir() if p.is_dir() and not p.name.startswith(".")):
                if kind == "rule":
                    main = rule_main_file(directory)
                else:
                    main = directory / ("SKILL.md" if kind == "skill" else "DOC.md")
                    main = main if main.is_file() else None
                if main is None:
                    items.append(Item(kind, directory.name, directory, Front(), has_main=False))
                else:
                    items.append(Item(kind, directory.name, main, _read(main)))
        return items

    def items(self) -> list:
        return self.memories() + self.assets()


# ------------------------------------------------------------------ 仓库定位


def user_config_path() -> Path:
    return home() / ".config" / "aimm" / "config.json"


def read_user_config() -> dict:
    try:
        data = json.loads(user_config_path().read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def write_user_config(data: dict) -> None:
    path = user_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def resolve_repo(explicit: str | None = None) -> Repo:
    """定位顺序：--repo 参数 > AIMM_REPO 环境变量 > 用户配置里记录的默认仓库。"""
    chosen = explicit or os.environ.get("AIMM_REPO") or read_user_config().get("repo")
    if not chosen:
        raise AimmError("未指定仓库：先运行 `aimm init <路径>`，或用 --repo / AIMM_REPO 指定")
    repo = Repo(Path(chosen))
    repo.config()
    return repo
