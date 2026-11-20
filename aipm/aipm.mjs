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

/**
 * npm-style ^ range: locked version must be >= min and below next incompatible bump.
 * ^1.2.3 -> [1.2.3, 2.0.0); ^0.2.3 -> [0.2.3, 0.3.0); ^0.0.3 -> [0.0.3, 0.0.4)
 */
function lockedVersionSatisfiesCaret(lockedV, caretRequest) {
  const minStr = caretRequest.slice(1).trim()
  const l = parseSemver(lockedV)
  const min = parseSemver(minStr)
  if (!l || !min) return false
  const ge = semverCompare(lockedV, minStr)
  if (ge === null || ge < 0) return false

  const [lMaj, lMin, lPat] = l
  const [mMaj, mMin, mPat] = min

  if (mMaj > 0) {
    return lMaj === mMaj
  }
  if (mMin > 0) {
    return lMaj === 0 && lMin === mMin
  }
  return lMaj === 0 && lMin === 0 && lPat === mPat
}

/** Declared constraint (exact or ^x.y.z) satisfied by locked version — for lockfile preference like npm. */
function lockedVersionSatisfiesRequest(lockedV, requested) {
  if (requested == null || requested === '') return false
  const r = String(requested).trim()
  if (r === 'latest') return false
  if (r.startsWith('^')) return lockedVersionSatisfiesCaret(lockedV, r)
  return String(lockedV) === r
}

/** Greatest published version satisfying npm-style ^ (same rules as lockedVersionSatisfiesCaret). */
function maxVersionSatisfyingCaret(versions, caretRequest) {
  if (!versions?.length) return null
  const candidates = versions.filter((v) => lockedVersionSatisfiesCaret(v, caretRequest))
  return maxSemverAmongVersions(candidates)
}

function maxSemverAmongVersions(versions) {
  if (!versions?.length) return null
  let best = versions[0]
  for (let i = 1; i < versions.length; i++) {
    const v = versions[i]
    const c = semverCompare(v, best)
    if (c === 1) best = v
    if (c === null && String(v) > String(best)) best = v
  }
  return best
}

/** publish：待发布版本须高于仓库已有 latest（semver）；新包无记录则任意合法版本。 */
function assertPublishVersionVsRegistry(registry, kind, registryPath, newVersion) {
  const registryKey = ARTIFACT_KIND[kind].registryKey
  const item = registry[registryKey]?.[registryPath]
  if (!item) return
  const existingVersions = item.versions ?? []
  if (existingVersions.includes(newVersion)) {
    throw new Error(`Version ${newVersion} is already published for '${registryPath}'.`)
  }
  if (!existingVersions.length) return
  const latest =
    item.latest && existingVersions.includes(item.latest)
      ? item.latest
      : maxSemverAmongVersions(existingVersions)
  if (!latest) return
  const cmp = semverCompare(newVersion, latest)
  if (cmp === null) {
    throw new Error(
      `Cannot compare publish version "${newVersion}" with registry latest "${latest}". Use semver x.y.z (e.g. 1.2.3).`,
    )
  }
  if (cmp !== 1) {
    throw new Error(
      `Publish version "${newVersion}" must be greater than registry latest "${latest}" (semver).`,
    )
  }
}

function readPublishVersionFromArtifact(srcDir) {
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
  const v = pkg?.version
  if (v == null || String(v).trim() === '') {
    throw new Error('package.json "version" is required')
  }
  return String(v).trim()
}

function parseConflictMode(args = []) {
  const byFlag = args.find((a) => a.startsWith('--on-conflict='))
  const mode = byFlag ? byFlag.split('=')[1] : 'ask'
  if (!['ask', 'skip', 'overwrite'].includes(mode)) {
    throw new Error("Invalid --on-conflict value. Use 'ask', 'skip', or 'overwrite'.")
  }
  return mode
}

/** Split install-related CLI into flags vs positionals (package name / version). */
function parseInstallCliArgs(args = []) {
  const flagArgs = []
  const positionals = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--skip-registry-refresh' || a === '-v' || a === '--verbose') {
      flagArgs.push(a)
      continue
    }
    if (typeof a === 'string' && a.startsWith('--on-conflict=')) {
      flagArgs.push(a)
      continue
    }
    if (a === '--on-conflict') {
      flagArgs.push(a)
      if (i + 1 < args.length && args[i + 1] != null && !String(args[i + 1]).startsWith('-')) {
        flagArgs.push(args[++i])
      }
      continue
    }
    if (typeof a === 'string' && a.startsWith('--ide=')) {
      flagArgs.push(a)
      continue
    }
    if (a === '--ide') {
      flagArgs.push(a)
      if (i + 1 < args.length) flagArgs.push(args[++i])
      continue
    }
    if (typeof a === 'string' && a.startsWith('--kind=')) {
      flagArgs.push(a)
      continue
    }
    if (a === '--kind') {
      flagArgs.push(a)
      if (i + 1 < args.length) flagArgs.push(args[++i])
      continue
    }
    if (String(a).startsWith('-')) {
      flagArgs.push(a)
      continue
    }
    positionals.push(a)
  }
  return { flagArgs, positionals }
}

/** init-skill / init-rule：仅识别 --ide，其余位置参数为包名（第一个可跳过交互询问包名）。 */
function parseInitArtifactCliArgs(args = []) {
  const flagArgs = []
  const positionals = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (typeof a === 'string' && a.startsWith('--ide=')) {
      flagArgs.push(a)
      continue
    }
    if (a === '--ide') {
      flagArgs.push(a)
      if (i + 1 < args.length) flagArgs.push(args[++i])
      continue
    }
    if (String(a).startsWith('-')) {
      flagArgs.push(a)
      continue
    }
    positionals.push(a)
  }
  return { flagArgs, positionals }
}

function parseInstallKindFlag(flagArgs = []) {
  const eq = flagArgs.find((a) => typeof a === 'string' && a.startsWith('--kind='))
  if (eq) {
    const v = eq.slice('--kind='.length).trim().toLowerCase()
    if (v === 'skill' || v === 'rule') return v
    throw new Error(`Invalid --kind (use skill or rule): ${eq}`)
  }
  const idx = flagArgs.indexOf('--kind')
  if (idx >= 0 && flagArgs[idx + 1] != null) {
    const v = String(flagArgs[idx + 1]).trim().toLowerCase()
    if (v === 'skill' || v === 'rule') return v
    throw new Error(`Invalid --kind (use skill or rule): ${flagArgs[idx + 1]}`)
  }
  return null
}

/** Remove --kind so install-skill / install-rule do not receive it. */
function stripInstallKindFlags(flagArgs = []) {
  const out = []
  for (let i = 0; i < flagArgs.length; i++) {
    const a = flagArgs[i]
    if (typeof a === 'string' && a.startsWith('--kind=')) continue
    if (a === '--kind') {
      i++
      continue
    }
    out.push(a)
  }
  return out
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

function sha256Utf8(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** filesIntegrity 只记录除 package.json 外的包内文件，便于写入后回写清单而不产生自引用哈希。 */
function buildFilesIntegrityMap(files, getUtf8Content) {
  const integrity = {}
  for (const file of files) {
    if (file === 'package.json') continue
    const raw = getUtf8Content(file)
    if (raw == null) continue
    integrity[file] = sha256Utf8(raw)
  }
  return integrity
}

/** 本地目录是否与上次安装快照一致：无额外交付文件、声明的文件哈希与 package.json.filesIntegrity 一致。 */
function isArtifactTreePristine(artifactDir, files) {
  const pkgPath = join(artifactDir, 'package.json')
  if (!existsSync(pkgPath)) return false
  let pkg
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  } catch {
    return false
  }
  const integ = pkg?.filesIntegrity
  if (!integ || typeof integ !== 'object') return false
  const contentFiles = files.filter((f) => f !== 'package.json')
  for (const f of contentFiles) {
    const expected = integ[f]
    if (typeof expected !== 'string' || !expected) return false
    const abs = join(artifactDir, f)
    if (!existsSync(abs)) return false
    if (sha256Utf8(readFileSync(abs, 'utf-8')) !== expected) return false
  }
  const allowed = new Set(files)
  const onDisk = listFilesRecursive(artifactDir).filter(
    (rel) => rel !== '.aipm' && !rel.startsWith('.aipm/'),
  )
  for (const rel of onDisk) {
    if (!allowed.has(rel)) return false
  }
  return true
}

function embedFilesIntegrityInInstalledArtifact(artifactDir, files) {
  const pkgPath = join(artifactDir, 'package.json')
  if (!existsSync(pkgPath)) return
  const integrity = buildFilesIntegrityMap(files, (f) => {
    const abs = join(artifactDir, f)
    return existsSync(abs) ? readFileSync(abs, 'utf-8') : null
  })
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  pkg.filesIntegrity = integrity
  pkg.files = files
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf-8')
}

function recordLockEntry(newLock, kindKey, packageName, version, registryRef, result, prevLock) {
  const prev = prevLock?.[kindKey]?.[packageName]
  if (
    result.outcome === 'declined_overwrite' ||
    result.outcome === 'declined_downgrade' ||
    result.outcome === 'skipped_non_dir'
  ) {
    if (prev) newLock[kindKey][packageName] = prev
    return
  }
  newLock[kindKey][packageName] = { version, registry: registryRef }
}

function pushInstallSummaryLine(summary, kind, installName, version, result) {
  const label = `${kind} ${installName}@${version}`
  if (result.outcome === 'updated') summary.updated.push(label)
  else if (result.outcome === 'unchanged') summary.unchanged.push(label)
  else {
    const reason =
      result.outcome === 'declined_downgrade'
        ? 'user declined downgrade'
        : result.outcome === 'declined_overwrite'
          ? 'user declined overwrite'
          : result.outcome === 'skipped_non_dir'
            ? 'path exists but is not a directory (skipped)'
            : result.outcome ?? 'skipped'
    summary.notUpdated.push(`${label} — ${reason}`)
  }
}

function printInstallSummary(summary) {
  console.log('')
  console.log('--- install summary ---')
  if (summary.updated.length) {
    console.log('Updated:')
    for (const line of summary.updated) console.log(`  · ${line}`)
  }
  if (summary.unchanged.length) {
    console.log('Unchanged (already at target version):')
    for (const line of summary.unchanged) console.log(`  · ${line}`)
  }
  if (summary.notUpdated.length) {
    console.log('Not updated:')
    for (const line of summary.notUpdated) console.log(`  · ${line}`)
  }
  if (!summary.updated.length && !summary.unchanged.length && !summary.notUpdated.length) {
    console.log('(no packages declared)')
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
/** 项目 aipm_profile 默认模板；`aipm init` 先深拷贝此文件内容再按 CLI/交互写入 registry、ide、profile 等 */
const PROFILE_TEMPLATE_FILE = join(dirname(SCRIPT_FILE), 'aipm-profile.template.json')
const PROFILE_CONFIG_FILE = join(ROOT, 'aipm_profile.json')
const PROFILE_LOCK_FILE = join(ROOT, 'aipm_profile.lock.json')

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
    /** 仅作文档；实际文件名由 resolveRuleMarkerFromPkgFiles / ruleMarkerFilename 决定（兼容旧 RULE.md）。 */
    markerFile: 'RULE.md',
  },
}

const LEGACY_RULE_MARKER = 'RULE.md'

/** @docker/project-context → project-context（用于规则主 markdown 文件名） */
function ruleLogicalBasename(registryPath) {
  const tail = registryPath.includes('/') ? registryPath.split('/').pop() : registryPath
  const s = String(tail ?? '').trim()
  return s || 'rule'
}

/** 与 skill 目录语义一致：短名 + .md，去掉非法路径字符 */
function ruleMarkerFilename(registryPath) {
  const base = ruleLogicalBasename(registryPath)
  const safe = base
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  if (!safe) {
    throw new Error(`Invalid registry path for rule marker file: ${registryPath}`)
  }
  return `${safe}.md`
}

/**
 * 从 package.json 的 files 解析规则「主」markdown：优先 LEGACY RULE.md，否则 {逻辑短名}.md，否则唯一的非 README .md。
 * 若传入 srcDir，则先把「目录型」files 项展开为具体路径再解析（与 publish 时 directory 条目一致）。
 */
function resolveRuleMarkerFromPkgFiles(pkg, registryPath, srcDir = null) {
  const files = Array.isArray(pkg?.files) ? pkg.files : []
  let md
  if (srcDir) {
    const expanded = []
    for (const raw of files) {
      if (typeof raw !== 'string' || !raw.trim()) continue
      const entry = normalizePublishRelPath(raw.trim())
      const abs = join(srcDir, entry)
      if (!existsSync(abs)) continue
      try {
        const st = statSync(abs)
        if (st.isDirectory()) {
          for (const f of listFilesRecursive(abs, abs)) {
            expanded.push(normalizePublishRelPath(join(entry, f)))
          }
        } else if (st.isFile()) {
          expanded.push(entry)
        }
      } catch {
        /* skip */
      }
    }
    md = expanded.filter(
      (f) => f.endsWith('.md') && !/^readme\.md$/i.test(basename(f)),
    )
  } else {
    md = files.filter(
      (f) => typeof f === 'string' && f.endsWith('.md') && !/^readme\.md$/i.test(f),
    )
  }
  if (md.includes(LEGACY_RULE_MARKER)) return LEGACY_RULE_MARKER
  const expected = ruleMarkerFilename(registryPath)
  if (md.includes(expected)) return expected
  if (md.length === 1) return md[0]
  return md[0] ?? expected
}

function ruleArtifactDirHasMarker(dir, registryPath) {
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) return false
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    const marker = resolveRuleMarkerFromPkgFiles(pkg, registryPath, dir)
    return existsSync(join(dir, marker))
  } catch {
    return false
  }
}

