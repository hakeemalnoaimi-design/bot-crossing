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
 *     the first quarter of a minute, which reads as broken. "Very first" means first *attempt*:
 *     if it fails, the next poll answers from what there is and the host is left to recover.
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
 *   - `GET /executions?status=error` filters; `status=crashed` is silently ignored and returns
 *     everything, so crashes are read from the window instead. `workflowId=<id>&limit=1` filters.
 *   - `excludePinnedData=true` is accepted on `/workflows` but node graphs still come back, so
 *     the saving is mostly in how rarely the list is read, not in what is left out of it.
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
 * How often the workflow list is re-read. It is the heavy call — every node graph of every
 * workflow, ~279 of them — and it changes when somebody edits n8n, not when a run finishes.
 * Executions are what move, and they stay on `N8N_POLL_SECONDS`.
 */
const WORKFLOW_REFRESH_MS = () => envNumber('N8N_WORKFLOW_REFRESH_SECONDS', 300, 1) * 1000
/** How long a per-workflow "latest run" lookup is trusted before it is asked again. */
const LOOKUP_MS = () => envNumber('N8N_LOOKUP_MINUTES', 10, 1) * 60 * 1000

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

/**
 * Per-workflow lookups, for live workflows that neither the window nor the error list saw. At
 * most four in flight and sixteen per refresh, so a poll never turns into dozens of requests at
 * once: a gap of fifty workflows fills over a handful of polls and then sits in the cache.
 */
const LOOKUP_CONCURRENCY = 4
const LOOKUP_PER_REFRESH = 16

/** Backoff after a failed call: exponential from the poll interval, never past this. */
const BACKOFF_MAX_MS = 5 * 60 * 1000
/** A `Retry-After` is honoured, but a host asking for an hour does not get to blind the map. */
const RETRY_AFTER_MAX_MS = 10 * 60 * 1000

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
    // The status and any `Retry-After` ride on the error so the caller can back off. The body
    // still does not.
    throw Object.assign(new Error(why), {
      status: res.status,
      retryAfterMs: retryAfterMs(res.headers.get('retry-after')),
    })
  }
  return res.json()
}

/** `Retry-After` is whole seconds or an HTTP date. Anything else is no hint at all. */
function retryAfterMs(header) {
  if (!header) return null
  const seconds = Number(header)
  const wait = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now()
  return Number.isFinite(wait) && wait >= 0 ? Math.min(wait, RETRY_AFTER_MAX_MS) : null
}

/**
 * Walk a paged collection. n8n hands back `{ data, nextCursor }`, and older builds hand back
 * a bare array — both are accepted, because the shape is not worth a version check.
 *
 * `more` is true when the last page allowed still had a cursor behind it: the collection goes
 * on past what was read, which is worth saying out loud rather than leaving as a silent cut-off.
 */
async function collect(path, pages, params = {}) {
  const rows = []
  let cursor = ''
  let full = false
  for (let page = 0; page < pages; page++) {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE), ...params })
    if (cursor) query.set('cursor', cursor)
    const body = await call(`${path}?${query}`)
    const got = Array.isArray(body) ? body : (body?.data ?? [])
    rows.push(...got)
    cursor = (Array.isArray(body) ? '' : body?.nextCursor) || ''
    full = got.length >= PAGE_SIZE
    if (!cursor || !full) break
  }
  return { rows, more: Boolean(cursor) && full }
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

function toThread(workflow, execution, now, staleSince = null) {
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
    /** True time of the last run, kept even where `lastActivityAt` was pushed back. `null` = none seen. */
    lastRunAt: ranAt || null,
    /** When this was last read successfully, if what is shown is older than the latest attempt. */
    staleSince,
    ref: {
      workflowId: String(workflow.id),
      executionId: execution?.id != null ? String(execution.id) : '',
    },
  }
}

// ── the snapshot ──────────────────────────────────────────────────────────────────────

/**
 * `at` is when a refresh was last *attempted* — success or failure — because that is what the
 * poll compares against. It used to stay 0 until one succeeded, which made every poll against a
 * dead host wait out the ten-second timeout, Claude Code's threads included.
 */
