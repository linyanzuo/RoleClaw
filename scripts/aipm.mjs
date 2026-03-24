#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { createHash, randomBytes } from 'crypto'
import { homedir, tmpdir } from 'os'
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

/** Read installed version from artifactDir/package.json. Returns { version, registryPath? } or null if not from aipm. */
function readInstalledVersion(artifactDir) {
  const pkgPath = join(artifactDir, 'package.json')
  if (!existsSync(pkgPath)) return null
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    if (!pkg?.aipm || typeof pkg.aipm !== 'object') return null
    if (!pkg?.version) return null
    return {
      version: String(pkg.version),
      registryPath: pkg.name ? String(pkg.name) : undefined,
    }
  } catch {
    return null
  }
}

const ROOT = process.cwd()
const SCRIPT_FILE = fileURLToPath(import.meta.url)
const TOOL_ROOT = resolve(dirname(SCRIPT_FILE), '..')
const AIPM_DIR = join(ROOT, '.aipm')
/** 本机 IDE 等不随仓库同步的配置（建议在 .gitignore 中忽略 .aipm/） */
const LOCAL_IDE_PROFILE_FILE = join(AIPM_DIR, 'profile.json')
const USER_CONFIG_DIR = join(homedir(), '.aipm')
/** 与 npm 的 ~/.npmrc 类似：key=value，# 行注释 */
const USER_AIPMRC_FILE = join(homedir(), '.aipmrc')
const BUNDLE_CACHE_DIR = join(USER_CONFIG_DIR, 'cache')
/** 与 aipm.mjs 同目录；npmrc 风格模板，供 `aipm global` 首次创建 ~/.aipmrc */
const GLOBAL_AIPMRC_TEMPLATE_FILE = join(dirname(SCRIPT_FILE), 'aipm-global-config.template.aipmrc')
const PROFILE_CONFIG_FILE = join(ROOT, 'aipm_profile.json')
const PROFILE_LOCK_FILE = join(ROOT, 'aipm_profile.lock.json')
const PACKAGE_JSON = join(ROOT, 'package.json')

