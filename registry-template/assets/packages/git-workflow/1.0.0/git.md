# Git 工作流规范（默认版本）

## 分支命名

- 功能分支：`feat/<scope>-<short-desc>`
- 修复分支：`fix/<scope>-<short-desc>`
- 热修复分支：`hotfix/<scope>-<short-desc>`
- 重构分支：`refactor/<scope>-<short-desc>`

示例：

- `feat/auth-login-page`
- `fix/order-price-rounding`
- `hotfix/payment-timeout`

---

## 提交信息规范（Conventional Commits）

提交格式：

`<type>(<scope>): <subject>`

常用 `type`：

- `feat`：新功能
- `fix`：缺陷修复
- `refactor`：重构（不改功能）
- `perf`：性能优化
- `docs`：文档更新
- `test`：测试相关
- `chore`：构建/配置/杂项

要求：

- `subject` 使用简明中文或英文，聚焦“为什么改”
- 不要写无意义描述，如 `update`、`fix bug`

示例：

- `feat(auth): add passwordless login flow`
- `fix(order): 修复优惠券叠加导致金额异常`

---

## Pull Request 要求

- 标题清晰，能说明业务目标
- 描述包含：
  - 背景
  - 方案
  - 风险
  - 测试方式
- 至少 1 位相关模块负责人 review

---

## 提交前自检清单

1. 代码可编译
2. Lint 通过
3. 关键测试通过
4. 变更说明完整
5. 无无关文件变更（如临时日志、缓存文件）