let snapshot = { threads: [], at: 0 }
let inFlight = null
let attempted = false
let lastError = ''

/** What the last successful refresh read, kept so a failed one can still be drawn from it. */
let model = { workflows: [], latest: new Map(), okAt: 0, cut: { workflows: false, executions: false } }
let workflowCache = { rows: [], more: false, at: 0 }
/** workflowId -> { at, execution } from the per-workflow lookup. `execution` is null for "no run". */
const lookups = new Map()
let looking = false
let lookupError = ''
/** Consecutive failures, and the earliest the next call to n8n may be made. */
let streak = 0
let backoffUntil = 0

/**
 * Back off after a failure. A 429 or 5xx usually means the instance is struggling, and polling
 * it every fifteen seconds is the opposite of helping — so wait what `Retry-After` says, or
 * double from the poll interval up to a few minutes.
 */
function noteFailure(err, now = Date.now()) {
  streak++
  const wait = err?.retryAfterMs ?? Math.min(BACKOFF_MAX_MS, POLL_MS() * 2 ** streak)
  backoffUntil = now + wait
}

/** The latest run to draw a workflow from: the window, else the errors, else its own lookup. */
const latestFor = (w) =>
  model.latest.get(w.id) || model.latest.get(String(w.id)) || lookups.get(String(w.id))?.execution || null

/**
 * Threads from the last good read. Re-run on every refresh *and* every failure, so a failed one
 * keeps the last known picture (with `staleSince` saying how old) and `now` still moves — a run
 * that was fresh when it was read stops cheering once it is not.
 */
function build(now = Date.now()) {
  const staleSince = lastError && model.okAt ? model.okAt : null
  return model.workflows.map((w) => toThread(w, latestFor(w), now, staleSince))
}

async function refresh() {
  // The workflow list is the heavy call and the slow-moving one, so it has its own clock.
  // `excludePinnedData` drops test data nobody here reads; the node graphs still come back.
  const wantWorkflows = !workflowCache.at || Date.now() - workflowCache.at >= WORKFLOW_REFRESH_MS()
  const [flows, recent, errored] = await Promise.all([
    wantWorkflows ? collect('/api/v1/workflows', WORKFLOW_PAGES(), { excludePinnedData: 'true' }) : null,
    collect('/api/v1/executions', EXECUTION_PAGES()),
    // The window is the newest N executions instance-wide, so a rarely-run workflow that failed
    // last week is not in it. Asking for failures on their own makes sure they are never hidden.
    // `status=crashed` is not asked for: the live instance ignores it and returns everything, so
    // it would be 250 unfiltered rows pretending to be a filter. Crashes show in the window.
    collect('/api/v1/executions', 1, { status: 'error' }),
  ])
  if (flows) workflowCache = { ...flows, at: Date.now() }
  model = {
    workflows: workflowCache.rows.filter((w) => w && w.id != null),
    latest: latestPerWorkflow([...recent.rows, ...errored.rows]),
    okAt: Date.now(),
    cut: { workflows: workflowCache.more, executions: recent.more },
  }
  // A lookup is only ever worth keeping for a workflow that is still there and still unseen.
  for (const id of lookups.keys()) {
    const w = model.workflows.find((x) => String(x.id) === id)
    if (!w || model.latest.has(w.id) || model.latest.has(id)) lookups.delete(id)
  }
}

/**
 * Live workflows that neither the window nor the error list saw get asked about directly, a few
 * at a time, and the answer — including "no run at all" — is cached for `N8N_LOOKUP_MINUTES`.
 * Runs behind the refresh rather than inside it, so the first scan does not wait on a request
 * per workflow, and publishes again as answers arrive.
 */
