/**
 * The Claude Code adapter against a fake home: desktop session records plus CLI transcripts.
 *
 * Every fixture gets a fresh temp HOME and a fresh import of the adapter (it resolves its paths at
 * import time), with every env var that moves those paths pointed inside the temp dir. A guard
 * refuses to run if the adapter's paths would land anywhere else.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const CLI = U(1)
const DESK = (n) => `local_${U(n)}`
const NOW = () => Date.now()
const iso = (ms) => new Date(ms).toISOString()

let seq = 0
async function fixture() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'cc-fixture-'))
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
  })
  const mod = await import(`../server/harnesses/claude-code.mjs?cc${++seq}`)
  const h = mod.default
  for (const p of Object.values(h.paths)) {
    assert.ok(p.startsWith(home), `adapter path ${p} escaped the fixture home`)
  }

  return {
    h,
    home,
    /** Write a transcript; `records` are objects (or raw strings). Returns its file path. */
    async transcript(id, records, { dir = '-work-demo', mtime } = {}) {
      const d = path.join(h.paths.CLI_PROJECTS, dir)
      await fsp.mkdir(d, { recursive: true })
      const file = path.join(d, `${id}.jsonl`)
      await fsp.writeFile(file, records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n')
      if (mtime) await fsp.utimes(file, new Date(mtime), new Date(mtime))
      return file
    },
    async desktop(sessionId, rec, { account = 'acct', org = 'org' } = {}) {
      const d = path.join(h.paths.DESKTOP_SESSIONS, account, org)
      await fsp.mkdir(d, { recursive: true })
      await fsp.writeFile(path.join(d, `${sessionId}.json`), JSON.stringify({ sessionId, ...rec }))
    },
    async live(sessionId, pid = process.pid) {
      await fsp.mkdir(h.paths.CLI_LIVE, { recursive: true })
      await fsp.writeFile(path.join(h.paths.CLI_LIVE, `${pid}-${sessionId}.json`), JSON.stringify({ pid, sessionId }))
    },
    scan: () => h.scanThreads(),
    done: () => fsp.rm(home, { recursive: true, force: true }),
  }
}

const user = (text, extra = {}) => ({ type: 'user', timestamp: iso(NOW() - 60_000), message: { content: text }, ...extra })
const asst = (content, stop_reason) => ({ type: 'assistant', message: { content, stop_reason } })
const toolUse = [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]
const said = [{ type: 'text', text: 'Which one do you want?' }]

// ── a CLI transcript on its own ───────────────────────────────────────────────

test('a terminal-only transcript becomes a prefixed thread with derived title, project and cwd', async () => {
  const f = await fixture()
  await f.transcript(CLI, [
    user('<system-reminder>ignore me</system-reminder>fix the login bug', { cwd: '/work/demo-app', gitBranch: 'feature/x' }),
    asst(said, 'end_turn'),
  ])
  const threads = await f.scan()
  assert.equal(threads.length, 1)
  const [t] = threads
  assert.equal(t.id, `claude-code:${CLI}`)
  assert.equal(t.title, 'fix the login bug', 'prompt wrappers are stripped')
  assert.equal(t.preview, 'fix the login bug')
  assert.equal(t.project, 'demo-app')
  assert.equal(t.projectPath, '/work/demo-app')
  assert.equal(t.cwd, '/work/demo-app')
  assert.equal(t.gitBranch, 'feature/x')
  assert.equal(t.source, 'cli')
  assert.equal(t.hasTranscript, true)
  assert.ok(t.sizeBytes > 0)
  assert.equal(t.canOpen, true)
  assert.equal(t.ref.cliSessionId, CLI)
  assert.equal(t.ref.desktopSessionId, '')
  assert.equal(t.archived, false)
  assert.equal(t.hasError, false)
  assert.equal(t.running, false)
  assert.equal(t.unread, false, 'terminal-only threads have no focus history, so are never unread')
  await f.done()
})

