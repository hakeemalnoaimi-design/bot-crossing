import http from 'node:http'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiMiddleware } from './api.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(here, '..', 'dist')
const PORT = Number(process.env.PORT) || 5274
const HOST = process.env.BOT_CROSSING_HOST || '127.0.0.1'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

/**
 * Resolve inside dist/ only — a request can never climb out with `..`.
 * `null` for a path that escapes; throws URIError for a malformed escape like `%E0%A4%A`, which
 * the caller turns into a 400.
 */
function resolveInDist(pathname) {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '')
  const file = path.resolve(DIST, rel || 'index.html')
  return file === DIST || file.startsWith(DIST + path.sep) ? file : null
}

async function serveRequest(req, res) {
  const url = new URL(req.url, 'http://localhost')

  if (url.pathname.startsWith('/api/')) {
    return apiMiddleware(req, res, null)
  }

  let file
  try {
    file = resolveInDist(url.pathname)
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Bad request')
    return
  }
  if (!file) {
    res.writeHead(403).end('Forbidden')
    return
  }
  try {
    if ((await fsp.stat(file)).isDirectory()) file = path.join(file, 'index.html')
  } catch {
    file = path.join(DIST, 'index.html') // SPA fallback
  }

  try {
    const body = await fsp.readFile(file)
    const type = TYPES[path.extname(file)] || 'application/octet-stream'
    const cache = file.includes(`${path.sep}assets${path.sep}`)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache'
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': cache })
    res.end(body)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found')
  }
}

/**
 * The whole handler sits behind one catch. An async handler that throws is an unhandled
 * rejection, and Node's default for those is to exit — one bad request line taking the server
 * down for everyone. Whatever goes wrong becomes a 500, or just a closed socket if the reply
 * had already started.
 */
export async function handler(req, res) {
  try {
    await serveRequest(req, res)
  } catch {
    if (res.headersSent) return void res.end()
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Server error')
  }
}

// Importable for tests without opening a port; `npm run serve` is the only thing that listens.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  http.createServer(handler).listen(PORT, HOST, () => {
    console.log(`BotsBay World → http://${HOST}:${PORT}`)
  })
}
