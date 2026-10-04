import * as THREE from 'three'
import './ui/styles.css'
import { DEFAULT_PRESET, Settings, hasStoredSettings } from './core/settings.js'
import { Engine } from './core/engine.js'
import { CameraRig } from './core/camera.js'
import { Colony, STATUS_LABEL, STATUS_ORDER, statusFor, transcriptProgress } from './game/colony.js'
import { Hud } from './ui/hud.js'
import { PLANETS } from './world/planet.js'
import { loadKit } from './world/kit.js'
import { crewRig, loadCrew } from './agents/crew.js'
import { TIMES } from './world/sky.js'
import {
  fetchThreads,
  fetchState,
  saveState,
  openThread,
  retryThread,
  newSession,
  revealFolder,
} from './game/api.js'
import { hideProject, hiddenCatalog, unhideProject } from './game/hidden-projects.js'

/**
 * Boot and the outer game loop.
 *
 * The one interesting piece of orchestration here is the archive round trip. The harness
 * owns the session records; the colony owns nothing but its own list of what you archived,
 * and that list is written by exactly one writer — this page — so a save from a stale tab
 * can never silently drop an archive. Everything else is wiring.
 */

const POLL_MS = 15000
/** How long an archive can be taken back from its toast. */
const UNDO_MS = 5000
const app = document.getElementById('app')

app.insertAdjacentHTML(
  'beforeend',
  `<div class="boot"><div class="inner">
     <h1>BotsBay World</h1>
     <p>Scanning for agent threads…</p>
     <div class="bar"><i></i></div>
   </div></div>`
)

const settings = new Settings()
if (!hasStoredSettings()) settings.applyPreset(DEFAULT_PRESET)

const engine = new Engine(settings).mount(app)
const rig = new CameraRig(engine.camera, engine.canvas, settings)
const colony = new Colony(engine.scene, settings, engine.camera, engine.renderer)

let state = { archived: [], archivedAt: {}, opened: [], plots: {}, seen: {}, hiddenProjects: [], viewedAt: {} }
let threads = []
/** Last legend built for the bottom bar, kept so the open zone's chip can light up between polls. */
let legendProjects = []
/** The zone layout as last written to the colony file, so an unchanged map is not re-saved. */
let lastLayout = ''
let selectedId = null
/** Which zone's sidebar is open. A repo, not a thread — they outlive the threads on them. */
let selectedProject = null
let hoverId = null
/**
 * Where N and the counters left off, per status. One shared cursor meant pressing N, then the
 * Blocked counter, then N again skipped people: each list is walked from its own last stop.
 */
const statusCursor = new Map()
/** The archive the toast can still take back, so `U` can answer it too. */
let lastArchived = null
let pendingSave = 0
/** A retry is on the wire. Module state rather than the button, so the `R` key sees it too. */
let retrying = false
const hoverGround = new THREE.Vector3()

// ── actions the HUD can trigger ────────────────────────────────────────────────────────

