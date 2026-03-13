#!/usr/bin/env node

import { createInterface } from 'node:readline'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'

function question(rl, promptText, defaultValue = '') {
  const suffix = defaultValue ? ` [${defaultValue}]` : ''
  return new Promise((resolve) => {
    rl.question(`${promptText}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue)
    })
  })
}

const ROOT = process.cwd()
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
  // Step 1/2/3 prefer local registry template for fast iteration.
  const localRegistry = join(ROOT, 'registry-template')
  if (existsSync(localRegistry)) {
    return './registry-template'
  }

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
  mkdirSync(paths.ideRootDir, { recursive: true })
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

async function installArtifact(baseRef, kind, name, version) {
  const kindConfig = ARTIFACT_KIND[kind]
  const installRoot = kindConfig.installDir
  const artifactDir = join(installRoot, name)

  process.stdout.write(`Installing ${kind} ${name}@${version} `)

  const files = await readJsonResource(
    baseRef,
    `${kindConfig.registryDir}/${name}/${version}/files.json`,
  )

  // Replace existing directory to avoid stale files.
  rmSync(artifactDir, { recursive: true, force: true })
  mkdirSync(artifactDir, { recursive: true })

  for (const file of files) {
    const targetPath = join(artifactDir, file)
    mkdirSync(dirname(targetPath), { recursive: true })
    writeFileSync(
      targetPath,
      await readTextResource(baseRef, `${kindConfig.registryDir}/${name}/${version}/${file}`),
      'utf-8',
    )
    process.stdout.write('.')
  }

  console.log(' ok')
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

  if (config.role) {
    try {
      const roleConfig = await fetchRoleConfig(config.registry, config, config.role)
      config.skills = { ...roleConfig.requiredSkills }
      config.rules = { ...roleConfig.requiredRules }
    } catch {
      config.skills = {}
      config.rules = {}
    }
  }

  writeConfig(config)
  console.log('\ncreated .roleclaw/config.json')
  console.log(`registry: ${config.registry}`)
  console.log(`ide: ${config.ide}`)
  console.log(`role: ${config.role ?? '(none)'}`)
  if (config.role) {
    console.log('run `roleclaw sync` to install skills and rules')
  }
}

async function cmdUseRole(role) {
  if (!role) {
    throw new Error('Usage: roleclaw use-role <role>')
  }

  const config = readConfigOrDefault()
  const roleConfig = await fetchRoleConfig(config.registry, config, role)

  config.role = role
  config.skills = { ...roleConfig.requiredSkills }
  config.rules = { ...roleConfig.requiredRules }
  writeConfig(config)

  console.log(`ide target: ${resolveIde(config)}`)
  console.log(`role set to: ${role}`)
  console.log(`role source: ${roleConfig.source}`)
  console.log(`default skills: ${Object.keys(config.skills).join(', ') || '(none)'}`)
  console.log(`default rules: ${Object.keys(config.rules).join(', ') || '(none)'}`)
  console.log('run `roleclaw sync` to install skills and rules')
}

async function cmdSync() {
  const config = readConfig()
  const { skills, rules } = await resolveDesiredArtifacts(config)
  const registry = await fetchRegistry(config.registry)
  const installPaths = getInstallPaths(config)

  ensureIdeDirs(installPaths)
  mkdirSync(installPaths.skillInstallDir, { recursive: true })
  mkdirSync(installPaths.ruleInstallDir, { recursive: true })

  for (const [name, requestedVersion] of Object.entries(skills)) {
    const resolvedVersion = resolveVersion(registry.packages, name, requestedVersion, 'Skill')
    ARTIFACT_KIND.skill.installDir = installPaths.skillInstallDir
    await installArtifact(config.registry, 'skill', name, resolvedVersion)
    config.skills[name] = resolvedVersion
  }

  for (const [name, requestedVersion] of Object.entries(rules)) {
    const resolvedVersion = resolveVersion(registry.rules, name, requestedVersion, 'Rule')
    ARTIFACT_KIND.rule.installDir = installPaths.ruleInstallDir
    await installArtifact(config.registry, 'rule', name, resolvedVersion)
    config.rules[name] = resolvedVersion
  }

  writeConfig(config)
  console.log('sync complete')
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

async function cmdUpdate(name) {
  const config = readConfig()
  const { skills, rules } = await resolveDesiredArtifacts(config)
  const registry = await fetchRegistry(config.registry)
  const installPaths = getInstallPaths(config)

  ensureIdeDirs(installPaths)
  mkdirSync(installPaths.skillInstallDir, { recursive: true })
  mkdirSync(installPaths.ruleInstallDir, { recursive: true })

  const skillTargets = name ? (skills[name] ? [name] : []) : Object.keys(skills)
  const ruleTargets = name ? (rules[name] ? [name] : []) : Object.keys(rules)

  if (name && !skillTargets.length && !ruleTargets.length) {
    throw new Error(`'${name}' is not declared in current skills/rules`)
  }

  for (const item of skillTargets) {
    const latest = resolveVersion(registry.packages, item, 'latest', 'Skill')
    ARTIFACT_KIND.skill.installDir = installPaths.skillInstallDir
    await installArtifact(config.registry, 'skill', item, latest)
    config.skills[item] = latest
  }

  for (const item of ruleTargets) {
    const latest = resolveVersion(registry.rules, item, 'latest', 'Rule')
    ARTIFACT_KIND.rule.installDir = installPaths.ruleInstallDir
    await installArtifact(config.registry, 'rule', item, latest)
    config.rules[item] = latest
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
  mkdirSync(installPaths.skillInstallDir, { recursive: true })
  mkdirSync(installPaths.ruleInstallDir, { recursive: true })
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
  mkdirSync(installPaths.skillInstallDir, { recursive: true })
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
 */
async function cmdPush(name) {
  const config = readConfig()
  if (isUrl(config.registry)) {
    throw new Error(
      'push only works with local registry. Your registry is a URL. ' +
        'To contribute changes, edit the registry repo directly and submit a PR.',
    )
  }

  const registryBase = resolveLocalBase(config.registry)
  const { skills, rules } = await resolveDesiredArtifacts(config)
  const installPaths = getInstallPaths(config)

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
  use-role <role>         Select role and write default skills/rules
  sync                    Install declared skills and rules
  list                    List declared and installed skills/rules
  update [name]           Update one artifact or all artifacts
  push [name]             Push IDE edits back to local registry (local only)
  doctor                  Check config, registry, role, and local installs

Additional commands:
  add <skill> [version]   Add and install one skill
  remove <name>           Remove artifact from skills/rules
  search [keyword]        Search skills and rules in registry
  help, --help, -h        Show this help

Config keys:
  ide                     Target IDE runtime directory (cursor|codex)
`

const COMMANDS = {
  init: cmdInit,
  'use-role': cmdUseRole,
  sync: cmdSync,
  list: cmdList,
  update: cmdUpdate,
  push: cmdPush,
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
