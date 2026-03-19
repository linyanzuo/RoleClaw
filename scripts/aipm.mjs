#!/usr/bin/env node

import { createInterface } from 'node:readline'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import { fileURLToPath } from 'url'

function question(rl, promptText, defaultValue = '') {
  const suffix = defaultValue ? ` [${defaultValue}]` : ''
  return new Promise((resolve) => {
    rl.question(`${promptText}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue)
    })
  })
}

const VERSION_MARKER = '.aipm'

/** Semver-style compare: returns 1 if a>b, -1 if a<b, 0 if equal, null if unparseable */
function semverCompare(a, b) {
  if (a === b) return 0
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return null
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1
  }
  return 0
}

function parseSemver(v) {
  const m = String(v).trim().match(/^(\d+)\.(\d+)\.(\d+)/)
  return m ? [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)] : null
}

function parseConflictMode(args = []) {
  const byFlag = args.find((a) => a.startsWith('--on-conflict='))
  const mode = byFlag ? byFlag.split('=')[1] : 'ask'
  if (!['ask', 'skip', 'overwrite'].includes(mode)) {
    throw new Error("Invalid --on-conflict value. Use 'ask', 'skip', or 'overwrite'.")
  }
  return mode
}

async function promptConflictAction(message, conflictState) {
  if (conflictState.mode === 'skip') return 'skip'
  if (conflictState.mode === 'overwrite') return 'overwrite'

  if (!process.stdin.isTTY) {
    throw new Error(`${message}. Non-interactive shell cannot ask; pass --on-conflict=skip|overwrite`)
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = (await question(
    rl,
    `${message}\nChoose [s]kip / [o]verwrite / s! (skip all) / o! (overwrite all)`,
    's',
  )).toLowerCase()
  rl.close()

  if (answer === 'o!') {
    conflictState.mode = 'overwrite'
    return 'overwrite'
  }
  if (answer === 's!') {
    conflictState.mode = 'skip'
    return 'skip'
  }
  if (answer === 'o' || answer === 'overwrite') return 'overwrite'
  return 'skip'
}

/** Read installed version from artifactDir/.aipm. Returns { version, registryPath? } or null. */
function readInstalledVersion(artifactDir) {
  const markerPath = join(artifactDir, VERSION_MARKER)
  if (!existsSync(markerPath)) return null
  try {
    const raw = readFileSync(markerPath, 'utf-8')
    const obj = JSON.parse(raw)
    if (!obj?.version) return null
    const result = { version: String(obj.version) }
    if (obj.registryPath) result.registryPath = String(obj.registryPath)
    return result
  } catch {
    return null
  }
}

const ROOT = process.cwd()
const SCRIPT_FILE = fileURLToPath(import.meta.url)
const TOOL_ROOT = resolve(dirname(SCRIPT_FILE), '..')
const AIPM_DIR = join(ROOT, '.aipm')
const CONFIG_FILE = join(AIPM_DIR, 'config.json')
const PACKAGE_JSON = join(ROOT, 'package.json')

const IDE_DIR_MAP = {
  cursor: '.cursor',
  codex: '.codex',
}

const ARTIFACT_KIND = {
  skill: {
    registryKey: 'packages',
    registryDir: 'assets/packages',
    markerFile: 'SKILL.md',
  },
  rule: {
    registryKey: 'rules',
    registryDir: 'assets/rules',
    markerFile: 'RULE.md',
  },
}

function isUrl(value) {
  return /^https?:\/\//.test(value)
}

function joinUrl(base, relativePath) {
  return `${base.replace(/\/+$/, '')}/${relativePath.replace(/^\/+/, '')}`
}

function resolveLocalBase(baseRef) {
  return isAbsolute(baseRef) ? baseRef : resolve(ROOT, baseRef)
}

function defaultRegistryRef() {
  // 1) Prefer workspace-local registry for same-repo iteration.
  const localRegistry = join(ROOT, 'registry-template')
  const hasLocalRegistry = existsSync(localRegistry)
  console.log(`[aipm][registry-check] local: ${localRegistry} -> ${hasLocalRegistry ? 'FOUND' : 'NOT_FOUND'}`)
  if (hasLocalRegistry) {
    console.log('[aipm][registry-check] selected: local registry')
    return './registry-template'
  }

  // 2) If aipm is called globally, fall back to bundled registry.
  const bundledRegistry = join(TOOL_ROOT, 'registry-template')
  const hasBundledRegistry = existsSync(bundledRegistry)
  console.log(`[aipm][registry-check] bundled: ${bundledRegistry} -> ${hasBundledRegistry ? 'FOUND' : 'NOT_FOUND'}`)
  if (hasBundledRegistry) {
    console.log('[aipm][registry-check] selected: bundled registry')
    return bundledRegistry
  }

  // 3) Final fallback: user-provided remote registry.
  console.log('[aipm][registry-check] selected: fallback remote registry')
  return 'https://raw.githubusercontent.com/YOUR_ORG/cursor-skills-registry/main'
}

function defaultConfig() {
  return {
    registry: defaultRegistryRef(),
    ide: 'cursor',
    skills: {},
    rules: {},
  }
}

function ensureAipmDir() {
  mkdirSync(AIPM_DIR, { recursive: true })
}

function resolveIde(config) {
  const ide = (config.ide ?? 'cursor').toLowerCase()
  if (!IDE_DIR_MAP[ide]) {
    throw new Error(`Unsupported ide '${config.ide}'. Supported: ${Object.keys(IDE_DIR_MAP).join(', ')}`)
  }
  return ide
}

function getInstallPaths(config) {
  const ide = resolveIde(config)
  const ideRootDir = join(ROOT, IDE_DIR_MAP[ide])
  return {
    ide,
    ideRootDir,
    skillInstallDir: join(ideRootDir, 'skills'),
    ruleInstallDir: join(ideRootDir, 'rules'),
  }
}

function ensureIdeDirs(paths) {
  const { ideRootDir, skillInstallDir, ruleInstallDir } = paths
  if (existsSync(ideRootDir)) {
    if (!statSync(ideRootDir).isDirectory()) {
      throw new Error(
        `'${ideRootDir}' exists but is not a directory. Remove it or use a different workspace.`,
      )
    }
  } else {
    mkdirSync(ideRootDir, { recursive: true })
  }
  mkdirSync(skillInstallDir, { recursive: true })
  mkdirSync(ruleInstallDir, { recursive: true })
}

function writeConfig(data) {
  ensureAipmDir()
  writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

/** Read config from package.json aipm or .aipm/config.json (npm-style). */
function readConfig() {
  if (existsSync(PACKAGE_JSON)) {
    try {
      const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf-8'))
      if (pkg.aipm && typeof pkg.aipm === 'object') {
        return mergeConfig(defaultConfig(), pkg.aipm)
      }
    } catch {}
  }
  if (existsSync(CONFIG_FILE)) {
    return mergeConfig(defaultConfig(), JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')))
  }
  throw new Error('aipm config not found. Add "aipm" to package.json or run: aipm init')
}

function readConfigOrDefault() {
  if (existsSync(PACKAGE_JSON)) {
    try {
      const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf-8'))
      if (pkg.aipm && typeof pkg.aipm === 'object') {
        return mergeConfig(defaultConfig(), pkg.aipm)
      }
    } catch {}
  }
  if (existsSync(CONFIG_FILE)) {
    return mergeConfig(defaultConfig(), JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')))
  }
  return defaultConfig()
}

function mergeConfig(base, overrides) {
  return {
    ...base,
    registry: overrides.registry ?? base.registry,
    ide: overrides.ide ?? base.ide,
    profile: overrides.profile ?? base.profile,
    skills: { ...(base.skills ?? {}), ...(overrides.skills ?? {}) },
    rules: { ...(base.rules ?? {}), ...(overrides.rules ?? {}) },
  }
}

async function readJsonResource(baseRef, relativePath) {
  if (isUrl(baseRef)) {
    const url = joinUrl(baseRef, relativePath)
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Unable to read ${relativePath} (${response.status})`)
    }
    return await response.json()
  }

  const absolutePath = join(resolveLocalBase(baseRef), relativePath)
  return JSON.parse(readFileSync(absolutePath, 'utf-8'))
}