const actions = {
  resetView: () => rig.resetView(),

  screenshot: () => {
    // Render one more frame, then read the buffer before the compositor clears it — the
    // alternative is preserveDrawingBuffer, which costs a copy on every single frame.
    engine.renderFrame()
    const url = engine.canvas.toDataURL('image/png')
    const a = document.createElement('a')
    a.href = url
    a.download = `botsbay-world-${colony.planet.id}-${stamp()}.png`
    a.click()
    hud.toast('Screenshot saved')
  },

  /** Google Earth's auto-rotate: a slow sweep around whatever is centred. */
  toggleOrbit: () => {
    const on = rig.toggleOrbit()
    hud.hint(on ? 'Orbit mode on — drag or press O to stop' : 'Orbit mode off')
    return on
  },

  cyclePlanet: () => {
    const ids = Object.keys(PLANETS)
    const next = ids[(ids.indexOf(settings.get('planet')) + 1) % ids.length]
    settings.set('planet', next)
    hud.hint(`${PLANETS[next].name} — ${PLANETS[next].blurb}`)
  },

  cycleTime: () => {
    settings.set('autoTime', false)
    settings.set('clockTime', false)
    const current = settings.get('timeOfDay')
    // Step to the next named time *after* the current one, wrapping at midnight.
    const next = TIMES.find((t) => t.value > current + 0.005) || TIMES[0]
    settings.set('timeOfDay', next.value)
    hud.hint(next.label)
  },

  /** Fly to the next astronaut in a given state, cycling through them on repeat presses. */
  focusStatus: (status) => {
    const key = status === 'agents' ? null : status
    const pool = colony.astronauts.agents.filter((a) => (key ? a.status === key : true))
    if (!pool.length) {
      hud.hint(key ? `Nobody is ${(STATUS_LABEL[key] || key).toLowerCase()} right now` : 'No builders on the island')
      return
    }
    pool.sort((a, b) => a.id.localeCompare(b.id))
    // The next one *after* whoever was last visited, by id, so a pool that gained or lost
    // somebody since the last press still carries on from the right place.
    const at = pool.findIndex((a) => a.id === statusCursor.get(key ?? 'agents'))
    const agent = pool[(at + 1) % pool.length]
    statusCursor.set(key ?? 'agents', agent.id)
    select(agent.id, { fly: true })
  },

  focusProject: (name) => {
    const plot = colony.plots.get(name)
    if (!plot) return
    rig.focus(plot.middle || plot.center, { distance: 30 })
  },

  /** The legend, and anything else that means "show me this repo". */
  pickProject: (name) => selectProject(name, { fly: true }),

  /** Back out of one repo to the list of all of them. The panel itself never leaves. */
  closeProject: () => {
    selectedProject = null
    select(null, {})
    syncProject()
  },

  select: (id) => select(id, {}),

  focusThread: (id) => select(id, { fly: true }),

  /** A thread with no builder has nothing to fly to, so its row opens the thread instead. */
  openById: (id) => actions.openThread(id),

  /**
   * A new thread in this repo. The desktop app opens an empty session with the folder as
   * its workspace — nothing here is resumed, and nothing is written to disk.
   */
  newConversation: async () => {
    const name = selectedProject
    const folder = name && pathForProject(name)
    if (!folder) {
      hud.toast('No folder on disk for that project', 'err')
      return
    }
    try {
      const harness = harnessForProject(name)
      await newSession(folder, harness)
      hud.toast(`New thread in ${name} — opening ${harnessLabel(harness)}`)
      // It lands as an astronaut walking down the ramp, once it has a record to scan.
      setTimeout(poll, 6000)
    } catch (err) {
      hud.toast(err.message || 'Could not start a thread there', 'err')
    }
  },

  revealProject: async () => {
    const folder = selectedProject && pathForProject(selectedProject)
    if (!folder) return
    try {
      await revealFolder(folder)
    } catch (err) {
      hud.toast(err.message || 'Could not open that folder', 'err')
    }
  },

  /**
   * Stop a thread asking for you, without touching it.
   *
   * `unread` comes from the harness, and the harness only counts a thread as read when it is
   * focused *in its own app*. Answer one in a terminal, or read it over somebody's shoulder,
   * and it keeps its hand up forever. Marking it viewed here records when you looked; the
   * moment the thread does something newer than that it goes back to waving, which is the
   * behaviour you actually want and the reason this is a timestamp rather than a flag.
   */
  markViewed: () => {
    const thread = threads.find((t) => t.id === selectedId)
    if (!thread) return
    state.viewedAt = { ...(state.viewedAt || {}), [thread.id]: Date.now() }
    queueSave()
    applyThreads(threads)
    hud.toast(`Marked ${titleOf(thread).slice(0, 40)} as viewed`)
  },

  hideProject: () => {
    const name = selectedProject
    if (!name) return
    state.hiddenProjects = hideProject(state.hiddenProjects || [], name)
    queueSave()
    // If the open thread belonged to the repo that just left, nothing is selected any more.
    if (selectedId) {
      const thread = threads.find((t) => t.id === selectedId)
      if (thread?.project === name) select(null, {})
    }
    selectedProject = null
    applyThreads(threads)
    hud.toast(`Hidden ${name} — still in your harness, gone from the island`)
  },

  unhideProject: (name) => {
    if (!name) return
    state.hiddenProjects = unhideProject(state.hiddenProjects || [], name)
    queueSave()
    applyThreads(threads)
    hud.toast(`Showing ${name} again`)
  },

  copyProjectPath: async () => {
    const folder = selectedProject && pathForProject(selectedProject)
    if (!folder) return
    try {
      await navigator.clipboard.writeText(folder)
      hud.toast('Path copied')
    } catch {
      // The async clipboard needs a permission this page does not always have — inside an
      // embedded preview, say. The old selection-based copy has no such gate.
      const copied = copyFallback(folder)
      hud.toast(copied ? 'Path copied' : 'Could not reach the clipboard', copied ? '' : 'err')
    }
  },

  /**
   * Open a thread in the harness it came from. With no id it is the selected builder's; with one
   * it is a row in the sidebar's Asleep group, which has no builder to select.
   */
  openThread: async (id = selectedId) => {
    const thread = threads.find((t) => t.id === id)
    if (!thread) return
    try {
      await openThread(thread)
      colony.astronauts.celebrate(thread.id)
      hud.toast(`Opened in ${thread.harnessName || 'your harness'}`)
      // Opening is the thing that makes a thread no longer unread, so refresh shortly after.
      setTimeout(poll, 1800)
    } catch (err) {
      hud.toast(err.message || 'Could not open that thread', 'err')
    }
  },

  /**
   * Ask the harness to run this thread again.
   *
   * The only action here that changes anything outside this machine, and the only one a thread
   * has to opt into: the button is drawn from `canRetry`, which the adapter sets, so nothing on
   * this side knows what is retryable or what running again even means. A poll is queued
   * afterwards because the answer — a new run, in a new state — is on the next scan.
   */
  retryThread: async () => {
    // One at a time. The server refuses a second retry too, but the button and `R` should not
    // even ask: a double click is the likeliest way to run a production workflow twice.
    if (retrying) return
    const thread = threads.find((t) => t.id === selectedId)
    if (!thread || !thread.canRetry) return
    // This re-runs a live workflow, side effects and all, so it is the one action that asks first.
    if (!window.confirm(`Re-run the failed execution of “${titleOf(thread)}” in n8n? This runs the production workflow again.`)) return
    retrying = true
    hud.setRetryBusy(true)
    try {
      const done = await retryThread(thread)
      hud.toast(done.message || 'Retrying')
      setTimeout(poll, 1800)
    } catch (err) {
      // The server's refusal (already retried, a newer run, no longer failed) arrives as the message.
      hud.toast(err.message || 'Could not retry that', 'err')
    } finally {
      retrying = false
      hud.setRetryBusy(false)
    }
  },

  // Archiving is the colony's own bookkeeping and nothing else: the thread leaves the map and
  // the astronaut walks back to the ship. The harness's own records are never touched — see
  // `reconcileArchived` in server/api.mjs for why that stopped being worth doing.
  archiveThread: () => {
    const thread = threads.find((t) => t.id === selectedId)
    if (!thread) return
    const foldedBefore = new Set(colony.dormantProjects || [])
    state.archived = [...new Set([...state.archived, thread.id])]
    state.archivedAt = { ...state.archivedAt, [thread.id]: Date.now() }
    queueSave()
    select(null, {})
    applyThreads(threads)
    // Retiring the last thread anybody has touched in a repo makes every thread left in it
    // dormant, and the whole zone folds away — sixty astronauts can leave the map on one
    // click. That is the setting working, but silently it reads as the colony breaking, so
    // it says which repo went and why.
    const folded = [...(colony.dormantProjects || [])].filter((n) => !foldedBefore.has(n))
    // No confirm: archiving only ever touches the colony's own list, so the way to be forgiving
    // is to take it back, not to ask first.
    lastArchived = thread.id
    hud.toast(
      folded.length
        ? `Archived — ${folded.join(', ')} ${folded.length === 1 ? 'is' : 'are'} all quiet now, folded off the map`
        : 'Archived — heading home',
      '',
      { ms: UNDO_MS, action: { label: 'Undo', run: () => actions.unarchiveThread(thread.id) } }
    )
    colony.ship.ping()
  },

  /** Bring one back: the Archived list's button, the toast's Undo, and `U`. */
  unarchiveThread: (id) => {
    if (!id || !state.archived.includes(id)) return
    state.archived = state.archived.filter((a) => a !== id)
    const { [id]: _gone, ...rest } = state.archivedAt || {}
    state.archivedAt = rest
    if (lastArchived === id) lastArchived = null
    queueSave()
    applyThreads(threads)
    const thread = threads.find((t) => t.id === id)
    hud.toast(`Restored ${thread ? titleOf(thread).slice(0, 40) : 'the thread'}`)
  },

  /** `U`: undo the archive the toast is still offering. */
  undoArchive: () => {
    if (lastArchived) actions.unarchiveThread(lastArchived)
  },

  uiVisibility: (visible) => colony.setUiVisible(visible),

  // The card's bar is about the *thread*, not about how much of its building has risen —
  // those were the same number while construction was drawn by burying the structure.
  progressFor: (id) => {
    const thread = threads.find((t) => t.id === id)
    return thread ? transcriptProgress(thread) : 0
  },
}

