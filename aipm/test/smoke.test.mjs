/**
 * aipm 冒烟测试：以本地目录作为 registry，跑通 install / publish / update 主流程。
 *
 * 运行：node --test aipm/test/
 *
 * 每次运行都会在系统临时目录下新建：
 *   home/  —— 作为 HOME，隔离 ~/.aipmrc 与 ~/.aipm/cache
 *   reg/   —— 本地 registry（registry.json + profiles/ + assets/）
 *   author/、consumer/ —— 两个项目：author 负责修改并 publish，consumer 负责 update
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const AIPM = join(dirname(fileURLToPath(import.meta.url)), '..', 'aipm.mjs')
const PROFILE_ID = 'demo-dev'
const SKILL = '@demo/hello'
const RULE = '@demo/baseline'

let root
let home
let registry
let author
let consumer

function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, 'utf-8')
}

function frontmatterDoc(name, description, body) {
  return `---\nname: "${name}"\ndescription: "${description}"\n---\n\n${body}\n`
}

/** 在 registry 中放一个已发布版本（等价于 publish 后的目录结构）。 */
function seedArtifact(kind, registryPath, version, markerFile, body) {
  const dir = join(registry, 'assets', kind === 'skill' ? 'packages' : 'rules', registryPath, version)
  const logicalName = registryPath.split('/').pop()
  writeJson(join(dir, 'package.json'), {
    name: registryPath,
    version,
    aipm: { type: kind, sourceRegistry: 'default' },
    files: [markerFile, 'package.json'],
  })
  writeText(join(dir, markerFile), frontmatterDoc(logicalName, `${logicalName} ${kind}`, body))
}

function createFixtureRegistry() {
  writeJson(join(registry, 'registry.json'), {
    packages: { [SKILL]: { latest: '1.0.0', versions: ['1.0.0'], description: 'hello skill' } },
    rules: { [RULE]: { latest: '1.0.0', versions: ['1.0.0'], description: 'baseline rule' } },
  })
  writeJson(join(registry, 'profiles', `${PROFILE_ID}.json`), {
    skills: { [SKILL]: 'latest' },
    rules: { [RULE]: 'latest' },
  })
  seedArtifact('skill', SKILL, '1.0.0', 'SKILL.md', '# hello v1.0.0')
  seedArtifact('rule', RULE, '1.0.0', 'RULE.md', '# baseline v1.0.0')
}

function createProject(name) {
  const dir = join(root, name)
  writeJson(join(dir, 'aipm_profile.json'), {
    registry,
    profile: PROFILE_ID,
    skills: {},
    rules: {},
  })
  return dir
}