async function readTextResource(baseRef, relativePath) {
  if (isUrl(baseRef)) {
    const url = joinUrl(baseRef, relativePath)
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Unable to read ${relativePath} (${response.status})`)
    }
    return await response.text()
  }

  const absolutePath = join(resolveLocalBase(baseRef), relativePath)
  return readFileSync(absolutePath, 'utf-8')
}

function normalizeArtifactMap(value) {
  if (!value) {
    return {}
  }

  if (Array.isArray(value)) {
    return Object.fromEntries(value.map((name) => [name, 'latest']))
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([name]) => Boolean(name))
        .map(([name, version]) => [name, typeof version === 'string' ? version : 'latest']),
    )
  }

  return {}
}

async function fetchRegistry(baseRef) {
  return await readJsonResource(baseRef, 'registry.json')
}

const SCOPE_MAX_LEN = 16
const NAME_MAX_LEN = 24
const PART_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Validate registry path. scope/name cannot use _; scope≤16 chars, name≤24 chars. */
function validateRegistryPath(registryPath, kindLabel = 'Package') {
  if (registryPath.includes('_')) {
    throw new Error(
      `${kindLabel} '${registryPath}': scope 与 name 不能包含下划线 _，因其用于 scope 与 name 的分隔`,
    )
  }
  if (registryPath.startsWith('@') && registryPath.includes('/')) {
    const rest = registryPath.slice(1)
    const [scope, ...nameParts] = rest.split('/')
    const name = nameParts.join('/')
    if (!PART_PATTERN.test(scope)) {
      throw new Error(
        `${kindLabel} '${registryPath}': scope 仅允许小写字母、数字、连字符，且不能含 _`,
      )
    }
    if (scope.length > SCOPE_MAX_LEN) {
      throw new Error(
        `${kindLabel} '${registryPath}': scope 不得超过 ${SCOPE_MAX_LEN} 个字符`,
      )
    }
    if (!PART_PATTERN.test(name)) {
      throw new Error(
        `${kindLabel} '${registryPath}': name 仅允许小写字母、数字、连字符，且不能含 _`,
      )
    }
    if (name.length > NAME_MAX_LEN) {
      throw new Error(
        `${kindLabel} '${registryPath}': name 不得超过 ${NAME_MAX_LEN} 个字符`,
      )
    }
  } else {
    if (registryPath.includes('_')) {
      throw new Error(
        `${kindLabel} '${registryPath}': 无 scope 时 name 不能包含下划线 _`,
      )
    }
    if (!PART_PATTERN.test(registryPath)) {
      throw new Error(
        `${kindLabel} '${registryPath}': name 仅允许小写字母、数字、连字符`,
      )
    }
    if (registryPath.length > NAME_MAX_LEN) {
      throw new Error(
        `${kindLabel} '${registryPath}': name 不得超过 ${NAME_MAX_LEN} 个字符`,
      )
    }
  }
}

/**
 * Registry path -> IDE install name. Ensures unique skill names for AI (Agent Skills spec: name = parent dir).
 * @frontend-engineer/git-workflow -> frontend-engineer_git-workflow (no name collision with git-workflow)
 * git-workflow -> git-workflow (unchanged)
 */
function registryPathToInstallName(registryPath) {
  if (registryPath.startsWith('@') && registryPath.includes('/')) {
    const rest = registryPath.slice(1)
    return rest.replace('/', '_')
  }
  return registryPath
}

/**
 * Install name -> registry path. Reverse of registryPathToInstallName.
 * frontend-engineer_git-workflow -> @frontend-engineer/git-workflow
 */
function installNameToRegistryPath(installName) {
  if (installName.includes('_')) {
    const idx = installName.indexOf('_')
    return `@${installName.slice(0, idx)}/${installName.slice(idx + 1)}`
  }
  return installName
}

/** Parse install dir name to registry path. Prefer .aipm.registryPath if present. */
function parseInstallNameToRegistryPath(installName, aipmRegistryPath = null) {
  const registryPath = aipmRegistryPath ?? installNameToRegistryPath(installName)
  const logicalName = registryPath.includes('/') ? registryPath.split('/').pop() : registryPath
  return { registryPath, logicalName }
}

/** Resolve artifact by package name (npm-style). Returns installName for IDE (unique, Agent Skills compliant). */
function resolveArtifactPath(registry, kind, packageName, requestedVersion) {
  const index = registry?.[kind === 'skill' ? 'packages' : 'rules']
  const kindLabel = kind === 'skill' ? 'Skill' : 'Rule'

  validateRegistryPath(packageName, kindLabel)

  const item = index?.[packageName]
  if (!item) {
    throw new Error(`${kindLabel} '${packageName}' was not found in registry`)
  }

  const version = resolveVersionFromItem(item, requestedVersion, kindLabel, packageName)
  const installName = registryPathToInstallName(packageName)
  return { registryPath: packageName, installName, version }
}

function resolveVersionFromItem(item, requested, kindLabel, name) {
  if (!requested || requested === 'latest') return item.latest
  if (requested.startsWith('^')) {
    const major = requested.slice(1).split('.')[0]
    const compatible = [...(item.versions ?? [])].filter((v) => v.startsWith(`${major}.`)).sort().at(-1)
    if (!compatible) throw new Error(`No compatible version for ${kindLabel} ${name}: ${requested}`)
    return compatible
  }
  if (!(item.versions ?? []).includes(requested)) {
    throw new Error(`${kindLabel} ${name}@${requested} was not found in registry`)
  }
  return requested
}

function resolveVersion(index, name, requested, kindLabel) {
  const item = index?.[name]
  if (!item) {
    throw new Error(`${kindLabel} '${name}' was not found in registry`)
  }

  if (!requested || requested === 'latest') {
    return item.latest
  }

  if (requested.startsWith('^')) {
    const major = requested.slice(1).split('.')[0]
    const compatible = [...(item.versions ?? [])]
      .filter((version) => version.startsWith(`${major}.`))
      .sort()
      .at(-1)

    if (!compatible) {
      throw new Error(`No compatible version for ${kindLabel} ${name}: ${requested}`)
    }

    return compatible
  }

  if (!(item.versions ?? []).includes(requested)) {
    throw new Error(`${kindLabel} ${name}@${requested} was not found in registry`)
  }

  return requested
}

async function installArtifact(baseRef, kind, registryPath, version, options = {}) {
  const kindConfig = ARTIFACT_KIND[kind]
  const installRoot = kindConfig.installDir
  const installName = options.installName ?? registryPathToInstallName(registryPath)
  const conflictState = options.conflictState ?? { mode: 'ask' }

  process.stdout.write(`Installing ${kind} ${installName}@${version} `)

  const files = await readJsonResource(
    baseRef,
    `${kindConfig.registryDir}/${registryPath}/${version}/files.json`,
  )
  const artifactDir = join(installRoot, installName)

  if (existsSync(artifactDir)) {
    const stat = statSync(artifactDir)
    if (!stat.isDirectory()) {
      const action = await promptConflictAction(
        `[conflict] '${relative(ROOT, artifactDir)}' exists and is not a directory`,
        conflictState,
      )
      if (action === 'skip') {
        console.log(' skipped')
        return { installed: false, skipped: true }
      }
      rmSync(artifactDir, { recursive: true, force: true })
    } else {
      const installed = readInstalledVersion(artifactDir)
      if (installed) {
        const cmp = semverCompare(installed.version, version)
        if (cmp === 0) {
          console.log(' up-to-date')
          return { installed: false, skipped: true }
        }
        if (cmp > 0) {
          console.log(` skipped (installed ${installed.version} > target ${version})`)
          return { installed: false, skipped: true }
        }
        const msg =
          cmp === -1
            ? `[newer] ${installName}: installed ${installed.version} -> ${version}. Overwrite?`
            : `[conflict] ${installName}: cannot compare versions (installed ${installed.version} vs target ${version}). Overwrite?`
        const action = await promptConflictAction(msg, conflictState)
        if (action === 'skip') {
          console.log(' skipped')
          return { installed: false, skipped: true }
        }
      } else {
        const action = await promptConflictAction(
          `[conflict] '${relative(ROOT, artifactDir)}' exists but has no .aipm (not from aipm). Overwrite?`,
          conflictState,
        )
        if (action === 'skip') {
          console.log(' skipped')
          return { installed: false, skipped: true }
        }
      }
      rmSync(artifactDir, { recursive: true, force: true })
    }
  }
  mkdirSync(artifactDir, { recursive: true })

  for (const file of files) {
    let content = await readTextResource(baseRef, `${kindConfig.registryDir}/${registryPath}/${version}/${file}`)
    const targetPath = join(artifactDir, file)
    mkdirSync(dirname(targetPath), { recursive: true })
    if (file === 'SKILL.md' && kind === 'skill' && installName !== registryPath) {
      content = patchSkillNameInFrontmatter(content, installName)
    }
    if (file === 'RULE.md' && kind === 'rule' && installName !== registryPath) {
      content = patchSkillNameInFrontmatter(content, installName)
    }
    writeFileSync(targetPath, content, 'utf-8')
    process.stdout.write('.')
  }

  const markerPath = join(artifactDir, VERSION_MARKER)
  const markerContent = { version, registryPath }
  writeFileSync(markerPath, JSON.stringify(markerContent, null, 0), 'utf-8')

  console.log(' ok')
  return { installed: true, skipped: false }
}

/** Load profile (配置单) from registry. Returns { skills, rules } or null if not found. */
async function loadProfileConfig(registryRef, profileId) {
  const profilePath = `profiles/${profileId}.json`
  try {
    const profileData = await readJsonResource(registryRef, profilePath)
    const skills = normalizeArtifactMap(profileData.skills ?? {})
    const rules = normalizeArtifactMap(profileData.rules ?? {})
    return { skills, rules }
  } catch {
    return null
  }
}

/** Return desired artifacts from config. When config.profile is set, load profile from registry and merge with explicit config (explicit overrides profile). */
async function resolveDesiredArtifacts(config) {
  let skills = {}
  let rules = {}

  if (config.profile) {
    const profileArtifacts = await loadProfileConfig(config.registry, config.profile)
    if (profileArtifacts) {
      skills = profileArtifacts.skills
      rules = profileArtifacts.rules
    }
  }

  const explicitSkills = normalizeArtifactMap(config.skills ?? {})
  const explicitRules = normalizeArtifactMap(config.rules ?? {})
  skills = { ...skills, ...explicitSkills }
  rules = { ...rules, ...explicitRules }

  return { skills, rules }
}

/** List installed dir names (flat: git-workflow, frontend-engineer_git-workflow). */
function listInstalledDirs(baseDir) {
  if (!existsSync(baseDir)) return []
  return readdirSync(baseDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

/** Patch name field in YAML frontmatter to match installName (Agent Skills: name = parent dir). */
function patchSkillNameInFrontmatter(content, installName) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!match) return content
  const block = match[1]
  const patched = block.replace(/name:\s*["']?[^"'\n]+["']?/m, `name: "${installName}"`)
  return content.replace(match[0], `---\n${patched}\n---`)
}

/** Parse name and description from SKILL.md or RULE.md frontmatter. */
function parseArtifactFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!match) return {}
  const block = match[1]
  const name = block.match(/name:\s*["']([^"']+)["']/)?.[1]
  const description = block.match(/description:\s*["']([^"']+)["']/)?.[1]
  return { name, description }
}

/** Recursively list all files under dir, paths relative to dir. */
function listFilesRecursive(dir, baseDir = dir) {
  if (!existsSync(dir)) return []
  const entries = readdirSync(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(fullPath, baseDir))
    } else if (entry.isFile()) {
      files.push(relative(baseDir, fullPath).replace(/\\/g, '/'))
    }
  }
  return files.sort()
}

function printDeclaredAndInstalled(title, declared, installDir, markerFile) {
  const installed = new Set(listInstalledDirs(installDir))
  const entries = Object.entries(declared)

  if (!entries.length) {
    console.log(`${title}: (none)`)
  } else {
    console.log(`\n${title}:`)
    for (const [name, version] of entries) {
      const ok = existsSync(join(installDir, name, markerFile))
      console.log(`- ${ok ? 'ok' : 'missing'} ${name}@${version}`)
      installed.delete(name)
    }
  }

  if (installed.size) {
    console.log(`\nextra installed ${title}:`)
    for (const name of [...installed]) {
      console.log(`- ${name}`)
    }
  }
}

function printDeclaredAndInstalledResolved(title, resolved, installDir, markerFile) {
  const installed = new Set(listInstalledDirs(installDir))
  if (!resolved.length) {
    console.log(`${title}: (none)`)
  } else {
    console.log(`\n${title}:`)
    for (const { logicalName, installName, version } of resolved) {
      const ok = existsSync(join(installDir, installName, markerFile))
      console.log(`- ${ok ? 'ok' : 'missing'} ${logicalName}@${version}`)
      installed.delete(installName)
    }
  }
  if (installed.size) {
    console.log(`\nextra installed ${title}:`)
    for (const name of [...installed]) {
      console.log(`- ${name}`)
    }
  }
}

function parseInitRegistry(args) {
  const i = args.indexOf('--registry')
  if (i >= 0 && args[i + 1]) return args[i + 1]
  const eq = args.find((a) => a.startsWith('--registry='))
  if (eq) return eq.slice('--registry='.length)
  return process.env.AIPM_REGISTRY || defaultRegistryRef()
}

async function cmdInit(args = []) {
  const hasPkgAipm =
    existsSync(PACKAGE_JSON) &&
    (() => {
      try {
        const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf-8'))
        return pkg.aipm && typeof pkg.aipm === 'object'
      } catch {
        return false
      }
    })()
  if (hasPkgAipm || existsSync(CONFIG_FILE)) {
    console.log('aipm config already exists, skip')
    return
  }

  if (!process.stdin.isTTY) {
    console.error('aipm init requires interactive mode. Run in a terminal.')
    process.exitCode = 1
    return
  }

  const registryRef = parseInitRegistry(args)
  const config = defaultConfig()
  config.registry = registryRef

  const rl = createInterface({ input: process.stdin, output: process.stdout })

  console.log('\nSupported IDEs:')
  const ideList = Object.keys(IDE_DIR_MAP)
  ideList.forEach((ide, i) => {
    console.log(`  ${i + 1}. ${ide}`)
  })
  const ideChoice = await question(rl, '\nSelect IDE (1-2)', '1')
  const ideIndex = parseInt(ideChoice, 10)
  config.ide = ideList[ideIndex - 1] ?? 'cursor'

  const profiles = listAvailableProfiles(registryRef)
  if (profiles.length) {
    console.log('\nAvailable profiles (optional, press Enter to skip):')
    profiles.forEach((p, i) => {
      console.log(`  ${i + 1}. ${p}`)
    })
    console.log(`  ${profiles.length + 1}. (none - configure skills manually)`)
    const profileChoice = await question(rl, `Select profile (1-${profiles.length + 1})`, String(profiles.length + 1))
    const profileIndex = parseInt(profileChoice, 10)
    if (profileIndex >= 1 && profileIndex <= profiles.length) {
      config.profile = profiles[profileIndex - 1]
    }
  }

  rl.close()

  config.skills ??= {}
  config.rules ??= {}

  writeConfig(config)
  console.log('\ncreated .aipm/config.json')
  console.log(`registry: ${config.registry}`)
  console.log(`ide: ${config.ide}`)
  if (config.profile) {
    console.log(`profile: ${config.profile}`)
  }
  console.log('Run `aipm pull` to install skills and rules.')
}

async function cmdPull(...args) {
  const config = readConfig()
  const { skills, rules } = await resolveDesiredArtifacts(config)
  const registry = await fetchRegistry(config.registry)
  const installPaths = getInstallPaths(config)
  const conflictState = { mode: parseConflictMode(args) }
  const explicitSkills = new Set(Object.keys(config.skills ?? {}))
  const explicitRules = new Set(Object.keys(config.rules ?? {}))

  ensureIdeDirs(installPaths)

  for (const [packageName, requestedVersion] of Object.entries(skills)) {
    const { registryPath, installName, version } = resolveArtifactPath(
      registry,
      'skill',
      packageName,
      requestedVersion,
    )
    ARTIFACT_KIND.skill.installDir = installPaths.skillInstallDir
    const result = await installArtifact(config.registry, 'skill', registryPath, version, {
      installName,
      conflictState,
    })
    if (result.installed && explicitSkills.has(packageName)) {
      config.skills[packageName] = version
    }
  }

  for (const [packageName, requestedVersion] of Object.entries(rules)) {
    const { registryPath, installName, version } = resolveArtifactPath(
      registry,
      'rule',
      packageName,
      requestedVersion,
    )
    ARTIFACT_KIND.rule.installDir = installPaths.ruleInstallDir
    const result = await installArtifact(config.registry, 'rule', registryPath, version, {
      installName,
      conflictState,
    })
    if (result.installed && explicitRules.has(packageName)) {
      config.rules[packageName] = version
    }
  }

  if (config.profile) {
    const desiredSkillNames = new Set(Object.keys(skills).map((n) => registryPathToInstallName(n)))
    const desiredRuleNames = new Set(Object.keys(rules).map((n) => registryPathToInstallName(n)))
    for (const installName of listInstalledDirs(installPaths.skillInstallDir)) {
      if (!desiredSkillNames.has(installName)) {
        const dir = join(installPaths.skillInstallDir, installName)
        if (readInstalledVersion(dir)) {
          rmSync(dir, { recursive: true, force: true })
          console.log(`Removed ${installName} (not in profile)`)
        }
      }
    }
    for (const installName of listInstalledDirs(installPaths.ruleInstallDir)) {
      if (!desiredRuleNames.has(installName)) {
        const dir = join(installPaths.ruleInstallDir, installName)
        if (readInstalledVersion(dir)) {
          rmSync(dir, { recursive: true, force: true })
          console.log(`Removed ${installName} (not in profile)`)
        }
      }
    }
  }

  writeConfig(config)
  console.log('pull complete')
}

async function cmdList() {
  const config = readConfigOrDefault()
  const { skills, rules } = await resolveDesiredArtifacts(config)
  const registry = await fetchRegistry(config.registry)
  const installPaths = getInstallPaths(config)

  console.log(`registry: ${config.registry}`)
  console.log(`ide: ${resolveIde(config)}`)
  if (config.profile) {
    console.log(`profile: ${config.profile}`)
  }

  const skillsResolved = Object.entries(skills).map(([n, v]) => {
    const r = resolveArtifactPath(registry, 'skill', n, v)
    return { logicalName: n, installName: r.installName, version: r.version }
  })
  const rulesResolved = Object.entries(rules).map(([n, v]) => {
    const r = resolveArtifactPath(registry, 'rule', n, v)
    return { logicalName: n, installName: r.installName, version: r.version }
  })

  printDeclaredAndInstalledResolved('declared skills', skillsResolved, installPaths.skillInstallDir, 'SKILL.md')
  printDeclaredAndInstalledResolved('declared rules', rulesResolved, installPaths.ruleInstallDir, 'RULE.md')
}

async function cmdUpdate(name, ...args) {
  const config = readConfig()
  const { skills, rules } = await resolveDesiredArtifacts(config)
  const registry = await fetchRegistry(config.registry)
  const installPaths = getInstallPaths(config)
  const conflictState = { mode: parseConflictMode(args) }

  ensureIdeDirs(installPaths)

  const skillTargets = name
    ? (skills[name] ? [name] : Object.keys(skills).filter((k) => registryPathToInstallName(k) === name))
    : Object.keys(skills)
  const ruleTargets = name
    ? (rules[name] ? [name] : Object.keys(rules).filter((k) => registryPathToInstallName(k) === name))
    : Object.keys(rules)

  if (name && !skillTargets.length && !ruleTargets.length) {
    throw new Error(`'${name}' is not declared in current skills/rules`)
  }

  for (const packageName of skillTargets) {
    const { registryPath, installName, version } = resolveArtifactPath(
      registry,
      'skill',
      packageName,
      'latest',
    )
    ARTIFACT_KIND.skill.installDir = installPaths.skillInstallDir
    const result = await installArtifact(config.registry, 'skill', registryPath, version, {
      installName,
      conflictState,
    })
    if (result.installed && (config.skills ?? {})[packageName] !== undefined) {
      config.skills[packageName] = version
    }
  }

  for (const packageName of ruleTargets) {
    const { registryPath, installName, version } = resolveArtifactPath(
      registry,
      'rule',
      packageName,
      'latest',
    )
    ARTIFACT_KIND.rule.installDir = installPaths.ruleInstallDir
    const result = await installArtifact(config.registry, 'rule', registryPath, version, {
      installName,
      conflictState,
    })
    if (result.installed && (config.rules ?? {})[packageName] !== undefined) {
      config.rules[packageName] = version
    }
  }

  writeConfig(config)
  console.log('update complete')
}

async function cmdDoctor() {
  let failures = 0

  const hasPkgAipm =
    existsSync(PACKAGE_JSON) &&
    (() => {
      try {
        const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf-8'))
        return pkg.aipm && typeof pkg.aipm === 'object'
      } catch {
        return false
      }
    })()
  const hasAipmConfig = existsSync(CONFIG_FILE)

  if (!hasPkgAipm && !hasAipmConfig) {
    console.log('[fail] aipm config not found (package.json aipm or .aipm/config.json)')
    console.log('run `aipm init` first')
    process.exitCode = 1
    return
  }

  console.log('[ok] config exists')

  const config = readConfig()
  const installPaths = getInstallPaths(config)
  let registry

  try {
    registry = await fetchRegistry(config.registry)
    console.log('[ok] registry is reachable')
  } catch (error) {
    console.log(`[fail] registry check failed: ${error.message}`)
    failures += 1
  }

  ensureIdeDirs(installPaths)
  console.log(`[ok] install directories are ready (${installPaths.ideRootDir})`)

  const { skills, rules } = await resolveDesiredArtifacts(config)

  for (const [packageName, requestedVersion] of Object.entries(skills)) {
    try {
      if (!registry) {
        throw new Error('registry is unavailable')
      }
      const { installName, version } = resolveArtifactPath(
        registry,
        'skill',
        packageName,
        requestedVersion,
      )
      console.log(`[ok] registry contains skill ${packageName}@${version}`)

      if (existsSync(join(installPaths.skillInstallDir, installName, 'SKILL.md'))) {
        console.log(`[ok] installed skill is present: ${packageName}`)
      } else {
        console.log(`[fail] installed skill is missing: ${packageName}`)
        failures += 1
      }
    } catch (error) {
      console.log(`[fail] skill check failed for ${packageName}: ${error.message}`)
      failures += 1
    }
  }

  for (const [packageName, requestedVersion] of Object.entries(rules)) {
    try {
      if (!registry) {
        throw new Error('registry is unavailable')
      }
      const { installName, version } = resolveArtifactPath(
        registry,
        'rule',
        packageName,
        requestedVersion,
      )
      console.log(`[ok] registry contains rule ${packageName}@${version}`)

      if (existsSync(join(installPaths.ruleInstallDir, installName, 'RULE.md'))) {
        console.log(`[ok] installed rule is present: ${packageName}`)
      } else {
        console.log(`[fail] installed rule is missing: ${packageName}`)
        failures += 1
      }
    } catch (error) {
      console.log(`[fail] rule check failed for ${packageName}: ${error.message}`)
      failures += 1
    }
  }

  if (!Object.keys(skills).length) {
    console.log('[ok] no declared skills')
  }
  if (!Object.keys(rules).length) {
    console.log('[ok] no declared rules')
  }

  if (failures) {
    console.log(`doctor finished with ${failures} issue(s)`)
    process.exitCode = 1
    return
  }

  console.log('doctor passed')
}

/** List available profile IDs from registry (local only). */
function listAvailableProfiles(registryRef) {
  if (isUrl(registryRef)) return []
  const profilesDir = join(resolveLocalBase(registryRef), 'profiles')
  if (!existsSync(profilesDir) || !statSync(profilesDir).isDirectory()) return []
  return readdirSync(profilesDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name.replace(/\.json$/, ''))
    .sort()
}

async function cmdUse(profileId) {
  if (!profileId) {
    const config = readConfigOrDefault()
    const profiles = listAvailableProfiles(config.registry)
    if (!profiles.length) {
      console.log('No profiles found in registry. Add profiles/*.json to your registry.')
      return
    }
    console.log('Available profiles:')
    profiles.forEach((p) => console.log(`  - ${p}`))
    console.log('\nUsage: aipm use <profile-id>')
    return
  }

  const config = readConfigOrDefault()
  const profileData = await loadProfileConfig(config.registry, profileId)
  if (!profileData) {
    throw new Error(`Profile '${profileId}' not found. Check registry has profiles/${profileId}.json`)
  }

  ensureAipmDir()
  config.profile = profileId
  config.skills = {}
  config.rules = {}
  writeConfig(config)

  console.log(`Switched to profile: ${profileId}`)
  console.log('Run `aipm pull` to sync skills and rules.')
}

async function cmdAdd(name, version = 'latest') {
  if (!name) {
    throw new Error('Usage: aipm add <name> [version]  (name: git-workflow or @scope/git-workflow)')
  }

  const config = readConfigOrDefault()
  const registry = await fetchRegistry(config.registry)
  const { registryPath, installName, version: resolvedVersion } = resolveArtifactPath(
    registry,
    'skill',
    name,
    version,
  )
  const installPaths = getInstallPaths(config)

  ensureIdeDirs(installPaths)
  ARTIFACT_KIND.skill.installDir = installPaths.skillInstallDir
  await installArtifact(config.registry, 'skill', registryPath, resolvedVersion, {
    installName,
  })

  config.skills[name] = resolvedVersion
  writeConfig(config)

  console.log(`added skill ${name}@${resolvedVersion}`)
}

async function cmdRemove(name) {
  if (!name) {
    throw new Error('Usage: aipm remove <name>  (name: git-workflow or @scope/git-workflow)')
  }

  const config = readConfig()
  const installPaths = getInstallPaths(config)

  const toRemove = []
  try {
    const registry = await fetchRegistry(config.registry)
    if (config.skills?.[name]) {
      const r = resolveArtifactPath(registry, 'skill', name, config.skills[name])
      toRemove.push({ kind: 'skill', installName: r.installName })
    }
    if (config.rules?.[name]) {
      const r = resolveArtifactPath(registry, 'rule', name, config.rules[name])
      toRemove.push({ kind: 'rule', installName: r.installName })
    }
  } catch {
    toRemove.push({ kind: 'skill', installName: name }, { kind: 'rule', installName: name })
  }

  for (const { kind, installName } of toRemove) {
    const dir = kind === 'skill' ? installPaths.skillInstallDir : installPaths.ruleInstallDir
    rmSync(join(dir, installName), { recursive: true, force: true })
  }

  if (config.skills?.[name]) delete config.skills[name]
  if (config.rules?.[name]) delete config.rules[name]
  writeConfig(config)

  console.log(`removed artifact ${name} (if existed)`)
}

/**
 * Push IDE-installed skills/rules back to local registry.
 * Only works when config.registry is a local path (not URL).
 * Source: .<ide>/skills/ and .<ide>/rules/ (relative to workspace root where .aipm/config.json lives)
 */
async function cmdPush(...args) {
  const filtered = args.filter((a) => !a.startsWith('-'))
  const name = filtered[0]
  const config = readConfig()
  if (isUrl(config.registry)) {
    throw new Error(
      'push only works with local registry. Your registry is a URL. ' +
        'To contribute changes, edit the registry repo directly and submit a PR.',
    )
  }

  const verbose = args.includes('--verbose') || args.includes('-v')
  const registryBase = resolveLocalBase(config.registry)
  const { skills, rules } = await resolveDesiredArtifacts(config)
  const registry = await fetchRegistry(config.registry)
  const installPaths = getInstallPaths(config)

  if (verbose) {
    console.log(`[push] workspace root: ${ROOT}`)
    console.log(`[push] registry: ${registryBase}`)
    console.log(`[push] source: ${installPaths.skillInstallDir} + ${installPaths.ruleInstallDir}`)
  }

  const skillTargets = name
    ? (skills[name] ? [name] : Object.keys(skills).filter((k) => registryPathToInstallName(k) === name))
    : Object.keys(skills)
  const ruleTargets = name
    ? (rules[name] ? [name] : Object.keys(rules).filter((k) => registryPathToInstallName(k) === name))
    : Object.keys(rules)

  if (name && !skillTargets.length && !ruleTargets.length) {
    throw new Error(`'${name}' is not declared in current skills/rules`)
  }

  function pushArtifact(kind, installName, registryPath, version) {
    const kindConfig = ARTIFACT_KIND[kind]
    const ideDir = kind === 'skill' ? installPaths.skillInstallDir : installPaths.ruleInstallDir
    const srcDir = join(ideDir, installName)
    const destDir = join(registryBase, kindConfig.registryDir, registryPath, version)

    if (!existsSync(srcDir)) {
      throw new Error(`${kind} ${installName} not found in ${ideDir}`)
    }

    const markerFile = kindConfig.markerFile
    const allFiles = listFilesRecursive(srcDir, srcDir)
    if (!allFiles.includes(markerFile)) {
      throw new Error(`${kind} ${installName} missing ${markerFile}`)
    }

    const files = [markerFile, ...allFiles.filter((f) => f !== markerFile)]
    mkdirSync(destDir, { recursive: true })

    for (const file of files) {
      const srcPath = join(srcDir, file)
      const destPath = join(destDir, file)
      if (existsSync(srcPath)) {
        mkdirSync(dirname(destPath), { recursive: true })
        let content = readFileSync(srcPath, 'utf-8')
        if (
          (file === 'SKILL.md' || file === 'RULE.md') &&
          installName !== registryPath
        ) {
          content = patchSkillNameInFrontmatter(content, registryPath)
        }
        writeFileSync(destPath, content, 'utf-8')
      }
    }

    writeFileSync(join(destDir, 'files.json'), JSON.stringify(files, null, 2) + '\n', 'utf-8')
    if (verbose) {
      console.log(`  ${relative(ROOT, srcDir)} -> ${relative(ROOT, destDir)}`)
    }
    process.stdout.write(`Pushed ${kind} ${installName}@${version} `)
    console.log('ok')
  }

  for (const packageName of skillTargets) {
    const { registryPath, installName } = resolveArtifactPath(
      registry,
      'skill',
      packageName,
      config.skills?.[packageName] ?? skills[packageName] ?? '1.0.0',
    )
    const version = config.skills?.[packageName] ?? skills[packageName] ?? '1.0.0'
    pushArtifact('skill', installName, registryPath, version)
  }

  for (const packageName of ruleTargets) {
    const { registryPath, installName } = resolveArtifactPath(
      registry,
      'rule',
      packageName,
      config.rules?.[packageName] ?? rules[packageName] ?? '1.0.0',
    )
    const version = config.rules?.[packageName] ?? rules[packageName] ?? '1.0.0'
    pushArtifact('rule', installName, registryPath, version)
  }

  console.log('push complete. Run `git add` and `git commit` in the registry to save changes.')
}

/** Add artifact (skill or rule) from IDE to Registry. */
async function addArtifactToRegistry(kind, installName, version, args) {
  const kindConfig = ARTIFACT_KIND[kind]
  const config = readConfig()
  if (isUrl(config.registry)) {
    throw new Error(`add-${kind} only works with local registry.`)
  }

  const registryBase = resolveLocalBase(config.registry)
  const installPaths = getInstallPaths(config)

  const srcDir =
    kind === 'skill'
      ? join(installPaths.skillInstallDir, installName)
      : join(installPaths.ruleInstallDir, installName)

  if (!existsSync(srcDir)) {
    const dirHint =
      kind === 'skill'
        ? installPaths.skillInstallDir
        : installPaths.ruleInstallDir
    throw new Error(
      `${kind} '${installName}' not found in ${dirHint}. Create .<ide>/${kind}s/${installName}/ with ${kindConfig.markerFile} first.`,
    )
  }

  const markerPath = join(srcDir, kindConfig.markerFile)
  if (!existsSync(markerPath)) {
    throw new Error(`${kind} '${installName}' missing ${kindConfig.markerFile}`)
  }

  const installed = readInstalledVersion(srcDir)
  const { registryPath, logicalName } = parseInstallNameToRegistryPath(
    installName,
    installed?.registryPath,
  )

  validateRegistryPath(registryPath, kind === 'skill' ? 'Skill' : 'Rule')

  const allFiles = listFilesRecursive(srcDir, srcDir)
  if (!allFiles.includes(kindConfig.markerFile)) {
    throw new Error(`${kind} '${installName}' missing ${kindConfig.markerFile}`)
  }

  const files = [
    kindConfig.markerFile,
    ...allFiles.filter((f) => f !== kindConfig.markerFile),
  ]
  const destDir = join(registryBase, kindConfig.registryDir, registryPath, version)

  if (existsSync(destDir)) {
    if (!args.includes('--overwrite')) {
      throw new Error(
        `'${registryPath}@${version}' already exists in registry. Use --overwrite to replace.`,
      )
    }
  }

  mkdirSync(destDir, { recursive: true })
  for (const file of files) {
    const srcPath = join(srcDir, file)
    const destPath = join(destDir, file)
    if (existsSync(srcPath)) {
      mkdirSync(dirname(destPath), { recursive: true })
      writeFileSync(destPath, readFileSync(srcPath, 'utf-8'), 'utf-8')
    }
  }
  if (!files.includes(VERSION_MARKER)) {
    const aipmContent = { version, registryPath }
    writeFileSync(
      join(destDir, VERSION_MARKER),
      JSON.stringify(aipmContent, null, 0),
      'utf-8',
    )
    files.push(VERSION_MARKER)
  }
  writeFileSync(
    join(destDir, 'files.json'),
    JSON.stringify(files, null, 2) + '\n',
    'utf-8',
  )

  const content = readFileSync(markerPath, 'utf-8')
  const { description: fmDesc } = parseArtifactFrontmatter(content)
  const description = fmDesc ?? `${kind}: ${logicalName}`

  const registryJsonPath = join(registryBase, 'registry.json')
  const registry = JSON.parse(readFileSync(registryJsonPath, 'utf-8'))
  const registryKey = kindConfig.registryKey
  registry[registryKey] ??= {}

  if (registry[registryKey][registryPath]) {
    const pkg = registry[registryKey][registryPath]
    if (!(pkg.versions ?? []).includes(version)) {
      pkg.versions = [...(pkg.versions ?? []), version].sort()
    }
    pkg.latest = version
    if (fmDesc) pkg.description = fmDesc
  } else {
    registry[registryKey][registryPath] = {
      latest: version,
      versions: [version],
      description,
      tags: [logicalName.replace(/-/g, ' ')],
    }
  }

  writeFileSync(registryJsonPath, JSON.stringify(registry, null, 2) + '\n', 'utf-8')

  const configKey = kind === 'skill' ? 'skills' : 'rules'
  config[configKey] ??= {}
  config[configKey][registryPath] = version
  writeConfig(config)

  console.log(`Added ${kind} ${registryPath}@${version} to registry`)
  console.log(`  ${relative(ROOT, srcDir)} -> ${relative(ROOT, destDir)}`)
  console.log(`  Run \`git add\` in the registry to save.`)
}

