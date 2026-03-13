# GIT 规范
所有注释内容尽量使用中文进行描述。

## 代码提交规范
遵循 [Conventional Commits](https://www.conventionalcommits.org/) 标准。格式为：`<类型>(<范围>): <描述>`。 

### 类型 (Type)
| 类型 (Type) | 描述 (Description) | 示例 |
| :--- | :--- | :--- |
| `feat` | 新增功能 (Feature) | 新增登录页 |
| `fix` | 修复 Bug | 修复输入框校验错误 |
| `docs` | 文档变更 (Documentation) | 更新 README.md |
| `style` | 代码格式调整，不影响逻辑 | 空格、分号调整 |
| `refactor` | 代码重构 | 不包含新功能与Bug修复的代码变动 |
| `perf` | 性能优化 | 提升列表渲染速度 |
| `test` | 测试相关 | 增加单元测试 |
| `chore` | 构建过程或辅助工具的变动 | 更新依赖版本 |
| `revert` | 回滚提交 | 回滚到上一个稳定版本 |

### 范围（Scope）
`<范围>` 部分是可选的，用于指定变更的范围。例如，模块名称或组件名称。

### 描述（Description）
`<描述>` 部分必须使用 **中文**。

### 示例
- `feat(auth): 增加鸿蒙系统登录支持`
- `fix(home): 修复小屏幕上的组件溢出问题`
- `chore: 更新 flutter_lints 到 v5.0.0`

## 分支命名规范
所有分支命名建议使用 **小写字母**，单词间使用 **中划线 (-)** 连接。

### 主分支
- `main` / `master`: 主分支，保护分支，随时可部署。
- `develop`: 开发分支，保护分支，包含最新开发代码。

### 辅助分支
- `feature/<功能名>`: 功能开发分支。从 `develop` 切出，合并回 `develop`。
    - 示例: `feature/login-page`, `feature/user-profile`
- `fix/<bug描述>`: Bug 修复分支。从 `develop` 切出，合并回 `develop`。
    - 示例: `fix/login-error`, `fix/nav-bar-crash`
- `hotfix/<bug描述>`: 紧急修复分支。从 `main` 切出，合并回 `main` 和 `develop`。
    - 示例: `hotfix/payment-crash`, `hotfix/security-patch-v1.0.1`
- `release/<版本号>`: 版本发布分支。从 `develop` 切出，合并回 `main` 和 `develop`。
    - 示例: `release/v1.0.0`, `release/v2.1.0-beta`
- `chore/<任务描述>`: 杂项任务分支（构建、文档等）。
    - 示例: `chore/update-deps`, `chore/add-readme`
