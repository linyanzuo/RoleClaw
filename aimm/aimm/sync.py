"""把个人记忆同步给各 AI 工具。

两种方式：
1. 入口文件托管块：在工具的全局入口文件里维护一段由标记包裹的记忆索引（所有工具通用）。
2. Claude 记忆目录链接：把某个项目的 Claude 记忆目录换成指向仓库 memory/ 的软链接。

所有改动先备份；--dry-run 只展示将发生的变化。
"""

from __future__ import annotations

import difflib
import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path

from . import secrets
from .core import INDEX_NAME, MEMORY_TYPES, TOOLS, AimmError, Item, Repo, home, parse_front, timestamp

# 托管块按分类分组，标题直接说明这一组在什么场合有用，帮助 AI 判断何时查阅
TYPE_SECTIONS = (
    ("feedback", "工作方式上的偏好与纠正（始终遵守）"),
    ("project", "进行中的工作与待办"),
    ("user", "关于用户"),
    ("reference", "外部资源与参考"),
    ("", "未分类"),
)

BEGIN = "<!-- aimm:begin（由 aimm sync 生成，勿手工编辑此块） -->"
END = "<!-- aimm:end -->"
_BLOCK_RE = re.compile(r"<!-- aimm:begin.*?-->\n.*?<!-- aimm:end -->\n?", re.DOTALL)


def entry_file(tool: str) -> Path:
    if tool == "claude":
        return home() / ".claude" / "CLAUDE.md"
    if tool == "codex":
        return home() / ".codex" / "AGENTS.md"
    raise AimmError(f"不支持的工具：{tool}（可选：{', '.join(TOOLS)}）")


def command_hint() -> str:
    """入口文件里写给 AI 的命令形式：已安装到 PATH 用 aimm，否则用仓库内的启动脚本。"""
    if shutil.which("aimm"):
        return "aimm"
    launcher = Path(__file__).resolve().parent.parent / "bin" / "aimm"
    return f"python3 '{launcher}'"


def build_block(repo: Repo, tool: str) -> str:
    """tool 写进命令示例的 --source，使各工具写入的记忆自动带上来源。"""
    cmd = command_hint()
    lines = [
        BEGIN,
        "## 个人共享记忆（aimm）",
        "",
        f"以下是跨工具共享的个人记忆索引，正文在 `{repo.memory_dir}`。"
        "这些记忆对所有项目都有效，是当前项目文档之外的另一个信息来源。",
        "",
        "- 回答涉及用户本人的问题时（偏好、背景、待办事项、进行中的工作、计划），必须同时查阅下面的索引，"
        "与项目内的信息合并作答，不能只看当前项目。",
        "- 被问到待办、任务或计划时，列出「进行中的工作与待办」下的全部条目。",
        "- 某条记忆与当前任务相关时，先读取对应文件再行动。",
        "- 本索引是会话开始时的快照，会话期间可能已有增删。引用某条记忆前先读取它的文件；"
        "文件不存在说明该记忆已被删除，不要再引用。"
        f"需要最新索引时执行 `{cmd} list`。",
        f"- 用户要求删除某条记忆时执行 `{cmd} remove <name>`，由用户确认，不要直接删文件。",
        "- 需要记住新的事实、偏好、待办或对工作方式的纠正时，用下面的命令写入，不要直接修改本块：",
        f"  `{cmd} add --name <短横线小写名> --description <一句话> --type <user|feedback|project|reference> --source {tool} --body <正文>`",
        "- 记忆不得包含密码、密钥、令牌等秘密正文，只写凭据的登记 ID 或读取位置。",
        "",
    ]
    active = [i for i in repo.memories() if i.front.present and i.meta("status") != "deprecated"]
    if not active:
        lines.append("（暂无记忆）")
    for kind, title in TYPE_SECTIONS:
        group = [i for i in active if (i.front.meta.get("type", "") in MEMORY_TYPES and i.front.meta["type"] == kind)
                 or (kind == "" and i.front.meta.get("type", "") not in MEMORY_TYPES)]
        if not group:
            continue
        lines += [f"### {title}", ""]
        lines += [f"- [{i.name or i.key}]({i.path}) — {i.description}" for i in group]
        lines.append("")
    while lines[-1] == "":
        lines.pop()
    lines.append(END)
    return "\n".join(lines) + "\n"


def apply_block(text: str, block: str) -> str:
    if _BLOCK_RE.search(text):
        return _BLOCK_RE.sub(lambda _: block, text, count=1)
    if not text.strip():
        return block
    return text.rstrip("\n") + "\n\n" + block


def has_block(text: str) -> bool:
    return bool(_BLOCK_RE.search(text))


