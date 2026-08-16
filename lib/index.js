/**
 * dsh-wallpaper-engine — host half.
 *
 * Feeds the browser-side background picker with local Wallpaper Engine
 * content. Two sources, tried in this order:
 *   1. Wallpaper Engine's own local Web API (default http://localhost:26384,
 *      available when the WE app is running with its local web service up) —
 *      used when it answers;
 *   2. Direct filesystem scan of the Steam libraries that hold the WE
 *      workshop content (appid 431960) and the local `myprojects` folder.
 *
 * Routes (all behind a loopback/private-range trust fence):
 *   GET /we/list?source=auto|api|scan[&refresh=1]  → wallpaper list for the picker
 *   GET /we/status                                  → diagnostics (API reachable, roots, counts)
 *   GET /we/file?p=<abs path>                       → media file (image/video, HTTP Range support)
 *   GET /we/preview?p=<abs path>                    → preview thumbnail (alias of /we/file)
 *   GET /we/config                                  → current config
 *   POST /we/config                                 → update config (extraDirs / apiBase / useApi)
 *
 * Config persists to $DSH_HOME/storages/dsh-wallpaper-engine.json.
 * File routes refuse anything outside the discovered wallpaper project dirs
 * (plus the parent dirs reported by the WE API) and only serve known media
 * extensions.
 */
import { readFile, readdir, stat, realpath, writeFile, rename, mkdir } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join, sep } from 'node:path'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

/** This package's icon (the floating toggle button image). */
const ICON_PATH = fileURLToPath(new URL('../icon.jpg', import.meta.url))

export const name = '@marlonlau/dsh-wallpaper-engine'
export const inject = ['webServer']

const execFileAsync = promisify(execFile)
const CACHE_TTL = 30_000
/** How the picker should present each wallpaper type. */
const KIND_BY_TYPE = {
  video: 'video',
  image: 'image',
  scene: 'preview-only',
  web: 'preview-only',
  application: 'preview-only',
  audio: 'preview-only',
}
const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.m4v': 'video/mp4', '.avi': 'video/x-msvideo',
}
const MEDIA_EXT = new Set(Object.keys(MIME))

// ---- config ---------------------------------------------------------------
function storageFile() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'storages', 'dsh-wallpaper-engine.json')
}
async function readConfig() {
  try { return JSON.parse(await readFile(storageFile(), 'utf8')) } catch { return {} }
}
async function writeConfig(cfg) {
  const file = storageFile()
  await mkdir(join(file, '..'), { recursive: true })
  const tmp = file + '.tmp'
  await writeFile(tmp, JSON.stringify(cfg, null, 2), 'utf8')
  await rename(tmp, file)
}

// ---- Steam library discovery -----------------------------------------------
/**
 * Locate the Steam installation via the Windows registry. No hardcoded install
 * paths — on machines where Steam lives somewhere unusual (or the registry is
 * unreadable), discovery simply returns nothing and the user adds their
 * wallpaper folders manually through the panel's directory picker.
 */
async function steamInstallPath() {
  for (const key of ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'HKLM\\SOFTWARE\\Valve\\Steam']) {
    try {
      const { stdout } = await execFileAsync('reg', ['query', key, '/v', 'InstallPath'])
      const m = stdout.match(/InstallPath\s+REG_\w+\s+(.+)/i)
      if (m && m[1].trim()) return m[1].trim()
    } catch { /* try the next key */ }
  }
  return null
}
/** Parse the `"path" "C:\\..."` rows of a libraryfolders.vdf. */
function parseLibraryFolders(text) {
  const paths = []
  const re = /"path"\s+"([^"]+)"/g
  let m
  while ((m = re.exec(text))) paths.push(m[1].replace(/\\\\/g, '\\'))
  return paths
}
async function discoverLibraries() {
  const libs = new Set()
  const steam = await steamInstallPath()
  if (steam) {
    libs.add(steam)
    try {
      for (const p of parseLibraryFolders(await readFile(join(steam, 'steamapps', 'libraryfolders.vdf'), 'utf8'))) libs.add(p)
    } catch { /* no vdf */ }
  }
  return [...libs]
}
/** All wallpaper project dirs (each holds a project.json) inside one library. */
async function projectDirsFromLibrary(lib) {
  const out = []
  const ws = join(lib, 'steamapps', 'workshop', 'content', '431960')
  try { for (const d of await readdir(ws, { withFileTypes: true })) if (d.isDirectory()) out.push(join(ws, d.name)) } catch { /* no workshop content */ }
  const mp = join(lib, 'steamapps', 'common', 'wallpaper_engine', 'projects', 'myprojects')
  try { for (const d of await readdir(mp, { withFileTypes: true })) if (d.isDirectory()) out.push(join(mp, d.name)) } catch { /* no myprojects */ }
  return out
}