const hud = new Hud(app, settings, actions)

/**
 * Say which chip is drawing the page, once, if the governor has had to back off on it.
 *
 * Profiled, the machine this was built on has two GPUs and the browser was using the slow
 * one — the render scale settling in the fifties was that, not the island. A page cannot
 * pick its GPU; the only lever is a setting in Windows, and the only useful thing to do is
 * to name the chip so somebody knows to look. Only integrated parts are named, and only
 * when the scale actually dropped: a machine holding full resolution has nothing to hear.
 */
let gpuHinted = false
engine.onAutoScaled = () => {
  if (gpuHinted) return
  const gpu = engine.gpuName
  if (!/intel|iris|uhd|vega|radeon\(tm\) graphics|apple m|adreno|mali/i.test(gpu)) return
  gpuHinted = true
  const name = gpu.replace(/^ANGLE \(\w+, /, '').replace(/ Direct3D.*$/, '').replace(/\(0x[0-9a-f]+\)/i, '').trim()
  hud.hint(`Drawing on ${name}, below full resolution — on a laptop with a second GPU, set your browser to High performance in Windows Graphics settings`, 11000)
}
// The sidebar is permanent, so the card beside an astronaut has a wall to stay clear of.
const sideWidth = () => (window.innerWidth <= 820 ? 0 : 334)
hud.setSideWidth(sideWidth())
window.addEventListener('resize', () => hud.setSideWidth(sideWidth()))

// ── selection ─────────────────────────────────────────────────────────────────────────

/** A thread's title, for a sentence. Adapters promise one; a half-written record has been seen without. */
const titleOf = (thread) => String(thread?.title || 'Untitled thread')

function select(id, { fly = false } = {}) {
  selectedId = id
  const agent = id ? colony.agentFor(id) : null
  if (!agent) {
    selectedId = null
    colony.astronauts.setSelected(null)
    hud.setSelection(null, null)
    syncProject()
    return
  }
  colony.astronauts.setSelected(agent)
  const thread = threads.find((t) => t.id === id) || agent.thread
  hud.setSelection(agent, thread)
  // Picking somebody is also picking the zone they are standing on: the sidebar follows.
  if (thread?.project && colony.plots.has(thread.project)) selectedProject = thread.project
  syncProject()
  if (fly) {
    rig.focus(new THREE.Vector3(agent.pos.x, 0, agent.pos.z), { distance: Math.min(rig.desiredDistance, 26) })
  }
}

/** Open a zone's sidebar. Any selected builder from a different zone lets go. */
function selectProject(name, { fly = false } = {}) {
  if (!name || !colony.plots.has(name)) return
  selectedProject = name
  const current = threads.find((t) => t.id === selectedId)
  if (current && current.project !== name) select(null, {})
  else syncProject()
  if (fly) actions.focusProject(name)
}

/**
 * The repo folder behind a zone. Plots are keyed by the folder's *name*, which is all the
 * colony needs to draw one — the path itself lives on the threads, so it is read back off
 * them, taking the most common answer if two checkouts somehow share a basename.
 */
/** The human name for a harness id — every thread already carries its own. */
function harnessLabel(id) {
  for (const thread of colony.threads.values()) {
    if (thread.harness === id && thread.harnessName) return thread.harnessName
  }
  return 'your harness'
}

/**
 * Which harness a project's threads belong to, picked the same way its path is: the most
 * common answer among the threads standing there. A repo worked on from two harnesses gets
 * a new thread in whichever one it is mostly used from.
 */
function harnessForProject(name) {
  const counts = new Map()
  for (const thread of colony.threads.values()) {
    if (thread.project !== name || !thread.harness) continue
    counts.set(thread.harness, (counts.get(thread.harness) ?? 0) + 1)
  }
  let best = ''
  let bestCount = 0
  for (const [id, n] of counts) {
    if (n <= bestCount) continue
    best = id
    bestCount = n
  }
  return best
}

function pathForProject(name) {
  const counts = new Map()
  for (const thread of colony.threads.values()) {
    if (thread.project !== name) continue
    const dir = thread.projectPath || thread.cwd
    if (!dir) continue
    counts.set(dir, (counts.get(dir) ?? 0) + 1)
  }
  let best = ''
  let bestCount = 0
  for (const [dir, n] of counts) {
    if (n <= bestCount) continue
    best = dir
    bestCount = n
  }
  return best
}

/** Push the open zone's current contents at the sidebar. Closes it if the zone is gone. */
function syncProject() {
  const hidden = hiddenCatalog(state.hiddenProjects || [], threads)
  // Folded-away repos are listed alongside the ones you hid by hand. Same principle: nothing
  // leaves the map without somewhere on screen saying where it went.
  const folded = hiddenCatalog([...(colony.dormantProjects || [])], threads)
  const plot = selectedProject ? colony.plots.get(selectedProject) : null
  if (!plot) {
    selectedProject = null
    hud.setProject(null)
    hud.setLegend(legendProjects, null, hidden, folded)
    return
  }
  const now = Date.now()
  const list = [...colony.threads.values()]
    .filter((thread) => thread.project === plot.name)
    .map((thread) => ({
      id: thread.id,
      title: thread.title,
      worktree: thread.worktree,
      lastActivityAt: thread.lastActivityAt,
      lastRunAt: thread.lastRunAt,
      staleSince: thread.staleSince,
      harness: thread.harness,
      // Has a builder on the island. The rest are over the cap or past the zone's slots, and
      // clicking one cannot fly anywhere — the sidebar lists them apart, with Open instead.
      drawn: colony.astronauts.isDrawn(thread.id),
      status: statusFor(thread, now),
    }))
    // Whoever wants something first, then most recently touched — the same order of
    // importance the badges use above their heads.
    .sort((a, b) => {
      const rank = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)
      return rank || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)
    })

  hud.setProject({
    name: plot.name,
    accent: plot.accent,
    path: pathForProject(plot.name),
    threads: list,
    selectedId,
  })
  // The legend is the same selection seen from the bottom of the screen: keep it in step
  // here rather than only on the next poll.
  hud.setLegend(legendProjects, selectedProject, hidden, folded)
}