const IDE_DIR_MAP = {
  cursor: '.cursor',
  codex: '.codex',
  trae: '.trae',
  windsurf: '.windsurf',
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

/** 解析 ~/.aipmrc：npmrc 风格，# 为行尾注释；registry-token / registry / registries（逗号分隔，可多行累加）。 */
function parseAipmrc(text) {
  const out = {}
  const regList = []
  for (let line of text.split(/\r?\n/)) {
    const hash = line.indexOf('#')
    if (hash >= 0) line = line.slice(0, hash)
    line = line.trim()
    if (!line || line.startsWith(';')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const rawKey = line.slice(0, eq).trim().toLowerCase().replace(/-/g, '')
    let val = line.slice(eq + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1)
    }
    if (rawKey === 'registrytoken') {
      if (val) out.registryToken = val
    } else if (rawKey === 'registry') {
      if (val) out.registry = val.replace(/\/+$/, '') + '/'
    } else if (rawKey === 'registries') {
      for (const part of val.split(',').map((s) => s.trim()).filter(Boolean)) {
        regList.push(part.replace(/\/+$/, '') + '/')
      }
    }
  }
  if (regList.length) out.registries = regList
  return out
}

/** 为支持 query token 的私有 HTTP 源追加 token（GET 拉取用）。已含 token= / private_token= 则不改。 */
function appendRegistryToken(url) {
  const token = getRegistryToken()
  if (!token || url.includes('token=') || url.includes('private_token=')) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}token=${encodeURIComponent(token)}`
}

/** Registry ID for bundle cache (stable hash of ref). */
function registryCacheId(ref) {
  return createHash('sha256').update(ref).digest('hex').slice(0, 16)
}

/** Bundle cache path for a remote resource. */
function bundleCachePath(baseRef, relativePath) {
  return join(BUNDLE_CACHE_DIR, registryCacheId(baseRef), relativePath)
}

/** Write to bundle cache (backup). */
function writeToBundleCache(baseRef, relativePath, content, isJson = false) {
  const cachePath = isUrl(baseRef)
    ? bundleCachePath(baseRef, relativePath)
    : join(BUNDLE_CACHE_DIR, 'published', registryCacheId(baseRef), relativePath)
  mkdirSync(dirname(cachePath), { recursive: true })
  writeFileSync(cachePath, isJson ? JSON.stringify(content, null, 0) : content, 'utf-8')
}

/** 远程 publish 打包上限（tar 子进程 stdout） */
const PUBLISH_TGZ_MAX_BUFFER = 48 * 1024 * 1024

/** 在 dirAbs 下将 relativePaths 打成 gzip tar（需系统 tar，Windows 10+ 自带）。 */
function packArtifactTarGz(dirAbs, relativePaths) {
  const sorted = [...relativePaths].sort()
  if (!sorted.length) {
    throw new Error('No files to pack')
  }
  const r = spawnSync('tar', ['-czf', '-', '-C', dirAbs, ...sorted], {
    maxBuffer: PUBLISH_TGZ_MAX_BUFFER,
    encoding: 'buffer',
    windowsHide: true,
  })
  if (r.error) {
    throw new Error(
      `${r.error.message} Run publish on a system with tar in PATH (Windows 10+ includes tar.exe).`,
    )
  }
  if (r.status !== 0) {
    const errText = r.stderr?.toString() || r.stdout?.toString() || `exit ${r.status}`
    throw new Error(`tar pack failed: ${errText}`)
  }
  return r.stdout
}

/**
 * 手动构造 multipart/form-data，避免 Node fetch + FormData/Blob/File 与 multer 不兼容或触发 ExperimentalWarning。
 */
function encodeMultipartPublish(manifestJson, tarGzBuffer) {
  const boundary = `----aipmPublish${randomBytes(16).toString('hex')}`
  const crlf = '\r\n'
  const buf = Buffer.isBuffer(tarGzBuffer) ? tarGzBuffer : Buffer.from(tarGzBuffer)
  const head1 = Buffer.from(
    `--${boundary}${crlf}Content-Disposition: form-data; name="manifest"${crlf}${crlf}${manifestJson}${crlf}`,
    'utf8',
  )
  const head2 = Buffer.from(
    `--${boundary}${crlf}Content-Disposition: form-data; name="artifact"; filename="artifact.tgz"${crlf}Content-Type: application/gzip${crlf}${crlf}`,
    'utf8',
  )
  const tail = Buffer.from(`${crlf}--${boundary}--${crlf}`, 'utf8')
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat([head1, head2, buf, tail]),
  }
}

function resolveLocalBase(baseRef) {
  return isAbsolute(baseRef) ? baseRef : resolve(ROOT, baseRef)
}

/** Resolve registry ref. Local path must exist; no bundled fallback. */
function resolveRegistryRef(ref) {
  if (isUrl(ref)) return ref
  return ref
}

/** 默认仓库：本地 aipm-registry（Docker 映射宿主机 9005）。未启动服务时 install 会失败，可改用项目/全局 registry 覆盖。 */
const DEFAULT_REGISTRY_URL = 'http://localhost:9005/'

function defaultRegistryRef() {
  return DEFAULT_REGISTRY_URL
}

/** 读取全局配置 ~/.aipmrc（npmrc 风格，支持 # 注释）。 */
function readGlobalConfig() {
  if (!existsSync(USER_AIPMRC_FILE)) return {}
  try {
    return parseAipmrc(readFileSync(USER_AIPMRC_FILE, 'utf-8'))
  } catch {
    return {}
  }
}

/** Read registry token: env AIPM_REGISTRY_TOKEN > ~/.aipmrc */
function getRegistryToken() {
  if (process.env.AIPM_REGISTRY_TOKEN) {
    const e = String(process.env.AIPM_REGISTRY_TOKEN).trim()
    return e || null
  }
  const t = readGlobalConfig().registryToken
  if (t == null || String(t).trim() === '') return null
  return String(t)
}

function defaultConfig() {
  return {
    registry: null,
    registries: null,
    skills: {},
    rules: {},
  }
}

/**
 * 返回有序 registry 列表。顺序：项目自定义 → 全局自定义 → 默认仓库。
 * - 默认仓库：http://localhost:9005/（aipm-registry，与 DEFAULT_REGISTRY_URL 一致）
 * - 全局自定义：~/.aipmrc 的 registry / registries，所有项目共享
 * - 项目自定义：aipm_profile.json 的 registry/registries，仅当前项目生效
 */
function getRegistries(config) {
  /** registries 显式为 [] 时仍应回退到单独的 registry 字段（否则仅写 registry 会被忽略）。 */
  let projectList = []
  const multi = config.registries
  if (multi != null) {
    const asArray = Array.isArray(multi) ? multi : [multi]
    projectList = asArray.filter(Boolean)
  }
  if (!projectList.length && config.registry) {
    projectList = [config.registry]
  }
  const globalCfg = readGlobalConfig()
  let globalList = []
  const gMulti = globalCfg?.registries
  if (gMulti != null) {
    globalList = (Array.isArray(gMulti) ? gMulti : [gMulti]).filter(Boolean)
  }
  if (!globalList.length && globalCfg?.registry) {
    globalList = [globalCfg.registry]
  }
  const combined = [...projectList.filter(Boolean), ...globalList.filter(Boolean)]
  const defaultRef = defaultRegistryRef()
  if (combined.includes(defaultRef)) return combined
  return [...combined, defaultRef]
}

/** 默认 publish 目标：第一个可用的 registry（本地路径存在 或 HTTP URL）。 */
function getDefaultPublishRegistry(config) {
  for (const ref of getRegistries(config)) {
    const resolved = resolveRegistryRef(ref)
    if (isUrl(resolved)) return resolved
    const abs = resolveLocalBase(ref)
    if (existsSync(abs)) return resolved
  }
  return null
}

/** 解析 package 的 sourceRegistry。返回 "default" | 本地路径。 */
function getSourceRegistryFromPackage(ideDir) {
  const pkgPath = join(ideDir, 'package.json')
  if (!existsSync(pkgPath)) return 'default'
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    const src = pkg?.aipm?.sourceRegistry
    return src ?? 'default'
  } catch {
    return 'default'
  }
}

/** 解析 publish 目标：--registry > package.sourceRegistry > 默认。支持本地路径或 HTTP URL。 */
function resolvePublishTarget(config, ideDir, registryOverride) {
  if (registryOverride) {
    return resolveRegistryRef(registryOverride)
  }
  const src = getSourceRegistryFromPackage(ideDir)
  if (src === 'default') return getDefaultPublishRegistry(config)
  return resolveRegistryRef(src)
}

function getConfigFilePath() {
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

/** 写入可同步的 aipm_profile.json（不含 ide）；ide 写入 .aipm/profile.json */
function writeConfig(data) {
  const { ide, ...rest } = data
  writeFileSync(PROFILE_CONFIG_FILE, JSON.stringify(rest, null, 2) + '\n', 'utf-8')
  if (ide !== undefined && ide !== null && String(ide).trim() !== '') {
    const k = normalizeIdeKey(String(ide).trim())
    if (k) writeLocalIdeProfile({ ide: k })
  }
}

const LOCKFILE_VERSION = 1

/** Read aipm_profile.lock.json. Returns null if missing or invalid. */
function readLockFile() {
  if (!existsSync(PROFILE_LOCK_FILE)) return null
  try {
    const lock = JSON.parse(readFileSync(PROFILE_LOCK_FILE, 'utf-8'))
    if (lock?.lockfileVersion !== LOCKFILE_VERSION) return null
    return lock
  } catch {
    return null
  }
}

/** Write aipm_profile.lock.json. */
function writeLockFile(lock) {
  const data = {
    lockfileVersion: LOCKFILE_VERSION,
    skills: lock.skills ?? {},
    rules: lock.rules ?? {},
  }
  writeFileSync(PROFILE_LOCK_FILE, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

/** Merge updates into lock, keep only desired packages, write. */
function mergeAndWriteLock(oldLock, updates, desiredSkills, desiredRules) {
  const skills = { ...(oldLock?.skills ?? {}) }
  for (const [k, v] of Object.entries(updates?.skills ?? {})) {
    skills[k] = v
  }
  const rules = { ...(oldLock?.rules ?? {}) }
  for (const [k, v] of Object.entries(updates?.rules ?? {})) {
    rules[k] = v
  }
  const filteredSkills = Object.fromEntries(
    Object.entries(skills).filter(([k]) => k in (desiredSkills ?? {})),
  )
  const filteredRules = Object.fromEntries(
    Object.entries(rules).filter(([k]) => k in (desiredRules ?? {})),
  )
  writeLockFile({ skills: filteredSkills, rules: filteredRules })
}

/**
 * Resolve artifact: use lock if valid (package exists at locked registry), else findRegistryForArtifact.
 * Returns { registryRef, version }.
 */
async function resolveArtifactWithLock(lock, registries, packageName, kind, requestedVersion) {
  const kindKey = kind === 'skill' ? 'skills' : 'rules'
  const locked = lock?.[kindKey]?.[packageName]
  if (locked?.version && locked?.registry) {
    const resolved = resolveRegistryRef(locked.registry)
    try {
      const registry = await fetchRegistry(resolved)
      const index = registry?.[kind === 'skill' ? 'packages' : 'rules']
      const item = index?.[packageName]
      if (item) {
        const kindLabel = kind === 'skill' ? 'Skill' : 'Rule'
        const version = resolveVersionFromItem(item, locked.version, kindLabel, packageName)
        return { registryRef: resolved, version, fromLock: true }
      }
    } catch {
      /* fall through to fresh resolve */
    }
  }
  const result = await findRegistryForArtifact(registries, packageName, kind, requestedVersion)
  return { ...result, fromLock: false }
}

/** Read config from package.json aipm or aipm_profile.json (project root). */
function readConfig() {
  const merged = mergeProjectConfigFromFiles()
  if (!merged) {
    throw new Error('aipm config not found. Add "aipm" to package.json or run: aipm init')
  }
  return finalizeConfigWithIde(merged)
}

function readConfigOrDefault() {
  const merged = mergeProjectConfigFromFiles()
  if (!merged) return finalizeConfigWithIde(defaultConfig())
  return finalizeConfigWithIde(merged)
}

function mergeConfig(base, overrides) {
  return {
    ...base,
    registry: overrides.registry ?? base.registry,
    registries: overrides.registries ?? base.registries,
    profile: overrides.profile ?? base.profile,
    skills: { ...(base.skills ?? {}), ...(overrides.skills ?? {}) },
    rules: { ...(base.rules ?? {}), ...(overrides.rules ?? {}) },
  }
}

/** 从可同步对象中去掉 ide（ide 只应存在于 .aipm/profile.json） */
function stripIdeFromObject(obj) {
  if (!obj || typeof obj !== 'object') return {}
  const { ide: _drop, ...rest } = obj
  return rest
}

function readLocalIdeProfile() {
  if (!existsSync(LOCAL_IDE_PROFILE_FILE)) return {}
  try {
    const j = JSON.parse(readFileSync(LOCAL_IDE_PROFILE_FILE, 'utf-8'))
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {}
  } catch {
    return {}
  }
}

function writeLocalIdeProfile(patch) {
  mkdirSync(AIPM_DIR, { recursive: true })
  const prev = readLocalIdeProfile()
  const next = { ...prev, ...patch }
  writeFileSync(LOCAL_IDE_PROFILE_FILE, JSON.stringify(next, null, 2) + '\n', 'utf-8')
}

function normalizeIdeKey(value) {
  if (value === undefined || value === null) return null
  const k = String(value).trim().toLowerCase()
  return IDE_DIR_MAP[k] ? k : null
}

/** 从 aipm_profile.json 删除 ide 字段（迁移到 .aipm/profile.json 后调用） */
function stripIdeFromSharedProfileFile() {
  if (!existsSync(PROFILE_CONFIG_FILE)) return
  try {
    const o = JSON.parse(readFileSync(PROFILE_CONFIG_FILE, 'utf-8'))
    if (!('ide' in o)) return
    delete o.ide
    writeFileSync(PROFILE_CONFIG_FILE, JSON.stringify(o, null, 2) + '\n', 'utf-8')
  } catch {
    /* ignore */
  }
}

/** 仅从磁盘读取「旧版」同步文件中的 ide，供首次选择 IDE 时作默认项（不经过 strip） */
function peekIdeFromSharedFiles() {
  if (existsSync(PROFILE_CONFIG_FILE)) {
    try {
      const n = normalizeIdeKey(JSON.parse(readFileSync(PROFILE_CONFIG_FILE, 'utf-8'))?.ide)
      if (n) return n
    } catch {}
  }
  if (existsSync(PACKAGE_JSON)) {
    try {
      const n = normalizeIdeKey(JSON.parse(readFileSync(PACKAGE_JSON, 'utf-8'))?.aipm?.ide)
      if (n) return n
    } catch {}
  }
  return null
}

function mergeProjectConfigFromFiles() {
  if (existsSync(PACKAGE_JSON)) {
    try {
      const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf-8'))
      if (pkg.aipm && typeof pkg.aipm === 'object') {
        return mergeConfig(defaultConfig(), stripIdeFromObject(pkg.aipm))
      }
    } catch {}
  }
  if (existsSync(PROFILE_CONFIG_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(PROFILE_CONFIG_FILE, 'utf-8'))
      return mergeConfig(defaultConfig(), stripIdeFromObject(raw))
    } catch {}
  }
  return null
}

/** 合并共享配置与本地 .aipm/profile.json 中的 ide */
function finalizeConfigWithIde(sharedMerged) {
  const local = readLocalIdeProfile()
  const ide = normalizeIdeKey(local.ide) ?? 'cursor'
  return { ...sharedMerged, ide }
}

function parseIdeCliArg(args = []) {
  const eq = args.find((a) => a.startsWith('--ide='))
  if (eq) return normalizeIdeKey(eq.slice('--ide='.length))
  const i = args.indexOf('--ide')
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) {
    return normalizeIdeKey(args[i + 1])
  }
  return null
}

/**
 * 在使用需安装路径的命令前调用：若无 .aipm/profile.json 中的 ide，则 --ide 或交互选择，并写入本地文件、从 aipm_profile.json 去掉 ide。
 */
async function ensureLocalIdeConfigured(args = []) {
  const local = readLocalIdeProfile()
  if (normalizeIdeKey(local.ide)) return

  const fromFlag = parseIdeCliArg(args)
  if (fromFlag) {
    writeLocalIdeProfile({ ide: fromFlag })
    stripIdeFromSharedProfileFile()
    return
  }

  const suggested = peekIdeFromSharedFiles() ?? 'cursor'
  const ideList = Object.keys(IDE_DIR_MAP)
  const defaultIndex = Math.max(0, ideList.indexOf(suggested))

  if (!process.stdin.isTTY) {
    throw new Error(
      'Missing IDE in .aipm/profile.json. Run interactively once or pass: aipm install --ide=cursor (codex|trae|windsurf)',
    )
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  console.log('\nTarget IDE (saved to .aipm/profile.json, not committed with the repo):')
  ideList.forEach((ide, i) => console.log(`  ${i + 1}. ${ide}`))
  const ideChoice = await question(rl, `\nSelect IDE (1-${ideList.length})`, String(defaultIndex + 1))
  rl.close()
  const ideIndex = parseInt(String(ideChoice), 10)
  const picked = ideList[ideIndex - 1] ?? suggested
  writeLocalIdeProfile({ ide: picked })
  stripIdeFromSharedProfileFile()
}

/** Read JSON: remote 先查 bundle 缓存，命中则直接用；否则拉取并写入缓存。 */
async function readJsonResource(baseRef, relativePath) {
  if (isUrl(baseRef)) {
    const cachePath = bundleCachePath(baseRef, relativePath)
    if (existsSync(cachePath)) {
      return JSON.parse(readFileSync(cachePath, 'utf-8'))
    }
    const url = appendRegistryToken(joinUrl(baseRef, relativePath))
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Unable to read ${relativePath} (${response.status})`)
    }
    const data = await response.json()
    writeToBundleCache(baseRef, relativePath, data, true)
    return data
  }

  const absolutePath = join(resolveLocalBase(baseRef), relativePath)
  return JSON.parse(readFileSync(absolutePath, 'utf-8'))
}

