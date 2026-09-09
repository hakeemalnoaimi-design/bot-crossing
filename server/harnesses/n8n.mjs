/**
 * Harness adapter: n8n — the workflows, not the agent sessions.
 *
 * The first harness here that is not a program on this machine. Everything else reads files
 * under the user's own home directory; this one reads an HTTP API over the network, and that
 * changes three things about how an adapter has to behave:
 *
 *   - **It cannot answer synchronously.** `scanThreads()` runs on a 15-second poll and must
 *     never hold it open waiting on a server, so this keeps a snapshot and refreshes it in the
 *     background. Only the very first scan waits, because the alternative is an empty map for
 *     the first quarter of a minute, which reads as broken.
 *   - **It has a secret.** The API key is read from `.env` and never leaves this process. It
 *     is not in the thread, not in `ref`, not in the harness status, and not in the deep link
 *     the page is handed — a `ref` makes a round trip through the browser on every action.
 *   - **It has a write.** Retry is the one thing in this whole project that changes something
 *     in somebody else's system, and it exists because a failed workflow you cannot restart is
 *     a notification rather than a control. It is opt-in per thread (`canRetry`), it only ever
 *     targets an execution that actually failed, and it is the *only* write — archiving stays
 *     in `data/colony.json` like every other harness, and nothing here edits a workflow.
 *
 * ## The mapping
 *
 * | n8n                          | colony                                    |
 * | ---------------------------- | ----------------------------------------- |
 * | one workflow                 | one thread                                |
 * | its first tag                | the zone, falling back to `Internal`      |
 * | newest execution `running`   | `running` — hammering                     |
 * | newest execution errored     | `hasError` — slumped, `!` badge           |
 * | newest execution `waiting`   | `unread` — `?` badge                      |
 * | success under an hour old    | `prState: 'MERGED'` — cheering            |
 * | success older than that      | nothing set — pottering                   |
 * | inactive, or quiet for 3 days| an old `lastActivityAt` — asleep          |
 * | active with no run on record | just inside the line — pottering          |
 *
 * The colony decides behaviour from those flags in `statusFor`, in one ordered function that
 * every harness feeds. Nothing about n8n reaches the renderer.
 *
 * ## Verified against a live instance
 *
 * Field names were checked against n8n.botsbay.app rather than taken from the docs:
 *
 *   - workflows: `id`, `name`, `active`, `isArchived`, `tags[]`, `createdAt`, `updatedAt`
 *   - executions: `id`, `workflowId`, `status`, `mode`, `startedAt`, `stoppedAt`, `waitTill`
 *   - statuses seen: `success`, `error`, `crashed`, `running`, `waiting`, `canceled`, `new`
 *
 * Two things that instance taught us. `active` really is the activation flag — a sample of
 * old drafts all read `false` and only a workflow that was genuinely running read `true`, so
 * it is safe to trust. And `tags` was empty on every workflow inspected, which means zones
 * will all be `Internal` until tags are added: the fallback is doing real work, not covering
 * an edge case.
 */
import { env, envNumber } from '../lib/env.mjs'

const BASE_URL = () => env('N8N_BASE_URL').replace(/\/+$/, '')
const API_KEY = () => env('N8N_API_KEY')
/** How often the snapshot is allowed to go stale. The colony polls faster than this. */
const POLL_MS = () => envNumber('N8N_POLL_SECONDS', 15, 1) * 1000

/**
 * n8n's public API caps a page at 250, which is what the two calls ask for. On a busy
 * instance 250 executions can be under an hour of history, so a workflow whose last run
 * fell off the end reports no execution at all and lands as dormant. That is usually the
 * right answer — a workflow that has not run inside the window is not doing anything — but
 * `N8N_EXECUTION_PAGES` buys more history for an instance where it is not.
 */
const PAGE_SIZE = 250
const WORKFLOW_PAGES = () => envNumber('N8N_WORKFLOW_PAGES', 4, 1)
const EXECUTION_PAGES = () => envNumber('N8N_EXECUTION_PAGES', 1, 1)