// ---- directory scan ----------------------------------------------------------
let cache = { at: 0, entries: [], roots: [] }
/** Parent dirs reported by the WE API last time (their files are trusted too). */
let apiDirs = []
const LOOSE_MEDIA_RE = /\.(png|jpe?g|webp|gif|bmp|mp4|webm|mov|m4v|avi)$/i
async function scan(force = false) {
  const now = Date.now()
  if (!force && now - cache.at < CACHE_TTL) return cache
  const cfg = await readConfig()
  const dirs = new Set()
  for (const lib of await discoverLibraries()) {
    for (const d of await projectDirsFromLibrary(lib)) dirs.add(d)
  }
  const loose = []
  for (const extra of cfg.extraDirs || []) {
    await collectExtra(extra, dirs, loose)
  }
  const entries = []
  for (const dir of dirs) {
    const e = await buildEntry(dir)
    if (e) entries.push(e)
  }
  for (const item of loose) {
    for (const file of item.files) {
      const kind = inferKind(file)
      entries.push({
        id: 'extra:' + file.replace(/\\/g, '/'),
        title: file.split(/[\\/]/).filter(Boolean).pop() || file,
        type: kind === 'video' ? 'video' : '',
        kind,
        file,
        preview: kind === 'video' ? '' : file,
        dir: item.dir,
        tags: [],
        workshopid: null,
      })
    }
  }
  entries.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'zh-CN'))
  cache = { at: now, entries, roots: [...dirs, ...loose.map((i) => i.dir)] }
  return cache
}
/**
 * Harvest one user-configured extra directory. Accepts three shapes:
 *   1. the dir itself is a single WE project (has project.json);
 *   2. it contains per-project subdirectories (each with project.json);
 *   3. it holds loose media files directly — each file becomes a wallpaper
 *      entry (this is what lets a plain folder of images/videos work).
 */