/** Read text: remote 先查 bundle 缓存，命中则直接用；否则拉取并写入缓存。 */
async function readTextResource(baseRef, relativePath) {
  if (isUrl(baseRef)) {
    const cachePath = bundleCachePath(baseRef, relativePath)
    if (existsSync(cachePath)) {
      return readFileSync(cachePath, 'utf-8')
    }
    const url = appendRegistryToken(joinUrl(baseRef, relativePath))
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Unable to read ${relativePath} (${response.status})`)
    }
    const text = await response.text()
    writeToBundleCache(baseRef, relativePath, text, false)
    return text
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

/** 按 registries 顺序查找包含该 package 的 registry，返回 { registryRef, registry, version }。 */
async function findRegistryForArtifact(registries, packageName, kind, requestedVersion) {
  const kindLabel = kind === 'skill' ? 'Skill' : 'Rule'
  for (const ref of registries) {
    const resolved = resolveRegistryRef(ref)
    try {
      const registry = await fetchRegistry(resolved)
      const index = registry?.[kind === 'skill' ? 'packages' : 'rules']
      const item = index?.[packageName]
      if (item) {
        const version = resolveVersionFromItem(item, requestedVersion, kindLabel, packageName)
        return { registryRef: resolved, registry, version }
      }
    } catch {
      continue
    }
  }
  throw new Error(`${kindLabel} '${packageName}' was not found in any registry`)
}

/** 按 registries 顺序合并 registry.json（同 package 先到先得），用于 list/doctor 等。 */
async function fetchMergedRegistry(registries) {
  const merged = { packages: {}, rules: {} }
  for (const ref of registries) {
    const resolved = resolveRegistryRef(ref)
    try {
      const reg = await fetchRegistry(resolved)
      for (const [k, v] of Object.entries(reg?.packages ?? {})) {
        if (!merged.packages[k]) merged.packages[k] = v
      }
      for (const [k, v] of Object.entries(reg?.rules ?? {})) {
        if (!merged.rules[k]) merged.rules[k] = v
      }
    } catch {
      continue
    }
  }
  return merged
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

/** Parse install dir name to registry path. Prefer package.json name (registryPath) if present. */
function parseInstallNameToRegistryPath(installName, pkgRegistryPath = null) {
  const registryPath = pkgRegistryPath ?? installNameToRegistryPath(installName)
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

  const pkg = await readJsonResource(
    baseRef,
    `${kindConfig.registryDir}/${registryPath}/${version}/package.json`,
  )
  const files = Array.isArray(pkg?.files) ? pkg.files : null
  if (!files?.length) {
    throw new Error(`Package ${registryPath}@${version} missing package.json with valid "files" array`)
  }
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
          `[conflict] '${relative(ROOT, artifactDir)}' exists but has no package.json with aipm field (not from aipm). Overwrite?`,
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

  console.log(' ok')
  return { installed: true, skipped: false }
}

/** Load profile (配置单) from registry. Returns { skills, rules } or null if not found. */
async function loadProfileConfigFromRef(registryRef, profileId) {
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

/** Load profile from first registry that has it (multi-registry). */
async function loadProfileConfig(registries, profileId) {
  for (const ref of registries) {
    const resolved = resolveRegistryRef(ref)
    const result = await loadProfileConfigFromRef(resolved, profileId)
    if (result) return result
  }
  return null
}

/** Return desired artifacts from config. When config.profile is set, load profile from registries and merge with explicit config (explicit overrides profile). */
async function resolveDesiredArtifacts(config) {
  let skills = {}
  let rules = {}
  const registries = getRegistries(config)

  if (config.profile) {
    const profileArtifacts = await loadProfileConfig(registries, config.profile)
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
  const name = block.match(/name:\s*["']([^"']+)["']/)?.[1] ?? block.match(/name:\s*(.+)/)?.[1]?.trim()
  const descMatch = block.match(/description:\s*["']([^"']+)["']/) ?? block.match(/description:\s*([^\n]+)/)
  const description = descMatch?.[1]?.trim()
  return { name, description }
}

/** Validate artifact before publish. Throws on failure. */
function validatePublishArtifact(srcDir, kindConfig, registryPath, version) {
  const markerFile = kindConfig.markerFile
  const markerPath = join(srcDir, markerFile)
  if (!existsSync(markerPath)) {
    throw new Error(`Missing ${markerFile}`)
  }
  const markerContent = readFileSync(markerPath, 'utf-8')
  const { name: fmName, description: fmDesc } = parseArtifactFrontmatter(markerContent)
  if (!fmName?.trim()) {
    throw new Error(`${markerFile} frontmatter must have "name" field`)
  }
  if (!fmDesc?.trim()) {
    throw new Error(`${markerFile} frontmatter must have "description" field`)
  }

  const pkgPath = join(srcDir, 'package.json')
  if (!existsSync(pkgPath)) {
    throw new Error('package.json is required')
  }
  let pkg
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  } catch (e) {
    throw new Error(`package.json invalid: ${e.message}`)
  }
  if (pkg?.name !== registryPath) {
    throw new Error(
      `package.json "name" must be "${registryPath}", got "${pkg?.name ?? '(missing)'}"`,
    )
  }
  if (pkg?.version !== version) {
    throw new Error(
      `package.json "version" must be "${version}", got "${pkg?.version ?? '(missing)'}"`,
    )
  }
  const files = Array.isArray(pkg?.files) ? pkg.files : []
  if (!files.length) {
    throw new Error('package.json "files" array is required and must not be empty')
  }
  if (!files.includes(markerFile)) {
    throw new Error(`package.json "files" must include "${markerFile}"`)
  }
  for (const f of files) {
    const p = join(srcDir, f)
    if (!existsSync(p)) {
      throw new Error(`package.json "files" lists "${f}" but file does not exist`)
    }
  }
  const allInDir = listFilesRecursive(srcDir, srcDir).filter(
    (f) => f !== '.aipm' && f !== 'files.json',
  )
  const filesSet = new Set(files)
  for (const f of allInDir) {
    if (!filesSet.has(f)) {
      throw new Error(
        `File "${f}" exists in directory but is not in package.json "files". Add it or remove the file.`,
      )
    }
  }
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
  return defaultRegistryRef()
}

/** 解析 publish 的 --registry 覆盖，未指定则 null。 */
function parseRegistryOverride(args) {
  const i = args.indexOf('--registry')
  if (i >= 0 && args[i + 1]) return args[i + 1]
  const eq = args.find((a) => a.startsWith('--registry='))
  if (eq) return eq.slice('--registry='.length)
  return null
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
  if (hasPkgAipm || existsSync(PROFILE_CONFIG_FILE)) {
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
  const ideChoice = await question(rl, `\nSelect IDE (1-${ideList.length})`, '1')
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
  console.log(`ide: ${config.ide} (saved to .aipm/profile.json — do not commit; use .gitignore)`)
  if (config.profile) {
    console.log(`profile: ${config.profile}`)
  }
  console.log('Run `aipm install` to install skills and rules.')
}

async function cmdPull(...args) {
  await ensureLocalIdeConfigured(args)
  const config = readConfig()
  const { skills, rules } = await resolveDesiredArtifacts(config)
  const registries = getRegistries(config)
  const installPaths = getInstallPaths(config)
  const conflictState = { mode: parseConflictMode(args) }
  const explicitSkills = new Set(Object.keys(config.skills ?? {}))
  const explicitRules = new Set(Object.keys(config.rules ?? {}))
  const lock = readLockFile()

  ensureIdeDirs(installPaths)

  const newLock = { skills: {}, rules: {} }

  for (const [packageName, requestedVersion] of Object.entries(skills)) {
    const { registryRef, version } = await resolveArtifactWithLock(
      lock,
      registries,
      packageName,
      'skill',
      requestedVersion,
    )
    const installName = registryPathToInstallName(packageName)
    ARTIFACT_KIND.skill.installDir = installPaths.skillInstallDir
    const result = await installArtifact(registryRef, 'skill', packageName, version, {
      installName,
      conflictState,
    })
    if (result.installed && explicitSkills.has(packageName)) {
      config.skills[packageName] = version
    }
    newLock.skills[packageName] = { version, registry: registryRef }
  }

  for (const [packageName, requestedVersion] of Object.entries(rules)) {
    const { registryRef, version } = await resolveArtifactWithLock(
      lock,
      registries,
      packageName,
      'rule',
      requestedVersion,
    )
    const installName = registryPathToInstallName(packageName)
    ARTIFACT_KIND.rule.installDir = installPaths.ruleInstallDir
    const result = await installArtifact(registryRef, 'rule', packageName, version, {
      installName,
      conflictState,
    })
    if (result.installed && explicitRules.has(packageName)) {
      config.rules[packageName] = version
    }
    newLock.rules[packageName] = { version, registry: registryRef }
  }

  writeLockFile(newLock)

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

async function cmdList(...args) {
  if (mergeProjectConfigFromFiles()) {
    await ensureLocalIdeConfigured(args)
  }
  const config = readConfigOrDefault()
  const { skills, rules } = await resolveDesiredArtifacts(config)
  const registries = getRegistries(config)
  const registry = await fetchMergedRegistry(registries)
  const installPaths = getInstallPaths(config)

  console.log(`registries: ${registries.join(', ')}`)
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
  await ensureLocalIdeConfigured(args)
  const config = readConfig()
  const { skills, rules } = await resolveDesiredArtifacts(config)
  const registries = getRegistries(config)
  const registry = await fetchMergedRegistry(registries)
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

  const lock = readLockFile()
  const newLock = { skills: {}, rules: {} }

  for (const packageName of skillTargets) {
    const requested = skills[packageName] ?? 'latest'
    const { registryRef, version } = await resolveArtifactWithLock(
      lock,
      registries,
      packageName,
      'skill',
      requested,
    )
    const installName = registryPathToInstallName(packageName)
    ARTIFACT_KIND.skill.installDir = installPaths.skillInstallDir
    const result = await installArtifact(registryRef, 'skill', packageName, version, {
      installName,
      conflictState,
    })
    if (result.installed && (config.skills ?? {})[packageName] !== undefined) {
      config.skills[packageName] = version
    }
    newLock.skills[packageName] = { version, registry: registryRef }
  }

  for (const packageName of ruleTargets) {
    const requested = rules[packageName] ?? 'latest'
    const { registryRef, version } = await resolveArtifactWithLock(
      lock,
      registries,
      packageName,
      'rule',
      requested,
    )
    const installName = registryPathToInstallName(packageName)
    ARTIFACT_KIND.rule.installDir = installPaths.ruleInstallDir
    const result = await installArtifact(registryRef, 'rule', packageName, version, {
      installName,
      conflictState,
    })
    if (result.installed && (config.rules ?? {})[packageName] !== undefined) {
      config.rules[packageName] = version
    }
    newLock.rules[packageName] = { version, registry: registryRef }
  }

  writeConfig(config)
  mergeAndWriteLock(lock, newLock, skills, rules)
  console.log('update complete')
}

async function cmdDoctor(...args) {
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
  const hasAipmConfig = existsSync(PROFILE_CONFIG_FILE)

  if (!hasPkgAipm && !hasAipmConfig) {
    console.log('[fail] aipm config not found (package.json aipm or aipm_profile.json)')
    console.log('run `aipm init` first')
    process.exitCode = 1
    return
  }

  console.log('[ok] config exists')

  await ensureLocalIdeConfigured(args)
  const config = readConfig()
  const installPaths = getInstallPaths(config)
  const registries = getRegistries(config)
  let registry

  const firstRef = resolveRegistryRef(registries[0])
  if (isUrl(firstRef)) {
    const token = getRegistryToken()
    console.log(`[info] registries: ${registries.join(', ')}`)
    console.log(`[info] bundle cache: ${BUNDLE_CACHE_DIR}`)
    console.log(`[info] global config: ${USER_AIPMRC_FILE}`)
    console.log(`[info] token: ${token ? 'configured' : 'not set (run aipm set-token for private)'}`)
  }
  try {
    registry = await fetchMergedRegistry(registries)
    console.log('[ok] registry is reachable')
  } catch (error) {
    console.log(`[fail] registry check failed: ${error.message}`)
    if (isUrl(firstRef) && !getRegistryToken()) {
      console.log('[hint] Private registry may need token. Run: aipm set-token <your-token>')
    }
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

async function cmdUse(...args) {
  const profileId = args[0]
  if (!profileId) {
    const config = readConfigOrDefault()
    const registries = getRegistries(config)
    let profiles = []
    for (const ref of registries) {
      const resolved = resolveRegistryRef(ref)
      if (!isUrl(resolved)) {
        profiles = listAvailableProfiles(resolved)
        if (profiles.length) break
      }
    }
    if (!profiles.length) {
      console.log('No profiles found in registry. Add profiles/*.json to your registry.')
      return
    }
    console.log('Available profiles:')
    profiles.forEach((p) => console.log(`  - ${p}`))
    console.log('\nUsage: aipm use <profile-id>')
    return
  }

  await ensureLocalIdeConfigured(args)
  const config = readConfigOrDefault()
  const registries = getRegistries(config)
  const profileData = await loadProfileConfig(registries, profileId)
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

async function cmdSetToken(tokenArg) {
  let token = tokenArg?.trim()
  if (!token && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    token = (await question(rl, 'Registry token (from 云效 个人访问令牌)')).trim()
    rl.close()
  }
  if (!token) {
    throw new Error('Usage: aipm set-token <token>   or run interactively')
  }
  if (/[\r\n]/.test(token)) {
    throw new Error('Registry token must not contain newlines')
  }

  mkdirSync(USER_CONFIG_DIR, { recursive: true })
  let text = existsSync(USER_AIPMRC_FILE) ? readFileSync(USER_AIPMRC_FILE, 'utf-8') : ''
  const lineRe = /^[ \t]*registry-token[ \t]*=.*/im
  const newLine = `registry-token=${token}`
  if (lineRe.test(text)) {
    text = text.replace(lineRe, newLine)
  } else {
    if (text && !text.endsWith('\n')) text += '\n'
    text += `${newLine}\n`
  }
  writeFileSync(USER_AIPMRC_FILE, text, 'utf-8')
  chmodSync(USER_AIPMRC_FILE, 0o600)

  console.log(`Registry token saved to ${USER_AIPMRC_FILE}`)
  console.log('Run `aipm install` to verify.')
}

/** 若 ~/.aipmrc 不存在，则从模板复制创建。 */
function ensureGlobalConfigFileFromTemplate() {
  mkdirSync(USER_CONFIG_DIR, { recursive: true })
  if (existsSync(USER_AIPMRC_FILE)) return false
  let body = ''
  if (existsSync(GLOBAL_AIPMRC_TEMPLATE_FILE)) {
    body = readFileSync(GLOBAL_AIPMRC_TEMPLATE_FILE, 'utf-8')
    if (body && !body.endsWith('\n')) body += '\n'
  }
  writeFileSync(USER_AIPMRC_FILE, body, 'utf-8')
  chmodSync(USER_AIPMRC_FILE, 0o600)
  return true
}

async function cmdGlobal() {
  const created = ensureGlobalConfigFileFromTemplate()
  let status
  if (created) status = 'created'
  else if (existsSync(USER_AIPMRC_FILE)) status = 'exists'
  else status = 'missing'

  const labelW = 11
  const line = (k, v) => console.log(`${k.padEnd(labelW)}${v}`)
  line('file:', USER_AIPMRC_FILE)
  line('status:', status)
  line('template:', GLOBAL_AIPMRC_TEMPLATE_FILE)
}

async function cmdInstallSkill(...args) {
  const [name, version = 'latest'] = args
  if (!name) {
    throw new Error('Usage: aipm install-skill <name> [version]  (name: @scope/name or scope_name)')
  }

  if (mergeProjectConfigFromFiles()) {
    await ensureLocalIdeConfigured(args)
  }
  const config = readConfigOrDefault()
  const registries = getRegistries(config)
  const lock = readLockFile()
  const { registryRef, version: resolvedVersion } = await resolveArtifactWithLock(
    lock,
    registries,
    name,
    'skill',
    version,
  )
  const installName = registryPathToInstallName(name)
  const installPaths = getInstallPaths(config)

  ensureIdeDirs(installPaths)
  ARTIFACT_KIND.skill.installDir = installPaths.skillInstallDir
  await installArtifact(registryRef, 'skill', name, resolvedVersion, { installName })

  config.skills ??= {}
  config.skills[name] = resolvedVersion
  writeConfig(config)
  mergeAndWriteLock(lock, { skills: { [name]: { version: resolvedVersion, registry: registryRef } } }, config.skills, config.rules ?? {})

  console.log(`installed skill ${name}@${resolvedVersion}`)
}

async function cmdInstallRule(...args) {
  const [name, version = 'latest'] = args
  if (!name) {
    throw new Error('Usage: aipm install-rule <name> [version]  (name: @scope/name or scope_name)')
  }

  if (mergeProjectConfigFromFiles()) {
    await ensureLocalIdeConfigured(args)
  }
  const config = readConfigOrDefault()
  const registries = getRegistries(config)
  const lock = readLockFile()
  const { registryRef, version: resolvedVersion } = await resolveArtifactWithLock(
    lock,
    registries,
    name,
    'rule',
    version,
  )
  const installName = registryPathToInstallName(name)
  const installPaths = getInstallPaths(config)

  ensureIdeDirs(installPaths)
  ARTIFACT_KIND.rule.installDir = installPaths.ruleInstallDir
  await installArtifact(registryRef, 'rule', name, resolvedVersion, { installName })

  config.rules ??= {}
  config.rules[name] = resolvedVersion
  writeConfig(config)
  mergeAndWriteLock(lock, { rules: { [name]: { version: resolvedVersion, registry: registryRef } } }, config.skills ?? {}, config.rules)

  console.log(`installed rule ${name}@${resolvedVersion}`)
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

async function cmdUninstallSkill(name, ...args) {
  if (!name) {
    throw new Error('Usage: aipm uninstall-skill <name>  (name: @scope/name or scope_name)')
  }

  await ensureLocalIdeConfigured(args)
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
    const lock = readLockFile()
    mergeAndWriteLock(lock, {}, config.skills ?? {}, config.rules ?? {})
  }

  console.log('uninstalled skill (if existed)')
}

async function cmdUninstallRule(name, ...args) {
  if (!name) {
    throw new Error('Usage: aipm uninstall-rule <name>  (name: @scope/name or scope_name)')
  }

  await ensureLocalIdeConfigured(args)
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
    const lock = readLockFile()
    mergeAndWriteLock(lock, {}, config.skills ?? {}, config.rules ?? {})
  }

  console.log('uninstalled rule (if existed)')
}

function formatPublishError(e) {
  return e instanceof Error ? e.message : String(e)
}

function printPublishResultsSummary(results) {
  console.log('')
  console.log('Publish results:')
  for (const r of results) {
    const ver = r.version && r.version !== '—' ? `@${r.version}` : ''
    if (r.ok) {
      console.log(`  [${r.kind}] ${r.packageName}${ver}  ok`)
    } else {
      console.log(`  [${r.kind}] ${r.packageName}${ver}  failed — ${r.error}`)
    }
  }
  const okn = results.filter((r) => r.ok).length
  const fail = results.length - okn
  console.log('---')
  console.log(`ok: ${okn}, failed: ${fail}`)
}

/**
 * Publish IDE skills/rules：目标由 resolvePublishTarget 决定（--registry > package.sourceRegistry > 默认）。
 * 默认 registry 为 DEFAULT_REGISTRY_URL（HTTP aipm-registry）；本地路径则直接写盘。
 * Source: .<ide>/skills/、.<ide>/rules/（相对含 aipm_profile.json 的项目根）
 */
async function cmdPush(...args) {
  await ensureLocalIdeConfigured(args)
  const filtered = args.filter((a) => !a.startsWith('-'))
  const name = filtered[0]
  const config = readConfig()
  const registryOverride = parseRegistryOverride(args)
  const installPaths = getInstallPaths(config)

  const verbose = args.includes('--verbose') || args.includes('-v')
  const { skills, rules } = await resolveDesiredArtifacts(config)

  if (verbose) {
    console.log(`[publish] workspace root: ${ROOT}`)
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

  function pushArtifact(kind, installName, registryPath, version, registryRef, registryBase, registry, quiet = false) {
    const kindConfig = ARTIFACT_KIND[kind]
    const existingVersions = registry[kindConfig.registryKey]?.[registryPath]?.versions ?? []
    if (existingVersions.includes(version)) {
      throw new Error(
        `Version ${version} is already published for '${registryPath}'. Bump version (e.g. 1.0.1) in package.json to publish changes.`,
      )
    }

    const ideDir = kind === 'skill' ? installPaths.skillInstallDir : installPaths.ruleInstallDir
    const srcDir = join(ideDir, installName)
    const destDir = join(registryBase, kindConfig.registryDir, registryPath, version)

    if (!existsSync(srcDir)) {
      throw new Error(`${kind} ${installName} not found in ${ideDir}`)
    }

    validatePublishArtifact(srcDir, kindConfig, registryPath, version)

    const markerFile = kindConfig.markerFile
    const allFiles = listFilesRecursive(srcDir, srcDir)
    if (!allFiles.includes(markerFile)) {
      throw new Error(`${kind} ${installName} missing ${markerFile}`)
    }

    const files = [
      markerFile,
      ...allFiles.filter(
        (f) => f !== markerFile && f !== '.aipm' && f !== 'files.json',
      ),
    ]
    mkdirSync(destDir, { recursive: true })

    const relDir = `${kindConfig.registryDir}/${registryPath}/${version}`
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
        if (file === 'package.json') {
          try {
            const pkg = JSON.parse(content)
            if (!pkg.aipm) pkg.aipm = {}
            if (pkg.aipm.sourceRegistry === undefined) pkg.aipm.sourceRegistry = 'default'
            pkg.files = files
            content = JSON.stringify(pkg, null, 2) + '\n'
          } catch {
            /* keep original */
          }
        }
        writeFileSync(destPath, content, 'utf-8')
        writeToBundleCache(registryRef, `${relDir}/${file}`, content, false)
      }
    }

    const registryKey = kindConfig.registryKey
    registry[registryKey] ??= {}
    const pkg = registry[registryKey][registryPath]
    if (pkg) {
      pkg.versions = [...(pkg.versions ?? []), version].sort()
      pkg.latest = version
      const markerPath = join(srcDir, kindConfig.markerFile)
      if (existsSync(markerPath)) {
        const { description: fmDesc } = parseArtifactFrontmatter(readFileSync(markerPath, 'utf-8'))
        if (fmDesc) pkg.description = fmDesc
      }
    } else {
      const markerPath = join(srcDir, kindConfig.markerFile)
      const { description: fmDesc } = parseArtifactFrontmatter(readFileSync(markerPath, 'utf-8'))
      const logicalName = registryPath.includes('/') ? registryPath.split('/').pop() : registryPath
      registry[registryKey][registryPath] = {
        latest: version,
        versions: [version],
        description: fmDesc ?? `${kind}: ${logicalName}`,
        tags: [logicalName.replace(/-/g, ' ')],
      }
    }
    const registryJsonPath = join(registryBase, 'registry.json')
    const registryStr = JSON.stringify(registry, null, 2) + '\n'
    writeFileSync(registryJsonPath, registryStr, 'utf-8')
    writeToBundleCache(registryRef, 'registry.json', registryStr, false)

    const config = readConfig()
    const configKey = kind === 'skill' ? 'skills' : 'rules'
    config[configKey] ??= {}
    config[configKey][registryPath] = version
    writeConfig(config)

    if (verbose) {
      console.log(`  ${relative(ROOT, srcDir)} -> ${relative(ROOT, destDir)}`)
    }
    if (!quiet) {
      process.stdout.write(`Pushed ${kind} ${installName}@${version} `)
      console.log('ok')
    }
  }

  const registryCache = new Map()
  async function getRegistryForPush(registryRef) {
    if (!registryCache.has(registryRef)) {
      registryCache.set(registryRef, await fetchRegistry(registryRef))
    }
    return registryCache.get(registryRef)
  }

  const publishQuiet = !verbose
  const results = []

  for (const packageName of skillTargets) {
    let version = ''
    try {
      const installName = registryPathToInstallName(packageName)
      const ideDir = join(installPaths.skillInstallDir, installName)
      const registryRef = resolvePublishTarget(config, ideDir, registryOverride)
      if (!registryRef) {
        throw new Error(
          `no registry. Add one to registries or use --registry <path-or-url>.`,
        )
      }
      const registry = await getRegistryForPush(registryRef)
      version = config.skills?.[packageName] ?? skills[packageName] ?? '1.0.0'
      if (isUrl(registryRef)) {
        await publishToRemoteRegistry('skill', packageName, version, registryRef, { quiet: publishQuiet })
      } else {
        const registryBase = resolveLocalBase(registryRef)
        const isNew = !registry.packages?.[packageName]
        if (isNew) {
          await addArtifactToRegistry('skill', packageName, version, args, publishQuiet)
        } else {
          const { registryPath, installName: inName } = resolveArtifactPath(
            registry,
            'skill',
            packageName,
            version,
          )
          pushArtifact('skill', inName, registryPath, version, registryRef, registryBase, registry, publishQuiet)
        }
      }
      results.push({ kind: 'skill', packageName, version, ok: true })
    } catch (e) {
      const msg = formatPublishError(e)
      results.push({
        kind: 'skill',
        packageName,
        version: version || '—',
        ok: false,
        error: msg,
      })
    }
  }

  for (const packageName of ruleTargets) {
    let version = ''
    try {
      const installName = registryPathToInstallName(packageName)
      const ideDir = join(installPaths.ruleInstallDir, installName)
      const registryRef = resolvePublishTarget(config, ideDir, registryOverride)
      if (!registryRef) {
        throw new Error(
          `no registry. Add one to registries or use --registry <path-or-url>.`,
        )
      }
      const registry = await getRegistryForPush(registryRef)
      version = config.rules?.[packageName] ?? rules[packageName] ?? '1.0.0'
      if (isUrl(registryRef)) {
        await publishToRemoteRegistry('rule', packageName, version, registryRef, { quiet: publishQuiet })
      } else {
        const registryBase = resolveLocalBase(registryRef)
        const isNew = !registry.rules?.[packageName]
        if (isNew) {
          await addArtifactToRegistry('rule', packageName, version, args, publishQuiet)
        } else {
          const { registryPath, installName: inName } = resolveArtifactPath(
            registry,
            'rule',
            packageName,
            version,
          )
          pushArtifact('rule', inName, registryPath, version, registryRef, registryBase, registry, publishQuiet)
        }
      }
      results.push({ kind: 'rule', packageName, version, ok: true })
    } catch (e) {
      const msg = formatPublishError(e)
      results.push({
        kind: 'rule',
        packageName,
        version: version || '—',
        ok: false,
        error: msg,
      })
    }
  }

  printPublishResultsSummary(results)
  const failCount = results.filter((r) => !r.ok).length
  if (failCount) {
    process.exitCode = 1
    console.log(`Publish finished with ${failCount} failure(s). Fix errors and re-run publish.`)
  } else {
    console.log('publish complete. Run `git add` and `git commit` in the registry to save changes.')
  }
}

/** Scaffold IDE artifact dir. Creates package.json and marker file. */
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

  const markerFile = kindConfig.markerFile
  const pkg = {
    name: registryPath,
    version,
    description: desc,
    aipm: { type: kind, sourceRegistry: 'default' },
    files: [markerFile, 'package.json'],
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
  writeFileSync(join(srcDir, markerFile), markerContent, 'utf-8')

  console.log(`Created ${kind} scaffold at ${relative(ROOT, srcDir)}`)
  return srcDir
}

/** Publish artifact to remote HTTP registry (POST /api/publish). */
async function publishToRemoteRegistry(kind, packageName, version, registryUrl, options = {}) {
  const kindConfig = ARTIFACT_KIND[kind]
  const config = readConfig()
  const installPaths = getInstallPaths(config)
  const installName = registryPathToInstallName(packageName)
  const srcDir =
    kind === 'skill'
      ? join(installPaths.skillInstallDir, installName)
      : join(installPaths.ruleInstallDir, installName)

  if (!existsSync(srcDir)) {
    throw new Error(`${kind} '${installName}' not found. Run \`aipm init-${kind}\` or \`aipm install\` first.`)
  }

  const registryPath = packageName
  validatePublishArtifact(srcDir, kindConfig, registryPath, version)

  const allFiles = listFilesRecursive(srcDir, srcDir).filter(
    (f) => f !== '.aipm' && f !== 'files.json',
  )
  const files = {}
  for (const f of allFiles) {
    const p = join(srcDir, f)
    if (existsSync(p)) {
      files[f] = readFileSync(p, 'utf-8')
    }
  }
  if (files['package.json']) {
    try {
      const pkg = JSON.parse(files['package.json'])
      if (!pkg.aipm) pkg.aipm = {}
      pkg.aipm.sourceRegistry = pkg.aipm.sourceRegistry ?? 'default'
      pkg.files = Object.keys(files)
      files['package.json'] = JSON.stringify(pkg, null, 2) + '\n'
    } catch {
      /* keep original */
    }
  }

  const markerPath = join(srcDir, kindConfig.markerFile)
  const { description: fmDesc } = parseArtifactFrontmatter(readFileSync(markerPath, 'utf-8'))
  const base = registryUrl.replace(/\/+$/, '')
  const apiUrl = `${base}/api/publish`
  const token = getRegistryToken()

  const tmpRoot = mkdtempSync(join(tmpdir(), 'aipm-publish-'))
  let tarGz
  let manifest
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = join(tmpRoot, rel)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, content, 'utf-8')
    }
    const relKeys = Object.keys(files).sort()
    tarGz = packArtifactTarGz(tmpRoot, relKeys)
    const filesSha256 = {}
    for (const f of relKeys) {
      const buf = readFileSync(join(tmpRoot, f))
      filesSha256[f] = createHash('sha256').update(buf).digest('hex')
    }
    manifest = {
      kind,
      registryPath,
      version,
      description: fmDesc || undefined,
      filesSha256,
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true })
  }

  const { contentType, body } = encodeMultipartPublish(JSON.stringify(manifest), tarGz)

  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body,
  })
  const raw = await res.text()
  let data = {}
  try {
    data = JSON.parse(raw)
  } catch {
    /* non-JSON body (e.g. proxy HTML) */
  }
  if (!res.ok) {
    const hint = typeof data.error === 'string' ? data.error : raw.slice(0, 200)
    throw new Error(hint || `Publish failed (${res.status})`)
  }

  const configKey = kind === 'skill' ? 'skills' : 'rules'
  config[configKey] ??= {}
  config[configKey][registryPath] = version
  writeConfig(config)

  if (!options.quiet) {
    console.log(`Published ${kind} ${registryPath}@${version} to ${base}`)
  }
}