/** A run that finished this recently is still worth cheering about. */
const FRESH_SUCCESS_MS = 60 * 60 * 1000
/** The colony's own dormancy line. Matched here so "inactive" lands on the same behaviour. */
const STALE_MS = 3 * 24 * 60 * 60 * 1000
/**
 * How old a live workflow with no execution on record claims to be: an hour inside the
 * dormancy line, so it reads as idle and still sorts below anything that genuinely ran.
 *
 * The hour of slack is not decoration. `lastActivityAt` is stamped when the snapshot refreshes
 * and compared against the clock when the colony draws, so a value sitting exactly on the line
 * would tip over into "asleep" between the two — a building that dozed off because a poll was
 * slow, and woke up on the next one.
 */
const AWAKE_BUT_UNKNOWN_MS = STALE_MS - 60 * 60 * 1000

/** Long enough for a slow instance, short enough that the colony never waits on a dead host. */
const REQUEST_TIMEOUT_MS = 10000

const ID = (workflowId) => `n8n:${workflowId}`

/**
 * n8n ids are alphanumeric, and they arrive back from the page inside `ref`. Everything that
 * reaches a URL is checked against this first — the page got them from a scan that may be
 * minutes stale, and a `ref` is the one part of a thread nothing in between ever inspects.
 * `RegExp.test` stringifies, so the type check matters: `['abc']` would otherwise pass.
 */
const WORKFLOW_ID = /^[A-Za-z0-9_-]{1,64}$/
const EXECUTION_ID = /^[0-9]{1,20}$/
const isWorkflowId = (v) => typeof v === 'string' && WORKFLOW_ID.test(v)
const isExecutionId = (v) => typeof v === 'string' && EXECUTION_ID.test(v)

// ── talking to n8n ────────────────────────────────────────────────────────────────────

/**
 * One call. Errors carry the status but never the body: an n8n error page can echo the
 * request back, and this message ends up in a log and on the harness list in the UI.
 */
async function call(path, { method = 'GET', signal } = {}) {
  const base = BASE_URL()
  const key = API_KEY()
  if (!base || !key) throw new Error('N8N_BASE_URL and N8N_API_KEY are not set')

  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'X-N8N-API-KEY': key, accept: 'application/json' },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  if (!res.ok) {
    const why = res.status === 401 ? 'the API key was rejected' : `n8n answered ${res.status}`
    throw new Error(why)
  }
  return res.json()
}

/**
 * Walk a paged collection. n8n hands back `{ data, nextCursor }`, and older builds hand back
 * a bare array — both are accepted, because the shape is not worth a version check.
 */
async function collect(path, pages) {
  const out = []
  let cursor = ''
  for (let page = 0; page < pages; page++) {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) })
    if (cursor) query.set('cursor', cursor)
    const body = await call(`${path}?${query}`)
    const rows = Array.isArray(body) ? body : (body?.data ?? [])
    out.push(...rows)
    cursor = (Array.isArray(body) ? '' : body?.nextCursor) || ''
    if (!cursor || rows.length < PAGE_SIZE) break
  }
  return out
}

// ── shaping ───────────────────────────────────────────────────────────────────────────

const ms = (value) => {
  const t = Date.parse(value || '')
  return Number.isNaN(t) ? 0 : t
}

/**
 * The zone. n8n's tags are objects — `{ id, name }` — but a build that hands back bare
 * strings is not worth failing over, so both are read.
 */
function zoneOf(workflow) {
  for (const tag of workflow.tags || []) {
    const name = (typeof tag === 'string' ? tag : tag?.name || '').trim()
    if (name) return name
  }
  return 'Internal'
}

/**
 * Newest execution per workflow.
 *
 * n8n returns executions newest first, so the first one seen for a workflow is its latest —
 * but that is a property of the endpoint rather than a guarantee, and getting it backwards
 * would show a week-old failure over this morning's success. Compared on `startedAt` instead,
 * which costs nothing and cannot be wrong.
 */
function latestPerWorkflow(executions) {
  const byWorkflow = new Map()
  for (const execution of executions) {
    const id = execution?.workflowId
    if (!id) continue
    const previous = byWorkflow.get(id)
    if (!previous || ms(execution.startedAt) > ms(previous.startedAt)) byWorkflow.set(id, execution)
  }
  return byWorkflow
}

/** n8n's own word for "this run failed". `canceled` is deliberately not one of them. */
const FAILED = new Set(['error', 'crashed'])

