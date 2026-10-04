/**
 * The write-ish HTTP routes (/api/open, /reveal, /new-session, /retry), `present()` and
 * `resolveFolder`, plus the archive reconciliation and project disambiguation that sit between a
 * scan and the page.
 *
 * Hermetic: the harness registry is emptied and replaced by fakes, so nothing reads a real home
 * directory, and the opener's spawn is stubbed, so no application or file manager is launched.
 * Talks raw http because Node's fetch will not let a test set Host.
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { EventEmitter } from 'node:events'

const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'botsbay-world-routes-'))
process.env.BOT_CROSSING_DATA = dataDir

const { HARNESSES } = await import('../server/harnesses/index.mjs')
const { setSpawnForTests } = await import('../server/lib/opener.mjs')
const { apiMiddleware } = await import('../server/api.mjs')
const { scanThreads } = await import('../server/scan.mjs')

// ── fakes ─────────────────────────────────────────────────────────────────────

const spawned = []
setSpawnForTests((cmd, args, opts) => {
  spawned.push({ cmd, args, opts })
  const child = new EventEmitter()
  child.unref = () => {}
  setImmediate(() => child.emit('spawn'))
  return child
})

const seen = { open: [], newSession: [], retry: [] }
let fakeThreads = []
let openAnswer = { ok: true, url: 'fake://thread/1' }
let retryAnswer = { ok: true }

const fake = {
  id: 'fake',
  name: 'Fake',
  detect: async () => true,
  scanThreads: async () => fakeThreads,
  openThread: (ref) => (seen.open.push(ref), openAnswer),
  newSession: (dir) => (seen.newSession.push(dir), { ok: true, url: `fake://new?folder=${encodeURIComponent(dir)}` }),
  retry: async (ref) => (seen.retry.push(ref), retryAnswer),
}
const mute = { id: 'mute', name: 'Mute', detect: async () => false, scanThreads: async () => [], openThread: () => ({ ok: false }), newSession: () => ({ ok: false }) }
HARNESSES.length = 0
HARNESSES.push(fake, mute)

const server = http.createServer((req, res) => apiMiddleware(req, res, null))
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const origin = `http://127.0.0.1:${port}`

const raw = (method, p, body, { sendOrigin = true } = {}) =>
  new Promise((resolve, reject) => {
    const headers = { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json' }
    if (sendOrigin) headers.Origin = origin
    const req = http.request({ port, host: '127.0.0.1', method, path: p, headers }, (res) => {
      let text = ''
      res.on('data', (c) => (text += c))
      res.on('end', () => resolve({ status: res.statusCode, text, json: () => JSON.parse(text) }))
    })
    req.on('error', reject)
    req.end(typeof body === 'string' || body === undefined ? body : JSON.stringify(body))
  })
const post = (p, body) => raw('POST', p, body)

function reset() {
  spawned.length = 0
  seen.open.length = seen.newSession.length = seen.retry.length = 0
  openAnswer = { ok: true, url: 'fake://thread/1' }
  retryAnswer = { ok: true }
  fakeThreads = []
}

const tmpFolder = await fsp.mkdtemp(path.join(os.tmpdir(), 'botsbay-world-folder-'))
after(async () => {
  server.close()
  setSpawnForTests(null)
  await fsp.rm(dataDir, { recursive: true, force: true })
  await fsp.rm(tmpFolder, { recursive: true, force: true })
})

// present() on Linux probes xdg-mime for the scheme, which is a real subprocess; the URL-handing
// paths below are the macOS/Windows ones, so they are not exercised there.
const notLinux = { skip: process.platform === 'linux' ? 'present() probes xdg-mime on Linux' : false }

// ── /api/open ─────────────────────────────────────────────────────────────────

test('/api/open hands the adapter its ref untouched and the URL to the opener', notLinux, async () => {
  reset()
  const ref = { sessionId: 'abc', nested: { a: [1, 2] } }
  const res = await post('/api/open', { harness: 'fake', ref })
  assert.equal(res.status, 200)
  assert.deepEqual(res.json(), { ok: true, url: 'fake://thread/1' })
  assert.deepEqual(seen.open, [ref])
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].args.at(-1), 'fake://thread/1', 'the URL is the last argument, as one string')
})

test('/api/open reports an adapter refusal as 400 and launches nothing', async () => {
  reset()
  openAnswer = { ok: false, error: 'No openable session id on that thread', command: { argv: ['/bin/x'], cwd: '/' } }
  const res = await post('/api/open', { harness: 'fake', ref: {} })
  assert.equal(res.status, 400)
  assert.deepEqual(res.json(), { ok: false, error: 'No openable session id on that thread' }, 'only the reason reaches the page')
  assert.equal(spawned.length, 0)
})

test('/api/open with no URL answers honestly off Linux', notLinux, async () => {
  reset()
  openAnswer = { ok: true, command: { argv: ['/bin/x'], cwd: tmpFolder } }
  const res = await post('/api/open', { harness: 'fake', ref: {} })
  assert.equal(res.status, 400)
  assert.match(res.json().error, /no deep link/i)
  assert.equal(spawned.length, 0)
})

test('/api/open with an unknown harness is an error and launches nothing', async () => {
  reset()
  const res = await post('/api/open', { harness: 'no-such-harness', ref: {} })
  assert.ok(res.status >= 400)
  assert.match(res.json().error, /Unknown harness/)
  assert.equal(spawned.length, 0)
})

test('/api/open with a missing harness or a body that is not JSON is an error and launches nothing', async () => {
  reset()
  for (const body of ['{}', '{"ref": {}}', 'not json', '{"harness":']) {
    const res = await post('/api/open', body)
    assert.ok(res.status >= 400, body)
    assert.equal(typeof res.json().error, 'string')
  }
  assert.equal(spawned.length, 0)
})

// The page-facing contract for a bad request is 400; today these answer 500 (the generic catch).
test('/api/open with a missing harness is a 400', async () => {
  assert.equal((await post('/api/open', '{}')).status, 400)
  assert.equal((await post('/api/open', 'not json')).status, 400)
})

test('a POST without an Origin never reaches a harness', async () => {
  reset()
  const res = await raw('POST', '/api/open', { harness: 'fake', ref: {} }, { sendOrigin: false })
  assert.equal(res.status, 403)
  assert.deepEqual(seen.open, [])
  assert.equal(spawned.length, 0)
})

// ── /api/retry ────────────────────────────────────────────────────────────────

test('/api/retry passes the ref through and relays success', async () => {
  reset()
  const ref = { executionId: '77' }
  const res = await post('/api/retry', { harness: 'fake', ref })
  assert.equal(res.status, 200)
  assert.deepEqual(res.json(), { ok: true })
  assert.deepEqual(seen.retry, [ref])
})

test('/api/retry relays an adapter refusal as 400', async () => {
  reset()
  retryAnswer = { ok: false, error: 'That run is success — nothing to retry' }
  const res = await post('/api/retry', { harness: 'fake', ref: {} })
  assert.equal(res.status, 400)
  assert.equal(res.json().error, 'That run is success — nothing to retry')
})

test('/api/retry on a harness with no retry says so; an unknown harness is an error', async () => {
  reset()
  const none = await post('/api/retry', { harness: 'mute', ref: {} })
  assert.equal(none.status, 400)
  assert.match(none.json().error, /Mute has nothing to retry/)
  const unknown = await post('/api/retry', { harness: 'ghost', ref: {} })
  assert.ok(unknown.status >= 400)
  assert.match(unknown.json().error, /Unknown harness/)
  assert.deepEqual(seen.retry, [])
})

// ── /api/reveal and /api/new-session: resolveFolder ───────────────────────────

test('/api/reveal opens an existing folder, resolved, through the opener only', async () => {
  reset()
  const res = await post('/api/reveal', { folder: tmpFolder })
  assert.equal(res.status, 200)
  assert.deepEqual(res.json(), { ok: true })
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].args.at(-1), path.resolve(tmpFolder))
})

test('/api/reveal normalises a folder with dot segments before opening it', async () => {
  reset()
  const res = await post('/api/reveal', { folder: path.join(tmpFolder, 'x', '..') })
  assert.equal(res.status, 200)
  assert.equal(spawned[0].args.at(-1), path.resolve(tmpFolder))
})

test('reveal and new-session refuse anything that is not an absolute, existing directory', async () => {
  reset()
  const aFile = path.join(tmpFolder, 'file.txt')
  await fsp.writeFile(aFile, 'x')
  const bad = [
    path.join(tmpFolder, 'does-not-exist'),
    aFile,
    'relative/dir',
    '.',
    '..',
    '',
    123,
    null,
    ['/tmp'],
    { toString: () => tmpFolder },
  ]
  for (const ep of ['/api/reveal', '/api/new-session']) {
    for (const folder of bad) {
      const res = await post(ep, { folder, harness: 'fake' })
      assert.equal(res.status, 400, `${ep} ${JSON.stringify(folder)}`)
      assert.equal(res.json().ok, false)
      assert.match(res.json().error, /not on this machine/)
    }
    const missing = await post(ep, { harness: 'fake' })
    assert.equal(missing.status, 400, `${ep} with no folder`)
  }
  assert.equal(spawned.length, 0)
  assert.deepEqual(seen.newSession, [])
})

test('/api/new-session builds the session for the resolved folder and opens it', notLinux, async () => {
  reset()
  const res = await post('/api/new-session', { folder: tmpFolder, harness: 'fake' })
  assert.equal(res.status, 200)
  assert.deepEqual(seen.newSession, [path.resolve(tmpFolder)])
  assert.equal(res.json().url, `fake://new?folder=${encodeURIComponent(path.resolve(tmpFolder))}`)
  assert.equal(spawned.length, 1)
})

test('/api/new-session with no harness uses the first detected one', notLinux, async () => {
  reset()
  const res = await post('/api/new-session', { folder: tmpFolder })
  assert.equal(res.status, 200)
  assert.equal(seen.newSession.length, 1, 'the "fake" harness was chosen; "mute" is not detected')
})

test('/api/new-session with an unknown harness is an error and opens nothing', async () => {
  reset()
  const res = await post('/api/new-session', { folder: tmpFolder, harness: 'ghost' })
  assert.ok(res.status >= 400)
  assert.match(res.json().error, /Unknown harness/)
  assert.equal(spawned.length, 0)
})

test('an unknown endpoint is a 404 and a non-POST to a POST route is too', async () => {
  assert.equal((await raw('GET', '/api/nope')).status, 404)
  assert.equal((await raw('GET', '/api/open')).status, 404)
})

// ── archived matching by ids inside `ref` ─────────────────────────────────────

const thread = (id, extra = {}) => ({
  id,
  title: id,
  project: 'p',
  projectPath: '/w/p',
  lastActivityAt: 1,
  archived: false,
  ref: {},
  ...extra,
})

async function archiveList(ids) {
  await fsp.writeFile(path.join(dataDir, 'colony.json'), JSON.stringify({ version: 2, archived: ids }))
}

async function archivedMap() {
  const res = await raw('GET', '/api/threads')
  assert.equal(res.status, 200)
  return Object.fromEntries(res.json().threads.map((t) => [t.id, t.archived]))
}

test('an archive matches the thread id, and any id inside ref, string or array', async () => {
  reset()
  fakeThreads = [
    thread('claude-code:u1'),
    thread('claude-code:u2', { ref: { desktopSessionId: 'local_old' } }),
    thread('claude-code:u3', { ref: { desktopSessionIds: ['local_a', 'local_b'] } }),
    thread('claude-code:u4', { ref: { cliSessionId: 'cli-4', cwd: '/w/p' } }),
    thread('claude-code:u5', { ref: { desktopSessionId: 'local_other', desktopSessionIds: ['x'] } }),
    thread('claude-code:u6', { ref: null }),
    thread('claude-code:u7', { ref: { n: 5, o: { desktopSessionId: 'local_nested' } } }),
    thread('claude-code:u8', { ref: { desktopSessionId: '' } }),
  ]
  await archiveList(['claude-code:u1', 'local_old', 'local_b', 'cli-4', 'local_nested', ''])
  const got = await archivedMap()
  assert.equal(got['claude-code:u1'], true, 'by thread id')
  assert.equal(got['claude-code:u2'], true, 'by a string inside ref (the thread re-keyed since)')
  assert.equal(got['claude-code:u3'], true, 'by an element of an array inside ref')
  assert.equal(got['claude-code:u4'], true)
  assert.equal(got['claude-code:u5'], false)
  assert.equal(got['claude-code:u6'], false, 'a null ref is tolerated')
  assert.equal(got['claude-code:u7'], false, 'only top-level ref values count')
  assert.equal(got['claude-code:u8'], false, 'an empty string in ref never matches an empty archive entry')
})

test('a harness-archived thread stays archived with an empty colony list', async () => {
  reset()
  fakeThreads = [thread('claude-code:h1', { archived: true }), thread('claude-code:h2')]
  await archiveList([])
  const got = await archivedMap()
  assert.equal(got['claude-code:h1'], true)
  assert.equal(got['claude-code:h2'], false)
})

test('a v1 colony file with bare uuids archives the claude-code thread', async () => {
  reset()
  const uuid = '2df3987c-02d3-405e-b8f5-da30e3835213'
  fakeThreads = [thread(`claude-code:${uuid}`), thread('codex:other')]
  await fsp.writeFile(path.join(dataDir, 'colony.json'), JSON.stringify({ version: 1, archived: [uuid] }))
  const got = await archivedMap()
  assert.equal(got[`claude-code:${uuid}`], true)
  assert.equal(got['codex:other'], false)
})

test('a corrupt colony.json still returns every thread, un-archived by the colony', async () => {
  reset()
  fakeThreads = [thread('claude-code:c1'), thread('claude-code:c2', { archived: true })]
  const file = path.join(dataDir, 'colony.json')
  const bad = '{"archived": ["claude-code:c1",'
  await fsp.writeFile(file, bad)
  const warn = console.warn
  const warnings = []
  console.warn = (...a) => warnings.push(a.join(' '))
  try {
    const res = await raw('GET', '/api/threads')
    assert.equal(res.status, 200)
    const byId = Object.fromEntries(res.json().threads.map((t) => [t.id, t.archived]))
    assert.deepEqual(byId, { 'claude-code:c1': false, 'claude-code:c2': true })
    assert.ok(warnings.some((w) => /colony\.json could not be read/.test(w)))
  } finally {
    console.warn = warn
  }
  assert.equal(await fsp.readFile(file, 'utf8'), bad, 'the damaged file is left alone')
  await fsp.rm(file, { force: true })
  for (const f of await fsp.readdir(dataDir)) if (f.includes('.corrupt-')) await fsp.rm(path.join(dataDir, f))
})

// ── disambiguateProjects (through scanThreads) ────────────────────────────────

const at = (id, projectPath, extra = {}) => {
  const segs = projectPath.split(/[\\/]/).filter(Boolean)
  return { id, project: segs.at(-1) || '', projectPath, lastActivityAt: 1, ...extra }
}
const labels = async (list) => {
  fakeThreads = list
  return Object.fromEntries((await scanThreads()).map((t) => [t.id, t.project]))
}

test('two checkouts sharing a folder name get distinct labels; unrelated names are untouched', async () => {
  reset()
  const got = await labels([
    at('a', '/home/me/workspaces/1/foo'),
    at('b', '/home/me/workspaces/2/foo'),
    at('c', '/home/me/other/bar'),
    at('d', '/home/me/workspaces/1/foo'),
  ])
  assert.equal(got.a, '1/foo')
  assert.equal(got.d, '1/foo', 'threads in the same checkout share a label')
  assert.equal(got.b, '2/foo')
  assert.equal(got.c, 'bar')
})

test('labels grow only as far as they must', async () => {
  reset()
  const got = await labels([at('a', '/a/x/foo'), at('b', '/b/x/foo'), at('c', '/solo/foo2')])
  assert.equal(got.a, 'a/x/foo')
  assert.equal(got.b, 'b/x/foo')
  assert.equal(got.c, 'foo2')
})

test('Windows paths split on backslashes, and a drive letter in either case is one path', async () => {
  reset()
  const split = await labels([at('a', String.raw`C:\ws\one\foo`), at('b', String.raw`C:\ws\two\foo`)])
  assert.equal(split.a, 'one/foo')
  assert.equal(split.b, 'two/foo')

  const same = await labels([at('a', String.raw`c:\ws\one\foo`), at('b', String.raw`C:\ws\one\foo`)])
  assert.equal(same.a, 'foo', 'c:\\ and C:\\ are one checkout, so there is no collision to resolve')
  assert.equal(same.b, 'foo')
})

test('a thread with no path keeps the bare name while the others move around it', async () => {
  reset()
  const got = await labels([at('a', '/w/1/foo'), at('b', '/w/2/foo'), { id: 'n', project: 'foo', projectPath: '', lastActivityAt: 1 }])
  assert.equal(got.n, 'foo')
  assert.notEqual(got.a, got.b)
  assert.notEqual(got.a, 'foo')
  assert.notEqual(got.b, 'foo')
})

test('scanThreads stamps the harness, sorts by recency, and survives a harness that throws', async () => {
  reset()
  const boom = { id: 'boom', name: 'Boom', detect: async () => true, scanThreads: async () => { throw new Error('store unreadable') }, openThread: () => ({ ok: false }), newSession: () => ({ ok: false }) }
  HARNESSES.push(boom)
  const warn = console.warn
  console.warn = () => {}
  try {
    fakeThreads = [at('old', '/w/a', { lastActivityAt: 10 }), at('new', '/w/b', { lastActivityAt: 20 })]
    const threads = await scanThreads()
    assert.deepEqual(threads.map((t) => t.id), ['new', 'old'])
    assert.ok(threads.every((t) => t.harness === 'fake' && t.harnessName === 'Fake'))
  } finally {
    console.warn = warn
    HARNESSES.splice(HARNESSES.indexOf(boom), 1)
  }
})