/** Add artifact (skill or rule) from IDE to Registry. */
async function addArtifactToRegistry(kind, name, version, args, quiet = false) {
  const kindConfig = ARTIFACT_KIND[kind]
  const config = readConfig()
  const installName =
    name.startsWith('@') && name.includes('/') ? registryPathToInstallName(name) : name
  const ideDir =
    kind === 'skill'
      ? join(getInstallPaths(config).skillInstallDir, installName)
      : join(getInstallPaths(config).ruleInstallDir, installName)
  const registryOverride = parseRegistryOverride(args)
  const registryRef = resolvePublishTarget(config, ideDir, registryOverride)
  if (!registryRef) {
    throw new Error(`add-${kind} requires a local registry. Add one to registries or use --registry <path>.`)
  }

  const registryBase = resolveLocalBase(registryRef)
  const installPaths = getInstallPaths(config)

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

  validatePublishArtifact(srcDir, kindConfig, registryPath, version)

  const allFiles = listFilesRecursive(srcDir, srcDir)
  if (!allFiles.includes(kindConfig.markerFile)) {
    throw new Error(`${kind} '${installName}' missing ${kindConfig.markerFile}`)
  }

  const files = [
    kindConfig.markerFile,
    ...allFiles.filter(
      (f) =>
        f !== kindConfig.markerFile &&
        f !== '.aipm' &&
        f !== 'files.json',
    ),
  ]
  const destDir = join(registryBase, kindConfig.registryDir, registryPath, version)

  const registryJsonPath = join(registryBase, 'registry.json')
  const registry = JSON.parse(readFileSync(registryJsonPath, 'utf-8'))
  const registryKey = kindConfig.registryKey
  const existingVersions = registry[registryKey]?.[registryPath]?.versions ?? []
  if (existingVersions.includes(version)) {
    throw new Error(
      `Version ${version} is already published for '${registryPath}'. Bump version (e.g. 1.0.1) in package.json to publish changes.`,
    )
  }
  if (existsSync(destDir)) {
    throw new Error(
      `'${registryPath}@${version}' already exists in registry. Bump version (e.g. 1.0.1) to publish.`,
    )
  }

  mkdirSync(destDir, { recursive: true })
  const relDir = `${kindConfig.registryDir}/${registryPath}/${version}`
  for (const file of files) {
    const srcPath = join(srcDir, file)
    const destPath = join(destDir, file)
    if (existsSync(srcPath)) {
      mkdirSync(dirname(destPath), { recursive: true })
      let content = readFileSync(srcPath, 'utf-8')
      if (file === 'package.json') {
        try {
          const pkg = JSON.parse(content)
          if (!pkg.aipm) pkg.aipm = {}
          if (pkg.aipm.sourceRegistry === undefined) pkg.aipm.sourceRegistry = 'default'
          pkg.files = files
          content = JSON.stringify(pkg, null, 2) + '\n'
        } catch {
          /* keep original */
        }
      }
      writeFileSync(destPath, content, 'utf-8')
      writeToBundleCache(registryRef, `${relDir}/${file}`, content, false)
    }
  }

  const content = readFileSync(markerPath, 'utf-8')
  const { description: fmDesc } = parseArtifactFrontmatter(content)
  const description = fmDesc ?? `${kind}: ${logicalName}`

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

  const registryStr = JSON.stringify(registry, null, 2) + '\n'
  writeFileSync(registryJsonPath, registryStr, 'utf-8')
  writeToBundleCache(registryRef, 'registry.json', registryStr, false)

  const configKey = kind === 'skill' ? 'skills' : 'rules'
  config[configKey] ??= {}
  config[configKey][registryPath] = version
  writeConfig(config)

  if (!quiet) {
    console.log(`Added ${kind} ${registryPath}@${version} to registry`)
    console.log(`  ${relative(ROOT, srcDir)} -> ${relative(ROOT, destDir)}`)
    console.log(`  Run \`git add\` in the registry to save.`)
  }
}

