/**
 * Detached restart helper for `dsh web`.
 *
 * Started with Start-Process (survives the sandboxed pwsh and the dsh server
 * it kills). Timeline:
 *   1. sleep DELAY_MS (lets the agent's final message reach the GUI),
 *   2. find the PID listening on 127.0.0.1:3080 (Get-NetTCPConnection, with a
 *      netstat fallback),
 *   3. verify that process looks like dsh (command line contains "dsh"),
 *   4. taskkill /F it,
 *   5. spawn a fresh `dsh web --host 127.0.0.1 --port 3080`, detached,
 *      stdout/stderr redirected to log files,
 *   6. poll until the port accepts connections, then write READY.
 *
 * All progress goes to restart.log next to this file.
 */
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const os = require('node:os')

const DELAY_MS = Number(process.env.DSH_WE_RESTART_DELAY || 15000)
const PORT = Number(process.env.DSH_WE_PORT || 3080)
const HOST = process.env.DSH_WE_HOST || '127.0.0.1'
const NODE = process.execPath
// Path to the dsh CLI: a node script (e.g. the deployed lib/bin.js) or any
// command on PATH. Override with DSH_BIN. Never hardcoded per-machine.
const DSH_BIN = process.env.DSH_BIN || 'dsh'
const HOME = process.env.USERPROFILE || os.homedir()
const BASE = __dirname
const LOG = path.join(BASE, 'restart.log')
const OUT_LOG = LOG + '.server.out'
const ERR_LOG = LOG + '.server.err'

function log(msg) {
  try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`) } catch { /* ignore */ }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }
function run(cmd, args, timeout) {
  return execFileSync(cmd, args, { encoding: 'utf8', timeout: timeout || 15000, windowsHide: true })
}
function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: HOST, port }, () => { s.destroy(); resolve(true) })
    s.on('error', () => resolve(false))
    s.setTimeout(2000, () => { s.destroy(); resolve(false) })
  })
}

async function findListenerPid() {
  // Preferred: Get-NetTCPConnection
  try {
    const out = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$c = Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $c.OwningProcess }`])
    const pid = parseInt(String(out).trim(), 10)
    if (!isNaN(pid) && pid > 0) return pid
  } catch (e) { log('Get-NetTCPConnection failed: ' + e.message) }
  // Fallback: netstat -ano
  try {
    const out = run('netstat.exe', ['-ano'])
    const wanted = new Set([`${HOST}:${PORT}`, `0.0.0.0:${PORT}`, `[::]:${PORT}`])
    for (const line of String(out).split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/)
      if (parts.length >= 5 && parts[0] === 'TCP' && wanted.has(parts[1]) && parts[3] === 'LISTENING') {
        const pid = parseInt(parts[4], 10)
        if (!isNaN(pid)) return pid
      }
    }
  } catch (e) { log('netstat failed: ' + e.message) }
  return null
}

async function looksLikeDsh(pid) {
  try {
    const out = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`])
    return /dsh/i.test(String(out))
  } catch (e) {
    log('command-line read failed for pid ' + pid + ' (' + e.message + '); assuming it is dsh')
    return true
  }
}

async function main() {
  log('=== helper start (delay ' + DELAY_MS + 'ms) ===')
  await sleep(DELAY_MS)
  const pid = await findListenerPid()
  if (pid) {
    const isDsh = await looksLikeDsh(pid)
    log('listener on ' + HOST + ':' + PORT + ' -> pid ' + pid + ', looksLikeDsh=' + isDsh)
    if (isDsh) {
      try {
        run('taskkill.exe', ['/F', '/PID', String(pid)])
        log('old server pid ' + pid + ' killed')
      } catch (e) { log('taskkill failed: ' + e.message) }
      await sleep(2000)
    } else {
      log('refusing to kill pid ' + pid + ': does not look like dsh')
    }
  } else {
    log('no listener on ' + HOST + ':' + PORT + '; starting fresh')
  }

  const outFd = fs.openSync(OUT_LOG, 'a')
  const errFd = fs.openSync(ERR_LOG, 'a')
  const spawnOpts = {
    cwd: HOME,
    env: { ...process.env, DSH_HOME: process.env.DSH_HOME || path.join(HOME, '.dsh') },
    stdio: ['ignore', outFd, errFd],
    detached: true,
    windowsHide: true,
  }
  let child
  if (/\.js$/i.test(DSH_BIN)) {
    child = spawn(NODE, [DSH_BIN, 'web', '--host', HOST, '--port', String(PORT)], spawnOpts)
  } else {
    child = spawn(DSH_BIN, ['web', '--host', HOST, '--port', String(PORT)], { ...spawnOpts, shell: true })
  }
  child.unref()
  log('new server spawned pid ' + child.pid)

  let up = false
  for (let i = 0; i < 60; i++) {
    await sleep(1000)
    if (await portOpen(PORT)) { up = true; break }
  }
  log(up ? 'PORT ' + PORT + ' UP (READY)' : 'PORT ' + PORT + ' NOT UP after 60s')
  log('=== helper done ===')
}

main().catch((e) => {
  log('helper fatal: ' + (e && (e.stack || e.message) || e))
  try { log('=== helper done (fatal) ===') } catch { /* ignore */ }
})
