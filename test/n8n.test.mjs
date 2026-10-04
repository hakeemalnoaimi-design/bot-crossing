/**
 * The n8n adapter, against a stub instance.
 *
 * Shapes here are copied from real responses off n8n.botsbay.app rather than from the docs —
 * the field names are the part of an adapter most likely to be quietly wrong, and the whole
 * point of this harness is that it reads somebody's live automation.
 *
 * The stub is a real HTTP server on loopback so the adapter's own `fetch`, headers, paging and
 * error handling are all exercised. Nothing here talks to a real instance.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const DAY = 24 * 60 * 60 * 1000

/** A stub n8n. Records what it was asked for, so the adapter's requests can be asserted on. */
async function fakeN8n({ workflows = [], executions = [], fail = null } = {}) {
  const seen = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    seen.push({ path: url.pathname, method: req.method, key: req.headers['x-n8n-api-key'] })
    if (fail) {
      res.writeHead(fail).end('{}')
      return
    }
    const json = (body) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    if (url.pathname === '/api/v1/workflows') return json({ data: workflows, nextCursor: null })
    if (url.pathname === '/api/v1/executions') return json({ data: executions, nextCursor: null })
    const one = /^\/api\/v1\/executions\/(\d+)$/.exec(url.pathname)
    if (one && req.method === 'GET') {
      const found = executions.find((e) => String(e.id) === one[1])
      return found ? json(found) : res.writeHead(404).end('{}')
    }
    if (/^\/api\/v1\/executions\/\d+\/retry$/.test(url.pathname)) return json({ id: 99999 })
    res.writeHead(404).end('{}')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    base,
    seen,
    // `fetch` pools its sockets and keeps them alive, and `close()` waits for every one of
    // them — so without this the whole run hangs at the end of the first test rather than
    // failing. Dropping the connections is what actually lets the server shut down.
    close: () =>
      new Promise((r) => {
        server.closeAllConnections()
        server.close(r)
      }),
  }
}

/**
 * A fresh copy of the adapter pointed at the stub. The module holds a snapshot and reads its
 * configuration at call time, so each test gets its own `.env` and its own import.
 */
let envSeq = 0

async function adapterFor(base, extra = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'n8n-env-'))
  const file = path.join(dir, '.env')
  const lines = [`N8N_BASE_URL=${base}`, 'N8N_API_KEY=test-key-123', 'N8N_POLL_SECONDS=1']
  for (const [k, v] of Object.entries(extra)) lines.push(`${k}=${v}`)
  await fsp.writeFile(file, lines.join('\n'))
  process.env.BOT_CROSSING_ENV = file
  // The *plain* specifier, deliberately. `n8n.mjs` imports `../lib/env.mjs` with no query, so
  // that is the instance it reads; reloading a `?query` copy would reset a different module
  // and leave the adapter looking at whatever the first test happened to cache.
  const { reloadEnv } = await import('../server/lib/env.mjs')
  reloadEnv()
  // The adapter, though, does want to be fresh each time: its snapshot is module state.
  const mod = await import(`../server/harnesses/n8n.mjs?${envSeq++}`)
  return { harness: mod.default, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) }
}

const workflow = (over = {}) => ({
  id: 'PUVLuoC9cchTF2Ey',
  name: 'BotsBay WA Daily Report',
  active: true,
  isArchived: false,
  tags: [],
  triggerCount: 1,
  createdAt: '2026-07-23T08:04:31.422Z',
  updatedAt: '2026-08-03T15:11:25.777Z',
  ...over,
})

const execution = (over = {}) => ({
  id: '11260',
  workflowId: 'PUVLuoC9cchTF2Ey',
  status: 'success',
  mode: 'trigger',
  startedAt: new Date(Date.now() - 60_000).toISOString(),
  stoppedAt: new Date(Date.now() - 59_000).toISOString(),
  waitTill: null,
  ...over,
})

// ── configuration ─────────────────────────────────────────────────────────────

test('without a URL and a key the harness is simply not there', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'n8n-env-'))
  await fsp.writeFile(path.join(dir, '.env'), 'N8N_BASE_URL=https://example.invalid\n')
  process.env.BOT_CROSSING_ENV = path.join(dir, '.env')
  const { reloadEnv } = await import('../server/lib/env.mjs')
  reloadEnv()
  const { default: harness } = await import(`../server/harnesses/n8n.mjs?nokey`)
  assert.equal(await harness.detect(), false, 'a URL without a key is not configured')
  assert.match(await harness.diagnostic(), /N8N_API_KEY/)
  await fsp.rm(dir, { recursive: true, force: true })
})