/** Create new skill/rule package interactively. Prompts for name, description, version. */
async function cmdInitSkill(...args) {
  if (!process.stdin.isTTY) {
    throw new Error('aipm init-skill requires interactive mode. Run in a terminal.')
  }
  await ensureLocalIdeConfigured(args)
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
async function cmdInitRule(...args) {
  if (!process.stdin.isTTY) {
    throw new Error('aipm init-rule requires interactive mode. Run in a terminal.')
  }
  await ensureLocalIdeConfigured(args)
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
  const registryRef = getDefaultPublishRegistry(config)
  if (!registryRef) {
    throw new Error(`unpublish-${kind} requires a local registry. Add one to registries or use --registry <path>.`)
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
  const registryStr = JSON.stringify(registry, null, 2) + '\n'
  writeFileSync(join(registryBase, 'registry.json'), registryStr, 'utf-8')
  writeToBundleCache(registryRef, 'registry.json', registryStr, false)

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
  const registries = getRegistries(config)
  const registry = await fetchMergedRegistry(registries)

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
  install [--on-conflict=..] [--ide=cursor|codex|trae|windsurf]
                          Install declared skills/rules (writes aipm_profile.lock.json for reproducibility)
                          Uses .aipm/profile.json for IDE; creates it on first run if missing
  list                    List declared and installed skills/rules
  update [name] [--on-conflict=..]
                          Update one artifact or all artifacts
  publish [name] [--registry PATH] [-v]
                          Sync to Registry (default: package sourceRegistry; -v verbose)
  doctor                  Check config, registry, and local installs

Create new packages (interactive):
  init-skill              Create new skill (prompts: name, description, version)
  init-rule               Create new rule (prompts: name, description, version)

Registry commands (local registry only):
  unpublish-skill <name> Remove skill from registry
  unpublish-rule <name>  Remove rule from registry

Additional commands:
  global                  Print ~/.aipmrc path / status / template path; create from template if no global file yet
  set-token [token]       Save registry-token in ~/.aipmrc (npmrc-style); publish uses Bearer, GET may use ?token=
  use [profile-id]        Switch to profile (配置单). Without arg, list available profiles.
  install-skill <name> [version]   Add skill to config and install from registry
  install-rule <name> [version]   Add rule to config and install from registry
  uninstall-skill <name>  Remove skill from config and IDE
  uninstall-rule <name>   Remove rule from config and IDE
  search [keyword]        Search skills and rules in registry
  help, --help, -h        Show this help

Config keys:
  aipm_profile.json       Synced project config: registry, registries, profile, skills, rules (no ide)
  .aipm/profile.json      Local only: ide (and future per-machine keys). Created on first install if missing.
  ~/.aipmrc                Global (npmrc-style): registry, registries (comma or repeated lines), registry-token; # comments
  package.json aipm.*     Optional; ide in package.json is treated like legacy and not written back to profile
  package.json aipm.sourceRegistry         Package source for publish ("default" or path)
  Default registry is http://localhost:9005/ (aipm-registry); project + global + default are merged in order.
  profile                 Current profile (loads skills/rules from profiles/<profile>.json)
  skills, rules           Dependencies (npm-style: name -> version). Override profile.
  ide                     Set via .aipm/profile.json; override once with --ide= on install/update/etc.

Bundle cache (~/.aipm/cache): Remote reads are cached; publish backs up to cache.

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
  'set-token': cmdSetToken,
  global: cmdGlobal,
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