async function cmdAddSkill(...args) {
  const filtered = args.filter((a) => !a.startsWith('-'))
  const name = filtered[0]
  const version = filtered[1] ?? '1.0.0'
  if (!name) throw new Error('Usage: aipm add-skill <name> [version] [--overwrite]')
  await addArtifactToRegistry('skill', name, version, args)
}

async function cmdAddRule(...args) {
  const filtered = args.filter((a) => !a.startsWith('-'))
  const name = filtered[0]
  const version = filtered[1] ?? '1.0.0'
  if (!name) throw new Error('Usage: aipm add-rule <name> [version] [--overwrite]')
  await addArtifactToRegistry('rule', name, version, args)
}

/** Remove artifact from Registry. Name can be registry path (e.g. shared/git-workflow) or logical name. */
async function removeArtifactFromRegistry(kind, name) {
  const kindConfig = ARTIFACT_KIND[kind]
  const config = readConfig()
  if (isUrl(config.registry)) {
    throw new Error(`remove-${kind} only works with local registry.`)
  }

  const registryBase = resolveLocalBase(config.registry)
  const registry = JSON.parse(readFileSync(join(registryBase, 'registry.json'), 'utf-8'))
  const registryKey = kindConfig.registryKey
  const index = registry[registryKey] ?? {}

  let registryPath = name.includes('/') && name.startsWith('@') ? name : null
  if (!registryPath) {
    if (index[name]) registryPath = name
    else {
      const inferred = installNameToRegistryPath(name)
      if (index[inferred]) registryPath = inferred
      else {
        const scoped = Object.keys(index).find((k) => k.endsWith(`/${name}`))
        if (scoped) registryPath = scoped
      }
    }
  }
  if (!registryPath || !index[registryPath]) {
    throw new Error(`${kind} '${name}' not found in registry`)
  }

  const artifactDir = join(registryBase, kindConfig.registryDir, registryPath)
  rmSync(artifactDir, { recursive: true, force: true })
  delete registry[registryKey][registryPath]
  writeFileSync(join(registryBase, 'registry.json'), JSON.stringify(registry, null, 2) + '\n', 'utf-8')

  const configKey = kind === 'skill' ? 'skills' : 'rules'
  if (config[configKey]?.[registryPath]) {
    delete config[configKey][registryPath]
    writeConfig(config)
  }

  console.log(`Removed ${kind} ${registryPath} from registry`)
}

