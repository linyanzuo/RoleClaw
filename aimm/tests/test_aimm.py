"""aimm 测试。

运行：python3 -m unittest discover -s tests   （在 aimm/ 目录下，无需额外依赖）

所有测试把 AIMM_HOME 指向临时目录，不会触碰真实的 ~/.claude、~/.codex 或用户配置。
"""

import contextlib
import hashlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aimm import cli, lint, secrets, sync
from aimm.core import Repo, parse_front

# 测试用的假凭据在运行时拼接，避免源码本身被秘密扫描工具命中
FAKE_ALIYUN_KEY = "LTAI" + "5tAbCdEfGh1234567890"
FAKE_PASSWORD_LINE = "password" + ": " + "Abcd1234efgh"


class AimmTestCase(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name).resolve()
        self.home = self.tmp / "home"
        self.home.mkdir()
        env = mock.patch.dict(os.environ, {"AIMM_HOME": str(self.home)})
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("AIMM_REPO", None)
        self.root = self.tmp / "assets-repo"
        self.run_ok("init", str(self.root), "--no-git")
        self.repo = Repo(self.root)

    def run_cli(self, *argv: str) -> tuple:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cli.main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def run_ok(self, *argv: str) -> str:
        code, out, err = self.run_cli(*argv)
        self.assertEqual(code, 0, msg=f"{argv} 失败：{err}{out}")
        return out

    def add(self, name: str, body: str = "正文内容", kind: str = "feedback", desc: str = "一条测试记忆") -> None:
        self.run_ok("add", "--name", name, "--description", desc, "--type", kind, "--body", body)

    def codes(self) -> list:
        return [f.code for f in lint.run(self.repo)]


class FrontmatterTest(unittest.TestCase):
    def test_roundtrip_keeps_unknown_fields(self) -> None:
        text = (
            "---\nname: demo\ndescription: \"含冒号: 的描述\"\nallowed-tools:\n  - Read\n"
            "metadata:\n  type: feedback\n  custom: 保留我\n---\n\n正文\n"
        )
        front = parse_front(text)
        self.assertEqual(front.top["description"], "含冒号: 的描述")
        self.assertEqual(front.meta, {"type": "feedback", "custom": "保留我"})
        again = parse_front(front.dump())
        self.assertEqual(again.top, front.top)
        self.assertEqual(again.meta, front.meta)
        self.assertEqual(again.extra, ["allowed-tools:", "  - Read"])
        self.assertEqual(again.body.strip(), "正文")

    def test_no_frontmatter(self) -> None:
        front = parse_front("# 标题\n正文\n")
        self.assertFalse(front.present)
        self.assertEqual(front.body, "# 标题\n正文\n")

    def test_legacy_aicm_fields_are_plain_top_level(self) -> None:
        front = parse_front("---\nfrontmatter: 旧格式描述\nupdate: 2026-05-24\n---\n正文\n")
        self.assertEqual(front.top, {"frontmatter": "旧格式描述", "update": "2026-05-24"})


class SecretsTest(unittest.TestCase):
    def test_detects_without_echoing(self) -> None:
        found = secrets.scan(f"第一行\n{FAKE_PASSWORD_LINE}\nkey {FAKE_ALIYUN_KEY}\n")
        self.assertEqual(found, [("credential-assignment", 2), ("aliyun-access-key", 3)])
        self.assertNotIn("Abcd1234", secrets.describe(found))

    def test_ignores_references_and_placeholders(self) -> None:
        text = "密码：见登记 ID ops-lan-dudu\npassword: <your-password>\ntoken: ${TOKEN_FROM_ENV}\n令牌从环境变量读取\n"
        self.assertEqual(secrets.scan(text), [])

    def test_url_credential(self) -> None:
        url = "mysql://root:" + "S3cretPass" + "@10.0.0.1:3306/db"
        self.assertEqual(secrets.scan(url), [("url-credential", 1)])