function toThread(workflow, execution, now) {
  const status = execution?.status || ''
  const failed = FAILED.has(status)
  const running = status === 'running' || status === 'new'
  const waiting = status === 'waiting'
  const succeeded = status === 'success'

  const ranAt = ms(execution?.stoppedAt) || ms(execution?.startedAt)
  const touched = ranAt || ms(workflow.updatedAt) || ms(workflow.createdAt)

  /**
   * Dormancy, which the colony works out from `lastActivityAt` alone — so this is where the
   * two cases the flag cannot express have to be said. Both are deliberate, and both are the
   * lesser of two wrong pictures. `lastRunAt` keeps the true time in either direction.
   *
   * **Switched off is dormant, however recently it ran.** Reported as the older of when it
   * really last ran and the far side of the three-day line, because a switched-off workflow
   * pottering about its plot looks exactly like a working one — the single most misleading
   * thing this map could do.
   *
   * **Switched on with nothing on record is idle, not asleep.** Measured against the live
   * instance, 40 of 58 active workflows had no execution left to read: n8n prunes history,
   * and a webhook that fires when somebody uses it can be perfectly healthy and have nothing
   * in the window. Falling back to `updatedAt` dated those from whenever the workflow was
   * last *edited*, which put most of a working instance to sleep. So they are floated to just
   * inside the line: awake, and sorted below everything with a real run behind it, which is
   * exactly what is known about them.
   */
  const dormant = !workflow.active
  const unknown = workflow.active && !ranAt
  const lastActivityAt = dormant
    ? Math.min(touched, now - STALE_MS - 60_000)
    : unknown
      ? now - AWAKE_BUT_UNKNOWN_MS
      : touched

  return {
    id: ID(workflow.id),
    title: workflow.name || 'Untitled workflow',
    preview: execution
      ? `Last run ${status}${ranAt ? ` — ${new Date(ranAt).toISOString()}` : ''}`
      : dormant
        ? 'Switched off in n8n'
        : 'Switched on — no run left on record',
    project: zoneOf(workflow),
    // A workflow is not a checkout: there is no folder to reveal and no branch to name. The
    // fields stay present and empty rather than absent, so nothing downstream has to ask.
    projectPath: '',
    worktree: '',
    cwd: '',
    gitBranch: '',
    model: '',
    effort: '',
    createdAt: ms(workflow.createdAt),
    lastActivityAt,
    lastFocusedAt: 0,

    // The six states, in the flags the colony reads. Only one of these is ever true at once
    // because n8n's statuses are exclusive, which keeps `statusFor`'s precedence honest.
    running,
    unread: waiting,
    hasError: failed,
    prState: succeeded && now - ranAt < FRESH_SUCCESS_MS ? 'MERGED' : '',

    starred: false,
    routine: '',
    /** n8n's own archive flag, reported and never written — same contract as every adapter. */
    archived: Boolean(workflow.isArchived),
    hasTranscript: false,
    /**
     * How built-up the structure looks. A workflow has no transcript, so this stands in with
     * how much of one there is to run: a two-node webhook should not look like a fifty-node
     * pipeline. Scaled into the same range a real transcript lands in.
     */
    sizeBytes: Math.max(1, Number(workflow.triggerCount) || 1) * 24 * 1024,
    source: workflow.active ? 'active' : 'inactive',
    canOpen: true,
    /** Retry is offered only where there is a failed run to retry. */
    canRetry: failed && isExecutionId(String(execution?.id ?? '')),
    /** True time of the last run, kept even where `lastActivityAt` was pushed back. */
    lastRunAt: ranAt,
    ref: {
      workflowId: String(workflow.id),
      executionId: execution?.id != null ? String(execution.id) : '',
    },
  }
}

// ── the snapshot ──────────────────────────────────────────────────────────────────────

let snapshot = { threads: [], at: 0 }
let inFlight = null
let lastError = ''

async function refresh() {
  const [workflows, executions] = await Promise.all([
    collect('/api/v1/workflows', WORKFLOW_PAGES()),
    collect('/api/v1/executions', EXECUTION_PAGES()),
  ])
  const latest = latestPerWorkflow(executions)
  const now = Date.now()
  const threads = workflows
    .filter((w) => w && w.id != null)
    .map((w) => toThread(w, latest.get(w.id) || latest.get(String(w.id)) || null, now))
  snapshot = { threads, at: now }
  lastError = ''
  return threads
}