test('the API key goes in the header and never into a thread', async () => {
  const stub = await fakeN8n({ workflows: [workflow()], executions: [execution()] })
  const { harness, cleanup } = await adapterFor(stub.base)
  const threads = await harness.scanThreads()

  assert.ok(stub.seen.length >= 2, 'both endpoints were called')
  for (const call of stub.seen) assert.equal(call.key, 'test-key-123', `${call.path} carried the key`)

  // The whole thread makes a round trip through the browser, `ref` included.
  const serialised = JSON.stringify(threads)
  assert.equal(serialised.includes('test-key-123'), false, 'the key is not in the thread')
  assert.equal(serialised.includes('X-N8N-API-KEY'), false)
  await stub.close()
  await cleanup()
})

// ── the mapping ───────────────────────────────────────────────────────────────

test('a workflow becomes a thread, zoned by its first tag', async () => {
  const stub = await fakeN8n({
    workflows: [
      workflow({ id: 'aaa', name: 'Arla intake', tags: [{ id: '1', name: 'Arla' }, { id: '2', name: 'hr' }] }),
      workflow({ id: 'bbb', name: 'Untagged one', tags: [] }),
    ],
    executions: [execution({ workflowId: 'aaa' }), execution({ id: '2', workflowId: 'bbb' })],
  })
  const { harness, cleanup } = await adapterFor(stub.base)
  const threads = await harness.scanThreads()
  const byId = new Map(threads.map((t) => [t.id, t]))

  assert.equal(byId.get('n8n:aaa').project, 'Arla', 'the first tag is the zone')
  assert.equal(byId.get('n8n:aaa').title, 'Arla intake')
  assert.equal(byId.get('n8n:bbb').project, 'Internal', 'no tags falls back to Internal')
  assert.ok(byId.has('n8n:aaa'), 'ids are prefixed')
  await stub.close()
  await cleanup()
})

test('every n8n status lands on the behaviour the table asks for', async () => {
  const now = Date.now()
  const at = (ms) => new Date(now - ms).toISOString()
  const cases = [
    ['running', { status: 'running' }, { running: true, hasError: false, unread: false, prState: '' }],
    ['error', { status: 'error' }, { running: false, hasError: true, unread: false, prState: '' }],
    ['crashed', { status: 'crashed' }, { running: false, hasError: true, unread: false, prState: '' }],
    ['waiting', { status: 'waiting' }, { running: false, hasError: false, unread: true, prState: '' }],
    [
      'fresh success',
      { status: 'success', startedAt: at(60_000), stoppedAt: at(30_000) },
      { running: false, hasError: false, unread: false, prState: 'MERGED' },
    ],
    [
      'old success',
      { status: 'success', startedAt: at(5 * 60 * 60 * 1000), stoppedAt: at(5 * 60 * 60 * 1000) },
      { running: false, hasError: false, unread: false, prState: '' },
    ],
  ]

  const stub = await fakeN8n({
    workflows: cases.map(([name], i) => workflow({ id: `w${i}`, name })),
    executions: cases.map(([, over], i) => execution({ id: String(100 + i), workflowId: `w${i}`, ...over })),
  })
  const { harness, cleanup } = await adapterFor(stub.base)
  const byId = new Map((await harness.scanThreads()).map((t) => [t.id, t]))

  cases.forEach(([name, , want], i) => {
    const got = byId.get(`n8n:w${i}`)
    for (const [key, value] of Object.entries(want)) {
      assert.equal(got[key], value, `${name}: ${key} should be ${value}`)
    }
  })
  await stub.close()
  await cleanup()
})