class MemoryTest(AimmTestCase):
    def test_init_layout(self) -> None:
        for rel in ("aimm.json", "memory/MEMORY.md", "assets/rules", "assets/skills", "assets/docs"):
            self.assertTrue((self.root / rel).exists(), rel)
        self.assertEqual(self.repo.config()["standard"], 1)
        user = json.loads((self.home / ".config/aimm/config.json").read_text(encoding="utf-8"))
        self.assertEqual(user["repo"], str(self.root))

    def test_init_refuses_non_empty_dir(self) -> None:
        other = self.tmp / "other"
        other.mkdir()
        (other / "keep.txt").write_text("x", encoding="utf-8")
        code, _, err = self.run_cli("init", str(other), "--no-git")
        self.assertEqual(code, 2)
        self.assertIn("目录非空", err)
        self.assertEqual([p.name for p in other.iterdir()], ["keep.txt"])

    def test_add_writes_file_and_index(self) -> None:
        self.add("prefer-concise", body="回答保持简短。\n\n**Why:** 用户明确要求。")
        front = parse_front((self.root / "memory/prefer-concise.md").read_text(encoding="utf-8"))
        self.assertEqual(front.top["name"], "prefer-concise")
        self.assertEqual(front.meta["type"], "feedback")
        self.assertIn("- [prefer-concise](prefer-concise.md) — 一条测试记忆", self.repo.index_text())
        self.assertEqual(self.codes(), [])

    def test_add_rejects_duplicate_unless_update(self) -> None:
        self.add("dup")
        code, _, err = self.run_cli("add", "--name", "dup", "--description", "d", "--type", "user", "--body", "新")
        self.assertEqual(code, 2)
        self.assertIn("已存在", err)
        self.run_ok("add", "--name", "dup", "--description", "新描述", "--body", "新正文", "--update")
        text = (self.root / "memory/dup.md").read_text(encoding="utf-8")
        self.assertIn("新正文", text)
        self.assertEqual(self.repo.index_text().count("](dup.md)"), 1)
        self.assertIn("新描述", self.repo.index_text())

    def test_add_rejects_secret_and_writes_nothing(self) -> None:
        code, out, err = self.run_cli(
            "add", "--name", "leak", "--description", "d", "--type", "reference", "--body", FAKE_PASSWORD_LINE)
        self.assertEqual(code, 2)
        self.assertIn("疑似包含秘密", err)
        self.assertNotIn("Abcd1234", out + err)
        self.assertFalse((self.root / "memory/leak.md").exists())

    def test_add_rejects_bad_name(self) -> None:
        code, _, err = self.run_cli("add", "--name", "Bad_Name", "--description", "d", "--type", "user", "--body", "x")
        self.assertEqual(code, 2)
        self.assertIn("小写字母", err)

    def test_list_json(self) -> None:
        self.add("one", kind="user")
        self.add("two", kind="project")
        data = json.loads(self.run_ok("list", "--json", "--type", "project"))
        self.assertEqual([d["name"] for d in data], ["two"])
        self.assertEqual(data[0]["status"], "raw")
        self.assertEqual(data[0]["visibility"], "local-only")

    def test_index_check_and_rebuild(self) -> None:
        self.add("kept")
        (self.root / "memory/native.md").write_text(
            "---\nname: native\ndescription: 工具直接写入的记忆\nmetadata:\n  type: user\n---\n\n正文\n", encoding="utf-8")
        code, out, _ = self.run_cli("index")
        self.assertEqual(code, 1)
        self.assertIn("native.md", out)
        self.run_ok("index", "--rebuild")
        self.assertEqual(self.run_cli("index")[0], 0)