function isUrl(value) {
  return /^https?:\/\//.test(value)
}

/**
 * Canonical http(s) registry root: trailing slashes on the path do not create a second source.
 * e.g. http://localhost:9005 and http://localhost:9005/ → http://localhost:9005/
 */
function normalizeHttpRegistryBase(ref) {
  const s = String(ref).trim()
  if (!isUrl(s)) return s
  try {
    const u = new URL(s)
    let path = u.pathname || '/'
    while (path.length > 1 && path.endsWith('/')) {
      path = path.slice(0, -1)
    }
    if (!path || path === '') path = '/'
    if (path === '/') {
      return `${u.origin}/`
    }
    return `${u.origin}${path}/`
  } catch {
    const trimmed = s.replace(/\/+$/, '')
    return `${trimmed}/`
  }
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
    } else if (rawKey === 'publishupdateprofile') {
      if (val) out.publishUpdateProfile = val.trim().toLowerCase()
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

/** Registry ID for bundle cache (stable hash of normalized ref so http://host and http://host/ share cache). */
function registryCacheId(ref) {
  const key = ref != null ? resolveRegistryRef(ref) : ref
  return createHash('sha256').update(String(key)).digest('hex').slice(0, 16)
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

/** Resolve registry ref. HTTP(S) roots are normalized so trailing slash does not fork cache or list entries. */
function resolveRegistryRef(ref) {
  if (ref == null || ref === '') return ref
  if (isUrl(ref)) return normalizeHttpRegistryBase(ref)
  return ref
}

/** Stable string for equality: same logical http(s) registry regardless of trailing slashes. */
function normalizeRegistryRefForCompare(ref) {
  const s = String(resolveRegistryRef(ref)).trim()
  if (isUrl(s)) {
    try {
      const u = new URL(s)
      let path = u.pathname || '/'
      while (path.length > 1 && path.endsWith('/')) {
        path = path.slice(0, -1)
      }
      if (path === '/' || path === '') return u.origin
      return `${u.origin}${path}`
    } catch {
      return s.replace(/\/+$/, '')
    }
  }
  return s.replace(/\/+$/, '') || s
}

function dedupeRegistryRefs(list) {
  const seen = new Set()
  const out = []
  for (const ref of list) {
    if (!ref) continue
    const key = isUrl(ref) ? normalizeRegistryRefForCompare(ref) : String(ref)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(ref)
  }
  return out
}

/** 默认仓库：本地 aipm-registry（Docker 映射宿主机 9005）。未启动服务时 install 会失败，可改用项目/全局 registry 覆盖。 */
const DEFAULT_REGISTRY_URL = 'http://localhost:9005/'

function defaultRegistryRef() {
  return normalizeHttpRegistryBase(DEFAULT_REGISTRY_URL)
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
    skills: {},
    rules: {},
  }
}

/**
 * `aipm init` 的起点：读取同目录下 aipm-profile.template.json（深拷贝）。
 * 模板缺失或非法时回退 defaultConfig()。
 */
function loadProfileTemplateForInit() {
  try {
    const raw = readFileSync(PROFILE_TEMPLATE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { config: JSON.parse(JSON.stringify(parsed)), fromFile: true }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.warn(`aipm: profile template unreadable (${PROFILE_TEMPLATE_FILE}): ${msg}`)
  }
  return { config: defaultConfig(), fromFile: false }
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
  const rawCombined = [...projectList.filter(Boolean), ...globalList.filter(Boolean)]
  let combined = dedupeRegistryRefs(rawCombined.map((r) => resolveRegistryRef(r)))
  const defaultRef = defaultRegistryRef()
  const defaultKey = normalizeRegistryRefForCompare(defaultRef)
  const hasDefaultLike = combined.some((r) => normalizeRegistryRefForCompare(r) === defaultKey)
  if (!hasDefaultLike) {
    combined = dedupeRegistryRefs([...combined, defaultRef])
  }
  return combined
}

/**
 * 与 getRegistries 相同顺序与去重规则，但保留来源标签（project → global → default）。
 * 用于 registry 命令输出优先级。
 */
function getRegistriesAnnotated(config) {
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

  const candidates = [
    ...projectList.map((raw) => ({ raw, tier: 'project' })),
    ...globalList.map((raw) => ({ raw, tier: 'global' })),
  ]
  const seen = new Set()
  const out = []
  for (const { raw, tier } of candidates) {
    const ref = resolveRegistryRef(raw)
    const key = isUrl(ref) ? normalizeRegistryRefForCompare(ref) : String(ref)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ ref, tier })
  }
  const defaultRef = defaultRegistryRef()
  const defaultKey = normalizeRegistryRefForCompare(defaultRef)
  if (!out.some((e) => normalizeRegistryRefForCompare(e.ref) === defaultKey)) {
    out.push({ ref: defaultRef, tier: 'default' })
  }
  return out
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

/** 写入磁盘时去掉 null / undefined，避免无意义的 "registry": null。 */
function sanitizeProfileObjectForDisk(rest) {
  const out = {}
  for (const [k, v] of Object.entries(rest)) {
    if (v !== null && v !== undefined) out[k] = v
  }
  return out
}

/** 写入可同步的 aipm_profile.json（不含 ide）；ide 写入 .aipm/profile.json */
function writeConfig(data) {
  const { ide, ...rest } = data
  writeFileSync(
    PROFILE_CONFIG_FILE,
    JSON.stringify(sanitizeProfileObjectForDisk(rest), null, 2) + '\n',
    'utf-8',
  )
  if (ide !== undefined && ide !== null && String(ide).trim() !== '') {
    const k = normalizeIdeKey(String(ide).trim())
    if (k) writeLocalIdeProfile({ ide: k })
  }
}

const LOCKFILE_VERSION = 1

/** Read aipm_profile.lock.json (pinned registry + version per package for team reproducibility). */
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

/** Write aipm_profile.lock.json after install/update (pins what was installed). */
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
 * aipm_profile 声明要哪些包及版本约束；aipm_profile.lock 锁定具体 registry + 版本。
 * 1) 无 lock 条目：按配置在 registries 中解析并安装，随后写入 lock。
 * 2) 有 lock 条目：先按配置解析「当前约束」；与 lock 比对 registry + 解析后版本。
 *    - 配置为 latest/省略版本：不比对「与当前 latest 是否相等」，直接以 lock 为准（多人一致）。
 *    - 配置为 ^ / 精确版本：registry 与 lock 一致且 lock 中版本仍满足该 semver 约束时沿用 lock（同 npm 在兼容范围内保留 lock）；否则按配置解析并刷新 lock。
 * 3) lock 记录失效（拉取失败等）时回退为按配置解析。
 */
async function resolveArtifactWithLock(lock, registries, packageName, kind, requestedVersion) {
  const kindKey = kind === 'skill' ? 'skills' : 'rules'
  const locked = lock?.[kindKey]?.[packageName]
  const wantLatest = !requestedVersion || requestedVersion === 'latest'
  const kindLabel = kind === 'skill' ? 'Skill' : 'Rule'

  async function resolveFromLockEntry() {
    if (!locked?.version || !locked?.registry) return null
    const resolved = resolveRegistryRef(locked.registry)
    try {
      const registry = await fetchRegistry(resolved)
      const index = registry?.[kind === 'skill' ? 'packages' : 'rules']
      const item = index?.[packageName]
      if (!item) return null
      const version = resolveVersionFromItem(item, locked.version, kindLabel, packageName)
      return { registryRef: resolved, version }
    } catch {
      return null
    }
  }

  if (wantLatest) {
    const fromLock = await resolveFromLockEntry()
    if (fromLock) return fromLock
    return findRegistryForArtifact(registries, packageName, kind, requestedVersion)
  }

  const fromProfile = await findRegistryForArtifact(registries, packageName, kind, requestedVersion)
  if (!locked?.version || !locked?.registry) return fromProfile

  const lockRefNorm = normalizeRegistryRefForCompare(locked.registry)
  const profileRefNorm = normalizeRegistryRefForCompare(fromProfile.registryRef)
  const registryMatch = lockRefNorm === profileRefNorm
  const semverOk = lockedVersionSatisfiesRequest(locked.version, requestedVersion)

  if (registryMatch && semverOk) {
    const fromLock = await resolveFromLockEntry()
    if (fromLock) return fromLock
  }

  return fromProfile
}

