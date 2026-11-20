"""aimm：AI Memory Manager —— 个人 AI 资产的记录、提炼与保存。

用法：aimm <命令> [选项]，`aimm <命令> -h` 查看各命令说明。
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from . import lint as lint_mod
from . import secrets, sync as sync_mod
from .core import (
    CONFIG_NAME, MEMORY_TYPES, NAME_RE, STANDARD, TOOLS,
    AimmError, Front, Item, Repo, read_user_config, resolve_repo, today, write_user_config,
)

MAIN_FILE = {"skill": "SKILL.md", "doc": "DOC.md"}
ASSET_LABEL = {"memory": "记忆", "rule": "规范", "skill": "技能", "doc": "文档集"}


# ------------------------------------------------------------------ 通用辅助


def confirm(question: str, assume_yes: bool) -> None:
    if assume_yes:
        return
    if not sys.stdin.isatty():
        raise AimmError("此操作需要确认：在终端中交互执行，或加 --yes")
    if input(f"{question} [y/N] ").strip().lower() not in ("y", "yes"):
        raise AimmError("已取消")


def check_secrets(text: str, what: str) -> None:
    found = secrets.scan(text)
    if found:
        raise AimmError(f"{what}疑似包含秘密，已拒绝：{secrets.describe(found)}。请改为引用登记 ID 或读取位置")


def read_body(args: argparse.Namespace) -> str:
    if args.body is not None:
        return args.body
    if args.file:
        try:
            return Path(args.file).read_text(encoding="utf-8")
        except OSError as exc:
            raise AimmError(f"无法读取 {args.file}：{exc}")
    if not sys.stdin.isatty():
        return sys.stdin.read()
    raise AimmError("缺少正文：用 --body、--file，或从标准输入传入")


def _git(repo: Repo, *argv: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(repo.root), *argv], capture_output=True, text=True)


def auto_commit(repo: Repo, message: str) -> None:
    """按配置把仓库内的改动提交到本地 Git；失败只提示，不影响已写入的文件。"""
    if not repo.config().get("auto_commit") or not (repo.root / ".git").exists():
        return
    try:
        _git(repo, "add", "-A", "--", "memory", "assets", CONFIG_NAME, ".gitignore")
        if _git(repo, "diff", "--cached", "--quiet").returncode == 0:
            return
        result = _git(repo, "commit", "-q", "-m", message)
    except OSError:
        print("[提示] 未找到 git，改动未提交", file=sys.stderr)
        return
    if result.returncode != 0:
        detail = (result.stderr.strip().splitlines() or [""])[-1]
        print(f"[提示] 自动提交失败，改动已保留在工作区{'：' + detail if detail else ''}", file=sys.stderr)


def report_sync(results: list, show_diff: bool = False) -> None:
    label = {
        "unchanged": "无变化", "updated": "已更新", "created": "已创建",
        "would-update": "将更新", "would-create": "将创建", "skipped": "跳过",
    }
    for result in results:
        print(f"  {result.tool}: {label[result.status]}  {result.path}")
        if result.backup:
            print(f"    原文件已备份到 {result.backup}")
        if show_diff and result.diff:
            print(result.diff, end="" if result.diff.endswith("\n") else "\n")


def refresh(repo: Repo, args: argparse.Namespace) -> None:
    if getattr(args, "no_sync", False):
        return
    results = sync_mod.refresh_existing(repo)
    if results:
        print("已刷新工具入口文件：")
        report_sync(results)


# ------------------------------------------------------------------------ 命令


def cmd_init(args: argparse.Namespace) -> None:
    repo = Repo(Path(args.path))
    if repo.config_path.exists():
        raise AimmError(f"已经是 aimm 仓库：{repo.root}")
    if repo.root.exists() and any(p.name not in (".git", ".DS_Store") for p in repo.root.iterdir()):
        raise AimmError(f"目录非空，为避免混入已有内容已停止：{repo.root}")
    tools = [t.strip() for t in args.tools.split(",") if t.strip()]
    for tool in tools:
        if tool not in TOOLS:
            raise AimmError(f"不支持的工具：{tool}（可选：{', '.join(TOOLS)}）")

    repo.memory_dir.mkdir(parents=True)
    for kind in ("rule", "skill", "doc"):
        directory = repo.asset_dir(kind)
        directory.mkdir(parents=True)
        (directory / ".gitkeep").write_text("", encoding="utf-8")
    repo.rebuild_index()
    (repo.root / ".gitignore").write_text(".DS_Store\n*.aimm-backup-*\n", encoding="utf-8")
    repo.save_config({"standard": STANDARD, "tools": tools, "auto_commit": not args.no_git})
    print(f"已创建个人资产仓库：{repo.root}")

    if not args.no_git:
        try:
            if not (repo.root / ".git").exists():
                _git(repo, "init", "-q")
            auto_commit(repo, "aimm: 初始化个人资产仓库")
        except OSError:
            print("[提示] 未找到 git，已跳过版本管理", file=sys.stderr)

    user = read_user_config()
    if not user.get("repo") or args.default:
        user["repo"] = str(repo.root)
        write_user_config(user)
        print("已设为默认仓库")
    elif user["repo"] != str(repo.root):
        print(f"默认仓库仍是 {user['repo']}；如需切换，加 --default 重新指定或使用 --repo")


def cmd_add(args: argparse.Namespace) -> None:
    repo = resolve_repo(args.repo)
    if not NAME_RE.match(args.name):
        raise AimmError("name 只能用小写字母、数字和连字符，例如 prefer-concise-answers")
    body = read_body(args).strip()
    if not body:
        raise AimmError("正文为空")
    check_secrets(args.description + "\n" + body, "记忆")

    existing = repo.find_memory(args.name)
    if existing and not args.update:
        raise AimmError(f"记忆已存在：{repo.rel(existing.path)}。要覆盖请加 --update")
    if existing:
        item = existing
    else:
        item = Item("memory", args.name, repo.memory_dir / f"{args.name}.md", Front(present=True))
    item.front.present = True
    item.front.top["name"] = args.name
    item.front.top["description"] = args.description
    item.front.body = body
    if args.type:
        item.front.meta["type"] = args.type
    elif not item.front.meta.get("type"):
        raise AimmError(f"缺少 --type（{' / '.join(MEMORY_TYPES)}）")
    item.front.meta["update"] = today()
    if args.source:
        item.front.meta["source"] = args.source
    item.save()
    repo.append_index(item)
    print(f"{'已更新' if existing else '已记录'}：{repo.rel(item.path)}")
    auto_commit(repo, f"aimm: {'更新' if existing else '记录'}记忆 {args.name}")
    refresh(repo, args)


def cmd_list(args: argparse.Namespace) -> None:
    repo = resolve_repo(args.repo)
    items = repo.memories() if args.asset == "memory" else repo.assets(args.asset) if args.asset else repo.items()
    if args.type:
        items = [i for i in items if i.asset == "memory" and i.front.meta.get("type") == args.type]
    if args.json:
        print(json.dumps([
            {
                "asset": i.asset, "name": i.name or i.key, "description": i.description,
                "path": repo.rel(i.path), "status": i.meta("status"), "scope": i.meta("scope"),
                "visibility": i.meta("visibility"), "type": i.front.meta.get("type", ""),
                "update": i.meta("update"), "promoted": i.front.meta.get("promoted", ""),
            }
            for i in items
        ], ensure_ascii=False, indent=2))
        return
    if not items:
        print("（没有符合条件的条目）")
        return
    for asset in ("memory", "rule", "skill", "doc"):
        group = [i for i in items if i.asset == asset]
        if not group:
            continue
        print(f"{ASSET_LABEL[asset]}（{len(group)}）")
        for i in group:
            tags = [t for t in (i.front.meta.get("type", ""), i.meta("status"), i.meta("update")) if t]
            if i.front.meta.get("promoted"):
                tags.append("已提炼为 " + i.front.meta["promoted"])
            print(f"  {i.name or i.key}  [{' · '.join(tags)}]")
            if i.description:
                print(f"      {i.description}")


def cmd_show(args: argparse.Namespace) -> None:
    repo = resolve_repo(args.repo)
    for item in repo.items():
        if args.name in (item.name, item.key) and item.has_main:
            print(f"# {repo.rel(item.path)}\n")
            print(item.path.read_text(encoding="utf-8"), end="")
            return
    raise AimmError(f"未找到：{args.name}")


def cmd_refine(args: argparse.Namespace) -> None:
    repo = resolve_repo(args.repo)
    memory = repo.find_memory(args.memory)
    if memory is None:
        raise AimmError(f"未找到记忆：{args.memory}")
    name = args.name or memory.name or memory.key
    if not NAME_RE.match(name):
        raise AimmError("资产 name 只能用小写字母、数字和连字符；用 --name 指定")
    description = args.description or memory.description
    if not description:
        raise AimmError("缺少描述：用 --description 指定")

    directory = repo.asset_dir(args.to) / name
    if directory.exists():
        raise AimmError(f"资产已存在：{repo.rel(directory)}")
    main = directory / (f"{name}.md" if args.to == "rule" else MAIN_FILE[args.to])

    if args.file:
        try:
            body = Path(args.file).read_text(encoding="utf-8")
        except OSError as exc:
            raise AimmError(f"无法读取 {args.file}：{exc}")
    else:
        body = memory.front.body
    body = body.strip()
    if not body.startswith("# "):
        body = f"# {name}\n\n{body}"
    check_secrets(description + "\n" + body, "资产")

    front = Front(present=True, body=body)
    front.top["name"] = name
    front.top["description"] = description
    if args.to == "rule":  # 过渡期：aicm 仍靠顶层 frontmatter 字段识别规范文件
        front.top["frontmatter"] = description
    front.meta.update({
        "asset": args.to, "status": "curated", "scope": "personal",
        "visibility": "local-only", "update": today(), "source": "aimm",
    })

    print(f"将把记忆 {memory.name or memory.key} 提炼为{ASSET_LABEL[args.to]}：{repo.rel(main)}")
    if args.dry_run:
        print("\n" + front.dump(), end="")
        return
    confirm("确认创建？", args.yes)

    Item(args.to, name, main, front).save()
    promoted = [p for p in memory.front.meta.get("promoted", "").split(",") if p.strip()]
    if name not in promoted:
        promoted.append(name)
    memory.front.meta["promoted"] = ",".join(promoted)
    memory.save()
    print(f"已创建：{repo.rel(main)}（原记忆保留，并已标记 promoted）")
    if args.to == "doc":
        print("提示：文档集的索引由 aicm 生成；正文加入后请重新生成索引")
    auto_commit(repo, f"aimm: 提炼 {memory.name or memory.key} 为{ASSET_LABEL[args.to]} {name}")
    refresh(repo, args)


def cmd_remove(args: argparse.Namespace) -> None:
    repo = resolve_repo(args.repo)
    targets = []
    for name in args.names:
        item = repo.find_memory(name)
        if item is None:
            raise AimmError(f"未找到记忆：{name}（未做任何改动）")
        if item.path not in [t.path for t in targets]:
            targets.append(item)

    print(f"将删除 {len(targets)} 条记忆：")
    for item in targets:
        print(f"  {item.name or item.key} — {item.description}")
        if item.front.meta.get("promoted"):
            print(f"    已提炼出的资产 {item.front.meta['promoted']} 不受影响，会保留")
    if args.dry_run:
        print("预览（未执行）")
        return
    confirm("确认删除？", args.yes)

    for item in targets:
        item.path.unlink()
        repo.remove_index(item.path.name)
    names = "、".join(item.name or item.key for item in targets)
    print(f"已删除：{names}")
    auto_commit(repo, f"aimm: 删除记忆 {names}")
    refresh(repo, args)


def cmd_lint(args: argparse.Namespace) -> int:
    repo = resolve_repo(args.repo)
    findings = lint_mod.run(repo)
    if args.json:
        print(json.dumps([f.__dict__ for f in findings], ensure_ascii=False, indent=2))
    elif not findings:
        print("校验通过，无问题")
    else:
        for f in findings:
            print(f"[{lint_mod.LEVEL_LABEL[f.level]}] {f.code} {f.path}: {f.message}")
        counts = {level: sum(1 for f in findings if f.level == level) for level in lint_mod.LEVEL_LABEL}
        print("\n" + "，".join(f"{lint_mod.LEVEL_LABEL[level]} {count}" for level, count in counts.items()))
    return 1 if lint_mod.has_errors(findings) else 0


def cmd_index(args: argparse.Namespace) -> int:
    repo = resolve_repo(args.repo)
    if args.rebuild:
        repo.rebuild_index()
        print(f"已重建 {repo.rel(repo.index_path)}（共 {len(repo.memories())} 条）")
        auto_commit(repo, "aimm: 重建记忆索引")
        refresh(repo, args)
        return 0
    problems = [f for f in lint_mod.run(repo) if f.code == "A07"]
    if not problems:
        print("索引与记忆文件一致")
        return 0
    for f in problems:
        print(f"[{lint_mod.LEVEL_LABEL[f.level]}] {f.message}")
    print("\n运行 `aimm index --rebuild` 重建")
    return 1


def cmd_sync(args: argparse.Namespace) -> None:
    repo = resolve_repo(args.repo)
    tools = [args.tool] if args.tool else repo.config().get("tools", [])
    if not tools:
        raise AimmError(f"{CONFIG_NAME} 的 tools 为空；用 --tool 指定")
    results = [sync_mod.sync_tool(repo, tool, dry_run=args.dry_run) for tool in tools]
    print("预览（未写入）：" if args.dry_run else "同步结果：")
    report_sync(results, show_diff=args.dry_run)


def cmd_link(args: argparse.Namespace) -> None:
    repo = resolve_repo(args.repo)
    plan = sync_mod.plan_link(repo, Path(args.project))
    print(f"Claude 记忆目录：{plan.target}")
    if plan.already_linked:
        print("已链接到本仓库，无需操作")
        return
    if plan.problems:
        print("存在以下问题，未做任何改动：")
        for problem in plan.problems:
            print(f"  - {problem}")
        raise AimmError("请先处理上述问题后重试")
    for source, dest in plan.imports:
        print(f"  导入 {source.name} -> {repo.rel(dest)}")
    for source in plan.identical:
        print(f"  已存在且内容相同，跳过 {source.name}")
    if plan.target.exists():
        print("  原目录将改名保留为备份（同级目录，后缀 .aimm-backup-<时间>）")
    print(f"  建立软链接 -> {repo.memory_dir}")
    if args.dry_run:
        print("预览（未执行）")
        return
    confirm("确认执行？", args.yes)
    backup = sync_mod.apply_link(repo, plan)
    print("已链接" + (f"；原目录备份在 {backup}" if backup else ""))
    auto_commit(repo, f"aimm: 导入 Claude 记忆 {len(plan.imports)} 条")
    refresh(repo, args)


# ---------------------------------------------------------------------- 入口


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="aimm", description="个人 AI 资产的记录、提炼与保存")
    sub = parser.add_subparsers(dest="command", metavar="<命令>")

    def command(name: str, func, help_text: str, repo: bool = True) -> argparse.ArgumentParser:
        p = sub.add_parser(name, help=help_text, description=help_text)
        p.set_defaults(func=func)
        if repo:
            p.add_argument("--repo", help="仓库路径（默认取 AIMM_REPO 或 init 时记录的默认仓库）")
        return p

    p = command("init", cmd_init, "创建个人资产仓库", repo=False)
    p.add_argument("path", help="仓库路径，须不存在或为空目录")
    p.add_argument("--tools", default="claude,codex", help="启用的工具，逗号分隔（默认 claude,codex）")
    p.add_argument("--no-git", action="store_true", help="不初始化 Git，也不自动提交")
    p.add_argument("--default", action="store_true", help="设为默认仓库，覆盖已有记录")

    p = command("add", cmd_add, "记录一条记忆")
    p.add_argument("--name", required=True, help="短横线小写名，同时作为文件名")
    p.add_argument("--description", required=True, help="一句话摘要，用于判断何时读取")
    p.add_argument("--type", choices=MEMORY_TYPES, help="记忆分类")
    p.add_argument("--body", help="正文；也可用 --file 或标准输入")
    p.add_argument("--file", help="从文件读取正文")
    p.add_argument("--source", help="写入方，如 claude、codex、manual")
    p.add_argument("--update", action="store_true", help="覆盖同名记忆")
    p.add_argument("--no-sync", action="store_true", help="不刷新工具入口文件")

    p = command("list", cmd_list, "列出记忆与资产")
    p.add_argument("--asset", choices=("memory", "rule", "skill", "doc"), help="只看某一类")
    p.add_argument("--type", choices=MEMORY_TYPES, help="只看某一分类的记忆")
    p.add_argument("--json", action="store_true", help="输出 JSON")

    p = command("show", cmd_show, "查看一条记忆或资产的主文件")
    p.add_argument("name")

    p = command("refine", cmd_refine, "把一条记忆提炼为资产（规范 / 技能 / 文档集）")
    p.add_argument("memory", help="记忆的 name")
    p.add_argument("--as", dest="to", required=True, choices=("rule", "skill", "doc"), help="目标资产类别")
    p.add_argument("--name", help="资产 name（默认沿用记忆的 name）")
    p.add_argument("--description", help="资产描述（默认沿用记忆的描述）")
    p.add_argument("--file", help="整理好的资产正文；缺省时以记忆正文为草稿")
    p.add_argument("--dry-run", action="store_true", help="只预览，不创建")
    p.add_argument("--yes", action="store_true", help="跳过确认")
    p.add_argument("--no-sync", action="store_true", help="不刷新工具入口文件")

    p = command("remove", cmd_remove, "删除记忆：删文件、去掉索引条目、提交并刷新工具入口文件")
    p.add_argument("names", nargs="+", metavar="name", help="要删除的记忆 name，可给多个")
    p.add_argument("--dry-run", action="store_true", help="只预览，不删除")
    p.add_argument("--yes", action="store_true", help="跳过确认")
    p.add_argument("--no-sync", action="store_true", help="不刷新工具入口文件")

    p = command("lint", cmd_lint, "按《AI 资产标准》校验仓库")
    p.add_argument("--json", action="store_true", help="输出 JSON")

    p = command("index", cmd_index, "检查或重建记忆索引 MEMORY.md")
    p.add_argument("--rebuild", action="store_true", help="按记忆文件重新生成索引")
    p.add_argument("--no-sync", action="store_true", help="不刷新工具入口文件")

    p = command("sync", cmd_sync, "把记忆索引写入各工具的全局入口文件")
    p.add_argument("--tool", choices=TOOLS, help="只同步一个工具（默认同步配置中的全部）")
    p.add_argument("--dry-run", action="store_true", help="只展示差异，不写入")

    p = command("link", cmd_link, "把某个项目的 Claude 记忆目录链接到本仓库")
    p.add_argument("tool", choices=("claude",))
    p.add_argument("--project", required=True, help="项目目录路径")
    p.add_argument("--dry-run", action="store_true", help="只预览，不执行")
    p.add_argument("--yes", action="store_true", help="跳过确认")
    p.add_argument("--no-sync", action="store_true", help="不刷新工具入口文件")

    return parser


def main(argv: list | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.print_help()
        return 0
    try:
        return args.func(args) or 0
    except AimmError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("\n已中断", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