class RefineTest(AimmTestCase):
    def test_refine_rule_creates_asset_and_marks_memory(self) -> None:
        self.add("commit-style", body="提交信息用中文，标题不超过 50 字。", desc="提交信息格式")
        self.run_ok("refine", "commit-style", "--as", "rule", "--yes")
        main = self.root / "assets/rules/commit-style/commit-style.md"
        front = parse_front(main.read_text(encoding="utf-8"))
        self.assertEqual(front.top["frontmatter"], "提交信息格式")  # aicm 过渡期兼容字段
        self.assertEqual(front.meta["asset"], "rule")
        self.assertEqual(front.meta["status"], "curated")
        self.assertEqual(front.meta["visibility"], "local-only")
        memory = parse_front((self.root / "memory/commit-style.md").read_text(encoding="utf-8"))
        self.assertEqual(memory.meta["promoted"], "commit-style")
        self.assertIn("提交信息用中文", memory.body)  # 原记忆保留
        self.assertNotIn("memory/", main.read_text(encoding="utf-8"))  # 资产不回指记忆
        self.assertEqual(self.codes(), [])

    def test_refine_skill_and_doc_main_files(self) -> None:
        self.add("release-flow", body="发布前先跑测试，再打标签。")
        self.run_ok("refine", "release-flow", "--as", "skill", "--yes")
        self.run_ok("refine", "release-flow", "--as", "doc", "--name", "release-notes", "--yes")
        self.assertTrue((self.root / "assets/skills/release-flow/SKILL.md").is_file())
        self.assertTrue((self.root / "assets/docs/release-notes/DOC.md").is_file())
        memory = parse_front((self.root / "memory/release-flow.md").read_text(encoding="utf-8"))
        self.assertEqual(memory.meta["promoted"], "release-flow,release-notes")

    def test_refine_dry_run_and_confirmation(self) -> None:
        self.add("draft")
        out = self.run_ok("refine", "draft", "--as", "rule", "--dry-run")
        self.assertIn("asset: rule", out)
        self.assertFalse((self.root / "assets/rules/draft").exists())
        with mock.patch("sys.stdin", io.StringIO("")):  # 非交互且未加 --yes：拒绝
            code, _, err = self.run_cli("refine", "draft", "--as", "rule")
        self.assertEqual(code, 2)
        self.assertIn("需要确认", err)
        self.assertFalse((self.root / "assets/rules/draft").exists())

    def test_refine_rejects_existing_asset(self) -> None:
        self.add("twice")
        self.run_ok("refine", "twice", "--as", "rule", "--yes")
        code, _, err = self.run_cli("refine", "twice", "--as", "rule", "--yes")
        self.assertEqual(code, 2)
        self.assertIn("资产已存在", err)