async function fillGaps() {
  if (looking) return
  const now = Date.now()
  const ttl = LOOKUP_MS()
  const todo = model.workflows
    .filter((w) => w.active && !w.isArchived && isWorkflowId(String(w.id)) && !latestFor(w))
    .filter((w) => !(now - (lookups.get(String(w.id))?.at ?? -Infinity) < ttl))
    // Never-asked first, then the longest ago: a big gap is worked through in turn, not in a rush.
    .sort((a, b) => (lookups.get(String(a.id))?.at ?? 0) - (lookups.get(String(b.id))?.at ?? 0))
    .slice(0, LOOKUP_PER_REFRESH)
  if (!todo.length) return

  looking = true
  let next = 0
  let halted = false
  let answered = 0
  const worker = async () => {
    while (!halted && next < todo.length) {
      const w = todo[next++]
      try {
        const query = new URLSearchParams({ workflowId: String(w.id), limit: '1' })
        const body = await call(`/api/v1/executions?${query}`)
        const rows = Array.isArray(body) ? body : (body?.data ?? [])
        lookups.set(String(w.id), { at: Date.now(), execution: rows[0] || null })
        answered++
      } catch (err) {
        // One refusal is the instance telling everyone to slow down. Stop, and back off.
        halted = true
        lookupError = err?.message || String(err)
        noteFailure(err)
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(LOOKUP_CONCURRENCY, todo.length) }, worker))
    if (!halted) lookupError = ''
    // `at` is left alone: this is new detail on the same read, not a fresh one.
    if (answered) snapshot = { ...snapshot, threads: build() }
  } finally {
    looking = false
  }
}

/**
 * Refresh at most one at a time, and never let a failure take the scan with it: a stale
 * snapshot is a far better answer than an empty colony every time the network hiccups.
 */
function refreshOnce() {
  if (inFlight) return inFlight
  // Backing off: the poll is answered from the snapshot and n8n is left alone.
  if (Date.now() < backoffUntil) return Promise.resolve(snapshot.threads)
  attempted = true
  inFlight = refresh()
    .then(() => {
      lastError = ''
      streak = 0
      backoffUntil = 0
      snapshot = { threads: build(), at: Date.now() }
      fillGaps().catch(() => {})
      return snapshot.threads
    })
    .catch((err) => {
      lastError = err?.message || String(err)
      noteFailure(err)
      // Keep the last known good threads, marked with how old they are, and still advance `at` —
      // `lastError` is what the harness list shows.
      snapshot = { threads: build(), at: Date.now() }
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
  // open on a network call, and that includes the poll after a first attempt that failed.
  if (!attempted) return refreshOnce()
  if (!fresh || snapshot.stale) refreshOnce()
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
 * Executions a retry has already been sent for, and ones a retry is on the wire for right now.
 *
 * n8n leaves the original execution at `error` after a retry — the new run is a separate
 * execution — so the instance alone cannot say "this was already handled" until it has also
 * written `retrySuccessId`, and that only happens if the retry succeeds. Without a memory here a
 * double click, or the same button in two tabs, re-runs a production workflow twice. The map is
 * bounded by age and by size: a failure that is still the latest ten minutes on is worth asking
 * about again, and the thing must not grow for as long as the server stays up.
 */
const RETRIED_TTL_MS = 10 * 60 * 1000
const RETRIED_MAX = 200
const retried = new Map() // executionId -> when it was sent
const retrying = new Set() // executionIds with a POST pending

function wasRetried(executionId, now = Date.now()) {
  for (const [id, at] of retried) {
    if (now - at > RETRIED_TTL_MS) retried.delete(id)
  }
  return retried.has(executionId)
}

function rememberRetried(executionId, now = Date.now()) {
  retried.set(executionId, now)
  // Maps iterate oldest-first, so the first key is the one to give up.
  while (retried.size > RETRIED_MAX) retried.delete(retried.keys().next().value)
}

/**
 * Ask n8n to run a failed execution again. The one write in the project.
 *
 * The execution id is **never taken from the page**. A `ref` makes a round trip through the
 * browser and is the one part of a thread nothing in between inspects, so trusting it would let
 * anyone who can reach the API retry any old failure of any workflow — each of which re-runs a
 * production workflow, emails and all. Only the workflow id is read from it; the execution is
 * whatever this adapter's own snapshot says is that workflow's latest run, and only if that run
 * failed and the thread was offered `canRetry`. If the page *also* named an execution and it is
 * not that one, the retry is refused rather than quietly redirected: the button was drawn for a
 * run that is no longer the latest, and the person should see the current state before deciding.
 *
 * The execution is still re-read from n8n before anything is posted, because the snapshot may
 * be a quarter of a minute old and "retry" on a run that has since gone green would silently
 * start work nobody asked for. That read is also where `retrySuccessId` is checked: n8n sets it
 * on an execution once a retry of it has succeeded.
 */
async function retry(ref) {
  const workflowId = ref?.workflowId
  if (!isWorkflowId(workflowId)) {
    return { ok: false, error: 'That thread has no failed n8n execution to retry' }
  }
  const thread = snapshot.threads.find((t) => t.id === ID(workflowId))
  const executionId = thread?.ref?.executionId
  if (!thread || !thread.canRetry || !isExecutionId(executionId)) {
    return { ok: false, error: 'That workflow has no failed latest run to retry' }
  }
  const claimed = ref?.executionId
  if (claimed != null && claimed !== '' && String(claimed) !== executionId) {
    return { ok: false, error: 'A newer run exists than the one that was on screen — refresh and look again' }
  }

  // Everything from here to the lock is synchronous, so two calls cannot both get past it.
  if (retrying.has(executionId)) {
    return { ok: false, error: `A retry of execution ${executionId} is already in progress` }
  }
  if (wasRetried(executionId)) {
    return { ok: false, error: `Execution ${executionId} was already retried — wait for the new run` }
  }
  retrying.add(executionId)
  try {
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
    if (current?.retrySuccessId) {
      return { ok: false, error: `That run was already retried successfully (as ${current.retrySuccessId})` }
    }
    try {
      await call(`/api/v1/executions/${executionId}/retry`, { method: 'POST' })
    } catch (err) {
      // Not remembered: n8n said no, so nothing ran and a second try is legitimate.
      return { ok: false, error: `n8n refused the retry — ${err?.message || err}` }
    }
    rememberRetried(executionId)
    // The colony should show the new run rather than the old failure. Marked stale, not zeroed,
    // so the next scan answers from the snapshot and refreshes behind it. n8n just accepted a
    // POST, so any backoff from earlier no longer applies.
    snapshot = { ...snapshot, stale: true }
    backoffUntil = 0
    return { ok: true, message: `Retrying execution ${executionId}` }
  } finally {
    retrying.delete(executionId)
  }
}

/** "3 min", "2 h 5 min" — how long ago, for a sentence a person reads. */
function ago(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000))
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))} s`
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`
}

