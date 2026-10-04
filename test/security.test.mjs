/**
 * The local-only guarantees: who may drive the API, which paths it will touch, and what it does
 * when its own state file is damaged. Each of these failed open at some point, and each failure
 * was silent — a stray page writing, a share on another machine being probed, a layout replaced.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

async function withApi(run) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'botsbay-world-sec-'))
  process.env.BOT_CROSSING_DATA = dir
  const { apiMiddleware } = await import(`../server/api.mjs?sec${dir}`)
  const server = http.createServer((req, res) => apiMiddleware(req, res, null))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  // Node's fetch will not let a test set Host, so this speaks http directly.
  const raw = (method, p, { host = `127.0.0.1:${port}`, origin, body } = {}) =>
    new Promise((resolve, reject) => {
      const headers = { Host: host, 'Content-Type': 'application/json' }
      if (origin) headers.Origin = origin
      const req = http.request({ port, host: '127.0.0.1', method, path: p, headers }, (res) => {
        let text = ''
        res.on('data', (c) => (text += c))
        res.on('end', () => resolve({ status: res.statusCode, text, json: () => JSON.parse(text) }))
      })
      req.on('error', reject)
      req.end(body)
    })
  try {
    await run({ raw, port, dir })
  } finally {
    server.close()
    await fsp.rm(dir, { recursive: true, force: true })
  }
}

// ── Origin carries a port ─────────────────────────────────────────────────────

test('an Origin on another local port is refused on a write', async () => {
  await withApi(async ({ raw, port }) => {
    const res = await raw('PUT', '/api/state', { origin: 'http://localhost:9999', body: '{}' })
    assert.equal(res.status, 403)
    const same = await raw('PUT', '/api/state', { origin: `http://127.0.0.1:${port}`, body: '{}' })
    assert.equal(same.status, 200)
  })
})

test('an https Origin is refused even on the right host and port', async () => {
  await withApi(async ({ raw, port }) => {
    const res = await raw('PUT', '/api/state', { origin: `https://127.0.0.1:${port}`, body: '{}' })
    assert.equal(res.status, 403)
  })
})

test('localhost and 127.0.0.1 are interchangeable only on the same port', async () => {
  await withApi(async ({ raw, port }) => {
    const ok = await raw('PUT', '/api/state', { host: `127.0.0.1:${port}`, origin: `http://localhost:${port}`, body: '{}' })
    assert.equal(ok.status, 200)
    const ok2 = await raw('PUT', '/api/state', { host: `localhost:${port}`, origin: `http://127.0.0.1:${port}`, body: '{}' })
    assert.equal(ok2.status, 200)
    const bad = await raw('PUT', '/api/state', { host: `localhost:${port}`, origin: `http://127.0.0.1:${port + 1}`, body: '{}' })
    assert.equal(bad.status, 403)
  })
})

test('a foreign Host and a write with no Origin are still refused', async () => {
  await withApi(async ({ raw, port }) => {
    assert.equal((await raw('GET', '/api/state', { host: 'evil.com' })).status, 403)
    assert.equal((await raw('PUT', '/api/state', { body: '{}' })).status, 403)
    assert.equal((await raw('GET', '/api/state')).status, 200)
    void port
  })
})

// ── UNC and device paths ──────────────────────────────────────────────────────

test('a UNC or device path is refused before the filesystem is touched', async () => {
  await withApi(async ({ raw, port }) => {
    const origin = `http://127.0.0.1:${port}`
    const calls = []
    const real = fsp.stat
    fsp.stat = (...a) => (calls.push(a[0]), real(...a))
    try {
      const folders = [
        String.raw`\\evil\share`,
        '//evil/share',
        String.raw`\\?\C:\Users`,
        String.raw`\\.\pipe\x`,
        String.raw`\/evil/share`,
      ]
      for (const folder of folders) {
        for (const ep of ['/api/reveal', '/api/new-session']) {
          const res = await raw('POST', ep, { origin, body: JSON.stringify({ folder }) })
          assert.equal(res.status, 400, `${ep} ${folder}`)
          assert.equal(res.json().ok, false)
        }
      }
    } finally {
      fsp.stat = real
    }
    assert.deepEqual(calls, [], 'fs.stat was never called')
  })
})

// ── serve.mjs ─────────────────────────────────────────────────────────────────

test('a malformed percent-escape is a 400 and the server survives it', async () => {
  const { handler } = await import('../server/serve.mjs')
  const server = http.createServer(handler)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  const get = (p) =>
    new Promise((resolve, reject) =>
      http.get({ port, host: '127.0.0.1', path: p }, (res) => (res.resume(), resolve(res.statusCode))).on('error', reject)
    )
  try {
    assert.equal(await get('/%E0%A4%A'), 400)
    assert.equal(await get('/%'), 400)
    assert.notEqual(await get('/no-such-file'), 400, 'the server is still answering')
  } finally {
    server.close()
  }
})

// ── a damaged colony file ─────────────────────────────────────────────────────

test('an unparseable colony.json is a 500, is kept, and is never overwritten', async () => {
  await withApi(async ({ raw, port, dir }) => {
    const origin = `http://127.0.0.1:${port}`
    const file = path.join(dir, 'colony.json')
    const bad = '{"archived": ["precious",'
    await fsp.writeFile(file, bad)

    assert.equal((await raw('GET', '/api/state')).status, 500)
    assert.equal((await raw('GET', '/api/state')).status, 500)
    const put = await raw('PUT', '/api/state', { origin, body: JSON.stringify({ archived: ['x'] }) })
    assert.equal(put.status, 500, 'a save is refused while the file cannot be read')

    assert.equal(await fsp.readFile(file, 'utf8'), bad, 'the original is untouched')
    const kept = (await fsp.readdir(dir)).filter((f) => f.startsWith('colony.json.corrupt-'))
    assert.equal(kept.length, 1, 'one copy, not one per request')
    assert.equal(await fsp.readFile(path.join(dir, kept[0]), 'utf8'), bad)
  })
})

test('a missing colony.json is still a fresh empty state', async () => {
  await withApi(async ({ raw }) => {
    const res = await raw('GET', '/api/state')
    assert.equal(res.status, 200)
    assert.equal(res.json().updatedAt, 0)
  })
})

test('a read error that is not a parse error returns 500 without making a copy', async () => {
  await withApi(async ({ raw, dir }) => {
    // A directory where the file should be: readFile fails with EISDIR, not ENOENT.
    await fsp.mkdir(path.join(dir, 'colony.json'))
    assert.equal((await raw('GET', '/api/state')).status, 500)
    const kept = (await fsp.readdir(dir)).filter((f) => f.includes('.corrupt-'))
    assert.deepEqual(kept, [])
  })
})