class LintTest(AimmTestCase):
    def write(self, rel: str, content: str) -> Path:
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def test_claude_native_memory_is_valid(self) -> None:
        self.write("memory/user-role.md", "---\nname: user-role\ndescription: 用户是后端工程师\nmetadata:\n  type: user\n---\n\n正文\n")
        self.repo.rebuild_index()
        self.assertEqual(self.codes(), [])

    def test_missing_frontmatter_and_fields(self) -> None:
        self.write("memory/plain.md", "没有 frontmatter\n")
        self.write("assets/skills/empty/README.md", "无主文件\n")
        self.repo.rebuild_index()
        codes = self.codes()
        self.assertEqual(codes.count("A01"), 2)

    def test_name_mismatch_levels(self) -> None:
        self.write("memory/file_name.md", "---\nname: other-name\ndescription: d\n---\n\n正文\n")
        self.write("assets/skills/dir-name/SKILL.md", "---\nname: other-name\ndescription: d\nmetadata:\n  asset: skill\n---\n\n正文\n")
        self.repo.rebuild_index()
        levels = {f.path: f.level for f in lint.run(self.repo) if f.code == "A02"}
        self.assertEqual(levels["memory/file_name.md"], lint.WARNING)
        self.assertEqual(levels["assets/skills/dir-name/SKILL.md"], lint.ERROR)

    def test_invalid_values_and_shareable_memory(self) -> None:
        self.write(
            "memory/bad.md",
            "---\nname: bad\ndescription: d\nmetadata:\n  type: nope\n  status: done\n  scope: everyone\n"
            "  visibility: shareable\n  update: 昨天\n---\n\n正文\n")
        self.repo.rebuild_index()
        codes = self.codes()
        self.assertEqual(codes.count("A03"), 4)
        self.assertIn("A06", codes)

    def test_asset_must_declare_matching_asset(self) -> None:
        self.write("assets/rules/no-asset/no-asset.md", "---\nname: no-asset\ndescription: d\n---\n\n正文\n")
        self.write("assets/rules/wrong/wrong.md", "---\nname: wrong\ndescription: d\nmetadata:\n  asset: skill\n---\n\n正文\n")
        self.assertEqual(self.codes().count("A03"), 2)

    def test_secret_in_skill_script_and_memory_reference(self) -> None:
        self.write("assets/skills/tool/SKILL.md", "---\nname: tool\ndescription: d\nmetadata:\n  asset: skill\n---\n\n详见 memory/some-note.md\n")
        self.write("assets/skills/tool/scripts/run.py", f"KEY = '{FAKE_ALIYUN_KEY}'\n")
        findings = lint.run(self.repo)
        by_code = {f.code: f for f in findings}
        self.assertEqual(by_code["A04"].path, "assets/skills/tool/scripts/run.py")
        self.assertNotIn(FAKE_ALIYUN_KEY, by_code["A04"].message)
        self.assertEqual(by_code["A05"].path, "assets/skills/tool/SKILL.md")
        self.assertEqual(self.run_cli("lint")[0], 1)

    def test_index_drift(self) -> None:
        self.add("listed")
        self.write("memory/unlisted.md", "---\nname: unlisted\ndescription: d\n---\n\n正文\n")
        (self.root / "memory/listed.md").unlink()
        messages = [f.message for f in lint.run(self.repo) if f.code == "A07"]
        self.assertEqual(messages, ["索引缺少条目：unlisted.md", "索引条目悬空：listed.md"])

    def test_expired_dangling_link_and_similarity(self) -> None:
        body = "这是一段足够长的正文，用来触发相似度比较，内容在两条记忆里几乎完全相同，只有结尾不同。"
        self.write("memory/old.md", f"---\nname: old\ndescription: d\nmetadata:\n  expires: 2020-01-01\n---\n\n{body}参见 [[missing-note]]。\n")
        self.write("memory/twin.md", f"---\nname: twin\ndescription: d\n---\n\n{body}参见 [[old]]。\n")
        self.repo.rebuild_index()
        codes = self.codes()
        self.assertEqual(sorted(codes), ["A09", "A10", "A12"])
        self.assertEqual(self.run_cli("lint")[0], 0)  # 只有警告和提示，不阻断

    def test_rule_high_block_limit(self) -> None:
        items = "\n".join(f"- **禁止** 第 {i} 条" for i in range(11))
        self.write(
            "assets/rules/big/big.md",
            f"---\nname: big\ndescription: d\nfrontmatter: d\nmetadata:\n  asset: rule\n---\n\n<!-- inject:high -->\n{items}\n<!-- inject:end -->\n")
        self.assertEqual(self.codes(), ["A11"])

    def test_doc_index_missing_stale_and_fresh(self) -> None:
        self.write("assets/docs/biz/DOC.md", "---\nname: biz\ndescription: d\nmetadata:\n  asset: doc\n---\n\n# biz\n")
        page = self.write("assets/docs/biz/order/refund.md", "# 退款流程\n")
        self.assertEqual(self.codes(), ["A08"])  # 缺索引
        digest = hashlib.sha256(page.read_bytes()).hexdigest()
        index = {"schema": 1, "name": "biz", "entries": [{"path": "order/refund.md", "title": "退款流程", "sha256": digest}]}
        self.write("assets/docs/biz/index.json", json.dumps(index, ensure_ascii=False))
        self.write("assets/docs/biz/INDEX.md", "生成文件，勿手工编辑\n")
        self.assertEqual(self.codes(), [])  # 索引最新
        page.write_text("# 退款流程\n\n新增一节\n", encoding="utf-8")
        self.assertEqual(self.codes(), ["A08"])  # 正文变了，索引过期

    def test_duplicate_names(self) -> None:
        self.write("memory/a.md", "---\nname: same\ndescription: d\n---\n\n一\n")
        self.write("memory/b.md", "---\nname: same\ndescription: d\n---\n\n二\n")
        self.repo.rebuild_index()
        messages = [f.message for f in lint.run(self.repo) if f.code == "A02" and f.level == lint.ERROR]
        self.assertEqual(len(messages), 1)
        self.assertIn("重复", messages[0])