@dataclass
class SyncResult:
    tool: str
    path: Path
    status: str            # unchanged / updated / created / would-update / would-create / skipped
    backup: Path | None = None
    diff: str = ""


def _backup(path: Path) -> Path:
    backup = path.with_name(f"{path.name}.aimm-backup-{timestamp()}")
    shutil.copy2(path, backup)
    return backup


def sync_tool(repo: Repo, tool: str, dry_run: bool = False, only_existing: bool = False) -> SyncResult:
    """only_existing：仅刷新已经装过托管块的入口文件（供 add/refine 后自动刷新）。"""
    path = entry_file(tool)
    exists = path.is_file()
    old = path.read_text(encoding="utf-8") if exists else ""
    if only_existing and not has_block(old):
        return SyncResult(tool, path, "skipped")
    new = apply_block(old, build_block(repo, tool))
    if new == old:
        return SyncResult(tool, path, "unchanged")
    diff = "".join(difflib.unified_diff(
        old.splitlines(keepends=True), new.splitlines(keepends=True),
        fromfile=str(path), tofile=str(path) + "（同步后）",
    ))
    if dry_run:
        return SyncResult(tool, path, "would-update" if exists else "would-create", diff=diff)
    backup = None
    if exists and not has_block(old):  # 首次写入已有文件时备份一次
        backup = _backup(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(new, encoding="utf-8")
    return SyncResult(tool, path, "updated" if exists else "created", backup=backup, diff=diff)


def refresh_existing(repo: Repo) -> list:
    """记忆变化后刷新已安装的托管块；从不向未安装过的入口文件写入。"""
    results = []
    for tool in repo.config().get("tools", []):
        if tool in TOOLS:
            result = sync_tool(repo, tool, only_existing=True)
            if result.status != "skipped":
                results.append(result)
    return results


# ------------------------------------------------------- Claude 记忆目录链接


def claude_memory_dir(project: Path) -> Path:
    slug = re.sub(r"[^A-Za-z0-9]", "-", str(Path(project).expanduser().resolve()))
    return home() / ".claude" / "projects" / slug / "memory"


@dataclass
class LinkPlan:
    target: Path                                   # Claude 的记忆目录
    already_linked: bool = False
    imports: list = field(default_factory=list)    # [(源文件, 仓库内目标文件)]
    identical: list = field(default_factory=list)  # 与仓库内容相同、无需导入
    problems: list = field(default_factory=list)   # 阻止链接的问题


def plan_link(repo: Repo, project: Path) -> LinkPlan:
    target = claude_memory_dir(project)
    plan = LinkPlan(target=target)
    if target.is_symlink():
        if target.resolve() == repo.memory_dir.resolve():
            plan.already_linked = True
        else:
            plan.problems.append(f"已是指向别处的软链接：{target} -> {target.resolve()}")
        return plan
    if not target.exists():
        return plan
    if not target.is_dir():
        plan.problems.append(f"不是目录：{target}")
        return plan
    for path in sorted(target.iterdir()):
        if path.name == INDEX_NAME or path.name == ".DS_Store":
            continue
        if path.is_dir() or path.suffix != ".md":
            plan.problems.append(f"无法处理的条目（非 .md 文件）：{path.name}")
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            plan.problems.append(f"无法读取：{path.name}")
            continue
        found = secrets.scan(text)
        if found:
            plan.problems.append(f"{path.name} 疑似包含秘密：{secrets.describe(found)}")
            continue
        dest = repo.memory_dir / path.name
        if dest.exists():
            if dest.read_text(encoding="utf-8") == text:
                plan.identical.append(path)
            else:
                plan.problems.append(f"与仓库中的同名文件内容不同：{path.name}")
            continue
        plan.imports.append((path, dest))
    return plan


def apply_link(repo: Repo, plan: LinkPlan) -> Path | None:
    """执行链接：导入 → 原目录改名为备份 → 建软链接。返回备份目录。"""
    if plan.problems:
        raise AimmError("存在未解决的问题，未做任何改动")
    if plan.already_linked:
        return None
    repo.memory_dir.mkdir(parents=True, exist_ok=True)
    for source, dest in plan.imports:
        shutil.copy2(source, dest)
        repo.append_index(Item("memory", dest.stem, dest, parse_front(dest.read_text(encoding="utf-8"))))
    backup = None
    if plan.target.exists():
        backup = plan.target.with_name(f"{plan.target.name}.aimm-backup-{timestamp()}")
        plan.target.rename(backup)
    plan.target.parent.mkdir(parents=True, exist_ok=True)
    plan.target.symlink_to(repo.memory_dir, target_is_directory=True)
    return backup