/** Read config from aipm_profile.json (project root). */
function readConfig() {
  const merged = mergeProjectConfigFromFiles()
  if (!merged) {
    throw new Error('aipm config not found. Run: aipm init')
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
    publishUpdateProfile:
      overrides.publishUpdateProfile !== undefined
        ? overrides.publishUpdateProfile
        : base.publishUpdateProfile,
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

/** publish 成功后是否把 skills/rules 版本写回 aipm_profile：ask | yes | no */
function normalizePublishUpdateProfileMode(raw) {
  if (raw == null || raw === '') return null
  const s = String(raw).trim().toLowerCase()
  if (s === 'ask' || s === 'yes' || s === 'no') return s
  return null
}

/** 优先级：CLI --publish-update-profile= > 项目配置 > ~/.aipmrc > 默认 ask */
function resolvePublishUpdateProfileMode(config, args = []) {
  const eq = args.find((a) => a.startsWith('--publish-update-profile='))
  if (eq) {
    const m = normalizePublishUpdateProfileMode(eq.slice('--publish-update-profile='.length))
    if (m) return m
  }
  const fromProj = normalizePublishUpdateProfileMode(config.publishUpdateProfile)
  if (fromProj) return fromProj
  const fromGlobal = normalizePublishUpdateProfileMode(readGlobalConfig().publishUpdateProfile)
  if (fromGlobal) return fromGlobal
  return 'ask'
}

/** 将成功发布的版本写回 aipm_profile.json（按 publishUpdateProfile / 询问） */
async function applyPublishProfileVersionSync(updates, args) {
  if (!updates.length) return
  const config = readConfig()
  const mode = resolvePublishUpdateProfileMode(config, args)
  let doWrite = false
  if (mode === 'yes') {
    doWrite = true
  } else if (mode === 'no') {
    console.log('[publish] Skipped updating aipm_profile.json (publish-update-profile=no).')
    return
  } else {
    if (!process.stdin.isTTY) {
      console.log(
        '[publish] publish-update-profile=ask in non-interactive shell: skipped aipm_profile.json. Use --publish-update-profile=yes|no, or set publish-update-profile in aipm_profile.json / ~/.aipmrc.',
      )
      return
    }
    const lines = updates.map((u) => `    ${u.kind} ${u.registryPath}@${u.version}`).join('\n')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const ans = (
      await question(rl, `Update aipm_profile.json with published version(s)?\n${lines}\n[y/N]`, 'n')
    ).trim()
    rl.close()
    doWrite = /^y(es)?$/i.test(ans)
    if (!doWrite) {
      console.log('[publish] aipm_profile.json left unchanged.')
      return
    }
  }
  const cfg = readConfig()
  for (const u of updates) {
    const key = u.kind === 'skill' ? 'skills' : 'rules'
    cfg[key] ??= {}
    cfg[key][u.registryPath] = versionSpecAfterPublish(cfg[key][u.registryPath], u.version)
  }
  writeConfig(cfg)
  console.log(`[publish] Updated ${relative(ROOT, PROFILE_CONFIG_FILE)} (published version(s)).`)
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
  return null
}

/** 仅读取 aipm_profile.json（不再支持根目录 package.json 的 aipm 字段）。 */
function mergeProjectConfigFromFiles() {
  if (!existsSync(PROFILE_CONFIG_FILE)) return null
  try {
    const raw = JSON.parse(readFileSync(PROFILE_CONFIG_FILE, 'utf-8'))
    return mergeConfig(defaultConfig(), stripIdeFromObject(raw))
  } catch {
    return null
  }
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

/**
 * Read JSON: remote 先查 bundle 缓存，命中则直接用；否则拉取并写入缓存。
 * @param {{ bypassCache?: boolean }} [options] bypassCache=true 时强制重新拉取（用于 search 等需最新 registry.json 的场景）。
 */
async function readJsonResource(baseRef, relativePath, options = {}) {
  const bypassCache = options.bypassCache === true
  if (isUrl(baseRef)) {
    const cachePath = bundleCachePath(baseRef, relativePath)
    if (!bypassCache && existsSync(cachePath)) {
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

async function fetchRegistry(baseRef, options = {}) {
  return await readJsonResource(baseRef, 'registry.json', options)
}

/**
 * 将 registry.json 写入 ~/.aipm/cache：HTTP(S) 强制重新拉取；本地路径从磁盘读入再写入 published 子目录缓存。
 */
async function refreshRegistryJsonCache(registryRef) {
  const baseRef = resolveRegistryRef(registryRef)
  if (isUrl(baseRef)) {
    await fetchRegistry(baseRef, { bypassCache: true })
    return
  }
  const abs = join(resolveLocalBase(baseRef), 'registry.json')
  if (!existsSync(abs)) {
    throw new Error(`registry.json not found at ${abs}`)
  }
  const data = JSON.parse(readFileSync(abs, 'utf-8'))
  writeToBundleCache(baseRef, 'registry.json', data, true)
}

function wantsSkipRegistryRefresh(args = []) {
  return args.includes('--skip-registry-refresh')
}

function wantsVerboseFromInstallArgs(args = []) {
  return args.includes('-v') || args.includes('--verbose')
}

/**
 * install/update 前刷新各源的 registry.json 索引，避免仅用旧缓存导致「找不到包」。
 * 失败则静默沿用原缓存，便于离线仍可按旧索引安装；用 --skip-registry-refresh 可完全跳过网络刷新。
 */
async function refreshRegistriesIndexCacheBestEffort(registries, options = {}) {
  const { verbose = false } = options
  for (const ref of registries) {
    const resolved = resolveRegistryRef(ref)
    try {
      await refreshRegistryJsonCache(ref)
    } catch (e) {
      if (verbose) {
        const msg = e instanceof Error ? e.message : String(e)
        console.log(`[aipm] registry index refresh skipped (${resolved}): ${msg}`)
      }
    }
  }
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
    const best = maxVersionSatisfyingCaret(item.versions ?? [], requested)
    if (!best) throw new Error(`No compatible version for ${kindLabel} ${name}: ${requested}`)
    return best
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
    const best = maxVersionSatisfyingCaret(item.versions ?? [], requested)
    if (!best) {
      throw new Error(`No compatible version for ${kindLabel} ${name}: ${requested}`)
    }
    return best
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
  const rulePrimaryMd =
    kind === 'rule' ? resolveRuleMarkerFromPkgFiles(pkg, registryPath) : null
  const artifactDir = join(installRoot, installName)

  async function writeArtifactFilesFromRegistry() {
    mkdirSync(artifactDir, { recursive: true })
    for (const file of files) {
      let content = await readTextResource(
        baseRef,
        `${kindConfig.registryDir}/${registryPath}/${version}/${file}`,
      )
      const targetPath = join(artifactDir, file)
      mkdirSync(dirname(targetPath), { recursive: true })
      if (file === 'SKILL.md' && kind === 'skill' && installName !== registryPath) {
        content = patchSkillNameInFrontmatter(content, installName)
      }
      if (kind === 'rule' && rulePrimaryMd && file === rulePrimaryMd && installName !== registryPath) {
        content = patchSkillNameInFrontmatter(content, installName)
      }
      writeFileSync(targetPath, content, 'utf-8')
      process.stdout.write('.')
    }
    embedFilesIntegrityInInstalledArtifact(artifactDir, files)
  }

  if (existsSync(artifactDir)) {
    const stat = statSync(artifactDir)
    if (!stat.isDirectory()) {
      const action = await promptConflictAction(
        `[conflict] '${relative(ROOT, artifactDir)}' exists and is not a directory`,
        conflictState,
      )
      if (action === 'skip') {
        console.log(' skipped')
        return { installed: false, skipped: true, outcome: 'skipped_non_dir' }
      }
      rmSync(artifactDir, { recursive: true, force: true })
      await writeArtifactFilesFromRegistry()
      console.log(' ok')
      return { installed: true, skipped: false, outcome: 'updated' }
    }

    const installed = readInstalledVersion(artifactDir)
    if (installed) {
      const cmp = semverCompare(installed.version, version)
      if (cmp === 0) {
        console.log(' up-to-date')
        return { installed: false, skipped: true, outcome: 'unchanged' }
      }
      if (cmp > 0) {
        if (conflictState.mode === 'skip') {
          console.log(' skipped')
          return { installed: false, skipped: true, outcome: 'declined_downgrade' }
        }
        if (conflictState.mode !== 'overwrite') {
          const msg = `[downgrade] ${installName}: installed ${installed.version} -> target ${version}. Replace entire directory with the older version?`
          const action = await promptConflictAction(msg, conflictState)
          if (action === 'skip') {
            console.log(' skipped')
            return { installed: false, skipped: true, outcome: 'declined_downgrade' }
          }
        }
      } else {
        const pristine = isArtifactTreePristine(artifactDir, files)
        if (!pristine) {
          if (conflictState.mode === 'skip') {
            console.log(' skipped')
            return { installed: false, skipped: true, outcome: 'declined_overwrite' }
          }
          if (conflictState.mode !== 'overwrite') {
            const msg =
              cmp === -1
                ? `[modified] ${installName}: local files differ from last install (extra files, edited files, or missing filesIntegrity). Replace entire directory with ${registryPath}@${version}?`
                : `[conflict] ${installName}: cannot compare versions (installed ${installed.version} vs target ${version}). Replace entire directory with ${registryPath}@${version}?`
            const action = await promptConflictAction(msg, conflictState)
            if (action === 'skip') {
              console.log(' skipped')
              return { installed: false, skipped: true, outcome: 'declined_overwrite' }
            }
          }
        }
      }
    } else {
      if (conflictState.mode === 'skip') {
        console.log(' skipped')
        return { installed: false, skipped: true, outcome: 'declined_overwrite' }
      }
      if (conflictState.mode !== 'overwrite') {
        const msg = `[conflict] '${relative(ROOT, artifactDir)}' exists but has no package.json with aipm field (not from aipm). Replace with ${registryPath}@${version}?`
        const action = await promptConflictAction(msg, conflictState)
        if (action === 'skip') {
          console.log(' skipped')
          return { installed: false, skipped: true, outcome: 'declined_overwrite' }
        }
      }
    }

    rmSync(artifactDir, { recursive: true, force: true })
    await writeArtifactFilesFromRegistry()
    console.log(' ok')
    return { installed: true, skipped: false, outcome: 'updated' }
  }

  await writeArtifactFilesFromRegistry()
  console.log(' ok')
  return { installed: true, skipped: false, outcome: 'updated' }
}

/** 是否把本次解析到的版本写回 aipm_profile（已安装或与磁盘一致，而非用户跳过/拒绝覆盖）。 */
function shouldPinArtifactVersionInProfile(result) {
  return Boolean(result?.installed || result?.outcome === 'unchanged')
}

/**
 * 版本约束语义（与 npm 一致）：
 * - 精确版本 x.y.z：固定版本，update 不会改动（aipm unpin 解除）
 * - ^x.y.z：兼容范围内可升级；update --latest 可跨主版本
 * - latest：始终跟随 registry 最新版
 */
function isPinnedVersionSpec(spec) {
  return spec != null && parseSemver(spec) != null
}

/**
 * install/update 成功后写回 aipm_profile 的约束：固定版本与 latest 原样保留；
 * ^ 约束把下限推进到本次解析版本；未声明或 install-skill 未指定版本时记为 ^resolved。
 */
function versionSpecToRecord(spec, resolvedVersion) {
  const s = spec == null ? '' : String(spec).trim()
  if (!s || s.startsWith('^')) return parseSemver(resolvedVersion) ? `^${resolvedVersion}` : resolvedVersion
  return s
}

/** publish 后同步 aipm_profile：原为固定版本则固定到新版本，否则同 versionSpecToRecord。 */
function versionSpecAfterPublish(spec, publishedVersion) {
  return isPinnedVersionSpec(spec) ? publishedVersion : versionSpecToRecord(spec, publishedVersion)
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

/** Align with publish/install transforms; hashes exclude package.json (added when writing package.json). */
function collectFilesIntegrityForPublish(files, srcDir, installName, registryPath, options = {}) {
  const ruleMarkerFile = options.ruleMarkerFile
  return buildFilesIntegrityMap(files, (file) => {
    const srcPath = join(srcDir, file)
    if (!existsSync(srcPath)) return null
    let data = readFileSync(srcPath, 'utf-8')
    if (file === 'SKILL.md' && installName !== registryPath) {
      data = patchSkillNameInFrontmatter(data, registryPath)
    } else if (ruleMarkerFile && file === ruleMarkerFile && installName !== registryPath) {
      data = patchSkillNameInFrontmatter(data, registryPath)
    } else if (!ruleMarkerFile && file === LEGACY_RULE_MARKER && installName !== registryPath) {
      data = patchSkillNameInFrontmatter(data, registryPath)
    }
    return data
  })
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

/** Validate artifact before publish（版本以 package.json 为准，不与 aipm_profile 对齐）。 */
function validatePublishArtifact(srcDir, kindConfig, registryPath) {
  const isRule = kindConfig.registryKey === 'rules'
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
  if (pkg?.version == null || String(pkg.version).trim() === '') {
    throw new Error('package.json "version" is required')
  }
  const filesDeclared = Array.isArray(pkg?.files) ? pkg.files : []
  if (!filesDeclared.length) {
    throw new Error('package.json "files" array is required and must not be empty')
  }

  const markerFile = isRule ? resolveRuleMarkerFromPkgFiles(pkg, registryPath, srcDir) : 'SKILL.md'
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

  if (!declaredFilesCoverMarker(filesDeclared, srcDir, markerFile)) {
    throw new Error(
      `package.json "files" must include "${markerFile}" or a directory entry whose tree contains it`,
    )
  }

  resolvePublishFiles(srcDir, pkg, { markerFile })
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

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizePublishRelPath(p) {
  return String(p).replace(/\\/g, '/').replace(/^\/+/, '')
}

/**
 * Ignore rules for publish validation / tarball (posix paths relative to skill or rule root).
 * - "dir/" matches that directory and everything under it
 * - "foo" matches path foo or foo/…
 * - "*" matches within one segment (no **)
 */
function pathMatchesPublishIgnore(relPath, patterns) {
  const norm = normalizePublishRelPath(relPath)
  const base = norm.includes('/') ? norm.slice(norm.lastIndexOf('/') + 1) : norm
  for (let pat of patterns) {
    pat = normalizePublishRelPath(pat)
    if (!pat) continue
    if (pat.endsWith('/')) {
      const dir = pat.slice(0, -1)
      if (norm === dir || norm.startsWith(dir + '/')) return true
      continue
    }
    if (pat.includes('*')) {
      const re = new RegExp(
        '^' + pat.split('*').map((part) => escapeRegExp(part)).join('[^/]*') + '$',
      )
      if (re.test(norm) || re.test(base)) return true
      continue
    }
    if (norm === pat || norm.startsWith(pat + '/')) return true
  }
  return false
}

/** Publish-time ignore patterns from package.json aipm.publishIgnore only. */
function publishIgnorePatternsFromPkg(pkg) {
  const merged = []
  const fromPkg = pkg?.aipm?.publishIgnore
  if (Array.isArray(fromPkg)) {
    for (const p of fromPkg) {
      if (typeof p === 'string' && p.trim()) merged.push(normalizePublishRelPath(p.trim()))
    }
  }
  return merged
}

function listArtifactTreeFiles(srcDir) {
  return listFilesRecursive(srcDir, srcDir).filter((f) => f !== '.aipm' && f !== 'files.json')
}

/**
 * Expand package.json "files": plain files stay; directory entries become all files under them (non-ignored).
 */
function expandDeclaredPublishFiles(filesDeclared, srcDir, ignorePatterns) {
  const out = new Set()
  for (const raw of filesDeclared) {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new Error(`package.json "files" contains invalid entry: ${JSON.stringify(raw)}`)
    }
    const entry = normalizePublishRelPath(raw.trim())
    const abs = join(srcDir, entry)
    if (!existsSync(abs)) {
      throw new Error(`package.json "files" lists "${entry}" but path does not exist`)
    }
    const st = statSync(abs)
    if (st.isDirectory()) {
      const inner = listFilesRecursive(abs, abs)
      for (const f of inner) {
        const rel = normalizePublishRelPath(join(entry, f))
        if (!pathMatchesPublishIgnore(rel, ignorePatterns)) out.add(rel)
      }
    } else if (st.isFile()) {
      if (pathMatchesPublishIgnore(entry, ignorePatterns)) {
        throw new Error(
          `package.json "files" lists "${entry}" but it matches a publish ignore pattern. Remove the pattern or the entry.`,
        )
      }
      out.add(entry)
    } else {
      throw new Error(`package.json "files" lists "${entry}" which is not a file or directory`)
    }
  }
  return [...out]
}

/** True if marker path is listed explicitly or lies under a declared directory entry. */
function declaredFilesCoverMarker(filesDeclared, srcDir, markerFile) {
  const entries = filesDeclared
    .filter((f) => typeof f === 'string' && f.trim())
    .map((f) => normalizePublishRelPath(f.trim()))
  if (entries.includes(markerFile)) return true
  for (const entry of entries) {
    const abs = join(srcDir, entry)
    if (!existsSync(abs) || !statSync(abs).isDirectory()) continue
    if (markerFile.startsWith(entry + '/')) return true
  }
  return false
}

/**
 * Ordered file list to publish: must match non-ignored files on disk exactly.
 * @param {object} opts
 * @param {string} opts.markerFile
 */
function resolvePublishFiles(srcDir, pkg, opts = {}) {
  const markerFile = opts.markerFile ?? 'SKILL.md'
  const filesDeclared = Array.isArray(pkg?.files) ? pkg.files : []
  if (!filesDeclared.length) {
    throw new Error('package.json "files" array is required and must not be empty')
  }
  const ignorePatterns = publishIgnorePatternsFromPkg(pkg)
  const expanded = expandDeclaredPublishFiles(filesDeclared, srcDir, ignorePatterns)
  const expandedSet = new Set(expanded)
  const allOnDisk = listArtifactTreeFiles(srcDir)
  const nonIgnoredOnDisk = allOnDisk.filter((f) => !pathMatchesPublishIgnore(f, ignorePatterns))
  const diskSet = new Set(nonIgnoredOnDisk)

  for (const f of nonIgnoredOnDisk) {
    if (!expandedSet.has(f)) {
      throw new Error(
        `File "${f}" exists in directory but is not covered by package.json "files". Add a path, a parent directory entry, or list a pattern under aipm.publishIgnore.`,
      )
    }
  }
  for (const f of expanded) {
    if (!diskSet.has(f)) {
      throw new Error(`package.json "files" expands to "${f}" but file is missing or excluded by ignore rules`)
    }
  }

  const rest = expanded.filter((f) => f !== markerFile).sort()
  const files = expanded.includes(markerFile) ? [markerFile, ...rest] : [...expanded].sort()
  return { files }
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

function printDeclaredAndInstalledResolved(title, resolved, installDir, kind) {
  const installed = new Set(listInstalledDirs(installDir))
  if (!resolved.length) {
    console.log(`${title}: (none)`)
  } else {
    console.log(`\n${title}:`)
    for (const { logicalName, installName, version } of resolved) {
      const dir = join(installDir, installName)
      const ok =
        kind === 'skill'
          ? existsSync(join(dir, 'SKILL.md'))
          : ruleArtifactDirHasMarker(dir, logicalName)
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

/** init 仅在命令行显式传入 --registry 时写入 aipm_profile；否则不写 registry 字段。 */
function parseInitRegistryExplicit(args) {
  const i = args.indexOf('--registry')
  if (i >= 0 && args[i + 1] && !String(args[i + 1]).startsWith('-')) {
    return String(args[i + 1]).trim()
  }
  const eq = args.find((a) => a.startsWith('--registry='))
  if (eq) {
    const v = eq.slice('--registry='.length).trim()
    if (v) return v
  }
  return null
}

/** 解析 publish 的 --registry 覆盖，未指定则 null。 */
function parseRegistryOverride(args) {
  const i = args.indexOf('--registry')
  if (i >= 0 && args[i + 1]) return args[i + 1]
  const eq = args.find((a) => a.startsWith('--registry='))
  if (eq) return eq.slice('--registry='.length)
  return null
}

/** 去掉 --registry 及其参数后的位置参数（unpublish 包名）。 */
function filterUnpublishPositionalArgs(args) {
  const out = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--registry') {
      if (args[i + 1]) i++
      continue
    }
    if (String(a).startsWith('--registry=')) continue
    if (String(a).startsWith('-')) continue
    out.push(a)
  }
  return out
}

/** unpublish 目标：--registry 优先，否则与 publish 相同（首个可用源，可为 HTTP 或本地路径）。 */
function resolveUnpublishRegistryRef(config, cliArgs) {
  const override = parseRegistryOverride(cliArgs)
  if (override != null && String(override).trim() !== '') {
    return resolveRegistryRef(String(override).trim())
  }
  return getDefaultPublishRegistry(config)
}

async function cmdInit(args = []) {
  if (existsSync(PROFILE_CONFIG_FILE)) {
    console.log('aipm config already exists, skip')
    return
  }

  if (!process.stdin.isTTY) {
    console.error('aipm init requires interactive mode. Run in a terminal.')
    process.exitCode = 1
    return
  }

  const explicitRegistry = parseInitRegistryExplicit(args)
  const registryForProfileList = explicitRegistry
    ? resolveRegistryRef(explicitRegistry)
    : defaultRegistryRef()

  const { config, fromFile: profileFromTemplateFile } = loadProfileTemplateForInit()
  if (explicitRegistry) {
    delete config.registries
    config.registry = resolveRegistryRef(explicitRegistry)
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })

  console.log('\nSupported IDEs:')
  const ideList = Object.keys(IDE_DIR_MAP)
  ideList.forEach((ide, i) => {
    console.log(`  ${i + 1}. ${ide}`)
  })
  const ideChoice = await question(rl, `\nSelect IDE (1-${ideList.length})`, '1')
  const ideIndex = parseInt(ideChoice, 10)
  config.ide = ideList[ideIndex - 1] ?? 'cursor'

  const profiles = listAvailableProfiles(registryForProfileList)
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
    } else {
      delete config.profile
    }
  }

  rl.close()

  config.skills ??= {}
  config.rules ??= {}

  writeConfig(config)
  console.log('\ncreated aipm_profile.json')
  if (profileFromTemplateFile) {
    console.log(`  source template: ${PROFILE_TEMPLATE_FILE}`)
  } else {
    console.log('  source: built-in default (template missing or invalid JSON)')
  }
  if (config.registry) {
    console.log(`  project registry: ${config.registry}`)
  } else {
    console.log(
      `  project registry: (not written — use ~/.aipmrc and/or built-in default ${DEFAULT_REGISTRY_URL})`,
    )
  }
  console.log(`ide: ${config.ide} (saved to .aipm/profile.json — do not commit; use .gitignore)`)
  if (config.profile) {
    console.log(`profile: ${config.profile}`)
  }
  console.log('Run `aipm install` to install skills and rules.')
}

/**
 * install <name> 时解析 skill / rule；同名并存时 TTY 询问，非 TTY 须 --kind=skill|rule。
 */
async function resolveInstallArtifactKind(registries, packageName, flagArgs = []) {
  const merged = await fetchMergedRegistry(registries)
  const hasSkill = Boolean(merged.packages?.[packageName])
  const hasRule = Boolean(merged.rules?.[packageName])
  if (!hasSkill && !hasRule) return null

  const fromFlag = parseInstallKindFlag(flagArgs)
  if (fromFlag === 'skill') {
    if (!hasSkill) {
      throw new Error(`No skill '${packageName}' in registry (you passed --kind=skill).`)
    }
    return 'skill'
  }
  if (fromFlag === 'rule') {
    if (!hasRule) {
      throw new Error(`No rule '${packageName}' in registry (you passed --kind=rule).`)
    }
    return 'rule'
  }

  if (hasSkill && !hasRule) return 'skill'
  if (hasRule && !hasSkill) return 'rule'

  if (!process.stdin.isTTY) {
    throw new Error(
      `Both skill and rule '${packageName}' exist in the registry. Pass --kind=skill or --kind=rule.`,
    )
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  console.log(`\nBoth a skill and a rule named '${packageName}' were found in the registry.`)
  const ans = (await question(rl, 'Choose [1] skill  [2] rule', '1')).trim().toLowerCase()
  rl.close()
  if (ans === '2' || ans === 'rule' || ans === 'r') return 'rule'
  return 'skill'
}

async function cmdPull(...args) {
  const pullPlan = parseInstallPullArgs(args)
  if (pullPlan.mode === 'one') {
    await ensureLocalIdeConfigured([...pullPlan.flagArgs])
    if (!mergeProjectConfigFromFiles()) {
      throw new Error('aipm config not found. Run: aipm init')
    }
    const config = readConfigOrDefault()
    const registries = getRegistries(config)
    if (!wantsSkipRegistryRefresh(pullPlan.flagArgs)) {
      await refreshRegistriesIndexCacheBestEffort(registries, {
        verbose: wantsVerboseFromInstallArgs(pullPlan.flagArgs),
      })
    }
    const kind = await resolveInstallArtifactKind(registries, pullPlan.name, pullPlan.flagArgs)
    if (!kind) {
      throw new Error(
        `Package '${pullPlan.name}' not found as a skill or rule in any registry. Use aipm search to list names, or check registries in aipm_profile.json.`,
      )
    }
    const forward = [pullPlan.name, pullPlan.version, ...stripInstallKindFlags(pullPlan.flagArgs)]
    if (kind === 'skill') return cmdInstallSkill(...forward)
    return cmdInstallRule(...forward)
  }

  await ensureLocalIdeConfigured(args)
  const config = readConfig()
  const { skills, rules } = await resolveDesiredArtifacts(config)
  const registries = getRegistries(config)
  if (!wantsSkipRegistryRefresh(args)) {
    await refreshRegistriesIndexCacheBestEffort(registries, {
      verbose: wantsVerboseFromInstallArgs(args),
    })
  }
  const installPaths = getInstallPaths(config)
  const conflictState = { mode: parseConflictMode(args) }
  const lock = readLockFile()

  ensureIdeDirs(installPaths)

  const newLock = { skills: {}, rules: {} }
  const summary = { updated: [], unchanged: [], notUpdated: [] }

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
    if (shouldPinArtifactVersionInProfile(result)) {
      config.skills ??= {}
      config.skills[packageName] = versionSpecToRecord(requestedVersion, version)
    }
    recordLockEntry(newLock, 'skills', packageName, version, registryRef, result, lock)
    pushInstallSummaryLine(summary, 'skill', installName, version, result)
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
    if (shouldPinArtifactVersionInProfile(result)) {
      config.rules ??= {}
      config.rules[packageName] = versionSpecToRecord(requestedVersion, version)
    }
    recordLockEntry(newLock, 'rules', packageName, version, registryRef, result, lock)
    pushInstallSummaryLine(summary, 'rule', installName, version, result)
  }

  writeLockFile(newLock)

  const desiredSkillNames = new Set(Object.keys(skills).map((n) => registryPathToInstallName(n)))
  const desiredRuleNames = new Set(Object.keys(rules).map((n) => registryPathToInstallName(n)))
  for (const installName of listInstalledDirs(installPaths.skillInstallDir)) {
    if (!desiredSkillNames.has(installName)) {
      const dir = join(installPaths.skillInstallDir, installName)
      if (readInstalledVersion(dir)) {
        rmSync(dir, { recursive: true, force: true })
        console.log(`Removed ${installName} (not in declared skills)`)
      }
    }
  }
  for (const installName of listInstalledDirs(installPaths.ruleInstallDir)) {
    if (!desiredRuleNames.has(installName)) {
      const dir = join(installPaths.ruleInstallDir, installName)
      if (readInstalledVersion(dir)) {
        rmSync(dir, { recursive: true, force: true })
        console.log(`Removed ${installName} (not in declared rules)`)
      }
    }
  }

  writeConfig(config)
  printInstallSummary(summary)
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

  printDeclaredAndInstalledResolved('declared skills', skillsResolved, installPaths.skillInstallDir, 'skill')
  printDeclaredAndInstalledResolved('declared rules', rulesResolved, installPaths.ruleInstallDir, 'rule')
}

/** 按 @scope/name 或 scope_name 在已声明的 skills/rules 中查找目标；name 为空时返回全部。 */
function findDeclaredTargets(skills, rules, name) {
  const pick = (map) =>
    name
      ? (map[name] ? [name] : Object.keys(map).filter((k) => registryPathToInstallName(k) === name))
      : Object.keys(map)
  const skillTargets = pick(skills)
  const ruleTargets = pick(rules)
  if (name && !skillTargets.length && !ruleTargets.length) {
    throw new Error(`'${name}' is not declared in current skills/rules`)
  }
  return { skillTargets, ruleTargets }
}

/**
 * update 不沿用 lock：按声明的约束重新解析 registry 并刷新 lock。
 * - latest / ^x.y.z：升级到约束内最新版；--latest 时忽略 ^ 上界，直接取 registry latest
 * - 精确版本（固定）：保持不动，若有更新版本则在结尾提示
 */
async function cmdUpdate(...rawArgs) {
  const name = rawArgs.find((a) => !a.startsWith('-'))
  const args = rawArgs.filter((a) => a.startsWith('-'))
  const toLatest = args.includes('--latest')
  await ensureLocalIdeConfigured(args)
  const config = readConfig()
  const { skills, rules } = await resolveDesiredArtifacts(config)
  const registries = getRegistries(config)
  if (!wantsSkipRegistryRefresh(args)) {
    await refreshRegistriesIndexCacheBestEffort(registries, {
      verbose: wantsVerboseFromInstallArgs(args),
    })
  }
  const installPaths = getInstallPaths(config)
  const conflictState = { mode: parseConflictMode(args) }

  ensureIdeDirs(installPaths)

  const { skillTargets, ruleTargets } = findDeclaredTargets(skills, rules, name)

  const lock = readLockFile()
  const newLock = { skills: {}, rules: {} }
  const summary = { updated: [], unchanged: [], notUpdated: [] }
  const pinnedBehind = []

  async function updateOne(kind, packageName, requested) {
    const kindKey = kind === 'skill' ? 'skills' : 'rules'
    const pinned = isPinnedVersionSpec(requested)
    const request = toLatest && !pinned ? 'latest' : requested
    const { registryRef, registry, version } = await findRegistryForArtifact(
      registries,
      packageName,
      kind,
      request,
    )
    const installName = registryPathToInstallName(packageName)
    ARTIFACT_KIND[kind].installDir =
      kind === 'skill' ? installPaths.skillInstallDir : installPaths.ruleInstallDir
    const result = await installArtifact(registryRef, kind, packageName, version, {
      installName,
      conflictState,
    })
    if (shouldPinArtifactVersionInProfile(result)) {
      config[kindKey] ??= {}
      config[kindKey][packageName] = versionSpecToRecord(requested, version)
    }
    recordLockEntry(newLock, kindKey, packageName, version, registryRef, result, lock)
    pushInstallSummaryLine(summary, kind, installName, version, result)
    const latest = registry?.[ARTIFACT_KIND[kind].registryKey]?.[packageName]?.latest
    if (pinned && latest && semverCompare(latest, version) === 1) {
      pinnedBehind.push(`${kind} ${packageName}@${version} (latest ${latest})`)
    }
  }

  for (const packageName of skillTargets) {
    await updateOne('skill', packageName, skills[packageName] ?? 'latest')
  }
  for (const packageName of ruleTargets) {
    await updateOne('rule', packageName, rules[packageName] ?? 'latest')
  }

  writeConfig(config)
  mergeAndWriteLock(lock, newLock, skills, rules)
  printInstallSummary(summary)
  if (pinnedBehind.length) {
    console.log('Pinned (kept at fixed version; run `aipm unpin <name>` to allow upgrades):')
    for (const line of pinnedBehind) console.log(`  · ${line}`)
  }
  console.log('update complete')
}

/** aipm pin <name> [version]：把约束改为精确版本（默认取当前 lock 中的版本），之后 update 不再升级它。 */
async function cmdPin(...rawArgs) {
  const [name, versionArg] = rawArgs.filter((a) => !a.startsWith('-'))
  if (!name) {
    throw new Error('Usage: aipm pin <name> [version]  (name: @scope/name or scope_name)')
  }
  const config = readConfig()
  const { skills, rules } = await resolveDesiredArtifacts(config)
  const { skillTargets, ruleTargets } = findDeclaredTargets(skills, rules, name)
  const lock = readLockFile()
  const registries = getRegistries(config)
  const targets = [
    ...skillTargets.map((p) => ['skill', 'skills', p]),
    ...ruleTargets.map((p) => ['rule', 'rules', p]),
  ]
  let needsInstall = false
  for (const [kind, kindKey, packageName] of targets) {
    const lockedVersion = lock?.[kindKey]?.[packageName]?.version
    const version = versionArg ? String(versionArg).trim() : lockedVersion
    if (!version) {
      throw new Error(`${packageName} is not installed yet; specify a version: aipm pin ${name} <version>`)
    }
    if (!parseSemver(version)) {
      throw new Error(`Pin version must be an exact semver x.y.z (got "${version}")`)
    }
    await findRegistryForArtifact(registries, packageName, kind, version)
    config[kindKey] ??= {}
    config[kindKey][packageName] = version
    if (version !== lockedVersion) needsInstall = true
    console.log(`pinned ${kind} ${packageName}@${version}`)
  }
  writeConfig(config)
  if (needsInstall) console.log('Run `aipm install` to apply the pinned version.')
}

/** aipm unpin [name]：精确版本改为 ^版本（兼容范围内可升级）；不带 name 时解除全部固定版本。 */
async function cmdUnpin(...rawArgs) {
  const name = rawArgs.find((a) => !a.startsWith('-'))
  const config = readConfig()
  const { skills, rules } = await resolveDesiredArtifacts(config)
  const { skillTargets, ruleTargets } = findDeclaredTargets(skills, rules, name)
  let count = 0
  for (const [kindKey, map, targets] of [
    ['skills', skills, skillTargets],
    ['rules', rules, ruleTargets],
  ]) {
    for (const packageName of targets) {
      const spec = map[packageName]
      if (!isPinnedVersionSpec(spec)) {
        if (name) console.log(`${packageName} is not pinned (${spec})`)
        continue
      }
      config[kindKey] ??= {}
      config[kindKey][packageName] = `^${String(spec).trim()}`
      count++
      console.log(`unpinned ${packageName}: ${spec} -> ^${String(spec).trim()}`)
    }
  }
  writeConfig(config)
  if (count) console.log('Run `aipm update` to upgrade within the new ranges.')
  else if (!name) console.log('No pinned skills/rules.')
}

async function cmdDoctor(...args) {
  let failures = 0

  const hasAipmConfig = existsSync(PROFILE_CONFIG_FILE)

  if (!hasAipmConfig) {
    console.log('[fail] aipm config not found (aipm_profile.json)')
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

      const ruleDir = join(installPaths.ruleInstallDir, installName)
      if (ruleArtifactDirHasMarker(ruleDir, packageName)) {
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
  line('profile tmpl:', PROFILE_TEMPLATE_FILE)
}

async function cmdInstallSkill(...args) {
  const { flagArgs, positionals } = parseInstallCliArgs(args)
  if (!positionals[0]) {
    throw new Error('Usage: aipm install-skill <name> [version]  (name: @scope/name or scope_name)')
  }
  let name
  let version = 'latest'
  if (positionals.length >= 2) {
    const s0 = parseSearchQuerySpec(positionals[0])
    name = s0.nameQuery || positionals[0]
    version = String(positionals[1]).trim() || 'latest'
  } else {
    const s = parseSearchQuerySpec(positionals[0])
    name = s.nameQuery || positionals[0]
    version = s.versionFilter != null ? String(s.versionFilter).trim() : 'latest'
  }

  if (mergeProjectConfigFromFiles()) {
    await ensureLocalIdeConfigured(flagArgs)
  }
  const config = readConfigOrDefault()
  const registries = getRegistries(config)
  if (!wantsSkipRegistryRefresh(flagArgs)) {
    await refreshRegistriesIndexCacheBestEffort(registries, {
      verbose: wantsVerboseFromInstallArgs(flagArgs),
    })
  }
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
  // 未指定版本记为 ^resolved（可升级）；指定精确版本即固定版本
  config.skills[name] = versionSpecToRecord(version === 'latest' ? '' : version, resolvedVersion)
  writeConfig(config)
  mergeAndWriteLock(lock, { skills: { [name]: { version: resolvedVersion, registry: registryRef } } }, config.skills, config.rules ?? {})

  console.log(`installed skill ${name}@${resolvedVersion}`)
}

async function cmdInstallRule(...args) {
  const { flagArgs, positionals } = parseInstallCliArgs(args)
  if (!positionals[0]) {
    throw new Error('Usage: aipm install-rule <name> [version]  (name: @scope/name or scope_name)')
  }
  let name
  let version = 'latest'
  if (positionals.length >= 2) {
    const s0 = parseSearchQuerySpec(positionals[0])
    name = s0.nameQuery || positionals[0]
    version = String(positionals[1]).trim() || 'latest'
  } else {
    const s = parseSearchQuerySpec(positionals[0])
    name = s.nameQuery || positionals[0]
    version = s.versionFilter != null ? String(s.versionFilter).trim() : 'latest'
  }

  if (mergeProjectConfigFromFiles()) {
    await ensureLocalIdeConfigured(flagArgs)
  }
  const config = readConfigOrDefault()
  const registries = getRegistries(config)
  if (!wantsSkipRegistryRefresh(flagArgs)) {
    await refreshRegistriesIndexCacheBestEffort(registries, {
      verbose: wantsVerboseFromInstallArgs(flagArgs),
    })
  }
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
  // 未指定版本记为 ^resolved（可升级）；指定精确版本即固定版本
  config.rules[name] = versionSpecToRecord(version === 'latest' ? '' : version, resolvedVersion)
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

function parseDestructiveYes(args = []) {
  return args.includes('--yes') || args.includes('-y')
}

/**
 * Print a plan and require typing "yes", or pass --yes (non-TTY must use --yes).
 */
async function confirmDestructivePlan(lines, args = []) {
  console.log('')
  for (const line of lines) console.log(line)
  console.log('')
  if (parseDestructiveYes(args)) {
    console.log('(--yes) proceeding without prompt.')
    return
  }
  if (!process.stdin.isTTY) {
    throw new Error('Not running in a TTY. Re-run with --yes to confirm.')
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ans = (await question(rl, 'Type "yes" to proceed', '')).trim().toLowerCase()
  rl.close()
  if (ans !== 'yes') {
    console.log('Aborted (no changes).')
    process.exit(0)
  }
}

/** Enumerate skill/rule dirs under IDE paths that look aipm-installed (package.json + aipm). */
function collectAipmManagedArtifactDirs(installPaths_skills_rules) {
  const skillInstallDir = installPaths_skills_rules.skillInstallDir
  const ruleInstallDir = installPaths_skills_rules.ruleInstallDir
  const out = { skills: [], rules: [] }
  for (const installName of listInstalledDirs(skillInstallDir)) {
    const dir = join(skillInstallDir, installName)
    const meta = readInstalledVersion(dir)
    if (meta) {
      out.skills.push({
        installName,
        path: dir,
        registryPath: meta.registryPath,
        version: meta.version,
      })
    }
  }
  for (const installName of listInstalledDirs(ruleInstallDir)) {
    const dir = join(ruleInstallDir, installName)
    const meta = readInstalledVersion(dir)
    if (meta) {
      out.rules.push({
        installName,
        path: dir,
        registryPath: meta.registryPath,
        version: meta.version,
      })
    }
  }
  return out
}

function applyPatchToProfileConfig(mutator) {
  if (!existsSync(PROFILE_CONFIG_FILE)) return
  try {
    const o = JSON.parse(readFileSync(PROFILE_CONFIG_FILE, 'utf-8'))
    mutator(o)
    writeFileSync(PROFILE_CONFIG_FILE, JSON.stringify(o, null, 2) + '\n', 'utf-8')
  } catch {
    /* skip corrupt */
  }
}

/** Remove all declared skills/rules/profile from aipm_profile.json. */
function clearAllArtifactDeclarationsInProjectConfig() {
  applyPatchToProfileConfig((o) => {
    o.skills = {}
    o.rules = {}
    delete o.profile
  })
}

/**
 * 移除 init 产生的项目侧配置，并删除当前 IDE 下所有 aipm 安装的 skill/rule（与 uninstall 相同的识别方式：目录内 package.json 含 aipm）。
 * 依赖 .aipm/profile.json 中的 ide（或 --ide=）；无配置时可用 --ide= 指定后再 deinit。
 */
async function cmdDeinit(...args) {
  await ensureLocalIdeConfigured(args)
  const config = readConfigOrDefault()
  const installPaths = getInstallPaths(config)
  const managed = collectAipmManagedArtifactDirs(installPaths)
  const pkgCount = managed.skills.length + managed.rules.length

  const lines = ['aipm deinit — planned changes:', '']

  if (existsSync(PROFILE_CONFIG_FILE)) {
    lines.push(`  [delete] ${relative(ROOT, PROFILE_CONFIG_FILE)}`)
  } else {
    lines.push(`  [skip] ${relative(ROOT, PROFILE_CONFIG_FILE)} (not found)`)
  }

  if (existsSync(PROFILE_LOCK_FILE)) {
    lines.push(`  [delete] ${relative(ROOT, PROFILE_LOCK_FILE)}`)
  } else {
    lines.push(`  [skip] ${relative(ROOT, PROFILE_LOCK_FILE)} (not found)`)
  }

  if (existsSync(AIPM_DIR)) {
    lines.push(`  [delete] directory ${relative(ROOT, AIPM_DIR)}/ (local IDE settings)`)
  } else {
    lines.push(`  [skip] ${relative(ROOT, AIPM_DIR)}/ (not found)`)
  }

  lines.push('')
  lines.push(`  Current IDE: ${installPaths.ide} (${relative(ROOT, installPaths.ideRootDir)})`)
  if (pkgCount) {
    lines.push('  Remove aipm-managed packages from IDE:')
    for (const s of managed.skills) {
      const label = s.registryPath ?? s.installName
      lines.push(`    [delete] skill ${label}@${s.version} → ${relative(ROOT, s.path)}`)
    }
    for (const r of managed.rules) {
      const label = r.registryPath ?? r.installName
      lines.push(`    [delete] rule ${label}@${r.version} → ${relative(ROOT, r.path)}`)
    }
  } else {
    lines.push('  [skip] No aipm-managed skills/rules under this IDE (nothing to remove in skills/rules dirs)')
  }
  lines.push('')

  const willChange =
    existsSync(PROFILE_CONFIG_FILE) ||
    existsSync(PROFILE_LOCK_FILE) ||
    existsSync(AIPM_DIR) ||
    pkgCount > 0

  if (!willChange) {
    console.log(
      'Nothing to deinit (no aipm_profile.json, lock, .aipm, or aipm-managed IDE packages).',
    )
    return
  }

  await confirmDestructivePlan(lines, args)

  for (const s of managed.skills) {
    if (existsSync(s.path)) rmSync(s.path, { recursive: true, force: true })
  }
  for (const r of managed.rules) {
    if (existsSync(r.path)) rmSync(r.path, { recursive: true, force: true })
  }

  if (existsSync(PROFILE_LOCK_FILE)) rmSync(PROFILE_LOCK_FILE, { force: true })
  if (existsSync(PROFILE_CONFIG_FILE)) rmSync(PROFILE_CONFIG_FILE, { force: true })
  if (existsSync(AIPM_DIR)) rmSync(AIPM_DIR, { recursive: true, force: true })

  console.log('deinit complete.')
}

/**
 * 卸载当前 IDE 下所有 aipm 安装的 skill/rule，并清空项目声明与 lock（含 profile 字段，避免下次 install 又从 profile 装回）。
 */
async function cmdUninstallAll(...args) {
  await ensureLocalIdeConfigured(args)
  const config = readConfigOrDefault()
  const { skills: mergedSkills, rules: mergedRules } = await resolveDesiredArtifacts(config)
  const installPaths = getInstallPaths(config)
  const managed = collectAipmManagedArtifactDirs(installPaths)

  const lines = ['aipm uninstall — planned changes:', '']
  lines.push(`  IDE: ${installPaths.ide} (${relative(ROOT, installPaths.ideRootDir)})`)
  lines.push('')

  const declaredSkillNames = new Set(Object.keys(mergedSkills).map((n) => registryPathToInstallName(n)))
  const declaredRuleNames = new Set(Object.keys(mergedRules).map((n) => registryPathToInstallName(n)))

  if (managed.skills.length) {
    lines.push('  Skills (directories to delete):')
    for (const s of managed.skills) {
      const logical = s.registryPath ?? s.installName
      const decl = declaredSkillNames.has(s.installName) ? 'declared' : 'extra (aipm-managed only)'
      lines.push(`    · ${logical} @${s.version}  [${decl}]`)
      lines.push(`      → ${relative(ROOT, s.path)}`)
    }
    lines.push('')
  }
  if (managed.rules.length) {
    lines.push('  Rules (directories to delete):')
    for (const r of managed.rules) {
      const logical = r.registryPath ?? r.installName
      const decl = declaredRuleNames.has(r.installName) ? 'declared' : 'extra (aipm-managed only)'
      lines.push(`    · ${logical} @${r.version}  [${decl}]`)
      lines.push(`      → ${relative(ROOT, r.path)}`)
    }
    lines.push('')
  }

  const hasProfileFile = existsSync(PROFILE_CONFIG_FILE)

  const mergedDecl = mergeProjectConfigFromFiles()
  const hasDeclarations =
    Boolean(mergedDecl?.profile) ||
    Object.keys(mergedDecl?.skills ?? {}).length > 0 ||
    Object.keys(mergedDecl?.rules ?? {}).length > 0

  const lock = readLockFile()
  const lockHasPins =
    Object.keys(lock?.skills ?? {}).length > 0 || Object.keys(lock?.rules ?? {}).length > 0

  lines.push('  Configuration & lock:')
  if (hasProfileFile && hasDeclarations) {
    lines.push(`    · Clear skills, rules, and profile in ${relative(ROOT, PROFILE_CONFIG_FILE)}`)
  } else if (hasProfileFile) {
    lines.push(
      `    · Patch ${relative(ROOT, PROFILE_CONFIG_FILE)} — ensure skills, rules, profile removed`,
    )
  } else {
    lines.push(`    · (no ${relative(ROOT, PROFILE_CONFIG_FILE)} to patch)`)
  }
  lines.push(
    `    · Write ${relative(ROOT, PROFILE_LOCK_FILE)} with empty skills and rules (overwrite or create)`,
  )

  const willRemoveDirs = managed.skills.length + managed.rules.length > 0

  if (!willRemoveDirs && !hasDeclarations && !lockHasPins) {
    console.log('Nothing to uninstall (no aipm-managed packages, no declarations, no lock pins).')
    return
  }

  await confirmDestructivePlan(lines, args)

  for (const s of managed.skills) {
    if (existsSync(s.path)) rmSync(s.path, { recursive: true, force: true })
  }
  for (const r of managed.rules) {
    if (existsSync(r.path)) rmSync(r.path, { recursive: true, force: true })
  }

  clearAllArtifactDeclarationsInProjectConfig()
  writeLockFile({ skills: {}, rules: {} })

  console.log('uninstall complete (IDE packages removed; declarations and lock cleared).')
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

  const profileVersionSyncQueue = []

  function pushArtifact(kind, installName, registryPath, version, registryRef, registryBase, registry, quiet = false) {
    const kindConfig = ARTIFACT_KIND[kind]

    const ideDir = kind === 'skill' ? installPaths.skillInstallDir : installPaths.ruleInstallDir
    const srcDir = join(ideDir, installName)
    const destDir = join(registryBase, kindConfig.registryDir, registryPath, version)

    if (!existsSync(srcDir)) {
      throw new Error(`${kind} ${installName} not found in ${ideDir}`)
    }

    validatePublishArtifact(srcDir, kindConfig, registryPath)
    assertPublishVersionVsRegistry(registry, kind, registryPath, version)

    const pkgJson = JSON.parse(readFileSync(join(srcDir, 'package.json'), 'utf-8'))
    const markerFile =
      kind === 'rule' ? resolveRuleMarkerFromPkgFiles(pkgJson, registryPath, srcDir) : 'SKILL.md'
    const { files } = resolvePublishFiles(srcDir, pkgJson, { markerFile })
    mkdirSync(destDir, { recursive: true })

    const filesIntegrity = collectFilesIntegrityForPublish(
      files,
      srcDir,
      installName,
      registryPath,
      kind === 'rule' ? { ruleMarkerFile: markerFile } : {},
    )
    const relDir = `${kindConfig.registryDir}/${registryPath}/${version}`
    for (const file of files) {
      const srcPath = join(srcDir, file)
      const destPath = join(destDir, file)
      if (existsSync(srcPath)) {
        mkdirSync(dirname(destPath), { recursive: true })
        let content = readFileSync(srcPath, 'utf-8')
        if (file === 'SKILL.md' && kind === 'skill' && installName !== registryPath) {
          content = patchSkillNameInFrontmatter(content, registryPath)
        }
        if (kind === 'rule' && file === markerFile && installName !== registryPath) {
          content = patchSkillNameInFrontmatter(content, registryPath)
        }
        if (file === 'package.json') {
          try {
            const pkg = JSON.parse(content)
            if (!pkg.aipm) pkg.aipm = {}
            if (pkg.aipm.sourceRegistry === undefined) pkg.aipm.sourceRegistry = 'default'
            pkg.files = files
            pkg.filesIntegrity = filesIntegrity
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
      const markerPath = join(srcDir, markerFile)
      if (existsSync(markerPath)) {
        const { description: fmDesc } = parseArtifactFrontmatter(readFileSync(markerPath, 'utf-8'))
        if (fmDesc) pkg.description = fmDesc
      }
    } else {
      const markerPath = join(srcDir, markerFile)
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

    profileVersionSyncQueue.push({ kind, registryPath, version })

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
  const publishedRegistryRefs = new Set()

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
      const skillSrc = join(installPaths.skillInstallDir, installName)
      if (!existsSync(skillSrc)) {
        throw new Error(`skill ${installName} not found in ${installPaths.skillInstallDir}`)
      }
      validatePublishArtifact(skillSrc, ARTIFACT_KIND.skill, packageName)
      version = readPublishVersionFromArtifact(skillSrc)
      assertPublishVersionVsRegistry(registry, 'skill', packageName, version)
      if (isUrl(registryRef)) {
        await publishToRemoteRegistry('skill', packageName, registryRef, {
          quiet: publishQuiet,
          profileVersionSyncQueue,
        })
      } else {
        const registryBase = resolveLocalBase(registryRef)
        const isNew = !registry.packages?.[packageName]
        if (isNew) {
          await addArtifactToRegistry('skill', packageName, args, publishQuiet, profileVersionSyncQueue)
        } else {
          // 新版本尚未进入 registry，不能用 resolveArtifactPath（它要求版本已发布）
          validateRegistryPath(packageName, 'Skill')
          pushArtifact('skill', installName, packageName, version, registryRef, registryBase, registry, publishQuiet)
        }
      }
      publishedRegistryRefs.add(resolveRegistryRef(registryRef))
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
      const ruleSrc = join(installPaths.ruleInstallDir, installName)
      if (!existsSync(ruleSrc)) {
        throw new Error(`rule ${installName} not found in ${installPaths.ruleInstallDir}`)
      }
      validatePublishArtifact(ruleSrc, ARTIFACT_KIND.rule, packageName)
      version = readPublishVersionFromArtifact(ruleSrc)
      assertPublishVersionVsRegistry(registry, 'rule', packageName, version)
      if (isUrl(registryRef)) {
        await publishToRemoteRegistry('rule', packageName, registryRef, {
          quiet: publishQuiet,
          profileVersionSyncQueue,
        })
      } else {
        const registryBase = resolveLocalBase(registryRef)
        const isNew = !registry.rules?.[packageName]
        if (isNew) {
          await addArtifactToRegistry('rule', packageName, args, publishQuiet, profileVersionSyncQueue)
        } else {
          // 新版本尚未进入 registry，不能用 resolveArtifactPath（它要求版本已发布）
          validateRegistryPath(packageName, 'Rule')
          pushArtifact('rule', installName, packageName, version, registryRef, registryBase, registry, publishQuiet)
        }
      }
      publishedRegistryRefs.add(resolveRegistryRef(registryRef))
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

  if (publishedRegistryRefs.size) {
    for (const ref of publishedRegistryRefs) {
      try {
        await refreshRegistryJsonCache(ref)
      } catch (e) {
        if (verbose) {
          console.log(
            `[publish] registry cache refresh failed (${ref}): ${e instanceof Error ? e.message : e}`,
          )
        }
      }
    }
  }

  await applyPublishProfileVersionSync(profileVersionSyncQueue, args)
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

  /** 展示用短名：@scope/pkg 取 pkg，与 IDE 目录名 installName（如 scope_pkg）分离 */
  const logicalName = registryPath.includes('/') ? registryPath.split('/').pop() : registryPath
  const desc = description ?? `${kind}: ${logicalName}`

  const markerFile = kind === 'rule' ? ruleMarkerFilename(registryPath) : kindConfig.markerFile
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
name: "${logicalName}"
description: "${desc}"
---

# ${logicalName}

<!-- Add skill content here. -->\n`
      : `---
name: "${logicalName}"
description: "${desc}"
---

# ${logicalName}

<!-- Add rule content here. -->\n`
  writeFileSync(join(srcDir, markerFile), markerContent, 'utf-8')

  console.log(`Created ${kind} scaffold at ${relative(ROOT, srcDir)}`)
  return srcDir
}

/** Publish artifact to remote HTTP registry (POST /api/publish）。版本以包内 package.json 为准。 */
async function publishToRemoteRegistry(kind, packageName, registryUrl, options = {}) {
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
  validatePublishArtifact(srcDir, kindConfig, registryPath)
  const version = readPublishVersionFromArtifact(srcDir)

  const pkgOnDisk = JSON.parse(readFileSync(join(srcDir, 'package.json'), 'utf-8'))
  const markerFileForRule =
    kind === 'rule' ? resolveRuleMarkerFromPkgFiles(pkgOnDisk, registryPath, srcDir) : null
  const markerFile = kind === 'skill' ? 'SKILL.md' : (markerFileForRule ?? LEGACY_RULE_MARKER)

  const { files: fileKeysSorted } = resolvePublishFiles(srcDir, pkgOnDisk, { markerFile })
  const files = {}
  for (const f of fileKeysSorted) {
    const p = join(srcDir, f)
    if (existsSync(p)) {
      files[f] = readFileSync(p, 'utf-8')
    }
  }
  const filesIntegrityRemote = collectFilesIntegrityForPublish(
    fileKeysSorted,
    srcDir,
    installName,
    registryPath,
    markerFileForRule ? { ruleMarkerFile: markerFileForRule } : {},
  )
  if (files['package.json']) {
    try {
      const pkg = JSON.parse(files['package.json'])
      if (!pkg.aipm) pkg.aipm = {}
      pkg.aipm.sourceRegistry = pkg.aipm.sourceRegistry ?? 'default'
      pkg.files = fileKeysSorted
      pkg.filesIntegrity = filesIntegrityRemote
      files['package.json'] = JSON.stringify(pkg, null, 2) + '\n'
    } catch {
      /* keep original */
    }
  }

  const markerPath = join(srcDir, markerFile)
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

  if (options.profileVersionSyncQueue) {
    options.profileVersionSyncQueue.push({ kind, registryPath, version })
  }

  if (!options.quiet) {
    console.log(`Published ${kind} ${registryPath}@${version} to ${base}`)
  }
}

/** HTTP registry：POST /api/unpublish（与 Docker aipm-registry 配套）。 */
async function unpublishToRemoteRegistry(kind, registryPath, registryUrl) {
  const base = String(registryUrl).replace(/\/+$/, '')
  const apiUrl = `${base}/api/unpublish`
  const token = getRegistryToken()
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ kind, registryPath }),
  })
  const raw = await res.text()
  let data = {}
  try {
    data = JSON.parse(raw)
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const hint = typeof data.error === 'string' ? data.error : raw.slice(0, 200)
    throw new Error(hint || `Unpublish failed (${res.status})`)
  }
}

/** Add artifact (skill or rule) from IDE to Registry。版本以包内 package.json 为准。 */
async function addArtifactToRegistry(kind, name, args, quiet = false, profileVersionSyncQueue = null) {
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

  const installed = readInstalledVersion(srcDir)
  const { registryPath, logicalName } = parseInstallNameToRegistryPath(
    installName,
    installed?.registryPath,
  )

  validateRegistryPath(registryPath, kind === 'skill' ? 'Skill' : 'Rule')

  const pkgProbe = JSON.parse(readFileSync(join(srcDir, 'package.json'), 'utf-8'))
  const markerFile =
    kind === 'skill' ? 'SKILL.md' : resolveRuleMarkerFromPkgFiles(pkgProbe, registryPath, srcDir)
  const markerPath = join(srcDir, markerFile)
  if (!existsSync(markerPath)) {
    throw new Error(`${kind} '${installName}' missing ${markerFile}`)
  }

  validatePublishArtifact(srcDir, kindConfig, registryPath)
  const version = readPublishVersionFromArtifact(srcDir)

  const { files } = resolvePublishFiles(srcDir, pkgProbe, { markerFile })
  const destDir = join(registryBase, kindConfig.registryDir, registryPath, version)

  const registryJsonPath = join(registryBase, 'registry.json')
  const registry = JSON.parse(readFileSync(registryJsonPath, 'utf-8'))
  const registryKey = kindConfig.registryKey
  assertPublishVersionVsRegistry(registry, kind, registryPath, version)
  if (existsSync(destDir)) {
    throw new Error(
      `'${registryPath}@${version}' already exists in registry. Bump version (e.g. 1.0.1) to publish.`,
    )
  }

  mkdirSync(destDir, { recursive: true })
  const filesIntegrity = collectFilesIntegrityForPublish(
    files,
    srcDir,
    installName,
    registryPath,
    kind === 'rule' ? { ruleMarkerFile: markerFile } : {},
  )
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
          pkg.filesIntegrity = filesIntegrity
          content = JSON.stringify(pkg, null, 2) + '\n'
        } catch {
          /* keep original */
        }
      }
      writeFileSync(destPath, content, 'utf-8')
      writeToBundleCache(registryRef, `${relDir}/${file}`, content, false)
    }
  }

  const markerContent = readFileSync(markerPath, 'utf-8')
  const { description: fmDesc } = parseArtifactFrontmatter(markerContent)
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

  if (profileVersionSyncQueue) {
    profileVersionSyncQueue.push({ kind, registryPath, version })
  } else {
    const configKey = kind === 'skill' ? 'skills' : 'rules'
    config[configKey] ??= {}
    config[configKey][registryPath] = versionSpecAfterPublish(config[configKey][registryPath], version)
    writeConfig(config)
  }

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
  const { flagArgs, positionals } = parseInitArtifactCliArgs(args)
  await ensureLocalIdeConfigured(flagArgs)
  const config = readConfig()
  const installPaths = getInstallPaths(config)
  ensureIdeDirs(installPaths)

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  console.log('\nCreate a new skill package (npm-style: @scope/name or scope_name)\n')

  let name
  const fromCli = positionals[0] != null && String(positionals[0]).trim() !== ''
  if (fromCli) {
    const spec = parseSearchQuerySpec(String(positionals[0]).trim())
    name = (spec.nameQuery || String(positionals[0]).trim()).trim()
  } else {
    name = await question(rl, 'Package name', '')
  }
  if (!name.trim()) {
    rl.close()
    throw new Error(
      'Package name is required. Usage: aipm init-skill [--ide=…] [@scope/name | scope_name]',
    )
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
  config.skills[registryPath] = versionSpecToRecord('', version)
  writeConfig(config)

  console.log(`\nSkill created. Edit ${relative(ROOT, join(srcDir, 'SKILL.md'))} then run \`aipm publish ${registryPath}\` to publish.`)
}

/** Create new rule package interactively. */
async function cmdInitRule(...args) {
  if (!process.stdin.isTTY) {
    throw new Error('aipm init-rule requires interactive mode. Run in a terminal.')
  }
  const { flagArgs, positionals } = parseInitArtifactCliArgs(args)
  await ensureLocalIdeConfigured(flagArgs)
  const config = readConfig()
  const installPaths = getInstallPaths(config)
  ensureIdeDirs(installPaths)

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  console.log('\nCreate a new rule package (npm-style: @scope/name or scope_name)\n')

  let name
  const fromCli = positionals[0] != null && String(positionals[0]).trim() !== ''
  if (fromCli) {
    const spec = parseSearchQuerySpec(String(positionals[0]).trim())
    name = (spec.nameQuery || String(positionals[0]).trim()).trim()
  } else {
    name = await question(rl, 'Package name', '')
  }
  if (!name.trim()) {
    rl.close()
    throw new Error(
      'Package name is required. Usage: aipm init-rule [--ide=…] [@scope/name | scope_name]',
    )
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
  config.rules[registryPath] = versionSpecToRecord('', version)
  writeConfig(config)

  const ruleMarker = ruleMarkerFilename(registryPath)
  console.log(
    `\nRule created. Edit ${relative(ROOT, join(srcDir, ruleMarker))} then run \`aipm publish ${registryPath}\` to publish.`,
  )
}

/**
 * Remove artifact from Registry. Name can be registry path (e.g. @scope/pkg) or logical / short name.
 * 本地仓库：改 registry.json + 删 assets 目录；HTTP 仓库：POST /api/unpublish（需 registry 服务支持）。
 */
async function removeArtifactFromRegistry(kind, name, cliArgs = []) {
  const kindConfig = ARTIFACT_KIND[kind]
  const config = readConfig()
  const registryRef = resolveUnpublishRegistryRef(config, cliArgs)
  if (!registryRef) {
    throw new Error(
      `unpublish-${kind} requires a registry. Add one to aipm_profile / ~/.aipmrc or use --registry <path-or-url>.`,
    )
  }

  const baseRef = resolveRegistryRef(registryRef)
  const registry = await readJsonResource(baseRef, 'registry.json')
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

  if (isUrl(baseRef)) {
    await unpublishToRemoteRegistry(kind, registryPath, baseRef)
    try {
      await refreshRegistryJsonCache(baseRef)
    } catch {
      /* best-effort cache refresh */
    }
  } else {
    const registryBase = resolveLocalBase(registryRef)
    const artifactDir = join(registryBase, kindConfig.registryDir, registryPath)
    rmSync(artifactDir, { recursive: true, force: true })
    delete registry[registryKey][registryPath]
    const registryStr = JSON.stringify(registry, null, 2) + '\n'
    writeFileSync(join(registryBase, 'registry.json'), registryStr, 'utf-8')
    writeToBundleCache(registryRef, 'registry.json', registryStr, false)
  }

  const configKey = kind === 'skill' ? 'skills' : 'rules'
  if (config[configKey]?.[registryPath]) {
    delete config[configKey][registryPath]
    writeConfig(config)
  }

  const registryWhere = isUrl(baseRef) ? baseRef : resolveLocalBase(registryRef)
  console.log(`Unpublished ${kind} ${registryPath} from registry at ${registryWhere}`)
}

async function cmdUnpublishSkill(...args) {
  const positional = filterUnpublishPositionalArgs(args)
  const name = positional[0]
  if (!name) {
    throw new Error('Usage: aipm unpublish-skill [--registry PATH|URL] <name>')
  }
  await removeArtifactFromRegistry('skill', name, args)
}

async function cmdUnpublishRule(...args) {
  const positional = filterUnpublishPositionalArgs(args)
  const name = positional[0]
  if (!name) {
    throw new Error('Usage: aipm unpublish-rule [--registry PATH|URL] <name>')
  }
  await removeArtifactFromRegistry('rule', name, args)
}


/**
 * 解析 search 查询：支持 @scope/name@1.0.2、scope_name@1.0.2、可选 v 前缀、^x.y.z、latest。
 * 返回用于名称/描述匹配的 nameQuery 与可选的版本过滤 versionFilter（原始字符串）。
 */
function parseSearchQuerySpec(raw) {
  const displayQuery = String(raw ?? '').trim()
  if (!displayQuery) {
    return { displayQuery: '', nameQuery: '', versionFilter: null }
  }
  const q = displayQuery

  function isVersionLike(s) {
    const t = String(s).trim()
    if (!t) return false
    if (t === 'latest') return true
    const u = t.replace(/^v/i, '')
    if (/^[\^]?\d+\.\d+/.test(u)) return true
    return false
  }

  if (q.startsWith('@')) {
    const lastAt = q.lastIndexOf('@')
    if (lastAt > 0) {
      const pkg = q.slice(0, lastAt)
      const ver = q.slice(lastAt + 1).trim()
      if (ver && isVersionLike(ver) && pkg.includes('/')) {
        return { displayQuery, nameQuery: pkg, versionFilter: ver }
      }
    }
    return { displayQuery, nameQuery: q, versionFilter: null }
  }

  const at = q.indexOf('@')
  if (at > 0) {
    const pkg = q.slice(0, at)
    const ver = q.slice(at + 1).trim()
    if (ver && isVersionLike(ver)) {
      return { displayQuery, nameQuery: pkg, versionFilter: ver }
    }
  }

  return { displayQuery, nameQuery: q, versionFilter: null }
}

function itemMatchesSearchVersionFilter(item, versionFilter) {
  if (versionFilter == null || String(versionFilter).trim() === '') return true
  const vRaw = String(versionFilter).trim()
  if (vRaw === 'latest') {
    return item.latest != null && String(item.latest).trim() !== ''
  }
  const vNorm = vRaw.replace(/^v/i, '')
  const vers = item.versions ?? []
  if (vRaw.startsWith('^')) {
    return maxVersionSatisfyingCaret(vers, vRaw) != null
  }
  return vers.includes(vNorm) || vers.includes(vRaw) || String(item.latest) === vNorm || String(item.latest) === vRaw
}

function matchesSearchQuery(name, item, nameQuery, versionFilter) {
  if (!itemMatchesSearchVersionFilter(item, versionFilter)) return false
  const q = String(nameQuery ?? '').trim()
  if (!q) return true
  return (
    name.includes(q) ||
    Boolean(item.description?.includes(q)) ||
    Boolean(item.tags?.some((tag) => String(tag).includes(q)))
  )
}

/**
 * aipm install：无位置参数 = 按 profile 全量安装；有参数 = 安装单个包（自动识别 skill / rule，行为同 install-skill | install-rule）。
 */
function parseInstallPullArgs(args = []) {
  const { flagArgs, positionals } = parseInstallCliArgs(args)
  if (positionals.length === 0) return { mode: 'all', flagArgs }
  if (positionals.length > 2) {
    throw new Error('Usage: aipm install [flags] [@scope/name | scope_name] [version]')
  }
  let name
  let version = 'latest'
  if (positionals.length >= 2) {
    const s0 = parseSearchQuerySpec(positionals[0])
    name = (s0.nameQuery || positionals[0]).trim()
    version = String(positionals[1]).trim() || 'latest'
  } else {
    const s = parseSearchQuerySpec(positionals[0])
    name = (s.nameQuery || positionals[0]).trim()
    version = s.versionFilter != null ? String(s.versionFilter).trim() : 'latest'
  }
  if (!name) {
    throw new Error('Usage: aipm install [flags] [@scope/name | scope_name] [version]')
  }
  return { mode: 'one', name, version, flagArgs }
}

/** Human-readable label for a registry ref (URL normalized, local path prefer relative to ROOT). */
function searchFormatRegistryLabel(ref) {
  const resolved = resolveRegistryRef(ref)
  if (isUrl(resolved)) {
    return `${resolved.replace(/\/+$/, '')}/`
  }
  const abs = resolveLocalBase(ref)
  const rel = relative(ROOT, abs)
  return rel && rel !== abs ? rel : abs
}

function searchFormatVersionLine(item, versionFilter = null) {
  const vf = versionFilter != null && String(versionFilter).trim() !== '' ? String(versionFilter).trim() : null
  if (vf && vf.startsWith('^')) {
    const best = maxVersionSatisfyingCaret(item.versions ?? [], vf)
    if (best) return `matches ${best} (range ${vf})`
  } else if (vf && vf !== 'latest') {
    const vNorm = vf.replace(/^v/i, '')
    const vers = item.versions ?? []
    if (vers.includes(vNorm) || vers.includes(vf) || String(item.latest) === vNorm) {
      return `version ${vNorm}`
    }
  }
  const versions =
    Array.isArray(item.versions) && item.versions.length ? item.versions.join(' · ') : null
  const latest =
    item.latest != null && String(item.latest).trim() !== '' ? String(item.latest).trim() : null
  const parts = []
  if (latest) parts.push(`latest ${latest}`)
  if (versions) parts.push(`versions ${versions}`)
  return parts.length ? parts.join('    ') : '—'
}

function searchPrintDescription(desc) {
  if (!desc || !String(desc).trim()) return
  const words = String(desc).trim().split(/\s+/)
  const prefix = '        '
  const maxLen = 72
  let line = ''
  for (const w of words) {
    const next = line ? `${line} ${w}` : w
    if (next.length > maxLen && line) {
      console.log(prefix + line)
      line = w
    } else {
      line = next
    }
  }
  if (line) console.log(prefix + line)
}

async function cmdSearch(...args) {
  const config = readConfigOrDefault()
  const registries = getRegistries(config)
  const rawQuery = args
    .filter((a) => typeof a === 'string' && !a.startsWith('-'))
    .join(' ')
    .trim()
  const { displayQuery: q, nameQuery, versionFilter } = parseSearchQuerySpec(rawQuery)

  const hits = []
  const fetchErrors = []

  for (const ref of registries) {
    const label = searchFormatRegistryLabel(ref)
    const resolved = resolveRegistryRef(ref)
    try {
      const reg = await fetchRegistry(resolved, { bypassCache: true })
      const skills = Object.entries(reg?.packages ?? {})
        .filter(([name, item]) => matchesSearchQuery(name, item, nameQuery, versionFilter))
        .sort(([a], [b]) => a.localeCompare(b))
      const rules = Object.entries(reg?.rules ?? {})
        .filter(([name, item]) => matchesSearchQuery(name, item, nameQuery, versionFilter))
        .sort(([a], [b]) => a.localeCompare(b))
      if (skills.length || rules.length) {
        hits.push({ label, skills, rules })
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      fetchErrors.push({ label, message })
    }
  }

  if (!hits.length) {
    console.log(
      q ? `no matching skills/rules found for "${q}"` : 'no skills/rules found in any reachable registry',
    )
    if (fetchErrors.length) {
      console.log('')
      console.log('Unreachable registries:')
      for (const { label, message } of fetchErrors) {
        console.log(`  · ${label}`)
        console.log(`    ${message}`)
      }
    }
    return
  }

  const bannerW = 58
  console.log('─'.repeat(bannerW))
  console.log(`  aipm search${q ? ` · "${q}"` : ' · (all packages)'}`)
  console.log(`  ${hits.length} registry source${hits.length === 1 ? '' : 's'} with matches`)
  console.log('─'.repeat(bannerW))
  console.log('')

  for (let i = 0; i < hits.length; i++) {
    const { label, skills, rules } = hits[i]
    console.log(`  ▸ ${label}`)
    console.log('')

    if (skills.length) {
      console.log('    Skills')
      console.log(`    ${'─'.repeat(32)}`)
      for (const [name, item] of skills) {
        console.log(`    ${name}`)
        console.log(`        ${searchFormatVersionLine(item, versionFilter)}`)
        searchPrintDescription(item.description)
      }
      console.log('')
    }

    if (rules.length) {
      console.log('    Rules')
      console.log(`    ${'─'.repeat(32)}`)
      for (const [name, item] of rules) {
        console.log(`    ${name}`)
        console.log(`        ${searchFormatVersionLine(item, versionFilter)}`)
        searchPrintDescription(item.description)
      }
      console.log('')
    }

    if (i < hits.length - 1) {
      console.log(`  ${'·'.repeat(42)}`)
      console.log('')
    }
  }

  if (fetchErrors.length) {
    console.log('─'.repeat(bannerW))
    console.log(
      `  ${fetchErrors.length} registry source${fetchErrors.length === 1 ? '' : 's'} could not be read`,
    )
    for (const { label, message } of fetchErrors) {
      console.log(`    · ${label}`)
      console.log(`      ${message}`)
    }
  }
}

async function cmdRegistry() {
  const config = readConfigOrDefault()
  const entries = getRegistriesAnnotated(config)
  console.log('Registries (priority: project → global → default when not duplicated)')
  console.log(`Bundle cache: ${BUNDLE_CACHE_DIR}`)
  console.log('')
  for (let i = 0; i < entries.length; i++) {
    const { ref, tier } = entries[i]
    const label = searchFormatRegistryLabel(ref)
    const resolved = resolveRegistryRef(ref)
    console.log(`${i + 1}. [${tier}] ${label}`)
    try {
      await refreshRegistryJsonCache(ref)
      const cachePath = isUrl(resolved)
        ? bundleCachePath(resolved, 'registry.json')
        : join(BUNDLE_CACHE_DIR, 'published', registryCacheId(resolved), 'registry.json')
      console.log(`   cache: updated → ${cachePath}`)
    } catch (e) {
      console.log(`   cache: failed — ${e instanceof Error ? e.message : String(e)}`)
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
  init [--registry PATH]   Create aipm_profile.json from aipm-profile.template.json (deep copy), then apply --registry / IDE & profile prompts. Omit --registry to not add project registry (unless template defines it). Fallback if template missing: built-in { skills, rules }.
  install [flags] [[@scope/name | scope_name] [version]]
                          No package args: install everything declared in profile + aipm_profile; prune IDE dirs not in declared set; install summary at end
                          With package args: install one skill or rule (auto-detected; if both exist with same name, prompts or use --kind=skill|--kind=rule)
                          Optional version: second arg or embedded @scope/name@1.0.2 (see search). Flags: --skip-registry-refresh, -v, --ide=…, --kind=…
                          Before resolve: refreshes registry index (unless --skip-registry-refresh); --on-conflict for full install only
                          Uses .aipm/profile.json for IDE; creates it on first run if missing
  list                    List declared and installed skills/rules
  update [name] [--latest] [--on-conflict=..] [--skip-registry-refresh] [-v]
                          Upgrade one or all artifacts, ignoring the lock: latest -> registry latest; ^x.y.z -> newest compatible
                          (--latest: newest regardless of ^ range, spec becomes ^new). Exact x.y.z specs are pinned and kept.
  pin <name> [version]    Pin to an exact version (default: version in lock); update will not change it
  unpin [name]            Turn exact version(s) into ^version so update can upgrade; no name = all pinned
  publish [name] [--registry PATH] [-v] [--publish-update-profile=ask|yes|no]
                          Sync to Registry (default: package sourceRegistry; -v verbose)
                          package.json "files" may list files or directories (directories expand to all non-ignored files under them).
                          Publish ignores: aipm.publishIgnore (string[] in package.json only; * matches one path segment, trailing / for directories).
                          After success: refresh bundle cache for each registry touched; sync aipm_profile (see publish-update-profile)
  registry                List registries for this project (priority order) and refresh registry.json in ~/.aipm/cache
  doctor                  Check config, registry, and local installs
  deinit [--yes] [--ide=…]  Remove aipm_profile.json, lock, .aipm/, and all aipm-managed skills/rules under current IDE (confirm or --yes)
  uninstall [--yes]       Remove all aipm-managed skill & rule dirs for current IDE; clear skills/rules/profile in config; empty lock (lists paths; confirm or --yes)

Create new packages (interactive):
  init-skill [@scope/name|scope_name]  Create skill; optional arg skips package name prompt (--ide=…)
  init-rule [@scope/name|scope_name]   Create rule; same as init-skill

Registry commands (local registry only):
  unpublish-skill [--registry PATH|URL] <name>  Remove skill (local data dir or HTTP + POST /api/unpublish)
  unpublish-rule [--registry PATH|URL] <name>   Remove rule (same)

Additional commands:
  global                  Print ~/.aipmrc path / status / template path; create from template if no global file yet
  set-token [token]       Save registry-token in ~/.aipmrc (npmrc-style); publish uses Bearer, GET may use ?token=
  use [profile-id]        Switch to profile (配置单). Without arg, list available profiles.
  install-skill <name> [version] [--skip-registry-refresh] [-v]   Add skill to config and install from registry
  install-rule <name> [version] [--skip-registry-refresh] [-v]   Add rule to config and install from registry
  uninstall-skill <name>  Remove one skill from config and IDE
  uninstall-rule <name>   Remove one rule from config and IDE
  search [query]          Search registries (fresh registry.json). Query may include version: @scope/name@1.0.2, name@1.0.2, or ^x.y.z / latest
  help, --help, -h        Show this help

Config keys:
  aipm_profile.json       Project config only: registry, registries, profile, skills, rules, publish-update-profile (no ide)
  .aipm/profile.json      Local only: ide (and future per-machine keys). Created on first install if missing.
  skill/rule package.json Per-artifact manifest (name, version, files, aipm.sourceRegistry for publish) — not project config
  ~/.aipmrc                Global (npmrc-style): registry, registries, registry-token, publish-update-profile=ask|yes|no; # comments
  Default registry is http://localhost:9005/ (aipm-registry); project + global + default are merged in order.
  profile                 Current profile (loads skills/rules from profiles/<profile>.json)
  skills, rules           Dependencies (npm-style: name -> version). Override profile.
  publishUpdateProfile    (JSON) or publish-update-profile (.aipmrc): after publish, ask | yes | no to update aipm_profile skills/rules versions
  ide                     Set via .aipm/profile.json; override once with --ide= on install/update/etc.

Bundle cache (~/.aipm/cache): Artifact files use cache on hit; registry.json is refreshed at start of install/update (unless install --skip-registry-refresh); publish / aipm registry also refresh it.

Conflict options (install/update; applies when local tree is “dirty” vs filesIntegrity or not-from-aipm):
  --on-conflict=ask       Ask once per package whether to replace the whole directory (default; TTY only)
  --on-conflict=skip      Skip packages that would need overwrite (keep previous lock pin when possible)
  --on-conflict=overwrite Replace whole directory without asking when dirty
`

const COMMANDS = {
  init: cmdInit,
  install: cmdPull,
  list: cmdList,
  update: cmdUpdate,
  pin: cmdPin,
  unpin: cmdUnpin,
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
  registry: cmdRegistry,
  deinit: cmdDeinit,
  uninstall: cmdUninstallAll,
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
