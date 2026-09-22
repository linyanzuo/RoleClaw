# 主流 AI IDE 支持分析

> 分析主流 AI 编码工具的技能/规则目录结构，为 AIPM 多 IDE 支持提供依据。

## 一、主流 AI IDE 概览

| IDE | 厂商 | 基于 | Skills | Rules | 备注 |
|-----|------|------|--------|-------|------|
| **Cursor** | Anysphere | VS Code | ✅ `.cursor/skills/` | ✅ `.cursor/rules/` | 行业标杆，Agent Skills 标准推动者 |
| **Codex** | 阿里 | VS Code | ✅ `.codex/skills/` | ✅ `.codex/rules/` | 国内企业常用 |
| **Trae** | 字节跳动 | VS Code | ✅ `.trae/skills/` | ✅ `.trae/rules/` | 免费，2025 年发布，支持 MCP |
| **Windsurf** | Codeium | VS Code | ✅ `.windsurf/skills/` | ✅ `.windsurf/rules/*.md` | Cascade 代理，规则支持 frontmatter |
| **Zed** | Zed Industries | 自研 | 规划中 | `.rules` / AGENTS.md | 规则选择尚在 Issue 讨论 |
| **Claude Code** | Anthropic | - | `.claude/skills/` | CLAUDE.md | 单文件规则 |
| **GitHub Copilot** | GitHub | - | - | `.github/copilot-instructions.md` | 单文件 |

## 二、目录结构对比

### Skills（技能包）

各 IDE 均采用 **SKILL.md + 支持文件** 的目录结构，与 [Agent Skills 开放标准](https://agentskills.io/) 一致：

```
<ide-root>/skills/<skill-name>/
├── SKILL.md          # 必填，YAML frontmatter（name, description）
├── templates/       # 可选
├── examples/        # 可选
└── ...
```

| IDE | 项目级 Skills | 全局 Skills |
|-----|---------------|-------------|
| Cursor | `.cursor/skills/` | `~/.cursor/skills/` |
| Codex | `.codex/skills/` | - |
| Trae | `.trae/skills/` | 通过 MCP 配置 |
| Windsurf | `.windsurf/skills/` | `~/.codeium/windsurf/skills/` |

### Rules（规则）

| IDE | 项目级 Rules | 格式 |
|-----|--------------|------|
| Cursor | `.cursor/rules/` | `.md` / `.mdc`，支持 frontmatter |
| Codex | `.codex/rules/` | 同 Cursor |
| Trae | `.trae/rules/` | `.md`，可分子目录（core/, quality/ 等） |
| Windsurf | `.windsurf/rules/*.md` | 每规则一文件，支持 `trigger`、`globs` 等 frontmatter |

## 三、AIPM 已支持 IDE

| IDE | 根目录 | skills | rules |
|-----|--------|--------|-------|
| cursor | `.cursor` | ✅ | ✅ |
| codex | `.codex` | ✅ | ✅ |
| trae | `.trae` | ✅ | ✅ |
| windsurf | `.windsurf` | ✅ | ✅ |

配置方式：在 `aipm_profile.json` 中设置 `"ide": "trae"` 或 `"ide": "windsurf"`，执行 `aipm init` 时选择对应 IDE 即可。

## 四、格式兼容性说明

- **Skills**：各 IDE 均使用 SKILL.md + frontmatter，AIPM 安装的包可直接兼容
- **Rules**：AIPM 使用 `RULE.md` 作为规则主文件，安装在 `.<ide>/rules/<name>/RULE.md`。Windsurf 期望 `.windsurf/rules/*.md`（单文件），若需更好兼容可考虑安装时生成 `rule-name.md` 的副本，当前以目录结构为主

## 五、参考链接

- [Cursor Rules](https://www.cursor.com/docs/context/rules)
- [Cursor Agent Skills](https://www.cursor.com/docs/context/skills)
- [Trae Skills](https://docs.trae.ai/ide/skills)
- [Trae Rules](https://docs.trae.ai/ide/rules)
- [Windsurf Skills](https://docs.windsurf.com/windsurf/cascade/skills)
- [Windsurf Memories & Rules](https://docs.windsurf.com/windsurf/cascade/memories)
- [Agent Skills 标准](https://agentskills.io/)