// ── pointer ───────────────────────────────────────────────────────────────────────────

/**
 * Where an astronaut is on screen, in CSS pixels, or null if it is behind the camera.
 *
 * Measured off the engine's own viewport rather than the canvas's bounding rect: this runs
 * every frame for the selected agent, and a layout read per frame to learn a number that
 * only changes on resize is the kind of thing that quietly costs a HUD its smoothness.
 */
const cardAnchor = new THREE.Vector3()
function screenOf(agent) {
  cardAnchor.set(agent.pos.x, agent.pos.y + 0.95, agent.pos.z).project(engine.camera)
  if (cardAnchor.z > 1) return null
  const { w, h } = engine.viewport
  return { x: (cardAnchor.x * 0.5 + 0.5) * w, y: (-cardAnchor.y * 0.5 + 0.5) * h }
}

function ndc(e) {
  const rect = engine.canvas.getBoundingClientRect()
  return {
    x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
    y: -((e.clientY - rect.top) / rect.height) * 2 + 1,
    aspect: rect.width / rect.height,
  }
}

engine.canvas.addEventListener('pointermove', (e) => {
  // Mid-drag the cursor is the grab hand and nothing else: running a pick every move event
  // while the world is being dragged would flicker the hover ring across the whole colony.
  if (rig.interacting) {
    engine.canvas.style.cursor = rig._mode === 'orbit' ? 'move' : 'grabbing'
    return
  }
  const p = ndc(e)
  const agent = colony.pick(p.x, p.y, p.aspect)
  hoverId = agent?.id ?? null
  colony.astronauts.setHover(agent)
  // Pointing at a quiet plot is what makes its name appear.
  const plot = plotUnder(e, p)
  colony.setHoveredPlot(plot)
  engine.canvas.style.cursor = agent || plot ? 'pointer' : 'grab'
})

