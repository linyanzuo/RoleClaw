# AIPM 待办

> 来源：Registry与版本管理方案.md

## Package 版本对比（Phase V）

### V1：实现 `aipm diff` 命令

- [ ] 新增 `aipm diff [name]` 命令
- [ ] 无参数：对比当前 profile 下所有 skills/rules
- [ ] 有参数：对比指定 name 的 skill 或 rule
- [ ] 逻辑：读取本地已安装版本，从 config 获取目标版本，拉取远程做文本 diff
- [ ] 输出格式：按文件（SKILL.md、RULE.md 等）分别输出 diff

### V2：`aipm update` 增加 `--preview` 选项

- [ ] `aipm update [name] --preview`：先执行 diff 逻辑，输出变更摘要，不执行安装
- [ ] `aipm update [name]`：保持现有行为，直接更新
- [ ] 依赖：V1