test('title precedence is custom > ai > summary > first prompt', async () => {
  const f = await fixture()
  const base = { cwd: '/work/p' }
  await f.transcript(U(10), [user('first prompt', base), { customTitle: 'Custom', aiTitle: 'AI' }, { type: 'summary', summary: 'Sum' }])
  await f.transcript(U(11), [user('first prompt', base), { aiTitle: 'AI' }, { type: 'summary', summary: 'Sum' }])
  await f.transcript(U(12), [user('first prompt', base), { type: 'summary', summary: 'Sum' }])
  await f.transcript(U(13), [user('first prompt', base)])
  await f.transcript(U(14), [{ type: 'progress', cwd: '/work/p' }])
  const byId = Object.fromEntries((await f.scan()).map((t) => [t.id, t.title]))
  assert.equal(byId[`claude-code:${U(10)}`], 'Custom')
  assert.equal(byId[`claude-code:${U(11)}`], 'AI')
  assert.equal(byId[`claude-code:${U(12)}`], 'Sum')
  assert.equal(byId[`claude-code:${U(13)}`], 'first prompt')
  assert.equal(byId[`claude-code:${U(14)}`], 'Untitled thread')
  await f.done()
})

test('a worktree cwd belongs to the repo it hangs off, either separator', async () => {
  const f = await fixture()
  await f.transcript(U(20), [user('a', { cwd: '/code/repo/.claude/worktrees/feat-abc' })])
  await f.transcript(U(21), [user('b', { cwd: String.raw`C:\code\repo2\.claude\worktrees\feat-def` })])
  const byId = Object.fromEntries((await f.scan()).map((t) => [t.id, t]))
  const a = byId[`claude-code:${U(20)}`]
  assert.equal(a.project, 'repo')
  assert.equal(a.worktree, 'feat-abc')
  assert.equal(a.projectPath, '/code/repo')
  assert.equal(a.cwd, '/code/repo/.claude/worktrees/feat-abc', 'cwd stays the worktree, for resuming')
  const b = byId[`claude-code:${U(21)}`]
  assert.equal(b.worktree, 'feat-def')
  assert.equal(b.projectPath, String.raw`C:\code\repo2`)
  await f.done()
})

test('with no cwd in the transcript the project folder name is decoded', async () => {
  const f = await fixture()
  await f.transcript(U(30), [user('hi')], { dir: '-Users-me-Some-Dir' })
  await f.transcript(U(31), [user('hi')], { dir: 'C--Users-me-Proj' })
  const byId = Object.fromEntries((await f.scan()).map((t) => [t.id, t]))
  assert.equal(byId[`claude-code:${U(30)}`].cwd, '/Users/me/Some/Dir')
  assert.equal(byId[`claude-code:${U(31)}`].cwd, String.raw`C:\Users\me\Proj`)
  if (process.platform === 'win32') assert.equal(byId[`claude-code:${U(31)}`].project, 'Proj')
  await f.done()
})

test('malformed transcript lines and corrupt desktop records are skipped, not fatal', async () => {
  const f = await fixture()
  await f.transcript(U(40), ['not json', '{"half":', user('survivor', { cwd: '/work/ok' })])
  const dir = path.join(f.h.paths.DESKTOP_SESSIONS, 'acct', 'org')
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, `${DESK(41)}.json`), '{"sessionId": ')
  await fsp.writeFile(path.join(dir, 'notes.json'), '{}')
  const threads = await f.scan()
  assert.equal(threads.length, 1)
  assert.equal(threads[0].title, 'survivor')
  await f.done()
})

// ── desktop records ───────────────────────────────────────────────────────────

test('a desktop record and its CLI transcript merge into one thread', async () => {
  const f = await fixture()
  const t0 = NOW() - 2 * 3600_000
  await f.transcript(CLI, [user('typed prompt', { cwd: '/work/demo', gitBranch: 'main' }), asst(said, 'end_turn')], { mtime: t0 })
  await f.desktop(DESK(2), {
    cliSessionId: CLI,
    title: 'Desktop title',
    cwd: '/work/demo',
    model: 'claude-x',
    effort: 'high',
    createdAt: t0 - 1000,
    lastActivityAt: t0,
    lastFocusedAt: t0 + 5000,
    isStarred: true,
    prState: 'open',
    scheduledTaskId: 'sched-1',
  })
  const threads = await f.scan()
  assert.equal(threads.length, 1, 'one conversation, one thread')
  const [t] = threads
  assert.equal(t.id, `claude-code:${CLI}`, 'canonical id is the transcript uuid')
  assert.equal(t.title, 'Desktop title', 'the app title wins over the prompt')
  assert.equal(t.preview, 'typed prompt')
  assert.equal(t.source, 'desktop')
  assert.equal(t.hasTranscript, true)
  assert.equal(t.model, 'claude-x')
  assert.equal(t.effort, 'high')
  assert.equal(t.gitBranch, 'main')
  assert.equal(t.starred, true)
  assert.equal(t.prState, 'open')
  assert.equal(t.routine, 'sched-1')
  assert.equal(t.canOpen, true)
  assert.equal(t.ref.desktopSessionId, DESK(2))
  assert.equal(t.ref.cliSessionId, CLI)
  assert.deepEqual(t.ref.desktopSessionIds, [DESK(2)])
  assert.equal(t.unread, false, 'focused after the last activity')
  // the private bookkeeping does not leak out
  for (const k of ['titled', 'hasLiveProcess', 'transcriptFile', 'recordActivityAt', 'desktopSessionId']) {
    assert.equal(k in t, false, `${k} is not part of the thread shape`)
  }
  await f.done()
})

