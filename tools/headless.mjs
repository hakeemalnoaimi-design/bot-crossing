/**
 * What `profile.mjs` and `shot.mjs` share: a headless Chrome on the real GPU, a DevTools
 * connection to it, and the built app loaded against the synthetic roster.
 *
 * Nothing in here touches the real server. The page is served by `profile-server.mjs`,
 * which answers with fake threads and keeps no state past the process.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startServer } from './profile-server.mjs'

/**
 * Stop a browser and everything it started.
 *
 * A browser is a process *tree* — a GPU process, a renderer per tab, a handful of utility
 * processes — and killing only the one we spawned leaves the rest running, holding on to
 * the GPU. Left to accumulate over a run of these tools they turn every later measurement
 * into a measurement of them: twenty-nine strays were once responsible for the frame time
 * more than doubling between two runs of the profiler.
 */
function killTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
  }
}

/** Chrome or Edge, wherever this machine keeps one. `CHROME` in the environment wins. */
export function findChrome() {
  if (process.env.CHROME) return process.env.CHROME
  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge']
  const found = candidates.find((p) => p && fs.existsSync(p))
  if (!found) throw new Error('no Chrome or Edge found — set CHROME to the browser binary')
  return found
}

class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.events = []
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
      } else if (msg.method) this.events.push(msg)
    }
  }
  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }
  /** Evaluate in the page and hand back the value; a thrown page error becomes a thrown one here. */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result.value
  }
  /** Uncaught exceptions and console errors the page produced so far. */
  problems() {
    const errors = this.events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text)
    const logs = this.events.filter((e) => e.method === 'Runtime.consoleAPICalled' && (e.params.type === 'error' || e.params.type === 'warning')).map((e) => e.params.args.map((a) => a.value ?? a.description).join(' '))
    return { errors, warnings: logs }
  }
}

/**
 * Bring everything up: the synthetic server, a headless browser on the GPU, the page with
 * its full roster placed. Resolves to `{ cdp, close }`.
 *
 * `--disable-gpu-vsync` and `--disable-frame-rate-limit` let the frame loop run as fast as
 * the GPU will go, so a wall-clock frame time means something; the GPU timer queries in
 * `profile-page.js` do not need them, but the two agreeing is a useful check.
 */
export async function openApp({ threads = 65, port = 5399, debugPort = 9333, width = 1536, height = 864, dpr = 1.25, dist = 'dist', uncapped = true } = {}) {
  const server = await startServer({ port, count: threads, dist })
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botsbay-headless-'))
  const flags = [
    '--headless=new',
    '--use-angle=d3d11',
    '--use-gl=angle',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    ...(uncapped ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : []),
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    `--window-size=${width},${height}`,
    `--force-device-scale-factor=${dpr}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ]
  const chrome = spawn(findChrome(), flags, { stdio: 'ignore', detached: process.platform !== 'win32' })

  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    killTree(chrome.pid)
    server.close()
    try {
      fs.rmSync(profileDir, { recursive: true, force: true })
    } catch {}
  }

  try {
    let wsUrl = null
    for (let i = 0; i < 100 && !wsUrl; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
        wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl || null
      } catch {}
      if (!wsUrl) await new Promise((r) => setTimeout(r, 200))
    }
    if (!wsUrl) throw new Error('the browser never opened its DevTools port')

    const ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      ws.onopen = resolve
      ws.onerror = reject
    })
    const cdp = new CDP(ws)
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` })

    // The colony has its whole roster and the boot screen has gone.
    await cdp.eval(`new Promise((resolve, reject) => {
      const start = Date.now()
      const tick = () => {
        const bc = window.botsBay || window.botCrossing
        if (bc && bc.colony.astronauts.agents.length >= ${threads} && !document.querySelector('.boot')) return resolve(true)
        if (Date.now() - start > 60000) return reject(new Error('the island never filled: ' + (bc ? bc.colony.astronauts.agents.length : 'no app on the page')))
        setTimeout(tick, 250)
      }
      tick()
    })`)
    return { cdp, close }
  } catch (err) {
    close()
    throw err
  }
}