/**
 * Why the list is empty or not to be trusted, when it is. Shown in the harness list rather than
 * swallowed — including the quiet failures: data that is old, and history that was cut short.
 */
async function diagnostic() {
  if (!BASE_URL()) return 'N8N_BASE_URL is not set in .env'
  if (!API_KEY()) return 'N8N_API_KEY is not set in .env'
  const now = Date.now()
  const notes = []
  if (lastError) {
    const retryIn = backoffUntil > now ? ` — next try in ${ago(backoffUntil - now)}` : ''
    notes.push(
      model.okAt
        ? `${lastError}${retryIn} — showing n8n as it was ${ago(now - model.okAt)} ago`
        : `${lastError}${retryIn}`
    )
  }
  if (lookupError) notes.push(`per-workflow run lookups are failing (${lookupError})`)
  if (model.cut.workflows) {
    notes.push(`more workflows exist than the ${WORKFLOW_PAGES()} page(s) read — raise N8N_WORKFLOW_PAGES`)
  }
  // Execution history running past the pages read is not a note: n8n always has older runs,
  // and the gaps are filled by the error page and the per-workflow lookups. A warning that is
  // always on is one nobody reads, and it would bury the ones above.
  return notes.join(' · ')
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
    attempted = false
    lastError = ''
    lookupError = ''
    model = { workflows: [], latest: new Map(), okAt: 0, cut: { workflows: false, executions: false } }
    workflowCache = { rows: [], more: false, at: 0 }
    lookups.clear()
    looking = false
    streak = 0
    backoffUntil = 0
    retried.clear()
    retrying.clear()
  },
  _shape: { toThread, latestPerWorkflow, zoneOf },
}