test('flags come from the desktop record: archived, error, unread', async () => {
  const f = await fixture()
  const old = NOW() - 3 * 3600_000
  const mk = async (n, rec) => {
    await f.transcript(U(n), [user('x', { cwd: '/work/p' })], { mtime: old })
    await f.desktop(DESK(n), { cliSessionId: U(n), title: `T${n}`, cwd: '/work/p', createdAt: old, ...rec })
  }
  await mk(50, { isArchived: true })
  await mk(51, { isArchived: 'True' })
  await mk(52, { isArchived: 'false' })
  await mk(53, { error: 'rate limited' })
  await mk(54, { lastActivityAt: old, lastFocusedAt: old - 10_000 })
  await mk(55, { lastActivityAt: old, lastFocusedAt: old + 10_000 })
  await mk(56, { lastActivityAt: old, lastFocusedAt: 0 })
  const by = Object.fromEntries((await f.scan()).map((t) => [t.title, t]))
  assert.equal(by.T50.archived, true)
  assert.equal(by.T51.archived, true)
  assert.equal(by.T52.archived, false)
  assert.equal(by.T53.hasError, true)
  assert.equal(by.T50.hasError, false)
  assert.equal(by.T54.unread, true, 'moved on after you last looked')
  assert.equal(by.T55.unread, false)
  assert.equal(by.T56.unread, true, 'never opened counts as unread')
  await f.done()
})

test('two desktop records for one transcript fold together; archived only if both are', async () => {
  const f = await fixture()
  const old = NOW() - 3 * 3600_000
  await f.transcript(CLI, [user('x', { cwd: '/work/p' })], { mtime: old })
  await f.desktop(DESK(3), { cliSessionId: CLI, title: 'Real', cwd: '/work/p', createdAt: old, isArchived: true })
  await f.desktop(DESK(4), { cliSessionId: CLI, cwd: '/work/p', createdAt: old + 1, isArchived: false })
  const threads = await f.scan()
  assert.equal(threads.length, 1)
  const [t] = threads
  assert.equal(t.title, 'Real')
  assert.equal(t.ref.desktopSessionId, DESK(3), 'the titled record is the canonical one')
  assert.deepEqual([...t.ref.desktopSessionIds].sort(), [DESK(3), DESK(4)].sort())
  assert.equal(t.archived, false, 'one live twin keeps the thread on the map')
  await f.done()
})

test('ghost records are filtered; new, titled or live ones are kept', async () => {
  const f = await fixture()
  const old = NOW() - 5 * 3600_000
  await f.desktop(DESK(60), { cwd: '/work/g', createdAt: old, lastActivityAt: old }) // ghost
  await f.desktop(DESK(61), { cwd: '/work/g', createdAt: NOW() - 1000, lastActivityAt: NOW() - 1000 }) // brand new
  await f.desktop(DESK(62), { cwd: '/work/g', title: 'Titled, no transcript', createdAt: old, lastActivityAt: old })
  await f.desktop(DESK(63), { cliSessionId: U(63), cwd: '/work/g', createdAt: old, lastActivityAt: old }) // live process only
  await f.live(U(63))
  const ids = (await f.scan()).map((t) => t.ref.desktopSessionId).sort()
  assert.deepEqual(ids, [DESK(61), DESK(62), DESK(63)].sort())
  await f.done()
})

// ── running / awaiting reply ──────────────────────────────────────────────────