async function collectExtra(extra, dirs, loose) {
  try { if (!(await stat(extra)).isDirectory()) return } catch { return }
  try { if ((await stat(join(extra, 'project.json'))).isFile()) { dirs.add(extra); return } } catch { /* not a single project */ }
  try {
    for (const d of await readdir(extra, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      const sub = join(extra, d.name)
      try { if ((await stat(join(sub, 'project.json'))).isFile()) dirs.add(sub) } catch { /* not a project */ }
    }
  } catch { /* unreadable */ }
  const files = []
  try {
    for (const d of await readdir(extra, { withFileTypes: true })) {
      if (d.isFile() && LOOSE_MEDIA_RE.test(d.name)) files.push(join(extra, d.name))
    }
  } catch { /* unreadable */ }
  if (files.length) loose.push({ dir: extra, files })
}
async function buildEntry(dir) {
  let j
  try { j = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8')) } catch { return null }
  const type = typeof j.type === 'string' ? j.type : ''
  const file = typeof j.file === 'string' && j.file ? join(dir, j.file) : ''
  const preview = typeof j.preview === 'string' && j.preview ? join(dir, j.preview) : ''
  if (!file && !preview) return null
  const kind = classifyKind(type, file)
  return {
    id: String(j.workshopid ?? dirName(dir)),
    title: String(j.title ?? dirName(dir)),
    type,
    kind,
    file,
    preview,
    dir,
    tags: Array.isArray(j.tags) ? j.tags.slice(0, 8) : [],
    workshopid: typeof j.workshopid === 'number' || typeof j.workshopid === 'string' ? j.workshopid : null,
  }
}
function dirName(p) { return p.split(/[\\/]/).filter(Boolean).pop() || '' }
function inferKind(file) {
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase()
  return /^(mp4|webm|mov|m4v|avi|flv)$/.test(ext) ? 'video' : 'image'
}
/** How the picker should present a wallpaper, given its declared type and media file. */
function classifyKind(type, file) {
  const base = KIND_BY_TYPE[type]
  if (base) return base
  if (file && /(scene\.json|index\.html)$/i.test(file)) return 'preview-only'
  return file ? inferKind(file) : 'image'
}

// ---- WE Web API ---------------------------------------------------------------
async function weApiList(cfg) {
  if (cfg.useApi === false) return null
  const base = String(cfg.apiBase || 'http://localhost:26384').replace(/\/+$/, '')
  try {
    const res = await fetch(base + '/api/wallpaper/list', { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return null
    const data = await res.json()
    const raw = Array.isArray(data) ? data : data && Array.isArray(data.wallpapers) ? data.wallpapers : null
    if (!raw || raw.length === 0) return null
    const dirs = []
    const entries = raw.map((it, i) => {
      const type = String(it.type ?? '')
      const file = typeof it.file === 'string' && it.file ? it.file : ''
      const preview = typeof it.preview === 'string' && it.preview ? it.preview : ''
      if (file) dirs.push(file.replace(/[\\/][^\\/]*$/, ''))
      if (preview) dirs.push(preview.replace(/[\\/][^\\/]*$/, ''))
      return {
        id: String(it.workshopid ?? it.id ?? it.title ?? i),
        title: String(it.title ?? it.name ?? ((file ? dirName(file) : '') || '')),
        type,
        kind: classifyKind(type, file),
        file,
        preview,
        dir: file ? file.replace(/[\\/][^\\/]*$/, '') : null,
        tags: [],
        workshopid: typeof it.workshopid === 'number' || typeof it.workshopid === 'string' ? it.workshopid : null,
      }
    })
    apiDirs = dirs
    return entries
  } catch {
    return null
  }
}

// ---- file serving ---------------------------------------------------------------
async function isAllowedPath(p) {
  const { roots } = await scan()
  let real
  try { real = await realpath(p) } catch { return false }
  for (const root of roots) {
    let rr
    try { rr = await realpath(root) } catch { continue }
    if (real === rr || real.startsWith(rr + sep)) return true
  }
  for (const dir of apiDirs) {
    if (real.startsWith(dir + sep)) return true
  }
  return false
}
async function serveFile(req, res) {
  if (!isTrusted(req)) return writeJson(res, 403, { ok: false, error: 'forbidden' })
  if (req.method !== 'GET' && req.method !== 'HEAD') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
  const p = new URL(req.url ?? '/', 'http://dsh.internal').searchParams.get('p')
  if (!p) return writeJson(res, 400, { ok: false, error: 'missing p' })
  const ext = p.slice(p.lastIndexOf('.')).toLowerCase()
  if (!MEDIA_EXT.has(ext)) return writeJson(res, 403, { ok: false, error: 'extension not allowed' })
  if (!(await isAllowedPath(p))) return writeJson(res, 403, { ok: false, error: 'path not allowed' })
  let st
  try { st = await stat(p) } catch { return writeJson(res, 404, { ok: false, error: 'not found' }) }
  if (!st.isFile()) return writeJson(res, 404, { ok: false, error: 'not a file' })
  const mime = MIME[ext]
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''))
  if (range) {
    const start = range[1] ? parseInt(range[1], 10) : 0
    const end = range[2] ? parseInt(range[2], 10) : st.size - 1
    if (start >= st.size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` })
      return res.end()
    }
    res.writeHead(206, {
      'Content-Type': mime,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${st.size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
    })
    if (req.method === 'HEAD') return res.end()
    createReadStream(p, { start, end }).on('error', () => res.destroy()).pipe(res)
    return
  }
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': st.size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
  })
  if (req.method === 'HEAD') return res.end()
  createReadStream(p).on('error', () => res.destroy()).pipe(res)
}

// ---- request helpers ------------------------------------------------------------
function isTrusted(req) {
  const host = req.headers?.host ?? ''
  return (
    host.startsWith('127.0.0.1') || host.startsWith('localhost') ||
    host.startsWith('192.168.') || host.startsWith('10.') ||
    host.startsWith('172.16.') || host.startsWith('172.17.') ||
    host.startsWith('172.18.') || host.startsWith('172.19.') || host.startsWith('172.2')
  )
}
function writeJson(res, status, payload) {
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(text)
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => { data += chunk })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

// ---- route handlers --------------------------------------------------------------
async function handleList(req, res) {
  if (!isTrusted(req)) return writeJson(res, 403, { ok: false, error: 'forbidden' })
  if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
  const u = new URL(req.url ?? '/', 'http://dsh.internal')
  const mode = u.searchParams.get('source') || 'auto'
  const refresh = u.searchParams.get('refresh') === '1'
  const cfg = await readConfig()
  let source = null
  let entries = null
  if (mode === 'api' || mode === 'auto') {
    entries = await weApiList(cfg)
    if (entries) source = 'api'
  }
  if (!entries && (mode === 'scan' || mode === 'auto')) {
    const c = await scan(refresh)
    entries = c.entries
    source = 'scan'
  }
  if (!entries) entries = []
  writeJson(res, 200, { ok: true, source, count: entries.length, entries })
}
async function handleStatus(req, res) {
  if (!isTrusted(req)) return writeJson(res, 403, { ok: false, error: 'forbidden' })
  const cfg = await readConfig()
  const c = await scan()
  const api = await weApiList(cfg)
  writeJson(res, 200, {
    ok: true,
    api: { reachable: !!api, base: cfg.apiBase || 'http://localhost:26384', useApi: cfg.useApi !== false },
    scan: { count: c.entries.length, roots: c.roots },
    extraDirs: cfg.extraDirs || [],
  })
}
async function handleConfig(req, res) {
  if (!isTrusted(req)) return writeJson(res, 403, { ok: false, error: 'forbidden' })
  try {
    if (req.method === 'GET') {
      const cfg = await readConfig()
      return writeJson(res, 200, { ok: true, config: cfg })
    }
    if (req.method === 'POST') {
      const raw = await readBody(req)
      const body = raw ? JSON.parse(raw) : {}
      const cfg = await readConfig()
      if (Array.isArray(body.extraDirs)) cfg.extraDirs = body.extraDirs.filter((d) => typeof d === 'string' && d.trim())
      if (typeof body.apiBase === 'string' && body.apiBase.trim()) cfg.apiBase = body.apiBase.trim()
      if (typeof body.useApi === 'boolean') cfg.useApi = body.useApi
      await writeConfig(cfg)
      cache = { at: 0, entries: [], roots: [] }
      return writeJson(res, 200, { ok: true, config: cfg })
    }
    writeJson(res, 405, { ok: false, error: 'method not allowed' })
  } catch (error) {
    writeJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

async function serveIcon(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
  try {
    const st = await stat(ICON_PATH)
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': st.size, 'Cache-Control': 'public, max-age=86400' })
    if (req.method === 'HEAD') return res.end()
    createReadStream(ICON_PATH).on('error', () => res.destroy()).pipe(res)
  } catch {
    writeJson(res, 404, { ok: false, error: 'icon not found' })
  }
}

export function apply(ctx) {
  const routes = [
    ['/we/list', handleList],
    ['/we/status', handleStatus],
    ['/we/file', serveFile],
    ['/we/preview', serveFile],
    ['/we/config', handleConfig],
    ['/we/icon', serveIcon],
  ]
  for (const [path, handler] of routes) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }), `dsh-wallpaper-engine: ${path}`)
  }
}