test('an inactive workflow reads as dormant however recently it ran', async () => {
  const stub = await fakeN8n({
    workflows: [workflow({ id: 'off', active: false }), workflow({ id: 'on', active: true })],
    executions: [execution({ id: '1', workflowId: 'off' }), execution({ id: '2', workflowId: 'on' })],
  })
  const { harness, cleanup } = await adapterFor(stub.base)
  const byId = new Map((await harness.scanThreads()).map((t) => [t.id, t]))

  // The colony reads dormancy off `lastActivityAt` alone, so that is where it has to show up.
  assert.ok(Date.now() - byId.get('n8n:off').lastActivityAt > 3 * DAY, 'switched off reads as dormant')
  assert.ok(Date.now() - byId.get('n8n:on').lastActivityAt < 3 * DAY, 'switched on does not')
  // …and the real time survives, so nothing has actually been lost.
  assert.ok(byId.get('n8n:off').lastRunAt > Date.now() - 5 * 60_000, 'the true run time is kept')
  await stub.close()
  await cleanup()
})

test('a workflow with no execution in the window still gets a thread', async () => {
  const stub = await fakeN8n({ workflows: [workflow({ id: 'quiet' })], executions: [] })
  const { harness, cleanup } = await adapterFor(stub.base)
  const [thread] = await harness.scanThreads()
  assert.equal(thread.id, 'n8n:quiet')
  assert.equal(thread.hasError, false)
  assert.equal(thread.running, false)
  assert.equal(thread.canRetry, false)
  assert.equal(thread.canOpen, true, 'the workflow itself is still worth opening')
  await stub.close()
  await cleanup()
})

test('a live workflow with no run left on record is idle, not asleep', async () => {
  // Measured on the real instance: 40 of 58 active workflows had nothing in the window,
  // because n8n prunes history and a webhook only runs when somebody uses it. Dating those
  // from `updatedAt` put most of a working instance to sleep.
  const lastEdited = new Date(Date.now() - 90 * DAY).toISOString()
  const stub = await fakeN8n({
    workflows: [
      workflow({ id: 'live', active: true, updatedAt: lastEdited }),
      workflow({ id: 'off', active: false, updatedAt: lastEdited }),
    ],
    executions: [],
  })
  const { harness, cleanup } = await adapterFor(stub.base)
  const byId = new Map((await harness.scanThreads()).map((t) => [t.id, t]))
  const now = Date.now()

  const live = byId.get('n8n:live')
  assert.ok(now - live.lastActivityAt < 3 * DAY, 'switched on reads as awake')
  assert.equal(live.lastRunAt, 0, 'and does not invent a run that never happened')
  assert.match(live.preview, /no run left on record/i, 'the card says what is actually known')

  // Switched off is still dormant — the change is only about live ones.
  assert.ok(now - byId.get('n8n:off').lastActivityAt > 3 * DAY, 'switched off is still asleep')
  await stub.close()
  await cleanup()
})

test('an unknown-history workflow sorts below one that genuinely ran', async () => {
  // Floated to just inside the line rather than to now: claiming it was active this second
  // would push it above everything with a real run behind it, which is the opposite lie.
  const stub = await fakeN8n({
    workflows: [workflow({ id: 'unknown', active: true }), workflow({ id: 'ran', active: true })],
    executions: [
      execution({ id: '5', workflowId: 'ran', startedAt: new Date(Date.now() - 2 * DAY).toISOString(), stoppedAt: new Date(Date.now() - 2 * DAY).toISOString() }),
    ],
  })
  const { harness, cleanup } = await adapterFor(stub.base)
  const byId = new Map((await harness.scanThreads()).map((t) => [t.id, t]))
  assert.ok(
    byId.get('n8n:ran').lastActivityAt > byId.get('n8n:unknown').lastActivityAt,
    'a real run two days ago still outranks an unknown one'
  )
  assert.ok(Date.now() - byId.get('n8n:unknown').lastActivityAt < 3 * DAY, 'but the unknown one is still awake')
  await stub.close()
  await cleanup()
})

test('the newest execution wins, whatever order they arrive in', async () => {
  const now = Date.now()
  const stub = await fakeN8n({
    workflows: [workflow({ id: 'w' })],
    executions: [
      // Deliberately oldest-first: the adapter must compare rather than trust the order.
      execution({ id: '1', workflowId: 'w', status: 'error', startedAt: new Date(now - 9e5).toISOString() }),
      execution({ id: '2', workflowId: 'w', status: 'running', startedAt: new Date(now - 1e4).toISOString() }),
    ],
  })
  const { harness, cleanup } = await adapterFor(stub.base)
  const [thread] = await harness.scanThreads()
  assert.equal(thread.running, true, 'the newer run decides')
  assert.equal(thread.hasError, false)
  assert.equal(thread.ref.executionId, '2')
  await stub.close()
  await cleanup()
})

