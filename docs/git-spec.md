---
frontmatter: Git 分支策略、工作流、Tag 与提交规范，适用于 RoleClaw 仓库（aipm / aicm / aimm / docs）
update: 2026-11-20
---

# Git 工作流规范

> 本规范仅约束 RoleClaw 仓库。工作区内其他项目（如 CloudPet、MoeMone）为独立仓库，各自维护 git 规范，不与本仓库产生关联。

## 远程仓库

| 远程 | 地址 | 角色 |
|---|---|---|
| `origin` | 阿里云 Codeup（`codeup.aliyun.com/.../AI/RoleClaw`） | **主仓库**，日常开发以此为准 |
| `github` | `github.com/linyanzuo/RoleClaw` | 镜像；云端 Agent 会话、GitHub CI 与 PR 基于此 |

- 两个远程的 `master`、`test` 必须保持一致：Codeup 有新提交后，按需快进同步到 GitHub（`git push github origin/master:refs/heads/master`，`test` 同理），**禁止强推**
- 在 GitHub 上合并的 PR，须同步回 Codeup（`git pull github master` 后 `git push origin master`）

## 操作与提交约束

<!-- inject:high -->
1. **提交前必须确认当前分支**，若在 `master` 或 `test` 上则先切换到工作分支
2. **禁止直接向 `master` 提交或 push**，只接受 PR 合并；`git push --force` 到 master 须告知用户并等待确认
3. **`git commit` 无需用户确认**：在工作分支上完成改动、通过提交前自检后可直接提交
4. **禁止自动 push**，`git push` 须等用户明确要求；唯一例外：云端 Agent 会话可推送到自己的 `claude/*` 工作分支（容器为临时环境，不推送即丢失）
5. **`test` 分支只用于集成测试合并，不在此做功能开发**
6. 合并操作（merge / rebase）须由用户决策，Agent 只提供建议
7. 所有 git message（commit、merge、revert）**描述必须中文**
8. merge commit 禁止保留 git 自动生成的英文（如 `Merge branch 'xxx' into yyy`），必须覆写为中文
9. **禁止**在 commit message 中附加任何工具生成标记（`Co-authored-by`、`Made-with`、会话链接等）
<!-- inject:end -->

## 分支模型

```text
master  ──────────────────────────────────────► 主干（发布基线，发版打 Tag）
  │
  ├─ feature_<scope>_<short-desc>  ──► test ──► PR ──► master
  ├─ hotfix_<scope>_<short-desc>   ──► PR ──► master（再 cherry-pick 到 test）
  └─ claude/<auto-name>            ──► test ──► PR ──► master（云端 Agent 会话分支）

test  ──────────────────────────────────────────► 集成测试
       （每次发版后从 master 重置，保持与主干同步）
```

### 分支说明

| 分支 | 用途 | 创建来源 | 合并目标 |
|---|---|---|---|
| `master` | 主干 / 发布基线 | — | — |
| `test` | 集成测试 | — | — |
| `feature_*` | 单次需求/功能/重构开发 | 必须从 `master` 拉取 | 先合 `test` 测试，通过后 PR 合 `master` |
| `hotfix_*` | 已发布版本的紧急修复 | 必须从 `master` 拉取 | PR 直接合 `master`，再 cherry-pick 到 `test` |
| `claude/*` | 云端 Agent 会话的工作分支（名称由系统生成） | `master` | 同 `feature_*` |

### 分支命名

```text
feature_<scope>_<short-desc>
hotfix_<scope>_<short-desc>
```

示例：

- `feature_aipm_update-preview`
- `feature_aicm_inject-medium`
- `hotfix_aipm_publish-new-version`

`claude/*` 分支名由云端会话自动生成，豁免上述命名规则。

## Tag 规范

仓库内 aipm、aicm、aimm 独立发版，Tag 必须带工具前缀：

```text
aipm-v{major}.{minor}.{patch}
aicm-v{major}.{minor}.{patch}
aimm-v{major}.{minor}.{patch}
```

- 在 `master` 上发布某个工具的正式版本时打对应 Tag
- `aicm-v*` / `aimm-v*` 须与各自 `pyproject.toml` 中的 `version` 一致

| 版本号 | 含义 |
|---|---|
| `major` | 重大架构变更或不兼容升级（如 CLI 行为、配置格式不兼容） |
| `minor` | 新功能、向后兼容 |
| `patch` | Bug 修复、配置调整 |

## 提交信息规范（Conventional Commits）

格式：

```text
<type>(<scope>): <中文描述>
```

| type | 用途 |
|---|---|
| `feat` | 新功能 |
| `fix` | 缺陷修复 |
| `refactor` | 重构（不改功能） |
| `perf` | 性能优化 |
| `docs` | 文档更新 |
| `chore` | 构建/配置/杂项 |
| `test` | 测试相关 |
| `style` | 代码格式调整 |
| `revert` | 回滚提交 |

| scope | 范围 |
|---|---|
| `aipm` | `aipm/` 包管理 CLI |
| `aicm` | `aicm/` 上下文管理工具 |
| `aimm` | `aimm/` 个人 AI 资产管理工具 |
| `registry` | registry 数据结构、profile、示例包 |
| `docs` | `docs/` 平台级文档 |
| `ci` | `.github/` 工作流 |

跨多个 scope 的改动可省略 scope。禁止无意义提交描述，如：`update`、`fix bug`、`修改`。

## PR 规范

合入 `master` 和 `test` 均须通过 PR（或经用户确认的合并），禁止直接 push。  
PR 描述必须包含：

1. 背景
2. 方案
3. 影响范围
4. 测试方式

> 注：GitHub 上需为 `master` 开启 branch protection，才能在技术上强制「只能通过 PR 合入」。

## 提交前自检清单

1. 改动 aipm 时：`node --check aipm/aipm.mjs` 与 `node --test aipm/test/*.test.mjs` 通过。
2. 改动 aicm 时：在 `aicm/` 下执行 `python3 -m unittest discover -s tests` 通过。
3. 改动 aimm 时：在 `aimm/` 下执行 `python3 -m unittest discover -s tests` 通过。
4. 改动规范文件时：执行 `aicm .`，确认提取输出正确。
5. 提交信息符合 Conventional Commits（中文描述），且不含工具生成标记。
6. 无无关文件变更（日志、临时文件、`.aipm/`、`.cursor/`、`aicm-report*` 等本地产物）。
7. 分支从 `master` 拉取，且命名符合 `feature_*` / `hotfix_*`（`claude/*` 除外）。

## test 分支管理

1. `test` 不作为长期开发基线，仅用于集成测试。
2. 每次正式版本发布后，`test` 应从 `master` 重置，保持主干同步。
3. 并行开发场景下，优先通过 feature/hotfix 分支合入 `test` 验证。

## 提交后汇报

提交后向用户汇报：分支、`commit hash` + `commit message`、文件范围（新增/修改/删除），以及是否仍有未提交改动。
