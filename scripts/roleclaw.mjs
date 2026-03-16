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

const ROOT = process.cwd()
const SCRIPT_FILE = fileURLToPath(import.meta.url)
const TOOL_ROOT = resolve(dirname(SCRIPT_FILE), '..')
const ROLECLAW_DIR = join(ROOT, '.roleclaw')
const CONFIG_FILE = join(ROLECLAW_DIR, 'config.json')

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
  // 1) Prefer project-local registry for same-repo iteration.
  const projectLocalRegistry = join(ROOT, 'registry-template')
  const hasProjectLocalRegistry = existsSync(projectLocalRegistry)
  console.log(`[roleclaw][registry-check] project-local: ${projectLocalRegistry} -> ${hasProjectLocalRegistry ? 'FOUND' : 'NOT_FOUND'}`)
  if (hasProjectLocalRegistry) {
    console.log('[roleclaw][registry-check] selected: project-local registry')
    return './registry-template'
  }

  // 2) If roleclaw is called globally, fall back to bundled registry.
  const bundledRegistry = join(TOOL_ROOT, 'registry-template')
  const hasBundledRegistry = existsSync(bundledRegistry)
  console.log(`[roleclaw][registry-check] bundled: ${bundledRegistry} -> ${hasBundledRegistry ? 'FOUND' : 'NOT_FOUND'}`)
  if (hasBundledRegistry) {
    console.log('[roleclaw][registry-check] selected: bundled registry')
    return bundledRegistry
  }

  // 3) Final fallback: user-provided remote registry.
  console.log('[roleclaw][registry-check] selected: fallback remote registry')
  return 'https://raw.githubusercontent.com/YOUR_ORG/cursor-skills-registry/main'
}

/** List available roles from registry. Returns [{ roleId, name }]. Supports local and remote. */
async function listAvailableRoles(registryRef) {
  if (isUrl(registryRef)) {
    try {
      const rbac = await readJsonResource(registryRef, 'organization/rbac/roles.json')
      const roles = rbac?.roles ?? {}
      return Object.entries(roles).map(([roleId, r]) => ({
        roleId,
        name: r.description ?? r.name ?? roleId,
      }))
    } catch {
      return []
    }
  }
  const rolesDir = join(resolveLocalBase(registryRef), 'organization/roles')
  if (!existsSync(rolesDir)) {
    try {
      const rbac = JSON.parse(readFileSync(join(resolveLocalBase(registryRef), 'organization/rbac/roles.json'), 'utf-8'))
      const roles = rbac?.roles ?? {}
      return Object.entries(roles).map(([roleId, r]) => ({
        roleId,
        name: r.description ?? r.name ?? roleId,
      }))
    } catch {
      return []
    }
  }
  return readdirSync(rolesDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => {
      try {
        const data = JSON.parse(readFileSync(join(rolesDir, e.name), 'utf-8'))
        return { roleId: data.roleId ?? e.name.replace('.json', ''), name: data.name ?? data.roleId }
      } catch {
        return { roleId: e.name.replace('.json', ''), name: e.name.replace('.json', '') }
      }
    })
    .sort((a, b) => a.roleId.localeCompare(b.roleId))
}

function defaultConfig() {
  return {
    registry: defaultRegistryRef(),
    ide: 'cursor',
    role: null,
    skills: {},
    rules: {},
    roleProfiles: {},
  }
}

function ensureRoleclawDir() {
  mkdirSync(ROLECLAW_DIR, { recursive: true })
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
        `'${ideRootDir}' exists but is not a directory. Remove it or use a different project.`,
      )
    }
  } else {
    mkdirSync(ideRootDir, { recursive: true })
  }
  mkdirSync(skillInstallDir, { recursive: true })
  mkdirSync(ruleInstallDir, { recursive: true })
}