// ── open and retry ────────────────────────────────────────────────────────────

test('Open deep-links to the run, or to the workflow when there is none', async () => {
  const stub = await fakeN8n()
  const { harness, cleanup } = await adapterFor(stub.base)
  assert.deepEqual(harness.openThread({ workflowId: 'abc', executionId: '42' }), {
    ok: true,
    url: `${stub.base}/workflow/abc/executions/42`,
  })
  assert.deepEqual(harness.openThread({ workflowId: 'abc', executionId: '' }), {
    ok: true,
    url: `${stub.base}/workflow/abc`,
  })
  // A ref off the page is not trusted: ids are pattern-checked before they reach a URL.
  assert.equal(harness.openThread({ workflowId: '../../etc', executionId: '1' }).ok, false)
  assert.equal(harness.openThread({ workflowId: ['abc'], executionId: '1' }).ok, false, 'an array is not an id')
  await stub.close()
  await cleanup()
})

const ago = (n) => new Date(Date.now() - n).toISOString()
const retryPosts = (stub) => stub.seen.filter((c) => c.method === 'POST')

test('Retry posts once, to the latest failed run, and checks the ref', async () => {
  const stub = await fakeN8n({
    workflows: [workflow({ id: 'w' })],
    executions: [execution({ id: '77', workflowId: 'w', status: 'error' })],
  })
  const { harness, cleanup } = await adapterFor(stub.base)
  await harness.scanThreads()

  const malformed = await harness.retry({ workflowId: 'w', executionId: 'abc; rm -rf /' })
  assert.equal(malformed.ok, false, 'a ref naming something that is not the latest run is refused')
  const unknown = await harness.retry({ workflowId: 'other', executionId: '77' })
  assert.equal(unknown.ok, false, 'a workflow the snapshot does not know has nothing to retry')
  assert.equal(retryPosts(stub).length, 0)

  const failed = await harness.retry({ workflowId: 'w', executionId: '77' })
  assert.equal(failed.ok, true, 'a failed latest run is retried')
  assert.deepEqual(retryPosts(stub).map((c) => c.path), ['/api/v1/executions/77/retry'], 'exactly one POST')
  await stub.close()
  await cleanup()
})

test('A client-supplied execution id is never the one that is retried', async () => {
  const stub = await fakeN8n({
    workflows: [workflow({ id: 'w' })],
    executions: [
      execution({ id: '10', workflowId: 'w', status: 'error', startedAt: ago(3 * 60_000) }),
      execution({ id: '20', workflowId: 'w', status: 'error', startedAt: ago(60_000) }),
    ],
  })
  const { harness, cleanup } = await adapterFor(stub.base)
  await harness.scanThreads()

  const stale = await harness.retry({ workflowId: 'w', executionId: '10' })
  assert.equal(stale.ok, false, 'an old failure of the same workflow is refused')
  assert.equal(retryPosts(stub).length, 0, 'and nothing was posted for it')

  // No claim at all is fine: the id comes from the adapter's own snapshot.
  const bare = await harness.retry({ workflowId: 'w' })
  assert.equal(bare.ok, true)
  assert.deepEqual(retryPosts(stub).map((c) => c.path), ['/api/v1/executions/20/retry'])
  await stub.close()
  await cleanup()
})

test('Retry is refused when the latest run succeeded', async () => {
  const stub = await fakeN8n({
    workflows: [workflow({ id: 'w' })],
    executions: [
      execution({ id: '77', workflowId: 'w', status: 'error', startedAt: ago(120_000) }),
      execution({ id: '88', workflowId: 'w', status: 'success', startedAt: ago(60_000) }),
    ],
  })
  const { harness, cleanup } = await adapterFor(stub.base)
  await harness.scanThreads()
  // Neither the old failure nor the green run can be retried: the latest is not a failure.
  assert.equal((await harness.retry({ workflowId: 'w', executionId: '77' })).ok, false)
  assert.equal((await harness.retry({ workflowId: 'w', executionId: '88' })).ok, false)
  assert.equal(retryPosts(stub).length, 0)
  await stub.close()
  await cleanup()
})