/**
 * The zone under the cursor: its name plate first, then the deck itself. The plate is
 * hit-tested whether or not it is currently faded in — pointing at where a quiet project's
 * name would be is exactly what makes it appear.
 */
function plotUnder(e, p) {
  const label = colony.pickLabel(p.x, p.y)
  if (label) return label
  const ground = rig.groundPoint(e.clientX, e.clientY, hoverGround)
  return ground ? colony.plotAt(ground.x, ground.z) : null
}

// Pressing on an astronaut used to suppress the camera, on the theory that grabbing one
// should not also drag the world out from under it. But nothing is draggable *about* an
// astronaut — a press is only ever the start of a selection or the start of a pan — so all
// that suppression did was make the ground refuse to move whenever a drag happened to begin
// on top of somebody. Selection is decided on release instead, where `wasClick` already
// distinguishes a click from a drag.
engine.canvas.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || !rig.wasClick) return
  const p = ndc(e)
  const agent = colony.pick(p.x, p.y, p.aspect)
  if (agent) {
    select(agent.id, {})
    return
  }
  // Nobody there: a zone's deck or its name plate opens that repo's sidebar instead, and
  // bare ground puts everything down.
  const plot = plotUnder(e, p)
  if (plot) selectProject(plot.name, {})
  else {
    select(null, {})
    actions.closeProject()
  }
})

engine.canvas.addEventListener('pointerleave', () => {
  hoverId = null
  colony.astronauts.setHover(null)
  colony.setHoveredPlot(null)
})

// ── keyboard ──────────────────────────────────────────────────────────────────────────

/** Whether an event came from something that has its own idea of what Enter and letters mean. */
function fromControl(t) {
  if (!(t instanceof Element)) return false
  // Anywhere inside the HUD counts: a focused row or chip is the thing being operated, and a
  // second handler here would act on the selected thread behind its back.
  return Boolean(t.closest('button, input, select, textarea, a, [contenteditable], .hud'))
}

