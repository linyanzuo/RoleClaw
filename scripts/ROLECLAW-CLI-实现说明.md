# RoleClaw CLI 实现说明（Step 3）

本文说明 `scripts/roleclaw.mjs` 的核心实现逻辑，方便后续维护与扩展。

## 1) 核心职责

`roleclaw` 在阶段一聚焦 5 个核心命令：

| 命令 | 作用 | 备注 |
|---|---|---|
| `use-role` | 按岗位写入默认 Skills/Rules | 优先 `config.roleProfiles`，其次 `roles/<role>.json` |
| `sync` | 把声明的 Skills/Rules 安装到 `.cursor/` | skills -> `.cursor/skills/`，rules -> `.cursor/rules/` |
| `list` | 查看声明与安装状态 | 同时展示缺失与额外安装项 |
| `update` | 更新到最新版本 | 支持指定单个 artifact 或全部更新 |
| `doctor` | 做可用性自检 | 失败项返回非 0 退出码 |

维护约定：

- 后续新增、删除或调整 CLI 命令时，必须同步更新本表与对应说明。

## 2) 关键设计

### 双来源 Registry（本地/远程）

Registry 既可以是远程 URL，也可以是本地目录，便于阶段一快速迭代：

```js
function defaultRegistryRef() {
  const localRegistry = join(ROOT, 'registry-template')
  if (existsSync(localRegistry)) return './registry-template'
  return 'https://raw.githubusercontent.com/YOUR_ORG/cursor-skills-registry/main'
}
```

### 配置与岗位读取策略

项目配置入口统一为 `.roleclaw/config.json`，阶段一岗位来源优先级如下：

1. `.roleclaw/config.json` 的 `roleProfiles`
2. `registry-template/roles/<role>.json`
3. `registry-template/rbac/roles.json`（兼容）

```js
async function fetchRoleConfig(baseRef, config, role) {
  if (config.roleProfiles?.[role]) {
    return config.roleProfiles[role]
  }
  try {
    return await readJsonResource(baseRef, `roles/${role}.json`)
  } catch {
    const rbac = await fetchRbacRoles(baseRef)
    // ... fallback 到 rbac.roles[role]
  }
}
```

### 安装策略（覆盖式写入，避免脏文件）

每次安装某个 Skill/Rule 时先删除旧目录，再按 `files.json` 重新写入：

```js
const artifactDir = join(installRoot, name)
rmSync(artifactDir, { recursive: true, force: true })
mkdirSync(artifactDir, { recursive: true })
```

### Skills + Rules 合并策略

项目配置中的显式声明优先，岗位必备作为补充：

```js
const skills = { ...(config.skills ?? {}) }
const rules = { ...(config.rules ?? {}) }
for (const [name, version] of Object.entries(roleConfig.requiredSkills)) {
  if (!skills[name]) skills[name] = version
}
for (const [name, version] of Object.entries(roleConfig.requiredRules)) {
  if (!rules[name]) rules[name] = version
}
```

## 3) doctor 的检查层次

`doctor` 从外到内检查三层：

1. 配置层：`.roleclaw/config.json` / registry / role 是否可读
2. 索引层：registry 中是否存在目标 skill/rule 版本
3. 本地层：`.cursor/skills/<name>/SKILL.md` 与 `.cursor/rules/<name>/RULE.md` 是否存在

只要有失败项，命令会以非 0 退出，方便接入 CI 或脚本化验收。

## 4) 维护建议

- 继续保持 `SKILL.md` 仅包含 AI 运行时最小信息
- `RULE.md` 同样保持最小运行时信息，不混入治理字段
- 元数据扩展优先加在 `registry.json` / `roles/*.json`
- 新增命令时先补 `doctor` 对应检查项，避免功能可用但不可诊断
- 命令行为变更后，同步更新“核心命令表”和示例代码片段