async function cmdRemoveSkill(name) {
  if (!name) throw new Error('Usage: aipm remove-skill <name>')
  await removeArtifactFromRegistry('skill', name)
}

async function cmdRemoveRule(name) {
  if (!name) throw new Error('Usage: aipm remove-rule <name>')
  await removeArtifactFromRegistry('rule', name)
}

/** Update artifact in Registry (sync from IDE). Same as push for single artifact. */
async function cmdUpdateSkill(...args) {
  const name = args.filter((a) => !a.startsWith('-'))[0]
  if (!name) throw new Error('Usage: aipm update-skill <name> [-v]')
  await cmdPush(name, ...args)
}

async function cmdUpdateRule(...args) {
  const name = args.filter((a) => !a.startsWith('-'))[0]
  if (!name) throw new Error('Usage: aipm update-rule <name> [-v]')
  await cmdPush(name, ...args)
}


async function cmdSearch(query = '') {
  const config = readConfigOrDefault()
  const registry = await fetchRegistry(config.registry)

  const skillResults = Object.entries(registry.packages ?? {}).filter(([name, item]) => {
    return (
      !query ||
      name.includes(query) ||
      item.description?.includes(query) ||
      item.tags?.some((tag) => tag.includes(query))
    )
  })
  const ruleResults = Object.entries(registry.rules ?? {}).filter(([name, item]) => {
    return (
      !query ||
      name.includes(query) ||
      item.description?.includes(query) ||
      item.tags?.some((tag) => tag.includes(query))
    )
  })

  if (!skillResults.length && !ruleResults.length) {
    console.log('no matching skills/rules found')
    return
  }

  if (skillResults.length) {
    console.log('skills:')
    for (const [name, item] of skillResults) {
      console.log(`- ${name} (latest: ${item.latest})`)
      if (item.description) {
        console.log(`  ${item.description}`)
      }
    }
  }

  if (ruleResults.length) {
    console.log('\nrules:')
    for (const [name, item] of ruleResults) {
      console.log(`- ${name} (latest: ${item.latest})`)
      if (item.description) {
        console.log(`  ${item.description}`)
      }
    }
  }
}