window.addEventListener('keydown', (e) => {
  const t = e.target
  const typing = t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement

  // One step at a time, outward — and before the typing check, so Esc closes Settings from a
  // slider or a dropdown too. The search box handles its own Esc.
  if (e.key === 'Escape' && !(t instanceof HTMLInputElement && t.type === 'search')) {
    if (document.querySelector('.help.open')) hud.toggleHelp(false)
    else if (hud.isSettingsOpen()) hud.toggleSettings(false)
    else if (hud.searching) hud.clearSearch()
    else if (selectedId) select(null, {})
    else if (selectedProject) actions.closeProject()
    return
  }

  // Never steal keys from a field the user is actually typing in.
  if (typing) return

  // ⌘\ (⌃\ elsewhere) dismisses the chrome, the same as H — the shortcut every editor
  // uses for its sidebar, and the one hand that is already on the keyboard.
  if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
    e.preventDefault()
    hud.toggleUi()
    return
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return

  // These act on whatever is selected, so they only fire from the canvas or the page. With
  // focus on a button, Enter presses the button; with it in a list row, the row is the target.
  if (fromControl(t) && ['Enter', 'a', 'A', 'r', 'R', 'v', 'V', 'c', 'C', 'n', 'N', 'u', 'U'].includes(e.key)) return

  switch (e.key) {
    case 'h':
    case 'H':
      hud.toggleUi()
      break
    case 's':
    case 'S':
      hud.toggleSettings()
      break
    case 'n':
    case 'N':
      actions.focusStatus('waiting')
      break
    case 'p':
    case 'P':
      actions.screenshot()
      break
    case 'l':
    case 'L':
      actions.cycleTime()
      break
    case 'o':
    case 'O':
      hud.setOrbit(actions.toggleOrbit())
      break
    // Tab used to change the world, from anywhere. It is the key that moves through the panels,
    // and taking it left a keyboard with no way into the HUD at all.
    case 'w':
    case 'W':
      actions.cyclePlanet()
      break
    case '/':
      e.preventDefault()
      hud.focusSearch()
      break
    case 'u':
    case 'U':
      actions.undoArchive()
      break
    case '0':
      actions.resetView()
      hud.setOrbit(false)
      break
    case 'Enter':
      if (selectedId) actions.openThread()
      break
    case 'a':
    case 'A':
      if (selectedId) actions.archiveThread()
      break
    case 'r':
    case 'R':
      if (selectedId) actions.retryThread()
      break
    case 'v':
    case 'V':
      if (selectedId) actions.markViewed()
      break
    case 'c':
    case 'C':
      if (selectedProject) actions.newConversation()
      break
    case '?':
      hud.toggleHelp()
      break
    // Arrow keys nudge the view and +/- zoom, the same as Earth's keyboard.
    case 'ArrowUp':
    case 'ArrowDown':
    case 'ArrowLeft':
    case 'ArrowRight': {
      e.preventDefault()
      const step = rig.distance * 0.09
      const forward = new THREE.Vector3(Math.sin(rig.azimuth), 0, Math.cos(rig.azimuth))
      const right = new THREE.Vector3(forward.z, 0, -forward.x)
      if (e.key === 'ArrowUp') rig.desiredTarget.addScaledVector(forward, -step)
      if (e.key === 'ArrowDown') rig.desiredTarget.addScaledVector(forward, step)
      if (e.key === 'ArrowLeft') rig.desiredTarget.addScaledVector(right, -step)
      if (e.key === 'ArrowRight') rig.desiredTarget.addScaledVector(right, step)
      rig._clampTarget()
      rig.idleFor = 0
      break
    }
    case '+':
    case '=':
      rig.desiredDistance = Math.max(4, rig.desiredDistance * 0.82)
      break
    case '-':
    case '_':
      rig.desiredDistance = Math.min(150, rig.desiredDistance * 1.22)
      break
  }
})

// ── data ──────────────────────────────────────────────────────────────────────────────