/**
 * Refresh at most one at a time, and never let a failure take the scan with it: a stale
 * snapshot is a far better answer than an empty colony every time the network hiccups.
 */
function refreshOnce() {
  if (inFlight) return inFlight
  inFlight = refresh()
    .catch((err) => {
      lastError = err?.message || String(err)
      // Keep whatever was last known good. `lastError` is what the harness list shows.
      return snapshot.threads
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

// ── the adapter ───────────────────────────────────────────────────────────────────────

/** Configured at all? Nothing here touches the network — this runs on every poll. */
const detect = async () => Boolean(BASE_URL() && API_KEY())

async function scanThreads() {
  const fresh = Date.now() - snapshot.at < POLL_MS()
  // The first scan waits, because there is nothing to show yet. Every scan after it gets the
  // snapshot immediately and lets the refresh land in the background — the poll is never held
  // open on a network call.
  if (!snapshot.at) return refreshOnce()
  if (!fresh) refreshOnce()
  return snapshot.threads
}

/**
 * Deep-links to the run itself where there is one, and to the workflow where there is not —
 * a workflow with no execution in the window still has an editor worth opening.
 */
function openThread(ref) {
  const base = BASE_URL()
  if (!base) return { ok: false, error: 'N8N_BASE_URL is not set' }
  const { workflowId, executionId } = ref || {}
  if (!isWorkflowId(workflowId)) return { ok: false, error: 'That thread has no n8n workflow id' }
  const url = isExecutionId(executionId)
    ? `${base}/workflow/${workflowId}/executions/${executionId}`
    : `${base}/workflow/${workflowId}`
  return { ok: true, url }
}

/** There is no "new workflow rooted at a folder": n8n does not work that way. */
function newSession() {
  return { ok: false, error: 'n8n workflows are created in n8n, not from a folder on this machine' }
}

/**
 * Ask n8n to run a failed execution again. The one write in the project.
 *
 * Both ids are pattern-checked before they reach the URL, and the execution is re-read first
 * so that a `ref` from a stale scan cannot retry something that has since succeeded — the
 * button is drawn from a poll that may be a quarter of a minute old, and "retry" on a run
 * that is now green would silently start work nobody asked for.
 */
async function retry(ref) {
  const { workflowId, executionId } = ref || {}
  if (!isWorkflowId(workflowId) || !isExecutionId(executionId)) {
    return { ok: false, error: 'That thread has no failed n8n execution to retry' }
  }
  let current
  try {
    current = await call(`/api/v1/executions/${executionId}`)
  } catch (err) {
    return { ok: false, error: `Could not read that execution — ${err?.message || err}` }
  }
  if (String(current?.workflowId ?? '') !== workflowId) {
    return { ok: false, error: 'That execution does not belong to that workflow' }
  }
  if (!FAILED.has(current?.status)) {
    return { ok: false, error: `That run is ${current?.status || 'no longer failed'} — nothing to retry` }
  }
  try {
    await call(`/api/v1/executions/${executionId}/retry`, { method: 'POST' })
  } catch (err) {
    return { ok: false, error: `n8n refused the retry — ${err?.message || err}` }
  }
  // The colony should show the new run rather than the old failure, so drop the snapshot.
  snapshot = { threads: snapshot.threads, at: 0 }
  return { ok: true, message: `Retrying execution ${executionId}` }
}

/** Why the list is empty, when it is. Shown in the harness list rather than swallowed. */
async function diagnostic() {
  if (!BASE_URL()) return 'N8N_BASE_URL is not set in .env'
  if (!API_KEY()) return 'N8N_API_KEY is not set in .env'
  return lastError
}

export default {
  id: 'n8n',
  name: 'n8n',
  detect,
  scanThreads,
  openThread,
  newSession,
  retry,
  diagnostic,
  /** Test seam: the snapshot is module state, and a test needs to start from nothing. */
  _reset: () => {
    snapshot = { threads: [], at: 0 }
    inFlight = null
    lastError = ''
  },
  _shape: { toThread, latestPerWorkflow, zoneOf },
}
