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
const PROFILE_CONFIG_FILE = join(ROOT, 'aipm_profile.json')
const LEGACY_CONFIG_FILE = join(AIPM_DIR, 'config.json')
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

/** Resolve registry ref: if local path does not exist, fall back to bundled registry. */
function resolveRegistryRef(ref) {
  if (isUrl(ref)) return ref
  const abs = resolveLocalBase(ref)
  if (existsSync(abs)) return ref
  const bundled = join(TOOL_ROOT, 'registry-template')
  if (existsSync(bundled)) return bundled
  return ref
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

function getConfigFilePath() {
  if (existsSync(PROFILE_CONFIG_FILE)) return PROFILE_CONFIG_FILE
  if (existsSync(LEGACY_CONFIG_FILE)) return LEGACY_CONFIG_FILE
  return PROFILE_CONFIG_FILE
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
  writeFileSync(PROFILE_CONFIG_FILE, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  if (existsSync(LEGACY_CONFIG_FILE)) {
    rmSync(LEGACY_CONFIG_FILE, { force: true })
  }
}

/** Read config from package.json aipm or aipm_profile.json (project root). Legacy: .aipm/config.json */
function readConfig() {
  if (existsSync(PACKAGE_JSON)) {
    try {
      const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf-8'))
      if (pkg.aipm && typeof pkg.aipm === 'object') {
        return mergeConfig(defaultConfig(), pkg.aipm)
      }
    } catch {}
  }
  const configPath = getConfigFilePath()
  if (existsSync(configPath)) {
    return mergeConfig(defaultConfig(), JSON.parse(readFileSync(configPath, 'utf-8')))
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
  const configPath = getConfigFilePath()
  if (existsSync(configPath)) {
    return mergeConfig(defaultConfig(), JSON.parse(readFileSync(configPath, 'utf-8')))
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
    const registryRef = resolveRegistryRef(config.registry)
    const profileArtifacts = await loadProfileConfig(registryRef, config.profile)
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
  if (hasPkgAipm || existsSync(PROFILE_CONFIG_FILE) || existsSync(LEGACY_CONFIG_FILE)) {
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
  console.log('\ncreated aipm_profile.json')
  console.log(`registry: ${config.registry}`)
  console.log(`ide: ${config.ide}`)
  if (config.profile) {
    console.log(`profile: ${config.profile}`)
  }
  console.log('Run `aipm install` to install skills and rules.')
}

async function cmdPull(...args) {
  const config = readConfig()
  const { skills, rules } = await resolveDesiredArtifacts(config)
  const registry = await fetchRegistry(resolveRegistryRef(config.registry))
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
    const result = await installArtifact(resolveRegistryRef(config.registry), 'skill', registryPath, version, {
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
    const result = await installArtifact(resolveRegistryRef(config.registry), 'rule', registryPath, version, {
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
  console.log('install complete')
}

async function cmdList() {
  const config = readConfigOrDefault()
  const { skills, rules } = await resolveDesiredArtifacts(config)
  const registry = await fetchRegistry(resolveRegistryRef(config.registry))
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
  const registry = await fetchRegistry(resolveRegistryRef(config.registry))
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
    const result = await installArtifact(resolveRegistryRef(config.registry), 'skill', registryPath, version, {
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
    const result = await installArtifact(resolveRegistryRef(config.registry), 'rule', registryPath, version, {
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
  const hasAipmConfig = existsSync(PROFILE_CONFIG_FILE) || existsSync(LEGACY_CONFIG_FILE)

  if (!hasPkgAipm && !hasAipmConfig) {
    console.log('[fail] aipm config not found (package.json aipm or aipm_profile.json)')
    console.log('run `aipm init` first')
    process.exitCode = 1
    return
  }

  console.log('[ok] config exists')

  const config = readConfig()
  const installPaths = getInstallPaths(config)
  let registry

  try {
    registry = await fetchRegistry(resolveRegistryRef(config.registry))
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
    const profiles = listAvailableProfiles(resolveRegistryRef(config.registry))
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
  const profileData = await loadProfileConfig(resolveRegistryRef(config.registry), profileId)
  if (!profileData) {
    throw new Error(`Profile '${profileId}' not found. Check registry has profiles/${profileId}.json`)
  }

  config.profile = profileId
  config.skills = {}
  config.rules = {}
  writeConfig(config)

  console.log(`Switched to profile: ${profileId}`)
  console.log('Run `aipm install` to sync skills and rules.')
}

async function cmdInstallSkill(name, version = 'latest') {
  if (!name) {
    throw new Error('Usage: aipm install-skill <name> [version]  (name: @scope/name or scope_name)')
  }

  const config = readConfigOrDefault()
  const registry = await fetchRegistry(resolveRegistryRef(config.registry))
  const { registryPath, installName, version: resolvedVersion } = resolveArtifactPath(
    registry,
    'skill',
    name,
    version,
  )
  const installPaths = getInstallPaths(config)

  ensureIdeDirs(installPaths)
  ARTIFACT_KIND.skill.installDir = installPaths.skillInstallDir
  await installArtifact(resolveRegistryRef(config.registry), 'skill', registryPath, resolvedVersion, {
    installName,
  })

  config.skills ??= {}
  config.skills[registryPath] = resolvedVersion
  writeConfig(config)

  console.log(`installed skill ${registryPath}@${resolvedVersion}`)
}

async function cmdInstallRule(name, version = 'latest') {
  if (!name) {
    throw new Error('Usage: aipm install-rule <name> [version]  (name: @scope/name or scope_name)')
  }

  const config = readConfigOrDefault()
  const registry = await fetchRegistry(resolveRegistryRef(config.registry))
  const { registryPath, installName, version: resolvedVersion } = resolveArtifactPath(
    registry,
    'rule',
    name,
    version,
  )
  const installPaths = getInstallPaths(config)

  ensureIdeDirs(installPaths)
  ARTIFACT_KIND.rule.installDir = installPaths.ruleInstallDir
  await installArtifact(resolveRegistryRef(config.registry), 'rule', registryPath, resolvedVersion, {
    installName,
  })

  config.rules ??= {}
  config.rules[registryPath] = resolvedVersion
  writeConfig(config)

  console.log(`installed rule ${registryPath}@${resolvedVersion}`)
}

/** Resolve user name to registryPath and installName for uninstall. Handles @scope/name and scope_name. */
function resolveNameForUninstall(config, registry, name, kind) {
  const installName =
    name.startsWith('@') && name.includes('/') ? registryPathToInstallName(name) : name
  const obj = kind === 'skill' ? config.skills : config.rules
  const findRegistryPath = () =>
    obj?.[name] ? name : Object.keys(obj ?? {}).find((k) => registryPathToInstallName(k) === name)
  const registryPath = findRegistryPath()
  if (registryPath) {
    try {
      const r = resolveArtifactPath(registry, kind, registryPath, obj[registryPath])
      return { registryPath, installName: r.installName }
    } catch {
      return { registryPath, installName }
    }
  }
  return { registryPath: null, installName }
}

async function cmdUninstallSkill(name) {
  if (!name) {
    throw new Error('Usage: aipm uninstall-skill <name>  (name: @scope/name or scope_name)')
  }

  const config = readConfig()
  const installPaths = getInstallPaths(config)

  let registryPath, installName
  try {
    const registry = await fetchRegistry(resolveRegistryRef(config.registry))
    const r = resolveNameForUninstall(config, registry, name, 'skill')
    registryPath = r.registryPath
    installName = r.installName
  } catch {
    installName =
      name.startsWith('@') && name.includes('/') ? registryPathToInstallName(name) : name
    registryPath = config.skills?.[name]
      ? name
      : Object.keys(config.skills ?? {}).find((k) => registryPathToInstallName(k) === name)
  }

  const targetDir = join(installPaths.skillInstallDir, installName)
  if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true })

  if (registryPath && config.skills?.[registryPath]) {
    delete config.skills[registryPath]
    writeConfig(config)
  }

  console.log('uninstalled skill (if existed)')
}

async function cmdUninstallRule(name) {
  if (!name) {
    throw new Error('Usage: aipm uninstall-rule <name>  (name: @scope/name or scope_name)')
  }

  const config = readConfig()
  const installPaths = getInstallPaths(config)

  let registryPath, installName
  try {
    const registry = await fetchRegistry(resolveRegistryRef(config.registry))
    const r = resolveNameForUninstall(config, registry, name, 'rule')
    registryPath = r.registryPath
    installName = r.installName
  } catch {
    installName =
      name.startsWith('@') && name.includes('/') ? registryPathToInstallName(name) : name
    registryPath = config.rules?.[name]
      ? name
      : Object.keys(config.rules ?? {}).find((k) => registryPathToInstallName(k) === name)
  }

  const targetDir = join(installPaths.ruleInstallDir, installName)
  if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true })

  if (registryPath && config.rules?.[registryPath]) {
    delete config.rules[registryPath]
    writeConfig(config)
  }

  console.log('uninstalled rule (if existed)')
}

/**
 * Push IDE-installed skills/rules back to local registry.
 * Only works when config.registry is a local path (not URL).
 * Source: .<ide>/skills/ and .<ide>/rules/ (relative to workspace root where aipm_profile.json lives)
 */
async function cmdPush(...args) {
  const filtered = args.filter((a) => !a.startsWith('-'))
  const name = filtered[0]
  const config = readConfig()
  const registryRef = resolveRegistryRef(config.registry)
  if (isUrl(registryRef)) {
    throw new Error(
      'publish only works with local registry. Your registry is a URL. ' +
        'To contribute changes, edit the registry repo directly and submit a PR.',
    )
  }

  const verbose = args.includes('--verbose') || args.includes('-v')
  const registryBase = resolveLocalBase(registryRef)
  const { skills, rules } = await resolveDesiredArtifacts(config)
  const registry = await fetchRegistry(registryRef)
  const installPaths = getInstallPaths(config)

  if (verbose) {
    console.log(`[publish] workspace root: ${ROOT}`)
    console.log(`[publish] registry: ${registryBase}`)
    console.log(`[publish] source: ${installPaths.skillInstallDir} + ${installPaths.ruleInstallDir}`)
  }

  let skillTargets = name
    ? (skills[name] ? [name] : Object.keys(skills).filter((k) => registryPathToInstallName(k) === name))
    : Object.keys(skills)
  let ruleTargets = name
    ? (rules[name] ? [name] : Object.keys(rules).filter((k) => registryPathToInstallName(k) === name))
    : Object.keys(rules)

  if (name && !skillTargets.length && !ruleTargets.length) {
    throw new Error(`'${name}' is not declared in current skills/rules`)
  }

  // When publishing all (no name), only publish artifacts that exist in IDE. Skip profile-declared but not-yet-installed.
  if (!name) {
    skillTargets = skillTargets.filter((p) =>
      existsSync(join(installPaths.skillInstallDir, registryPathToInstallName(p))),
    )
    ruleTargets = ruleTargets.filter((p) =>
      existsSync(join(installPaths.ruleInstallDir, registryPathToInstallName(p))),
    )
    if (!skillTargets.length && !ruleTargets.length) {
      throw new Error(
        'No skills or rules found in IDE. Run `aipm init-skill` to create, or `aipm install` to install from registry.',
      )
    }
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
    const version = config.skills?.[packageName] ?? skills[packageName] ?? '1.0.0'
    const isNew = !registry.packages?.[packageName]
    if (isNew) {
      await addArtifactToRegistry('skill', packageName, version, args)
    } else {
      const { registryPath, installName } = resolveArtifactPath(
        registry,
        'skill',
        packageName,
        version,
      )
      pushArtifact('skill', installName, registryPath, version)
    }
  }

  for (const packageName of ruleTargets) {
    const version = config.rules?.[packageName] ?? rules[packageName] ?? '1.0.0'
    const isNew = !registry.rules?.[packageName]
    if (isNew) {
      await addArtifactToRegistry('rule', packageName, version, args)
    } else {
      const { registryPath, installName } = resolveArtifactPath(
        registry,
        'rule',
        packageName,
        version,
      )
      pushArtifact('rule', installName, registryPath, version)
    }
  }

  console.log('publish complete. Run `git add` and `git commit` in the registry to save changes.')
}

/** Scaffold IDE artifact dir. Creates package.json, .aipm, and marker file. */
function scaffoldArtifactDir(kind, installName, registryPath, version, description = null) {
  const kindConfig = ARTIFACT_KIND[kind]
  const config = readConfig()
  const installPaths = getInstallPaths(config)
  const srcDir =
    kind === 'skill'
      ? join(installPaths.skillInstallDir, installName)
      : join(installPaths.ruleInstallDir, installName)

  mkdirSync(srcDir, { recursive: true })

  const logicalName = registryPath.includes('/') ? registryPath.split('/').pop() : registryPath
  const desc = description ?? `${kind}: ${logicalName}`

  writeFileSync(
    join(srcDir, VERSION_MARKER),
    JSON.stringify({ version, registryPath }, null, 0),
    'utf-8',
  )

  const pkg = {
    name: registryPath,
    version,
    description: desc,
    aipm: { type: kind },
  }
  writeFileSync(join(srcDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf-8')

  const markerContent =
    kind === 'skill'
      ? `---
name: "${installName}"
description: "${desc}"
---

# ${logicalName}

<!-- Add skill content here. -->\n`
      : `---
name: "${installName}"
description: "${desc}"
---

# ${logicalName}

<!-- Add rule content here. -->\n`
  writeFileSync(join(srcDir, kindConfig.markerFile), markerContent, 'utf-8')

  console.log(`Created ${kind} scaffold at ${relative(ROOT, srcDir)}`)
  return srcDir
}

/** Add artifact (skill or rule) from IDE to Registry. */
async function addArtifactToRegistry(kind, name, version, args) {
  const kindConfig = ARTIFACT_KIND[kind]
  const config = readConfig()
  const registryRef = resolveRegistryRef(config.registry)
  if (isUrl(registryRef)) {
    throw new Error(`add-${kind} only works with local registry.`)
  }

  const registryBase = resolveLocalBase(registryRef)
  const installPaths = getInstallPaths(config)

  // Resolve name to installName for IDE directory lookup.
  // IDE dirs use scope_name (e.g. frontend_vue-ts-coding-standard), registry uses @scope/name.
  const installName =
    name.startsWith('@') && name.includes('/') ? registryPathToInstallName(name) : name

  ensureIdeDirs(installPaths)

  const srcDir =
    kind === 'skill'
      ? join(installPaths.skillInstallDir, installName)
      : join(installPaths.ruleInstallDir, installName)

  if (!existsSync(srcDir)) {
    throw new Error(
      `${kind} '${installName}' not found. Run \`aipm init-${kind}\` to create a new package first.`,
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

/** Create new skill/rule package interactively. Prompts for name, description, version. */
async function cmdInitSkill() {
  if (!process.stdin.isTTY) {
    throw new Error('aipm init-skill requires interactive mode. Run in a terminal.')
  }
  const config = readConfig()
  const installPaths = getInstallPaths(config)
  ensureIdeDirs(installPaths)

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  console.log('\nCreate a new skill package (npm-style: @scope/name or scope_name)\n')

  const name = await question(rl, 'Package name', '')
  if (!name.trim()) {
    rl.close()
    throw new Error('Package name is required')
  }
  const registryPath =
    name.startsWith('@') && name.includes('/') ? name.trim() : installNameToRegistryPath(name.trim())
  const installName = registryPathToInstallName(registryPath)

  const srcDir = join(installPaths.skillInstallDir, installName)
  if (existsSync(srcDir)) {
    rl.close()
    throw new Error(`Skill '${installName}' already exists at ${relative(ROOT, srcDir)}`)
  }

  validateRegistryPath(registryPath, 'Skill')

  const description = await question(
    rl,
    'Description',
    `skill: ${registryPath.includes('/') ? registryPath.split('/').pop() : registryPath}`,
  )
  const version = await question(rl, 'Version', '1.0.0')
  rl.close()

  scaffoldArtifactDir('skill', installName, registryPath, version, description || undefined)

  config.skills ??= {}
  config.skills[registryPath] = version
  writeConfig(config)

  console.log(`\nSkill created. Edit ${relative(ROOT, join(srcDir, 'SKILL.md'))} then run \`aipm publish ${registryPath}\` to publish.`)
}

/** Create new rule package interactively. */
async function cmdInitRule() {
  if (!process.stdin.isTTY) {
    throw new Error('aipm init-rule requires interactive mode. Run in a terminal.')
  }
  const config = readConfig()
  const installPaths = getInstallPaths(config)
  ensureIdeDirs(installPaths)

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  console.log('\nCreate a new rule package (npm-style: @scope/name or scope_name)\n')

  const name = await question(rl, 'Package name', '')
  if (!name.trim()) {
    rl.close()
    throw new Error('Package name is required')
  }
  const registryPath =
    name.startsWith('@') && name.includes('/') ? name.trim() : installNameToRegistryPath(name.trim())
  const installName = registryPathToInstallName(registryPath)

  const srcDir = join(installPaths.ruleInstallDir, installName)
  if (existsSync(srcDir)) {
    rl.close()
    throw new Error(`Rule '${installName}' already exists at ${relative(ROOT, srcDir)}`)
  }

  validateRegistryPath(registryPath, 'Rule')

  const description = await question(
    rl,
    'Description',
    `rule: ${registryPath.includes('/') ? registryPath.split('/').pop() : registryPath}`,
  )
  const version = await question(rl, 'Version', '1.0.0')
  rl.close()

  scaffoldArtifactDir('rule', installName, registryPath, version, description || undefined)

  config.rules ??= {}
  config.rules[registryPath] = version
  writeConfig(config)

  console.log(`\nRule created. Edit ${relative(ROOT, join(srcDir, 'RULE.md'))} then run \`aipm publish ${registryPath}\` to publish.`)
}

/** Remove artifact from Registry. Name can be registry path (e.g. shared/git-workflow) or logical name. */
async function removeArtifactFromRegistry(kind, name) {
  const kindConfig = ARTIFACT_KIND[kind]
  const config = readConfig()
  const registryRef = resolveRegistryRef(config.registry)
  if (isUrl(registryRef)) {
    throw new Error(`unpublish-${kind} only works with local registry.`)
  }

  const registryBase = resolveLocalBase(registryRef)
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

  console.log(`Unpublished ${kind} ${registryPath} from registry`)
}

async function cmdUnpublishSkill(name) {
  if (!name) throw new Error('Usage: aipm unpublish-skill <name>')
  await removeArtifactFromRegistry('skill', name)
}

async function cmdUnpublishRule(name) {
  if (!name) throw new Error('Usage: aipm unpublish-rule <name>')
  await removeArtifactFromRegistry('rule', name)
}


async function cmdSearch(query = '') {
  const config = readConfigOrDefault()
  const registry = await fetchRegistry(resolveRegistryRef(config.registry))

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

Two key roles:
  1. Package lifecycle: create packages (init-skill/init-rule), publish to Registry
  2. IDE management: install packages per profile config, ensure IDE matches declared versions

Usage:
  aipm <command> [args]

Primary commands:
  init [--registry PATH]   Create aipm_profile.json in project root (interactive)
  install [--on-conflict=..]
                          Install declared skills/rules from Registry to IDE (reads profile)
  list                    List declared and installed skills/rules
  update [name] [--on-conflict=..]
                          Update one artifact or all artifacts
  publish [name] [-v]      Sync latest version to Registry (local only; -v verbose)
  doctor                  Check config, registry, and local installs

Create new packages (interactive):
  init-skill              Create new skill (prompts: name, description, version)
  init-rule               Create new rule (prompts: name, description, version)

Registry commands (local registry only):
  unpublish-skill <name> Remove skill from registry
  unpublish-rule <name>  Remove rule from registry

Additional commands:
  use [profile-id]        Switch to profile (配置单). Without arg, list available profiles.
  install-skill <name> [version]   Add skill to config and install from registry
  install-rule <name> [version]   Add rule to config and install from registry
  uninstall-skill <name>  Remove skill from config and IDE
  uninstall-rule <name>   Remove rule from config and IDE
  search [keyword]        Search skills and rules in registry
  help, --help, -h        Show this help

Config keys (aipm_profile.json in project root):
  profile                 Current profile (loads skills/rules from profiles/<profile>.json)
  skills, rules           Dependencies (npm-style: name -> version). Override profile.
  ide                     Target IDE runtime directory (cursor|codex)

Conflict options (install/update):
  --on-conflict=ask       Ask per conflict (default; interactive shells only)
  --on-conflict=skip      Skip conflicting files/directories
  --on-conflict=overwrite Overwrite conflicting files/directories
`

const COMMANDS = {
  init: cmdInit,
  install: cmdPull,
  list: cmdList,
  update: cmdUpdate,
  publish: cmdPush,
  use: cmdUse,
  'init-skill': cmdInitSkill,
  'init-rule': cmdInitRule,
  'unpublish-skill': cmdUnpublishSkill,
  'unpublish-rule': cmdUnpublishRule,
  doctor: cmdDoctor,
  'install-skill': cmdInstallSkill,
  'install-rule': cmdInstallRule,
  'uninstall-skill': cmdUninstallSkill,
  'uninstall-rule': cmdUninstallRule,
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