function applyThreads(list) {
  // A thread you have said you looked at stops counting as unread until it moves on again.
  // Done here rather than in `statusFor` so the card, the badge and the astronaut all agree.
  const viewed = state.viewedAt || {}
  threads = list.map((t) => {
    const at = viewed[t.id]
    return at && t.lastActivityAt <= at ? { ...t, unread: false } : t
  })
  list = threads
  const archivedSet = new Set(state.archived)
  const hiddenSet = new Set(state.hiddenProjects || [])

  // Which threads the colony has met before. Walking out of the ship is meant to *mean*
  // something — a thread that just appeared — and without this every reload staged a
  // hundred-astronaut entrance, which piled up at the ramp and read as a bug because it was
  // one. A thread already on the books is simply already outside.
  const known = new Set(Object.keys(state.seen || {}))
  let firstSeen = false
  for (const t of list) {
    if (state.seen?.[t.id]) continue
    state.seen = { ...(state.seen || {}), [t.id]: Date.now() }
    firstSeen = true
  }
  if (firstSeen) queueSave()

  const stats = colony.setThreads(list, archivedSet, hiddenSet, known)

  // How much of the roster is actually on the island. Over the crew cap or a zone's slots the
  // rest have no builder, and a map that silently shows 84 of 445 reads as the whole truth.
  //
  // Three numbers that used to disagree: the "builders" counter said 79 while this line said 76
  // of 387. The counter was counting every thread that survived the dormant rule — 79 — and the
  // line was counting who actually has a builder, three of which were over a zone's slots. The
  // counter now reports the drawn ones, and this line splits the rest into the two reasons.
  const now = Date.now()
  let drawnCount = 0
  let dormant = 0
  let over = 0
  for (const t of colony.threads.values()) {
    if (colony.astronauts.isDrawn(t.id)) drawnCount++
    else if (statusFor(t, now) === 'sleeping') dormant++
    else over++
  }
  hud.setStats({ ...stats, agents: drawnCount })
  hud.setCoverage({ shown: drawnCount, total: colony.threads.size, dormant, over })

  // Everything findable, drawn or not: the search box looks through all of it.
  hud.setDirectory(
    [...colony.threads.values()].map((t) => ({
      id: t.id,
      title: t.title,
      project: t.project,
      harness: t.harness,
      harnessName: t.harnessName,
      lastActivityAt: t.lastActivityAt,
      lastRunAt: t.lastRunAt,
      status: statusFor(t, now),
      drawn: colony.astronauts.isDrawn(t.id),
    }))
  )
  hud.setArchived(
    state.archived
      .map((id) => {
        const t = list.find((x) => x.id === id)
        return { id, title: t ? titleOf(t) : id.replace(/^[^:]+:/, ''), project: t?.project || '', at: state.archivedAt?.[id] || 0 }
      })
      .sort((a, b) => b.at - a.at)
  )

  legendProjects = colony.plotOrder
    .map((plot) => {
      const mine = list.filter((t) => !t.archived && !archivedSet.has(t.id) && t.project === plot.name)
      return {
        name: plot.name,
        accent: plot.accent,
        count: mine.length,
        drawn: mine.filter((t) => colony.astronauts.isDrawn(t.id)).length,
        urgent: colony.urgentPlots?.has(plot.id) ?? false,
      }
    })
    .sort((a, b) => b.count - a.count)

  // Keep the card honest if the thread it is showing changed underneath it.
  if (selectedId) {
    const still = colony.agentFor(selectedId)
    if (still) hud.setSelection(still, list.find((t) => t.id === selectedId) || still.thread)
    else select(null, {})
  }
  // Which also repaints the legend, so the open zone's chip is lit by the same pass.
  syncProject()

  // Zones only move when their own footprint changes, and when one does the colony file
  // learns about it — so the map you built up a memory of survives a reload.
  const layout = colony.layoutForSave()
  const signature = JSON.stringify(layout)
  if (signature !== lastLayout) {
    lastLayout = signature
    state.plots = layout
    queueSave()
  }
}

let polling = false
async function poll({ force = false } = {}) {
  // A hidden tab has nobody to show it to, and a scan of four hundred workflows is not free on
  // the server. The visibility handler polls the moment the tab is back.
  if (document.hidden && !force) return
  if (polling) return
  polling = true
  try {
    const res = await fetchThreads()
    applyThreads(res.threads || [])
    // `warnings` are the harnesses that could not be read, and `scannedAt` is when the server
    // last looked: both used to be thrown away, so a harness that stopped answering left the
    // map frozen at its last roster with nothing on screen to say so.
    hud.setHealth({
      ok: true,
      warnings: res.warnings || [],
      scannedAt: Number(res.scannedAt) || Date.now(),
      stale: (res.threads || []).some((t) => t.staleSince),
    })
    hud.removeBoot()
  } catch (err) {
    // Stays on screen, unlike the toast: the old picture is still up, and what it needs is a
    // standing note that it is old.
    hud.setHealth({ ok: false, error: err.message || 'Could not reach the thread scanner' })
    hud.toast(err.message || 'Could not reach the thread scanner', 'err')
    hud.removeBoot()
  } finally {
    // Unconditionally, and the fetch has a deadline, so this is reached even when the server
    // accepts the request and never answers.
    polling = false
  }
}

function queueSave() {
  clearTimeout(pendingSave)
  pendingSave = setTimeout(async () => {
    try {
      // Adopt whatever comes back: unchanged when the save was clean, and the merged colony when
      // another tab had written since this one loaded. Dropping it would leave this page
      // asserting a picture the file has already moved past, and the next save would fight.
      state = await saveState(state)
    } catch {
      /* the colony still runs; only the archive list is at risk, and it retries next time */
    }
  }, 500)
}

