/**
 * A stand-in for the real server, for profiling and screenshots only.
 *
 * Serves the built `dist/` and answers `/api/threads` with a synthetic roster of N threads
 * across a handful of projects, so a frame-time measurement is deterministic and never
 * touches a real harness, the real colony file, or any key in `.env`. Nothing here reads
 * the network or the home directory.
 */
import http from 'node:http'
import fsp from 'node:fs/promises'
import path from 'node:path'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.md': 'text/markdown',
}

const PROJECTS = ['autoflow', 'botsbay-site', 'client-alpha', 'client-beta', 'internal-tools', 'n8n-flows', 'ops', 'research', 'sandbox']

/** A roster with the shape a real one has: one big zone, then a tail of smaller ones. */
export function syntheticThreads(count) {
  const now = Date.now()
  const out = []
  for (let n = 0; n < count; n++) {
    const pi = Math.min(PROJECTS.length - 1, Math.floor(Math.pow(n / count, 1.35) * PROJECTS.length))
    const project = PROJECTS[pi]
    out.push({
      id: `profile:${n}`,
      title: `Thread ${n} in ${project}`,
      preview: 'profiling',
      project,
      projectPath: `C:\\work\\${project}`,
      worktree: '',
      cwd: `C:\\work\\${project}`,
      gitBranch: 'main',
      model: 'claude-fable-5-1',
      createdAt: now - (count - n) * 3_600_000,
      lastActivityAt: now - (n % 40) * 3_600_000, // all within two days: nothing dormant
      lastFocusedAt: 0,
      running: n % 13 === 0,
      unread: n % 17 === 3,
      hasError: n === 7,
      prState: n === 11 ? 'MERGED' : '',
      archived: false,
      sizeBytes: 2_000 + ((n * 7919) % 50) * 40_000,
      source: 'profile',
      canOpen: false,
      canRetry: false,
      ref: { n },
      harness: 'profile',
      harnessName: 'Profile',
    })
  }
  return out
}

function send(res, status, body) {
  const json = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) })
  res.end(json)
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        resolve({})
      }
    })
  })
}

/** Serve `dist` on 127.0.0.1:`port` with `count` synthetic threads. Resolves to the server. */
export function startServer({ port, count, dist }) {
  const DIST = path.resolve(dist)
  const threads = syntheticThreads(count)
  let state = { version: 2, archived: [], archivedAt: {}, opened: [], plots: {}, seen: {}, hiddenProjects: [], viewedAt: {}, settings: null, updatedAt: 1 }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/threads') return send(res, 200, { threads, scannedAt: Date.now(), warnings: [] })
      if (url.pathname === '/api/harnesses') return send(res, 200, { harnesses: [] })
      if (url.pathname === '/api/state' && req.method === 'GET') return send(res, 200, state)
      if (url.pathname === '/api/state' && req.method === 'PUT') {
        const body = await readBody(req)
        state = { ...state, ...body, updatedAt: Date.now() }
        delete state.baseUpdatedAt
        return send(res, 200, { ok: true, updatedAt: state.updatedAt })
      }
      return send(res, 404, { error: 'not in the profile server' })
    }
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    let file = path.resolve(DIST, rel || 'index.html')
    if (!file.startsWith(DIST)) return res.writeHead(403).end()
    try {
      if ((await fsp.stat(file)).isDirectory()) file = path.join(file, 'index.html')
    } catch {
      file = path.join(DIST, 'index.html')
    }
    try {
      const body = await fsp.readFile(file)
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Content-Length': body.length })
      res.end(body)
    } catch {
      res.writeHead(404).end('not found')
    }
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}