/** 以非交互方式运行 aipm（stdin 非 TTY），返回 { status, output }。 */
function aipm(cwd, ...args) {
  const env = { ...process.env, HOME: home, USERPROFILE: home }
  delete env.AIPM_REGISTRY_TOKEN
  const r = spawnSync(process.execPath, [AIPM, ...args], {
    cwd,
    env,
    input: '',
    encoding: 'utf-8',
    timeout: 60_000,
  })
  return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

function assertOk(result, label) {
  assert.equal(result.status, 0, `${label} exited with ${result.status}\n${result.output}`)
}

describe('aipm smoke: local registry', () => {
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'aipm-smoke-'))
    home = join(root, 'home')
    registry = join(root, 'reg')
    mkdirSync(home, { recursive: true })
    createFixtureRegistry()
    author = createProject('author')
    consumer = createProject('consumer')
  })

  after(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  test('--help exits 0', () => {
    const r = aipm(root, '--help')
    assertOk(r, 'aipm --help')
    assert.match(r.output, /Usage:/)
  })

  test('install: installs profile skills/rules into IDE dir and writes lock', () => {
    for (const project of [author, consumer]) {
      assertOk(aipm(project, 'install', '--ide=cursor'), 'aipm install')

      const skillMd = join(project, '.cursor/skills/demo_hello/SKILL.md')
      const ruleMd = join(project, '.cursor/rules/demo_baseline/RULE.md')
      assert.ok(existsSync(skillMd), 'skill SKILL.md installed')
      assert.ok(existsSync(ruleMd), 'rule RULE.md installed')
      assert.match(readFileSync(skillMd, 'utf-8'), /hello v1\.0\.0/)

      const lock = readJson(join(project, 'aipm_profile.lock.json'))
      assert.equal(lock.skills[SKILL].version, '1.0.0')
      assert.equal(lock.rules[RULE].version, '1.0.0')

      const ideProfile = readJson(join(project, '.aipm/profile.json'))
      assert.equal(ideProfile.ide, 'cursor')
    }
  })

  test('install is idempotent', () => {
    const r = aipm(author, 'install')
    assertOk(r, 'second aipm install')
    assert.match(r.output, /up-to-date/)
  })

  test('list and doctor succeed after install', () => {
    const list = aipm(author, 'list')
    assertOk(list, 'aipm list')
    assert.match(list.output, /ok @demo\/hello@1\.0\.0/)

    const doctor = aipm(author, 'doctor')
    assertOk(doctor, 'aipm doctor')
    assert.match(doctor.output, /doctor passed/)
  })

  test('publish: new version of an existing skill lands in the local registry', () => {
    const skillDir = join(author, '.cursor/skills/demo_hello')
    writeText(join(skillDir, 'SKILL.md'), frontmatterDoc('demo_hello', 'hello skill', '# hello v1.1.0'))
    const pkg = readJson(join(skillDir, 'package.json'))
    pkg.version = '1.1.0'
    writeJson(join(skillDir, 'package.json'), pkg)

    assertOk(aipm(author, 'publish', SKILL, '--publish-update-profile=yes'), 'aipm publish')

    const index = readJson(join(registry, 'registry.json'))
    assert.equal(index.packages[SKILL].latest, '1.1.0')
    assert.deepEqual(index.packages[SKILL].versions, ['1.0.0', '1.1.0'])

    const published = join(registry, 'assets/packages', SKILL, '1.1.0')
    assert.match(readFileSync(join(published, 'SKILL.md'), 'utf-8'), /hello v1\.1\.0/)
    const publishedPkg = readJson(join(published, 'package.json'))
    assert.equal(publishedPkg.version, '1.1.0')
    assert.ok(publishedPkg.filesIntegrity?.['SKILL.md'], 'filesIntegrity recorded')

    assert.equal(readJson(join(author, 'aipm_profile.json')).skills[SKILL], '1.1.0')
  })

  test('publish: re-publishing the same version is rejected', () => {
    const r = aipm(author, 'publish', SKILL, '--publish-update-profile=no')
    assert.notEqual(r.status, 0, `expected failure\n${r.output}`)
    assert.match(r.output, /already published/)
  })

  test('publish: a brand-new rule is added to the local registry', () => {
    const newRule = '@demo/extra'
    const ruleDir = join(author, '.cursor/rules/demo_extra')
    writeJson(join(ruleDir, 'package.json'), {
      name: newRule,
      version: '0.1.0',
      aipm: { type: 'rule', sourceRegistry: 'default' },
      files: ['RULE.md', 'package.json'],
    })
    writeText(join(ruleDir, 'RULE.md'), frontmatterDoc('extra', 'extra rule', '# extra v0.1.0'))
    const cfgPath = join(author, 'aipm_profile.json')
    const cfg = readJson(cfgPath)
    cfg.rules[newRule] = '0.1.0'
    writeJson(cfgPath, cfg)

    assertOk(aipm(author, 'publish', newRule, '--publish-update-profile=yes'), 'aipm publish new rule')

    const index = readJson(join(registry, 'registry.json'))
    assert.equal(index.rules[newRule].latest, '0.1.0')
    assert.ok(existsSync(join(registry, 'assets/rules', newRule, '0.1.0/RULE.md')))
  })

  test('update: consumer picks up the newly published version', () => {
    // 模拟 consumer 从仓库拉取了 author 提交的 aipm_profile.json（版本已升到 1.1.0）
    const cfgPath = join(consumer, 'aipm_profile.json')
    const cfg = readJson(cfgPath)
    cfg.skills[SKILL] = '1.1.0'
    writeJson(cfgPath, cfg)

    const r = aipm(consumer, 'update')
    assertOk(r, 'aipm update')
    assert.match(r.output, /demo_hello@1\.1\.0/)

    const skillMd = readFileSync(join(consumer, '.cursor/skills/demo_hello/SKILL.md'), 'utf-8')
    assert.match(skillMd, /hello v1\.1\.0/)
    const lock = readJson(join(consumer, 'aipm_profile.lock.json'))
    assert.equal(lock.skills[SKILL].version, '1.1.0')
    assert.equal(lock.rules[RULE].version, '1.0.0')

    assertOk(aipm(consumer, 'doctor'), 'aipm doctor after update')
  })
})
