# Registry 远程化与 Package 版本管理方案

## 文档目的

将 Registry 远程化、版本对比、版本发布与覆盖策略细化为可执行步骤，便于按序推进。

---

## 一、Registry 远程化

### Step R1：拆分 Registry 为独立仓库

#### 目标

将 registry 从 RoleClaw 主仓拆出，作为独立 Git 仓库（linyanzuo/aipm），便于单独部署与访问。

#### 任务

1. 新建 Git 仓库（如 `roleclaw-registry` 或 `aipm-registry`）。
2. 将 registry 内容作为新仓库根目录（即 `registry.json`、`profiles/`、`assets/` 等在根下）。
3. 在 RoleClaw 主仓中：
   - 已移除 `registry-template/`，使用远程仓库 + bundle 缓存；
   - 更新 README，说明生产环境使用远程 registry URL。

#### 完成标准

- 独立仓库可单独 clone、push
- 仓库根目录结构：`registry.json`、`profiles/`、`assets/packages/`、`assets/rules/`

---

### Step R2：配置远程 Registry URL

#### 目标

aipm 支持通过 URL 拉取 registry，成员无需拉取主仓代码。

#### 任务

1. 确定 raw 服务地址，例如：
   - GitHub: `https://raw.githubusercontent.com/<org>/<repo>/<branch>/`
   - GitLab: `https://gitlab.com/<org>/<repo>/-/raw/<branch>/`
   - 自建静态服务或 OSS 根路径
2. 在 `aipm init` 时，若选择远程 registry，写入上述 URL 到 `aipm_profile.json`。
3. 更新 `scripts/install-aipm.sh` 及文档，说明 `AIPM_REGISTRY` 环境变量用法。
4. 验证：配置远程 URL 后执行 `aipm install`，能正确拉取 packages。

#### 完成标准

- `aipm_profile.json` 中 `registry` 可为 `https://...` URL
- `aipm install` 能从远程 URL 成功安装

---

### Step R3：Registry 同步与发布流程（可选）

#### 目标

明确「谁改 registry、如何发布到远程」。

#### 任务

1. 约定流程：岗位负责人/管理员在本地或通过 PR 修改 registry 仓库，合并后自动/手动触发发布。
2. 若用 GitHub：可配置 GitHub Actions，在 push 到 main 后自动同步到 CDN 或触发缓存刷新（如有需要）。
3. 文档化：在 registry 仓库 README 中说明提交规范、发布流程。

#### 完成标准

- 有明确的「修改 → 合并 → 生效」流程说明
- 成员通过 `aipm install` 能获取到最新内容（依赖 raw 或 CDN 的缓存策略）

---

## 二、Package 版本对比

### Step V1：实现 `aipm diff` 命令

#### 目标

更新前可查看本地与远程目标版本的差异。

#### 任务

1. 新增 `aipm diff [name]` 命令：
   - 无参数：对比当前 profile 下所有 skills/rules
   - 有参数：对比指定 name 的 skill 或 rule
2. 逻辑：
   - 读取本地已安装版本（package.json 中的 version）
   - 从 config 获取目标版本（profile 或显式配置）
   - 若本地版本与目标版本相同，输出 "up-to-date"
   - 若不同，拉取远程目标版本的文件内容，与本地做文本 diff
3. 输出格式：按文件（SKILL.md、RULE.md 等）分别输出 diff，可用 `diff` 风格或 unified diff。
4. 仅对比文本文件，二进制或非文本可跳过或仅提示「有变更」。

#### 完成标准

- `aipm diff` 可执行
- 能正确展示本地与远程的文本差异

---

### Step V2：`aipm update` 增加 `--preview` 选项

#### 目标

执行 update 前可先预览变更，再决定是否执行。

#### 任务

1. `aipm update [name] --preview`：先执行 diff 逻辑，输出变更摘要，不执行安装。
2. `aipm update [name]`：保持现有行为，直接更新。

#### 完成标准

- `aipm update --preview` 输出变更预览
- 不影响原有 `aipm update` 行为

---

## 三、Package 版本发布与覆盖

### Step P1：定义版本发布约定

#### 目标

统一版本号与发布规则，写入文档。

#### 任务

1. 在 registry 仓库 README 或 `CONTRIBUTING.md` 中约定：
   - 使用 semver：`major.minor.patch`
   - 已发布版本不可变：修改内容必须发新版本（如 1.0.0 → 1.0.1）
   - 版本目录：`assets/packages/<name>/<version>/`，每个 version 为独立目录
2. 可选：每个版本目录增加 `CHANGELOG.md` 或 package.json 中 `changelog` 字段，记录变更说明。

#### 完成标准

- 有书面版本发布约定
- 团队知晓「已发布不可覆盖」原则

---

### Step P2：实现 `aipm publish` 校验（可选）

#### 目标

发布前自动校验 package 完整性，减少错误发布。

#### 任务

1. 新增 `aipm publish <name> [version]` 或集成到现有 publish：
   - 校验 SKILL.md / RULE.md 的 frontmatter（name、description 必填）
   - 校验 package.json 的 files 数组与目录内文件一致
   - 校验 package.json 的 name、version 与目录匹配
2. 校验失败时输出错误并中止，不执行 publish。
3. 若 registry 为远程 URL，publish 可能仅做本地校验，实际发布仍通过 Git push 到 registry 仓库。（此处 push 指 git push）

#### 完成标准

- 有可执行的校验逻辑
- 校验失败时能明确提示

---

### Step P3：版本覆盖策略落地

#### 目标

在工具层面体现「已发布不可覆盖」策略（可选）。

#### 任务

1. 若 registry 为本地路径，`aipm publish` 或 `init-skill` 时：
   - 检查目标版本目录是否已存在
   - 若存在且非 `--overwrite`，提示「版本已存在，请使用新版本号」并中止
2. 若 registry 为远程 URL，则覆盖策略由 registry 仓库的 CI 或人工 review 保障，aipm 不做强制。

#### 完成标准

- 本地 registry 场景下，避免误覆盖已发布版本
- 或明确文档说明由人工/CI 保障

---

## 四、推荐执行顺序

```text
Phase R：Registry 远程化
  Step R1  拆分 Registry 为独立仓库
  Step R2  配置远程 Registry URL 并验证
  Step R3  Registry 同步与发布流程（可选）

Phase V：版本对比
  Step V1  实现 aipm diff 命令
  Step V2  aipm update --preview 选项

Phase P：版本发布与覆盖
  Step P1  定义版本发布约定（文档）
  Step P2  aipm publish 校验（可选）
  Step P3  版本覆盖策略落地（可选）
```

---

## 五、依赖关系

| 步骤 | 前置依赖 |
|------|----------|
| R1 | 无 |
| R2 | R1（需有独立 registry 仓库） |
| R3 | R2 |
| V1 | 无（可独立进行） |
| V2 | V1 |
| P1 | 无 |
| P2 | P1 |
| P3 | P1 |

建议先完成 **R1、R2**，使成员能用远程 registry；**V1、V2** 可与 R 并行；**P1** 尽早落文档，P2、P3 视需要推进。