test('A run that went green since the last poll is not retried', async () => {
  const executions = [execution({ id: '77', workflowId: 'w', status: 'error' })]
  const stub = await fakeN8n({ workflows: [workflow({ id: 'w' })], executions })
  const { harness, cleanup } = await adapterFor(stub.base)
  await harness.scanThreads()
  executions[0].status = 'success' // the instance moved on after the snapshot was taken
  const result = await harness.retry({ workflowId: 'w', executionId: '77' })
  assert.equal(result.ok, false)
  assert.equal(retryPosts(stub).length, 0)
  await stub.close()
  await cleanup()
})

test('A second retry while one is pending is refused', async () => {
  const stub = await fakeN8n({
    workflows: [workflow({ id: 'w' })],
    executions: [execution({ id: '77', workflowId: 'w', status: 'error' })],
  })
  const { harness, cleanup } = await adapterFor(stub.base)
  await harness.scanThreads()
  const [first, second] = await Promise.all([
    harness.retry({ workflowId: 'w', executionId: '77' }),
    harness.retry({ workflowId: 'w', executionId: '77' }),
  ])
  assert.equal(first.ok, true)
  assert.equal(second.ok, false)
  assert.match(second.error, /already in progress/)
  assert.equal(retryPosts(stub).length, 1, 'one POST, not two')
  await stub.close()
  await cleanup()
})

test('A retried run cannot be retried again, and the next scan does not block on n8n', async () => {
  const stub = await fakeN8n({
    workflows: [workflow({ id: 'w' })],
    executions: [execution({ id: '77', workflowId: 'w', status: 'error' })],
  })
  const { harness, cleanup } = await adapterFor(stub.base)
  await harness.scanThreads()
  assert.equal((await harness.retry({ workflowId: 'w', executionId: '77' })).ok, true)

  // n8n still reports the original as `error`, so the adapter has to remember.
  const again = await harness.retry({ workflowId: 'w', executionId: '77' })
  assert.equal(again.ok, false)
  assert.match(again.error, /already retried/)
  assert.equal(retryPosts(stub).length, 1)

  // Stale, not "never scanned": the poll answers from the snapshot and refreshes behind it.
  stub.seen.length = 0
  const threads = await harness.scanThreads()
  assert.equal(threads.length, 1, 'answered immediately from the last snapshot')
  await new Promise((r) => setTimeout(r, 100))
  assert.ok(stub.seen.some((c) => c.path === '/api/v1/executions'), 'and a refresh was kicked off')
  await stub.close()
  await cleanup()
})

test('A run n8n already shows as retried successfully is refused', async () => {
  const stub = await fakeN8n({
    workflows: [workflow({ id: 'w' })],
    executions: [execution({ id: '77', workflowId: 'w', status: 'error', retrySuccessId: '99' })],
  })
  const { harness, cleanup } = await adapterFor(stub.base)
  await harness.scanThreads()
  const result = await harness.retry({ workflowId: 'w', executionId: '77' })
  assert.equal(result.ok, false)
  assert.equal(retryPosts(stub).length, 0)
  await stub.close()
  await cleanup()
})

test('nothing here writes to n8n except the retry', async () => {
  const stub = await fakeN8n({ workflows: [workflow()], executions: [execution({ status: 'error' })] })
  const { harness, cleanup } = await adapterFor(stub.base)
  await harness.scanThreads()
  const writes = stub.seen.filter((c) => c.method !== 'GET')
  assert.deepEqual(writes, [], 'a scan is read-only')
  // The contract every adapter is held to: archiving is the colony's own bookkeeping.
  assert.equal(harness.setArchived, undefined)
  await stub.close()
  await cleanup()
})

// ── failure ───────────────────────────────────────────────────────────────────

test('an instance that is down costs its own threads and nothing else', async () => {
  const stub = await fakeN8n({ fail: 500 })
  const { harness, cleanup } = await adapterFor(stub.base)
  const threads = await harness.scanThreads()
  assert.deepEqual(threads, [], 'no threads, no throw')
  assert.match(await harness.diagnostic(), /500/, 'and it says why')
  await stub.close()
  await cleanup()
})

test('a rejected key says so rather than looking like an empty instance', async () => {
  const stub = await fakeN8n({ fail: 401 })
  const { harness, cleanup } = await adapterFor(stub.base)
  await harness.scanThreads()
  assert.match(await harness.diagnostic(), /API key was rejected/)
  await stub.close()
  await cleanup()
})