function writeConfig(data) {
  ensureRoleclawDir()
  writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

function readConfig() {
  if (existsSync(CONFIG_FILE)) {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
  }

  throw new Error('.roleclaw/config.json does not exist, run: roleclaw init')
}

function readConfigOrDefault() {
  if (existsSync(CONFIG_FILE)) {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
  }

  return defaultConfig()
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

async function fetchRbacRoles(baseRef) {
  try {
    return await readJsonResource(baseRef, 'organization/rbac/roles.json')
  } catch {
    return null
  }
}

async function fetchRoleConfig(baseRef, config, role) {
  // Highest priority: role definition inside project config.
  const profile = config.roleProfiles?.[role]
  if (profile) {
    return {
      roleId: role,
      source: 'config.roleProfiles',
      requiredSkills: normalizeArtifactMap(profile.skills),
      requiredRules: normalizeArtifactMap(profile.rules),
    }
  }

  try {
    // Canonical role source: organization/roles/<role>.json from registry.
    const roleConfig = await readJsonResource(baseRef, `organization/roles/${role}.json`)
    return {
      roleId: roleConfig.roleId ?? role,
      source: 'roles',
      requiredSkills: normalizeArtifactMap(roleConfig.requiredSkills),
      requiredRules: normalizeArtifactMap(roleConfig.requiredRules),
    }
  } catch {
    // Fallback for RBAC-only layout.
    const rbac = await fetchRbacRoles(baseRef)
    const roleConfig = rbac?.roles?.[role]
    if (!roleConfig) {
      throw new Error(`Role '${role}' not found in config.roleProfiles, organization/roles/ or organization/rbac/roles.json`)
    }

    return {
      roleId: role,
      source: 'rbac',
      requiredSkills: normalizeArtifactMap(roleConfig.skills),
      requiredRules: normalizeArtifactMap(roleConfig.rules),
    }
  }
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

async function installArtifact(baseRef, kind, name, version, options = {}) {
  const kindConfig = ARTIFACT_KIND[kind]
  const installRoot = kindConfig.installDir
  const artifactDir = join(installRoot, name)
  const conflictState = options.conflictState ?? { mode: 'ask' }

  process.stdout.write(`Installing ${kind} ${name}@${version} `)

  const files = await readJsonResource(
    baseRef,
    `${kindConfig.registryDir}/${name}/${version}/files.json`,
  )

  if (existsSync(artifactDir) && !statSync(artifactDir).isDirectory()) {
    const action = await promptConflictAction(
      `[conflict] '${artifactDir}' exists and is not a directory`,
      conflictState,
    )
    if (action === 'skip') {
      console.log(' skipped')
      return { installed: false, skipped: true }
    }
    rmSync(artifactDir, { recursive: true, force: true })
  }
  mkdirSync(artifactDir, { recursive: true })

  for (const file of files) {
    const targetPath = join(artifactDir, file)
    mkdirSync(dirname(targetPath), { recursive: true })
    if (existsSync(targetPath)) {
      const action = await promptConflictAction(
        `[conflict] '${relative(ROOT, targetPath)}' already exists`,
        conflictState,
      )
      if (action === 'skip') {
        process.stdout.write('s')
        continue
      }
      rmSync(targetPath, { recursive: true, force: true })
    }
    writeFileSync(
      targetPath,
      await readTextResource(baseRef, `${kindConfig.registryDir}/${name}/${version}/${file}`),
      'utf-8',
    )
    process.stdout.write('.')
  }

  console.log(' ok')
  return { installed: true, skipped: false }
}

async function resolveDesiredArtifacts(config) {
  const skills = { ...(config.skills ?? {}) }
  const rules = { ...(config.rules ?? {}) }
  let roleSource = null

  if (!config.role) {
    return { skills, rules, roleSource }
  }

  const roleConfig = await fetchRoleConfig(config.registry, config, config.role)
  roleSource = roleConfig.source

  // Merge role defaults while preserving explicit project overrides.
  for (const [name, version] of Object.entries(roleConfig.requiredSkills)) {
    if (!skills[name]) {
      skills[name] = version
    }
  }

  for (const [name, version] of Object.entries(roleConfig.requiredRules)) {
    if (!rules[name]) {
      rules[name] = version
    }
  }

  return { skills, rules, roleSource }
}

function listInstalledDirs(baseDir) {
  if (!existsSync(baseDir)) {
    return []
  }

  return readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
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

function parseInitRegistry(args) {
  const i = args.indexOf('--registry')
  if (i >= 0 && args[i + 1]) return args[i + 1]
  const eq = args.find((a) => a.startsWith('--registry='))
  if (eq) return eq.slice('--registry='.length)
  return process.env.ROLECLAW_REGISTRY || defaultRegistryRef()
}

async function cmdInit(args = []) {
  if (existsSync(CONFIG_FILE)) {
    console.log('roleclaw config already exists, skip')
    return
  }

  if (!process.stdin.isTTY) {
    console.error('roleclaw init requires interactive mode. Run in a terminal.')
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

  const roles = await listAvailableRoles(registryRef)
  console.log('\nAvailable roles:')
  if (roles.length === 0) {
    console.log('  (none found in registry)')
  } else {
    roles.forEach((r, i) => {
      console.log(`  ${i + 1}. ${r.roleId} (${r.name})`)
    })
    console.log(`  ${roles.length + 1}. (skip, set later)`)
    const roleChoice = await question(rl, `\nSelect role (1-${roles.length + 1})`, String(roles.length + 1))
    const roleIndex = parseInt(roleChoice, 10)
    if (roleIndex >= 1 && roleIndex <= roles.length) {
      config.role = roles[roleIndex - 1].roleId
    }
  }

  rl.close()

  // Do not overwrite explicit project declarations during init.
  // Role defaults are merged at runtime by resolveDesiredArtifacts().
  config.skills ??= {}
  config.rules ??= {}

  writeConfig(config)
  console.log('\ncreated .roleclaw/config.json')
  console.log(`registry: ${config.registry}`)
  console.log(`ide: ${config.ide}`)
  console.log(`role: ${config.role ?? '(none)'}`)
  if (config.role) {
    console.log('run `roleclaw pull` to install skills and rules')
  }
}

async function cmdPull(...args) {
  const config = readConfig()
  const { skills, rules } = await resolveDesiredArtifacts(config)
  const registry = await fetchRegistry(config.registry)
  const installPaths = getInstallPaths(config)
  const conflictState = { mode: parseConflictMode(args) }

  ensureIdeDirs(installPaths)

  for (const [name, requestedVersion] of Object.entries(skills)) {
    const resolvedVersion = resolveVersion(registry.packages, name, requestedVersion, 'Skill')
    ARTIFACT_KIND.skill.installDir = installPaths.skillInstallDir
    const result = await installArtifact(config.registry, 'skill', name, resolvedVersion, { conflictState })
    if (result.installed) {
      config.skills[name] = resolvedVersion
    }
  }

  for (const [name, requestedVersion] of Object.entries(rules)) {
    const resolvedVersion = resolveVersion(registry.rules, name, requestedVersion, 'Rule')
    ARTIFACT_KIND.rule.installDir = installPaths.ruleInstallDir
    const result = await installArtifact(config.registry, 'rule', name, resolvedVersion, { conflictState })
    if (result.installed) {
      config.rules[name] = resolvedVersion
    }
  }

  writeConfig(config)
  console.log('pull complete')
}

async function cmdList() {
  const config = readConfigOrDefault()
  const { skills, rules } = await resolveDesiredArtifacts(config)
  const installPaths = getInstallPaths(config)

  console.log(`registry: ${config.registry}`)
  console.log(`ide: ${resolveIde(config)}`)
  console.log(`role: ${config.role ?? '(none)'}`)

  printDeclaredAndInstalled('declared skills', skills, installPaths.skillInstallDir, 'SKILL.md')
  printDeclaredAndInstalled('declared rules', rules, installPaths.ruleInstallDir, 'RULE.md')
}

async function cmdUpdate(name, ...args) {
  const config = readConfig()
  const { skills, rules } = await resolveDesiredArtifacts(config)
  const registry = await fetchRegistry(config.registry)
  const installPaths = getInstallPaths(config)
  const conflictState = { mode: parseConflictMode(args) }

  ensureIdeDirs(installPaths)

  const skillTargets = name ? (skills[name] ? [name] : []) : Object.keys(skills)
  const ruleTargets = name ? (rules[name] ? [name] : []) : Object.keys(rules)

  if (name && !skillTargets.length && !ruleTargets.length) {
    throw new Error(`'${name}' is not declared in current skills/rules`)
  }

  for (const item of skillTargets) {
    const latest = resolveVersion(registry.packages, item, 'latest', 'Skill')
    ARTIFACT_KIND.skill.installDir = installPaths.skillInstallDir
    const result = await installArtifact(config.registry, 'skill', item, latest, { conflictState })
    if (result.installed) {
      config.skills[item] = latest
    }
  }

  for (const item of ruleTargets) {
    const latest = resolveVersion(registry.rules, item, 'latest', 'Rule')
    ARTIFACT_KIND.rule.installDir = installPaths.ruleInstallDir
    const result = await installArtifact(config.registry, 'rule', item, latest, { conflictState })
    if (result.installed) {
      config.rules[item] = latest
    }
  }

  writeConfig(config)
  console.log('update complete')
}

async function cmdDoctor() {
  let failures = 0

  if (!existsSync(CONFIG_FILE)) {
    console.log('[fail] missing .roleclaw/config.json')
    console.log('run `roleclaw init` first')
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

  if (config.role) {
    try {
      const roleConfig = await fetchRoleConfig(config.registry, config, config.role)
      console.log(`[ok] role exists: ${roleConfig.roleId} (source: ${roleConfig.source})`)
    } catch (error) {
      console.log(`[fail] role check failed: ${error.message}`)
      failures += 1
    }
  } else {
    console.log('[ok] no role selected yet')
  }

  ensureIdeDirs(installPaths)
  console.log(`[ok] install directories are ready (${installPaths.ideRootDir})`)

  const { skills, rules } = await resolveDesiredArtifacts(config)

  for (const [name, requestedVersion] of Object.entries(skills)) {
    try {
      if (!registry) {
        throw new Error('registry is unavailable')
      }
      const resolvedVersion = resolveVersion(registry.packages, name, requestedVersion, 'Skill')
      console.log(`[ok] registry contains skill ${name}@${resolvedVersion}`)
    } catch (error) {
      console.log(`[fail] skill check failed for ${name}: ${error.message}`)
      failures += 1
      continue
    }

    if (existsSync(join(installPaths.skillInstallDir, name, 'SKILL.md'))) {
      console.log(`[ok] installed skill is present: ${name}`)
    } else {
      console.log(`[fail] installed skill is missing: ${name}`)
      failures += 1
    }
  }

  for (const [name, requestedVersion] of Object.entries(rules)) {
    try {
      if (!registry) {
        throw new Error('registry is unavailable')
      }
      const resolvedVersion = resolveVersion(registry.rules, name, requestedVersion, 'Rule')
      console.log(`[ok] registry contains rule ${name}@${resolvedVersion}`)
    } catch (error) {
      console.log(`[fail] rule check failed for ${name}: ${error.message}`)
      failures += 1
      continue
    }

    if (existsSync(join(installPaths.ruleInstallDir, name, 'RULE.md'))) {
      console.log(`[ok] installed rule is present: ${name}`)
    } else {
      console.log(`[fail] installed rule is missing: ${name}`)
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

async function cmdAdd(name, version = 'latest') {
  if (!name) {
    throw new Error('Usage: roleclaw add <name> [version]')
  }

  const config = readConfigOrDefault()
  const registry = await fetchRegistry(config.registry)
  const resolvedVersion = resolveVersion(registry.packages, name, version, 'Skill')
  const installPaths = getInstallPaths(config)

  ensureIdeDirs(installPaths)
  ARTIFACT_KIND.skill.installDir = installPaths.skillInstallDir
  await installArtifact(config.registry, 'skill', name, resolvedVersion)

  config.skills[name] = resolvedVersion
  writeConfig(config)

  console.log(`added skill ${name}@${resolvedVersion}`)
}

async function cmdRemove(name) {
  if (!name) {
    throw new Error('Usage: roleclaw remove <name>')
  }

  const config = readConfig()
  const installPaths = getInstallPaths(config)
  rmSync(join(installPaths.skillInstallDir, name), { recursive: true, force: true })
  rmSync(join(installPaths.ruleInstallDir, name), { recursive: true, force: true })

  if (config.skills?.[name]) {
    delete config.skills[name]
  }
  if (config.rules?.[name]) {
    delete config.rules[name]
  }
  writeConfig(config)

  console.log(`removed artifact ${name} (if existed)`)
}

/**
 * Push IDE-installed skills/rules back to local registry.
 * Only works when config.registry is a local path (not URL).
 * Source: .<ide>/skills/ and .<ide>/rules/ (relative to project root where .roleclaw/config.json lives)
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
  const installPaths = getInstallPaths(config)

  if (verbose) {
    console.log(`[push] project root: ${ROOT}`)
    console.log(`[push] registry: ${registryBase}`)
    console.log(`[push] source: ${installPaths.skillInstallDir} + ${installPaths.ruleInstallDir}`)
  }

  const skillTargets = name ? (skills[name] ? [name] : []) : Object.keys(skills)
  const ruleTargets = name ? (rules[name] ? [name] : []) : Object.keys(rules)

  if (name && !skillTargets.length && !ruleTargets.length) {
    throw new Error(`'${name}' is not declared in current skills/rules`)
  }

  function pushArtifact(kind, artifactName, version) {
    const kindConfig = ARTIFACT_KIND[kind]
    const ideDir = kind === 'skill' ? installPaths.skillInstallDir : installPaths.ruleInstallDir
    const srcDir = join(ideDir, artifactName)
    const destDir = join(registryBase, kindConfig.registryDir, artifactName, version)

    if (!existsSync(srcDir)) {
      throw new Error(`${kind} ${artifactName} not found in ${ideDir}`)
    }

    const markerFile = kindConfig.markerFile
    const allFiles = listFilesRecursive(srcDir, srcDir)
    if (!allFiles.includes(markerFile)) {
      throw new Error(`${kind} ${artifactName} missing ${markerFile}`)
    }

    const files = [markerFile, ...allFiles.filter((f) => f !== markerFile)]
    mkdirSync(destDir, { recursive: true })

    for (const file of files) {
      const srcPath = join(srcDir, file)
      const destPath = join(destDir, file)
      if (existsSync(srcPath)) {
        mkdirSync(dirname(destPath), { recursive: true })
        writeFileSync(destPath, readFileSync(srcPath, 'utf-8'), 'utf-8')
      }
    }

    writeFileSync(join(destDir, 'files.json'), JSON.stringify(files, null, 2) + '\n', 'utf-8')
    if (verbose) {
      console.log(`  ${relative(ROOT, srcDir)} -> ${relative(ROOT, destDir)}`)
    }
    process.stdout.write(`Pushed ${kind} ${artifactName}@${version} `)
    console.log('ok')
  }

  for (const item of skillTargets) {
    const version = config.skills?.[item] ?? skills[item] ?? '1.0.0'
    pushArtifact('skill', item, version)
  }

  for (const item of ruleTargets) {
    const version = config.rules?.[item] ?? rules[item] ?? '1.0.0'
    pushArtifact('rule', item, version)
  }

  console.log('push complete. Run `git add` and `git commit` in the registry to save changes.')
}

/** Add artifact (skill or rule) from IDE to Registry. */
async function addArtifactToRegistry(kind, name, version, args) {
  const kindConfig = ARTIFACT_KIND[kind]
  const config = readConfig()
  if (isUrl(config.registry)) {
    throw new Error(`add-${kind} only works with local registry.`)
  }

  const registryBase = resolveLocalBase(config.registry)
  const installPaths = getInstallPaths(config)
  const srcDir =
    kind === 'skill'
      ? join(installPaths.skillInstallDir, name)
      : join(installPaths.ruleInstallDir, name)

  if (!existsSync(srcDir)) {
    const dirHint =
      kind === 'skill'
        ? installPaths.skillInstallDir
        : installPaths.ruleInstallDir
    throw new Error(
      `${kind} '${name}' not found in ${dirHint}. Create .<ide>/${kind}s/${name}/ with ${kindConfig.markerFile} first.`,
    )
  }

  const markerPath = join(srcDir, kindConfig.markerFile)
  if (!existsSync(markerPath)) {
    throw new Error(`${kind} '${name}' missing ${kindConfig.markerFile}`)
  }

  const allFiles = listFilesRecursive(srcDir, srcDir)
  if (!allFiles.includes(kindConfig.markerFile)) {
    throw new Error(`${kind} '${name}' missing ${kindConfig.markerFile}`)
  }

  const files = [
    kindConfig.markerFile,
    ...allFiles.filter((f) => f !== kindConfig.markerFile),
  ]
  const destDir = join(
    registryBase,
    kindConfig.registryDir,
    name,
    version,
  )

  if (existsSync(destDir)) {
    if (!args.includes('--overwrite')) {
      throw new Error(
        `'${name}@${version}' already exists in registry. Use --overwrite to replace.`,
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
  writeFileSync(
    join(destDir, 'files.json'),
    JSON.stringify(files, null, 2) + '\n',
    'utf-8',
  )

  const content = readFileSync(markerPath, 'utf-8')
  const { description: fmDesc } = parseArtifactFrontmatter(content)
  const description = fmDesc ?? `${kind}: ${name}`

  const registryPath = join(registryBase, 'registry.json')
  const registry = JSON.parse(readFileSync(registryPath, 'utf-8'))
  const registryKey = kindConfig.registryKey
  registry[registryKey] ??= {}

  if (registry[registryKey][name]) {
    const pkg = registry[registryKey][name]
    if (!(pkg.versions ?? []).includes(version)) {
      pkg.versions = [...(pkg.versions ?? []), version].sort()
    }
    pkg.latest = version
    if (fmDesc) pkg.description = fmDesc
  } else {
    registry[registryKey][name] = {
      latest: version,
      versions: [version],
      description,
      tags: [name.replace(/-/g, ' ')],
    }
  }

  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n', 'utf-8')

  const configKey = kind === 'skill' ? 'skills' : 'rules'
  config[configKey] ??= {}
  config[configKey][name] = version
  writeConfig(config)

  console.log(`Added ${kind} ${name}@${version} to registry`)
  console.log(`  ${relative(ROOT, srcDir)} -> ${relative(ROOT, destDir)}`)
  console.log(`  Run \`git add\` in the registry to save.`)
}

async function cmdAddSkill(...args) {
  const filtered = args.filter((a) => !a.startsWith('-'))
  const name = filtered[0]
  const version = filtered[1] ?? '1.0.0'
  if (!name) throw new Error('Usage: roleclaw add-skill <name> [version] [--overwrite]')
  await addArtifactToRegistry('skill', name, version, args)
}

async function cmdAddRule(...args) {
  const filtered = args.filter((a) => !a.startsWith('-'))
  const name = filtered[0]
  const version = filtered[1] ?? '1.0.0'
  if (!name) throw new Error('Usage: roleclaw add-rule <name> [version] [--overwrite]')
  await addArtifactToRegistry('rule', name, version, args)
}

/** Remove artifact from Registry. */
async function removeArtifactFromRegistry(kind, name) {
  const kindConfig = ARTIFACT_KIND[kind]
  const config = readConfig()
  if (isUrl(config.registry)) {
    throw new Error(`remove-${kind} only works with local registry.`)
  }

  const registryBase = resolveLocalBase(config.registry)
  const artifactDir = join(registryBase, kindConfig.registryDir, name)

  if (!existsSync(artifactDir)) {
    throw new Error(`${kind} '${name}' not found in registry.`)
  }

  rmSync(artifactDir, { recursive: true, force: true })

  const registryPath = join(registryBase, 'registry.json')
  const registry = JSON.parse(readFileSync(registryPath, 'utf-8'))
  const registryKey = kindConfig.registryKey
  if (registry[registryKey]?.[name]) {
    delete registry[registryKey][name]
    writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n', 'utf-8')
  }

  const configKey = kind === 'skill' ? 'skills' : 'rules'
  if (config[configKey]?.[name]) {
    delete config[configKey][name]
    writeConfig(config)
  }

  console.log(`Removed ${kind} ${name} from registry`)
}

async function cmdRemoveSkill(name) {
  if (!name) throw new Error('Usage: roleclaw remove-skill <name>')
  await removeArtifactFromRegistry('skill', name)
}

async function cmdRemoveRule(name) {
  if (!name) throw new Error('Usage: roleclaw remove-rule <name>')
  await removeArtifactFromRegistry('rule', name)
}

/** Update artifact in Registry (sync from IDE). Same as push for single artifact. */
async function cmdUpdateSkill(...args) {
  const name = args.filter((a) => !a.startsWith('-'))[0]
  if (!name) throw new Error('Usage: roleclaw update-skill <name> [-v]')
  await cmdPush(name, ...args)
}

async function cmdUpdateRule(...args) {
  const name = args.filter((a) => !a.startsWith('-'))[0]
  if (!name) throw new Error('Usage: roleclaw update-rule <name> [-v]')
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
roleclaw - Skills and Rules CLI

Usage:
  roleclaw <command> [args]

Primary commands:
  init [--registry PATH]   Create .roleclaw/config.json (interactive; use ROLECLAW_REGISTRY or --registry for external registry)
  pull [--on-conflict=..] Install declared skills and rules
  list                    List declared and installed skills/rules
  update [name] [--on-conflict=..]
                          Update one artifact or all artifacts
  push [name] [-v]         Push IDE edits back to local registry (local only; -v verbose)
  doctor                  Check config, registry, role, and local installs

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
  add <skill> [version]   Add and install one skill from registry
  remove <name>           Remove artifact from local config and IDE
  search [keyword]        Search skills and rules in registry
  help, --help, -h        Show this help

Config keys:
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

if (['roleclaw', 'roleclaw.mjs'].includes(basename(process.argv[1] ?? ''))) {
  main().catch((error) => {
    console.error(`error: ${error.message}`)
    process.exit(1)
  })
}