async function boot() {
  // The model kit and the crew rig both have to be in hand before the first roster arrives:
  // buildings and the ground scatter are assembled out of the kit synchronously the moment
  // a thread shows up, and the crew's body mesh is built from the rig. Fetched alongside
  // the saved state rather than after it, since none of them waits on the others.
  const settle = (p) => p.then(() => null, (err) => err)
  const [, kitError, crewError] = await Promise.all([
    fetchState()
      .then((s) => {
        state = s
        // Before the first roster: zones come back to the ground they were on last time.
        colony.restoreLayout(state.plots)
        // And the settings, but only for a browser that has none of its own — an explicit
        // choice made here always outranks the file.
        if (!hasStoredSettings() && state.settings) settings.applyAll(state.settings)
      })
      .catch(() => {
        /* first run, or the file is gone — an empty colony state is a valid one */
      }),
    settle(loadKit()),
    settle(loadCrew()),
  ])
  if (kitError || crewError) {
    hud.toast('Could not load the model assets — run `npm run assets`', 'err')
    console.error(kitError || crewError)
  }
  colony.astronauts.setRig(crewRig())
  if (!kitError) colony.onAssetsReady()

  await poll({ force: true })
  setInterval(() => poll(), POLL_MS)
  window.addEventListener('focus', () => poll())
  // A tab that was hidden for an hour should catch up the moment it comes back.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) poll()
  })

  // The old key is honoured so a browser that has seen the sheet before is not shown it again.
  // Storage can be blocked or throw (private windows, cleared site data); then the sheet is simply shown.
  let seenHelp = false
  try {
    seenHelp = Boolean(localStorage.getItem('botsbay.seen-help') || localStorage.getItem('botcrossing.seen-help'))
    if (!seenHelp) localStorage.setItem('botsbay.seen-help', '1')
  } catch {
    /* the sheet comes back next time, which beats not opening at all */
  }
  if (!seenHelp) {
    hud.toggleHelp(true)
  } else {
    hud.hint('Drag to move · click a builder · H hides everything', 5200)
  }
}

// ── settings plumbing ─────────────────────────────────────────────────────────────────

settings.onChange((changed, scope) => {
  // Kept in the colony file as well as in this browser's own storage. `localStorage` is
  // per *origin*, so a dev server that comes back on a different port looks to the browser
  // like a different site and hands you factory settings — the file does not care.
  state.settings = { ...settings.values }
  queueSave()
  if (scope.render || changed.has('fov')) engine.applySettings()
  colony.onSettingsChanged(changed, scope)
  if (changed.has('showFps')) hud.syncSettings()
  // Folding dormant repos away changes which threads are on the map, so the colony has to be
  // rebuilt from the list rather than merely re-rendered.
  // A new world can mean a new zone palette, so the plots have to be rebuilt rather than
  // merely re-lit — and waiting for the next poll to do it would leave the old colours up
  // for as long as fifteen seconds.
  if (changed.has('planet')) applyThreads(threads)
  if (changed.has('hideDormant')) applyThreads(threads)
  if (changed.has('maxAgents')) applyThreads(threads)
})

// ── frame ─────────────────────────────────────────────────────────────────────────────

engine.add({
  update(dt, elapsed) {
    rig.update(dt)
    colony.update(dt, elapsed, rig.target)
    // Whatever the camera is orbiting is what should be in focus.
    engine.setFocusDistance(rig.distance)

    if (selectedId) {
      hud.updateAvatar(colony.astronauts.faceTexture.image)
      // A selected astronaut that walked off the roster should not keep a stale card open.
      const agent = colony.agentFor(selectedId)
      if (!agent) select(null, {})
      else hud.placeCard(screenOf(agent))
    }
    hud.setFps(engine.perf, engine.viewport, `${colony.astronauts.visibleCount} builders · ${colony.particles.liveCount} bits`)
  },
})

engine.start()
boot()

// Handy for poking at the running island from the console. The old name still answers.
window.botsBay = { engine, rig, colony, settings, hud, poll: () => poll({ force: true }), get threads() { return threads } }
window.botCrossing = window.botsBay

/** `execCommand('copy')` over a throwaway textarea — the copy that predates permissions. */
function copyFallback(text) {
  const el = document.createElement('textarea')
  el.value = text
  el.setAttribute('readonly', '')
  el.style.cssText = 'position:fixed;top:0;opacity:0;pointer-events:none'
  document.body.appendChild(el)
  el.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  el.remove()
  return ok
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}