test('running needs a live pid, recent activity, and a turn that is not handed back', async () => {
  const f = await fixture()
  const stale = NOW() - 2 * 3600_000
  const cwd = '/work/r'
  await f.transcript(U(70), [user('go', { cwd }), asst(toolUse, 'tool_use')]) // mid-turn
  await f.transcript(U(71), [user('go', { cwd }), asst(said, 'end_turn')]) // asked a question
  await f.transcript(U(72), [user('go', { cwd }), asst(toolUse, 'tool_use')], { mtime: stale }) // idle for hours
  await f.transcript(U(73), [user('go', { cwd }), asst(toolUse, 'tool_use')]) // no process
  await f.transcript(U(74), [user('go', { cwd }), asst(toolUse, 'tool_use'), user('tool result')]) // model speaks next
  await f.transcript(U(75), [user('go', { cwd }), asst(toolUse, 'tool_use')]) // stale registry entry
  for (const n of [70, 71, 72, 74]) await f.live(U(n), process.pid)
  await f.live(U(75), 2 ** 30)
  const by = Object.fromEntries((await f.scan()).map((t) => [t.id, t]))
  const T = (n) => by[`claude-code:${U(n)}`]

  assert.equal(T(70).running, true)
  assert.equal(T(70).unread, false)

  assert.equal(T(71).running, false, 'waiting on you is not working')
  assert.equal(T(71).unread, true, 'and it wants you, even with no desktop record')

  assert.equal(T(72).running, false, 'a warmed idle process is not activity')
  assert.equal(T(73).running, false)
  assert.equal(T(74).running, true)
  assert.equal(T(75).running, false, 'a pid that is gone does not count')
  await f.done()
})

// ── cache ─────────────────────────────────────────────────────────────────────

test('the transcript meta cache is invalidated when the file changes', async () => {
  const f = await fixture()
  const t0 = NOW() - 3600_000
  const file = await f.transcript(CLI, [user('original prompt', { cwd: '/work/c' })], { mtime: t0 })
  assert.equal((await f.scan())[0].title, 'original prompt')
  assert.equal((await f.scan())[0].title, 'original prompt', 'unchanged file, same answer')

  await fsp.writeFile(file, JSON.stringify(user('changed prompt', { cwd: '/work/c' })) + '\n')
  await fsp.utimes(file, new Date(t0 + 10_000), new Date(t0 + 10_000))
  const [t] = await f.scan()
  assert.equal(t.title, 'changed prompt', 'a new mtime means a re-read')
  assert.equal(t.lastActivityAt, t0 + 10_000)
  await f.done()
})

test('a deleted transcript drops its thread on the next scan', async () => {
  const f = await fixture()
  const file = await f.transcript(CLI, [user('x', { cwd: '/work/d' })])
  assert.equal((await f.scan()).length, 1)
  await fsp.rm(file)
  assert.equal((await f.scan()).length, 0)
  await f.done()
})

// ── absent install ────────────────────────────────────────────────────────────

test('no .claude directory and no desktop app: not detected, empty scan, no throw', async () => {
  const f = await fixture()
  assert.equal(await f.h.detect(), false)
  assert.deepEqual(await f.scan(), [])
  await f.done()
})

test('either store alone is enough to be detected', async () => {
  const a = await fixture()
  await fsp.mkdir(a.h.paths.CLI_PROJECTS, { recursive: true })
  assert.equal(await a.h.detect(), true)
  await a.done()
  const b = await fixture()
  await fsp.mkdir(b.h.paths.DESKTOP_SESSIONS, { recursive: true })
  assert.equal(await b.h.detect(), true)
  await b.done()
})

// ── opening ───────────────────────────────────────────────────────────────────

test('openThread builds deep links from validated ids, preferring the desktop record', async () => {
  const f = await fixture()
  const both = await f.h.openThread({ desktopSessionId: DESK(5), cliSessionId: CLI })
  assert.equal(both.url, `claude://claude.ai/epitaxy/${DESK(5)}`)
  const cli = await f.h.openThread({ cliSessionId: CLI, cwd: '/x' })
  assert.equal(cli.url, `claude://resume?session=${CLI}`)
  assert.equal((await f.h.openThread({ cliSessionId: 'nope; rm -rf /' })).ok, false)
  assert.equal((await f.h.openThread(null)).ok, false)
  const fresh = await f.h.newSession('/work/my repo')
  assert.equal(fresh.ok, true)
  assert.equal(new URL(fresh.url).searchParams.get('folder'), '/work/my repo')
  await f.done()
})