class SyncTest(AimmTestCase):
    def test_block_is_idempotent_and_preserves_user_content(self) -> None:
        self.add("first", desc="第一条")
        entry = self.home / ".codex/AGENTS.md"
        entry.parent.mkdir(parents=True)
        entry.write_text("# 我的全局规则\n\n- 保留这一行\n", encoding="utf-8")

        out = self.run_ok("sync", "--tool", "codex", "--dry-run")
        self.assertIn("将更新", out)
        self.assertEqual(entry.read_text(encoding="utf-8"), "# 我的全局规则\n\n- 保留这一行\n")  # 预览不写入

        self.run_ok("sync", "--tool", "codex")
        text = entry.read_text(encoding="utf-8")
        self.assertTrue(text.startswith("# 我的全局规则\n\n- 保留这一行\n"))
        self.assertIn("第一条", text)
        backups = list(entry.parent.glob("AGENTS.md.aimm-backup-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(encoding="utf-8"), "# 我的全局规则\n\n- 保留这一行\n")

        self.assertIn("无变化", self.run_ok("sync", "--tool", "codex"))
        self.assertEqual(entry.read_text(encoding="utf-8"), text)
        self.assertEqual(len(list(entry.parent.glob("AGENTS.md.aimm-backup-*"))), 1)  # 只在首次备份

    def test_creates_missing_entry_file(self) -> None:
        self.add("only")
        self.run_ok("sync", "--tool", "claude")
        text = (self.home / ".claude/CLAUDE.md").read_text(encoding="utf-8")
        self.assertTrue(text.startswith(sync.BEGIN))
        self.assertTrue(text.endswith(sync.END + "\n"))

    def test_add_refreshes_only_installed_blocks(self) -> None:
        self.add("before")
        self.assertFalse((self.home / ".claude/CLAUDE.md").exists())  # 未安装过则从不写入
        self.assertFalse((self.home / ".codex/AGENTS.md").exists())
        self.run_ok("sync", "--tool", "claude")
        self.add("after", desc="之后新增")
        self.assertIn("之后新增", (self.home / ".claude/CLAUDE.md").read_text(encoding="utf-8"))
        self.assertFalse((self.home / ".codex/AGENTS.md").exists())

    def test_deprecated_memory_is_left_out(self) -> None:
        self.add("gone", desc="已废弃的记忆")
        path = self.root / "memory/gone.md"
        path.write_text(path.read_text(encoding="utf-8").replace("metadata:\n", "metadata:\n  status: deprecated\n"), encoding="utf-8")
        self.assertNotIn("已废弃的记忆", sync.build_block(self.repo, "claude"))

    def test_block_groups_memories_by_type(self) -> None:
        self.add("todo-one", kind="project", desc="待办一")
        self.add("habit", kind="feedback", desc="偏好一")
        (self.root / "memory/untyped.md").write_text("---\nname: untyped\ndescription: 无分类\n---\n\n正文\n", encoding="utf-8")
        block = sync.build_block(self.repo, "claude")
        feedback, project, other = (block.index(t) for t in ("### 工作方式上的偏好与纠正", "### 进行中的工作与待办", "### 未分类"))
        self.assertTrue(feedback < block.index("偏好一") < project < block.index("待办一") < other < block.index("无分类"))
        self.assertNotIn("### 关于用户", block)  # 空分组不输出
        self.assertNotIn("（暂无记忆）", block)
        self.assertTrue(block.endswith("无分类\n" + sync.END + "\n"))

    def test_command_example_carries_tool_as_source(self) -> None:
        self.run_ok("sync")
        claude = (self.home / ".claude/CLAUDE.md").read_text(encoding="utf-8")
        codex = (self.home / ".codex/AGENTS.md").read_text(encoding="utf-8")
        self.assertIn("--source claude ", claude)
        self.assertNotIn("--source codex", claude)
        self.assertIn("--source codex ", codex)
        self.assertNotIn("--source claude", codex)


class LinkTest(AimmTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.project = self.tmp / "My Project"
        self.project.mkdir()
        self.claude_dir = sync.claude_memory_dir(self.project)

    def seed(self, name: str, content: str) -> None:
        self.claude_dir.mkdir(parents=True, exist_ok=True)
        (self.claude_dir / name).write_text(content, encoding="utf-8")

    def test_slug_matches_claude_convention(self) -> None:
        # 与本机实际观察一致：/、空格、下划线、点都被替换为连字符
        with mock.patch.dict(os.environ, {"AIMM_HOME": "/h"}):
            self.assertEqual(
                str(sync.claude_memory_dir(Path("/Users/someone/Desktop/ci_lib"))),
                "/h/.claude/projects/-Users-someone-Desktop-ci-lib/memory",
            )
            self.assertEqual(
                sync.claude_memory_dir(Path("/Users/someone/My App/.claude/wt")).parent.name,
                "-Users-someone-My-App--claude-wt",
            )

    def test_imports_backs_up_and_links(self) -> None:
        note = "---\nname: note\ndescription: 来自 Claude\nmetadata:\n  type: user\n---\n\n正文\n"
        self.seed("note.md", note)
        self.seed("MEMORY.md", "- [note](note.md) — 来自 Claude\n")

        out = self.run_ok("link", "claude", "--project", str(self.project), "--dry-run")
        self.assertIn("导入 note.md", out)
        self.assertFalse(self.claude_dir.is_symlink())

        self.run_ok("link", "claude", "--project", str(self.project), "--yes")
        self.assertTrue(self.claude_dir.is_symlink())
        self.assertEqual(self.claude_dir.resolve(), self.repo.memory_dir.resolve())
        self.assertEqual((self.root / "memory/note.md").read_text(encoding="utf-8"), note)
        self.assertIn("](note.md)", self.repo.index_text())
        backups = list(self.claude_dir.parent.glob("memory.aimm-backup-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual((backups[0] / "note.md").read_text(encoding="utf-8"), note)
        self.assertIn("无需操作", self.run_ok("link", "claude", "--project", str(self.project), "--yes"))

    def test_conflict_or_secret_aborts_without_changes(self) -> None:
        self.add("clash", body="仓库里的版本")
        self.seed("clash.md", "---\nname: clash\ndescription: d\n---\n\nClaude 里的另一个版本\n")
        self.seed("leak.md", f"---\nname: leak\ndescription: d\n---\n\n{FAKE_PASSWORD_LINE}\n")
        code, out, err = self.run_cli("link", "claude", "--project", str(self.project), "--yes")
        self.assertEqual(code, 2)
        self.assertIn("内容不同", out)
        self.assertIn("疑似包含秘密", out)
        self.assertNotIn("Abcd1234", out + err)
        self.assertFalse(self.claude_dir.is_symlink())
        self.assertFalse((self.root / "memory/leak.md").exists())
        self.assertIn("仓库里的版本", (self.root / "memory/clash.md").read_text(encoding="utf-8"))

    def test_links_when_claude_dir_absent(self) -> None:
        self.run_ok("link", "claude", "--project", str(self.project), "--yes")
        self.assertTrue(self.claude_dir.is_symlink())


class RepoResolutionTest(AimmTestCase):
    def test_explicit_repo_and_missing_repo(self) -> None:
        (self.home / ".config/aimm/config.json").unlink()
        code, _, err = self.run_cli("list")
        self.assertEqual(code, 2)
        self.assertIn("未指定仓库", err)
        self.assertEqual(self.run_cli("list", "--repo", str(self.root))[0], 0)
        code, _, err = self.run_cli("list", "--repo", str(self.tmp / "nowhere"))
        self.assertEqual(code, 2)
        self.assertIn("不是 aimm 仓库", err)


if __name__ == "__main__":
    unittest.main()