const HELP = `
aipm - Skills and Rules CLI

Usage:
  aipm <command> [args]

Primary commands:
  init [--registry PATH]   Create .aipm/config.json (interactive; use AIPM_REGISTRY or --registry for external registry)
  pull [--on-conflict=..] Install declared skills and rules
  list                    List declared and installed skills/rules
  update [name] [--on-conflict=..]
                          Update one artifact or all artifacts
  push [name] [-v]         Push IDE edits back to local registry (local only; -v verbose)
  doctor                  Check config, registry, and local installs

Registry commands (local registry only):
  add-skill <name> [version] [--overwrite]
                          Add skill from IDE to registry
  add-rule <name> [version] [--overwrite]
                          Add rule from IDE to registry
  remove-skill <name>      Remove skill from registry
  remove-rule <name>       Remove rule from registry
  update-skill <name> [-v] Sync skill from IDE to registry
  update-rule <name> [-v]  Sync rule from IDE to registry

Additional commands:
  use [profile-id]        Switch to profile (配置单). Without arg, list available profiles.
  add <skill> [version]   Add and install one skill from registry
  remove <name>           Remove artifact from local config and IDE
  search [keyword]        Search skills and rules in registry
  help, --help, -h        Show this help

Config keys:
  profile                 Current profile (loads skills/rules from profiles/<profile>.json)
  skills, rules           Dependencies (npm-style: name -> version). Override profile.
  ide                     Target IDE runtime directory (cursor|codex)

Conflict options (pull/update):
  --on-conflict=ask       Ask per conflict (default; interactive shells only)
  --on-conflict=skip      Skip conflicting files/directories
  --on-conflict=overwrite Overwrite conflicting files/directories
`

const COMMANDS = {
  init: cmdInit,
  pull: cmdPull,
  list: cmdList,
  update: cmdUpdate,
  push: cmdPush,
  use: cmdUse,
  'add-skill': cmdAddSkill,
  'add-rule': cmdAddRule,
  'remove-skill': cmdRemoveSkill,
  'remove-rule': cmdRemoveRule,
  'update-skill': cmdUpdateSkill,
  'update-rule': cmdUpdateRule,
  doctor: cmdDoctor,
  add: cmdAdd,
  remove: cmdRemove,
  search: cmdSearch,
}

export async function main(argv = process.argv) {
  const [, , command, ...args] = argv

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP)
    process.exit(0)
  }

  if (!COMMANDS[command]) {
    console.log(HELP)
    process.exit(1)
  }

  await COMMANDS[command](...args)
}

if (['aipm', 'aipm.mjs'].includes(basename(process.argv[1] ?? ''))) {
  main().catch((error) => {
    console.error(`error: ${error.message}`)
    process.exit(1)
  })
}
