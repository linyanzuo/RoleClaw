"""去重逻辑测试：同名且注入内容相同的规范文件只保留一份。

运行：python -m unittest discover -s tests   （在 aicm/ 目录下，无需额外依赖）
"""

import contextlib
import io
import tempfile
import unittest
from pathlib import Path

from aicm import cli


def spec(body: str, desc: str = "测试规范", extra: str = "") -> str:
    return f"---\nfrontmatter: {desc}\n---\n\n<!-- inject:high -->\n{body}\n<!-- inject:end -->\n{extra}"


class DedupeTestCase(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)

    def write(self, rel: str, content: str) -> None:
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def dedupe(self) -> tuple[list[str], dict[str, str]]:
        kept, merged = cli.dedupe_specs(cli.collect_specs(self.root))
        return (
            [s.rel.as_posix() for s in kept],
            {k.as_posix(): v.as_posix() for k, v in merged.items()},
        )

    def run_cmd(self, fn, *args) -> str:
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            fn(self.root, *args)
        return buf.getvalue()

    # ── dedupe_specs ──

    def test_same_name_same_content_keeps_shallowest(self) -> None:
        self.write("context/coding/git-spec.md", spec("规则 A"))
        self.write(".worktrees/m10/Frontend/context/coding/git-spec.md", spec("规则 A"))
        self.write(".worktrees/m13/workspace/context/coding/git-spec.md", spec("规则 A"))
        kept, merged = self.dedupe()
        self.assertEqual(kept, ["context/coding/git-spec.md"])
        self.assertEqual(set(merged.values()), {"context/coding/git-spec.md"})
        self.assertEqual(len(merged), 2)

    def test_shallowest_wins_even_if_sorted_later(self) -> None:
        # ".worktrees/..." 字典序在 "z/..." 之前，但 z/ 那份更浅，应保留 z/ 的
        self.write(".worktrees/a/b/c/spec.md", spec("规则"))
        self.write("z/spec.md", spec("规则"))
        kept, merged = self.dedupe()
        self.assertEqual(kept, ["z/spec.md"])
        self.assertEqual(merged, {".worktrees/a/b/c/spec.md": "z/spec.md"})

    def test_same_depth_tie_breaks_by_path(self) -> None:
        self.write("b/spec.md", spec("规则"))
        self.write("a/spec.md", spec("规则"))
        kept, _ = self.dedupe()
        self.assertEqual(kept, ["a/spec.md"])

    def test_same_name_different_content_all_kept(self) -> None:
        self.write("context/git-spec.md", spec("规则 A"))
        self.write(".worktrees/m10/context/git-spec.md", spec("规则 A（分支上改过）"))
        kept, merged = self.dedupe()
        self.assertEqual(len(kept), 2)
        self.assertEqual(merged, {})

    def test_different_name_same_content_all_kept(self) -> None:
        self.write("context/git-spec.md", spec("规则 A"))
        self.write("context/commit-spec.md", spec("规则 A"))
        kept, merged = self.dedupe()
        self.assertEqual(len(kept), 2)
        self.assertEqual(merged, {})

    def test_only_injected_content_is_compared(self) -> None:
        # inject 块之外的正文、frontmatter 描述不同，不影响判定：注入内容相同即为副本
        self.write("context/spec.md", spec("规则 A", desc="描述一", extra="\n低频正文 1\n"))
        self.write("wt/x/context/spec.md", spec("规则 A", desc="描述二", extra="\n低频正文 2\n"))
        kept, merged = self.dedupe()
        self.assertEqual(kept, ["context/spec.md"])
        self.assertEqual(len(merged), 1)

    def test_files_without_inject_block_never_merged(self) -> None:
        plain = "---\nfrontmatter: 无高频块\n---\n\n正文\n"
        self.write("context/plain.md", plain)
        self.write("wt/x/context/plain.md", plain)
        kept, merged = self.dedupe()
        self.assertEqual(len(kept), 2)
        self.assertEqual(merged, {})

    def test_partial_duplicates_within_group(self) -> None:
        self.write("context/spec.md", spec("v1"))
        self.write("wt/a/context/spec.md", spec("v1"))
        self.write("wt/b/context/spec.md", spec("v2"))
        self.write("wt/c/context/spec.md", spec("v2"))
        kept, merged = self.dedupe()
        self.assertEqual(kept, ["context/spec.md", "wt/b/context/spec.md"])
        self.assertEqual(
            merged,
            {"wt/a/context/spec.md": "context/spec.md", "wt/c/context/spec.md": "wt/b/context/spec.md"},
        )

    # ── 命令输出 ──

    def test_inject_outputs_once_with_summary(self) -> None:
        self.write("context/git-spec.md", spec("唯一的规则正文"))
        self.write(".worktrees/m10/context/git-spec.md", spec("唯一的规则正文"))
        self.write(".worktrees/m11/context/git-spec.md", spec("唯一的规则正文"))
        out = self.run_cmd(cli.cmd_inject)
        self.assertEqual(out.count("### 来自 "), 1)
        self.assertEqual(out.count("唯一的规则正文"), 1)
        self.assertIn("### 来自 context/git-spec.md（测试规范）", out)
        self.assertIn("已合并 2 份", out)
        self.assertNotIn(".worktrees", out)

    def test_inject_without_duplicates_has_no_summary(self) -> None:
        self.write("context/a.md", spec("规则 A"))
        self.write("context/b.md", spec("规则 B"))
        out = self.run_cmd(cli.cmd_inject)
        self.assertEqual(out.count("### 来自 "), 2)
        self.assertNotIn("已合并", out)

    def test_scan_lists_all_and_marks_duplicates(self) -> None:
        self.write("context/git-spec.md", spec("规则"))
        self.write(".worktrees/m10/context/git-spec.md", spec("规则"))
        out = self.run_cmd(cli.cmd_scan)
        self.assertIn("共 2 个文件，其中 1 个为同名同内容副本", out)
        self.assertEqual(out.count("git-spec.md\n"), 2)
        self.assertEqual(out.count("【副本：注入内容同 context/git-spec.md"), 1)

    def test_check_reports_duplicate_copies_once(self) -> None:
        line = "提交信息必须使用约定式提交格式并写明范围"
        self.write("CLAUDE.md", f"# 项目\n\n{line}\n")
        self.write("context/git-spec.md", spec(line))
        self.write(".worktrees/m10/context/git-spec.md", spec(line))
        out = self.run_cmd(cli.cmd_check, 0.8)
        self.assertIn("发现 1 处疑似重复", out)
        self.assertIn("已合并 1 份", out)


if __name__ == "__main__":
    unittest.main()
