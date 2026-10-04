import { PRESETS, PLANETS_ORDER, STATUS_FILTERS, filterThreads, shortPath } from './hud-data.js'
import { PLANETS } from '../world/planet.js'
import { TIMES, systemTimeOfDay, WORLD_TIMEZONE } from '../world/sky.js'
import { STATUS_LABEL } from '../game/colony.js'
import { FACE, FRAME_COLS, FRAME_ROWS } from '../agents/faces.js'
import { PLOT_PALETTE, hashString } from '../world/plots.js'

/**
 * The whole HUD, in plain DOM.
 *
 * Deliberately not a framework: this sits on top of a render loop that must not miss a
 * frame, so the UI only ever touches the DOM when something it shows has actually changed —
 * every setter compares against the last value it wrote and returns early otherwise.
 *
 * The one hard rule is that all of this is optional. Pressing H hides every panel, and the
 * game stays fully readable because status lives above the astronauts' heads in the scene,
 * not in here.
 */

/**
 * The page only ever runs on the machine the server is on — it answers nothing else — so the
 * browser's OS is the server's OS, and the name of the thing that shows a folder can be read
 * here rather than asked for.
 */
const IS_MAC = /Mac/.test(navigator.platform)
const FILE_MANAGER = IS_MAC ? 'Finder' : /Win/.test(navigator.platform) ? 'Explorer' : 'Files'

const ICON = {
  settings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  eye: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`,
  eyeOff: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c6.5 0 10 7 10 7a18.5 18.5 0 0 1-2.16 3.19M6.6 6.6C4.06 8.2 2 11 2 11s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24M2 2l20 20"/></svg>`,
  home: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h14V9.5"/><path d="M9.5 20v-6h5v6"/></svg>`,
  next: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4.5M12 16h.01"/></svg>`,
  sun: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`,
  globe: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"/></svg>`,
  camera: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M3 8.5h3.2l1.5-2h8.6l1.5 2H21v11H3z"/><circle cx="12" cy="14" r="3.4"/></svg>`,
  help: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .8-1 1.6v.4"/><path d="M12 17h.01"/></svg>`,
  open: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-8.5 8.5"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>`,
  retry: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-.6 4"/><path d="M20 5v6h-6"/></svg>`,
  archive: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18v3H3z"/><path d="M5 9v10h14V9"/><path d="M10 13h4"/></svg>`,
  close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  back: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 5.5 8 12l6.5 6.5"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 11.7a8 8 0 0 1-8.5 8 9.3 9.3 0 0 1-2.7-.4L4.5 21l1.4-4.1a7.9 7.9 0 0 1-2.4-5.7A8 8 0 0 1 12 3.6a8 8 0 0 1 8.5 8.1z"/><path d="M12 8.6v5.4M9.3 11.3h5.4"/></svg>`,
  folder: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.4A1.4 1.4 0 0 1 4.4 6h4.2l2 2.5h7A1.4 1.4 0 0 1 19 9.9v7.7a1.4 1.4 0 0 1-1.4 1.4H4.4A1.4 1.4 0 0 1 3 17.6z"/></svg>`,
  copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>`,
  locate: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7.6"/><path d="M12 1.8v2.6M12 19.6v2.6M1.8 12h2.6M19.6 12h2.6"/></svg>`,
  orbit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="4"/><ellipse cx="12" cy="12" rx="10.2" ry="4.6" transform="rotate(-24 12 12)"/><circle cx="21" cy="8.2" r="1.5" fill="currentColor" stroke="none"/></svg>`,
}

/** The most rows the search results or the archived list will draw at once. */
const RESULT_CAP = 150

const STAT_DEFS = [
  { key: 'working', label: 'building', cls: 'working' },
  { key: 'waiting', label: 'need you', cls: 'waiting' },
  { key: 'blocked', label: 'blocked', cls: 'blocked' },
  { key: 'celebrating', label: 'shipped', cls: 'done' },
  { key: 'agents', label: 'builders', cls: 'idle' },
]

export class Hud {
  constructor(root, settings, actions) {
    this.settings = settings
    this.actions = actions
    this.visible = true
    this._last = {}
    this.hiddenOpen = false

    this.el = document.createElement('div')
    this.el.className = 'hud'
    this.el.innerHTML = TEMPLATE
    root.appendChild(this.el)

    this.$ = (sel) => this.el.querySelector(sel)
    // Icon-only buttons say what they do in `title`, which is not a name a screen reader reads
    // reliably. The shortcut in brackets stays in the tooltip and out of the name.
    for (const b of this.el.querySelectorAll('button[title]:not([aria-label])')) {
      if (!b.textContent.trim()) b.setAttribute('aria-label', b.title.replace(/\s*\(.*\)$/, ''))
    }

    this.health = null
    this.coverage = null
    this.asleepOpen = false
    this.archivedOpen = false

    // The search block: what was typed, which chips are on, and every thread to search through.
    this.find = { query: '', sources: new Set(), statuses: new Set() }
    this.directory = []
    this.archived = []
    this.selectedId = null

    this._buildStats()
    this._buildSettings()
    this._buildAvatar()
    this._buildFind()
    this._wire()
    this.syncSettings()
    // "Updated 12s ago" has to keep counting between polls, or it reads as fresh for as long as
    // nothing changes — which is exactly when it matters.
    setInterval(() => this._renderHealth(), 5000)
  }

  // ── construction ────────────────────────────────────────────────────────────────────

  _buildStats() {
    const wrap = this.$('.stats')
    this.statEls = {}
    for (const def of STAT_DEFS) {
      const b = document.createElement('button')
      b.className = `stat ${def.cls}`
      b.type = 'button'
      b.dataset.key = def.key
      b.title =
        def.key === 'agents'
          ? 'Builders on the island right now. Click to fly to the next one'
          : `Fly to the next builder that is ${def.label}`
      // The label is hidden at narrow widths and the pip is only a colour, so the button says
      // the whole thing itself — and `setStats` keeps the number in it current.
      b.setAttribute('aria-label', `0 ${def.label}`)
      b.innerHTML = `<i class="pip" aria-hidden="true"></i><span class="n">0</span><span class="lbl">${def.label}</span>`
      b.type = 'button'
      b.addEventListener('click', () => this.actions.focusStatus?.(def.key))
      wrap.appendChild(b)
      this.statEls[def.key] = b
    }
  }

  /**
   * The search box and its chips. The status chips never change; the source chips are drawn
   * from whichever harnesses the directory turns out to hold, so an install with only Claude
   * Code has one chip and one with n8n beside it has two.
   */
  _buildFind() {
    const wrap = this.$('.find .status-chips')
    this.statusChips = new Map()
    for (const def of STATUS_FILTERS) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = `chip ${statusClass(def.id)}`
      b.title = def.title
      b.setAttribute('aria-pressed', 'false')
      b.innerHTML = `<span>${def.label}</span><span class="c"></span>`
      b.addEventListener('click', () => this._toggleFilter(this.find.statuses, def.id))
      wrap.appendChild(b)
      this.statusChips.set(def.id, b)
    }

    const input = this.$('#find-q')
    // Typing rewrites a list of up to four hundred rows. Waiting for a pause costs nothing a
    // person can feel and saves doing it once per letter.
    input.addEventListener('input', () => {
      this.find.query = input.value
      clearTimeout(this._findTimer)
      this._findTimer = setTimeout(() => this._renderResults(), 100)
    })
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        this.clearSearch()
        input.blur()
      } else if (e.key === 'Enter') {
        // Straight to the best match, the way a command palette would.
        this.$('.results .thread')?.click()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        this.$('.results .thread')?.focus()
      }
    })
    this.$('#btn-find-clear').addEventListener('click', () => this.clearSearch())
  }

  _buildSettings() {
    const body = this.$('.settings .body')
    const s = this.settings
    this.controls = []

    // Quality presets.
    body.appendChild(
      group(
        'Quality preset',
        chips(
          Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label, title: p.hint })),
          () => s.get('preset'),
          (id) => s.applyPreset(id),
          this.controls
        )
      )
    )

    // Performance.
    const perf = group('Performance')
    perf.append(
      this._toggle('HDR + bloom', 'bloom', 'Glowing eyes, lamps and windows. The first thing to drop.'),
      this._toggle('Tilt-shift', 'tiltShift', 'A shallow depth of field, which is what makes the island read as a model.'),
      this._slider(
        'Tilt-shift blur',
        'tiltShiftStrength',
        0,
        1,
        0.05,
        (v) => `${Math.round(v * 100)}%`,
        'Aperture: how shallow the focus is, and how far out of it things go.'
      ),
      this._slider(
        'Tilt-shift angle',
        'tiltShiftAngle',
        -90,
        90,
        1,
        (v) => `${v}°`,
        'Swings the plane of focus, the way tilting a real lens does.'
      ),
      this._select('Shadows', 'shadows', [
        ['off', 'Off'],
        ['low', 'Low'],
        ['high', 'High'],
        ['ultra', 'Ultra'],
      ]),
      this._select('Particles', 'particles', [
        ['off', 'Off'],
        ['low', 'Low'],
        ['full', 'Full'],
      ]),
      this._select('Textures', 'textureQuality', [
        ['low', 'Low'],
        ['medium', 'Medium'],
        ['high', 'High'],
        ['ultra', 'Ultra'],
      ]),
      this._select('Ground detail', 'groundDetail', [
        ['low', 'Low'],
        ['medium', 'Medium'],
        ['high', 'High'],
      ]),
      this._toggle('Anti-aliasing', 'antialias', 'SMAA pass. Cheap, but not free.'),
      this._slider(
        'Render scale',
        'renderScale',
        0.35,
        2,
        0.05,
        (v) => `${Math.round(v * 100)}%`,
        '100% is your display’s own resolution, retina included.'
      ),
      this._toggle('Adaptive quality', 'autoQuality', 'Quietly drops render scale if frames get expensive.'),
      this._slider('Scatter', 'scatterDensity', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
      this._slider('Max builders', 'maxAgents', 10, 200, 10, (v) => String(v)),
      this._toggle('Stars', 'stars')
    )
    body.appendChild(perf)

    // World.
    const world = group('World')
    const planets = document.createElement('div')
    planets.className = 'planets'
    for (const id of PLANETS_ORDER) {
      const planet = PLANETS[id]
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'planet'
      b.title = planet.blurb
      const c1 = hex(planet.ground.high)
      const c2 = hex(planet.ground.low)
      b.innerHTML = `<i class="orb" style="background:radial-gradient(circle at 33% 30%, ${c1}, ${c2})"></i><span>${planet.name}</span>`
      b.addEventListener('click', () => this.settings.set('planet', id))
      planets.appendChild(b)
      this.controls.push({ el: b, sync: () => b.setAttribute('aria-pressed', String(this.settings.get('planet') === id)) })
    }
    world.appendChild(planets)
    body.appendChild(world)

    // Lighting.
    const light = group('Lighting')
    light.append(
      chips(
        // `Live` is a time of day like the others from where you are standing, so it belongs
        // in the same row rather than in a toggle further down.
        [...TIMES.map((t) => ({ id: t.id, label: t.label })), { id: 'live', label: 'Live' }],
        () => (this.settings.get('clockTime') ? 'live' : nearestTime(this.settings.get('timeOfDay'))),
        (id) => {
          this.settings.set('autoTime', false)
          this.settings.set('clockTime', id === 'live')
          if (id === 'live') this.settings.set('timeOfDay', systemTimeOfDay())
          else this.settings.set('timeOfDay', TIMES.find((t) => t.id === id).value)
        },
        this.controls
      ),
      this._toggle(
        'Follow local clock',
        'clockTime',
        `The sky runs on Bahrain time (${WORLD_TIMEZONE}), wherever you are opening this from. Pressing L or dragging the scrubber turns it off; this is how it comes back.`
      ),
      this._slider('Time of day', 'timeOfDay', 0, 1, 0.005, clockLabel, undefined, () => {
        // Reaching for the slider is a request for a particular light, so stop following the
        // clock — otherwise the next frame would drag the thumb straight back.
        this.settings.set('clockTime', false)
      }),
      this._toggle(
        'Cycle day/night',
        'autoTime',
        'Runs the clock forward on its own. Ignored while the sky is following this machine’s clock.'
      ),
      this._slider('Cycle length', 'dayLength', 30, 900, 30, (v) => `${Math.round(v / 60)}m`),
      this._toggle(
        'Environment light',
        'ibl',
        'Image-based lighting taken from this world’s own sky. Metals get something to reflect.'
      ),
      this._slider('Environment', 'iblIntensity', 0, 2, 0.05, (v) => v.toFixed(2)),
      this._slider('Exposure', 'exposure', 0.4, 2, 0.05, (v) => v.toFixed(2)),
      this._slider('Bloom', 'bloomStrength', 0, 1.6, 0.02, (v) => v.toFixed(2))
    )
    body.appendChild(light)

    // View.
    const view = group('View')
    view.append(
      this._toggle(
        'Hide dormant threads',
        'hideDormant',
        'Leaves anything quiet for three days off the map, and folds a zone away entirely when nothing in it is awake. Nothing is touched in the harness, and it all comes back to the same ground the moment something stirs.'
      )
    )
    view.append(
      this._toggle('Return to isometric', 'autoFrame', 'Eases the angle back when you stop dragging.'),
      this._slider('Field of view', 'fov', 20, 60, 1, (v) => `${v}°`),
      this._toggle('Project labels', 'showLabels'),
      this._toggle('Reduced motion', 'reducedMotion', 'Calms the bobbing and the camera easing.'),
      this._toggle('Show FPS', 'showFps')
    )
    body.appendChild(view)
  }

  _row(label, hint) {
    const row = document.createElement('div')
    row.className = 'row'
    const l = document.createElement('div')
    l.className = 'label'
    l.innerHTML = `<span>${label}</span>${hint ? `<span class="hint">${hint}</span>` : ''}`
    row.appendChild(l)
    return row
  }

  _toggle(label, key, hint) {
    const row = this._row(label, hint)
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'toggle'
    b.setAttribute('role', 'switch')
    b.setAttribute('aria-label', label)
    b.addEventListener('click', () => this.settings.set(key, !this.settings.get(key)))
    row.appendChild(b)
    this.controls.push({
      el: row,
      sync: () => {
        b.setAttribute('aria-checked', String(Boolean(this.settings.get(key))))
        row.classList.toggle('overridden', this.settings.isOverridden(key))
      },
    })
    return row
  }

  _select(label, key, options, hint) {
    const row = this._row(label, hint)
    const sel = document.createElement('select')
    sel.className = 'select'
    sel.setAttribute('aria-label', label)
    for (const [value, text] of options) {
      const o = document.createElement('option')
      o.value = value
      o.textContent = text
      sel.appendChild(o)
    }
    sel.addEventListener('change', () => this.settings.set(key, sel.value))
    row.appendChild(sel)
    this.controls.push({
      el: row,
      sync: () => {
        sel.value = String(this.settings.get(key))
        row.classList.toggle('overridden', this.settings.isOverridden(key))
      },
    })
    return row
  }

  _slider(label, key, min, max, step, format, hint, onInput) {
    const row = this._row(label, hint)
    const wrap = document.createElement('div')
    wrap.style.cssText = 'display:flex;align-items:center;gap:8px'
    const input = document.createElement('input')
    input.type = 'range'
    input.className = 'slider'
    input.setAttribute('aria-label', label)
    input.min = min
    input.max = max
    input.step = step
    const out = document.createElement('span')
    out.className = 'value'
    input.addEventListener('input', () => {
      onInput?.()
      this.settings.set(key, Number(input.value))
    })
    wrap.append(input, out)
    row.appendChild(wrap)
    this.controls.push({
      el: row,
      sync: () => {
        const v = Number(this.settings.get(key))
        // Never fight the thumb the user is dragging.
        if (document.activeElement !== input) input.value = String(v)
        out.textContent = format(v)
        row.classList.toggle('overridden', this.settings.isOverridden(key))
      },
    })
    return row
  }

  /** The little face on the agent card, drawn from the same atlas the astronauts use. */
  _buildAvatar() {
    const canvas = this.$('.thread-pop .avatar canvas')
    canvas.width = 108
    canvas.height = 108
    this.avatarCtx = canvas.getContext('2d')
    this.avatarTmp = document.createElement('canvas')
    this.avatarTmp.width = 108
    this.avatarTmp.height = 108
    this.avatarTmpCtx = this.avatarTmp.getContext('2d')
    this._avatarState = { frame: -1, color: '' }
  }

  _wire() {
    const on = (sel, ev, fn) => this.$(sel).addEventListener(ev, fn)

    on('#btn-settings', 'click', () => this.toggleSettings())
    on('#btn-close-settings', 'click', () => this.toggleSettings(false))
    on('#btn-hide', 'click', () => this.toggleUi())
    on('#btn-help', 'click', () => this.toggleHelp())
    on('#btn-shot', 'click', () => this.actions.screenshot?.())
    on('#btn-home', 'click', () => this.actions.resetView?.())
    on('#btn-next', 'click', () => this.actions.focusStatus?.('waiting'))
    on('#btn-orbit', 'click', () => this.setOrbit(this.actions.toggleOrbit?.()))
    on('#btn-planet', 'click', () => this.actions.cyclePlanet?.())
    on('#btn-time', 'click', () => this.actions.cycleTime?.())
    on('#btn-open', 'click', () => this.actions.openThread?.())
    on('#btn-viewed', 'click', () => this.actions.markViewed?.())
    on('#btn-retry', 'click', () => this.actions.retryThread?.())
    on('#btn-archive', 'click', () => this.actions.archiveThread?.())
    on('#btn-deselect', 'click', () => this.actions.select?.(null))
    on('#btn-new-session', 'click', () => this.actions.newConversation?.())
    on('#btn-reveal', 'click', () => this.actions.revealProject?.())
    on('#btn-copy-path', 'click', () => this.actions.copyProjectPath?.())
    on('#btn-hide-project', 'click', () => this.actions.hideProject?.())
    on('#btn-hidden-toggle', 'click', () => this.toggleHiddenList())
    on('#btn-archived-toggle', 'click', () => this.toggleArchivedList())
    on('#btn-locate', 'click', () => this.actions.focusProject?.(this.project?.name))
    on('#btn-close-project', 'click', () => this.actions.closeProject?.())
    on('.help', 'click', (e) => {
      if (e.target === this.$('.help')) this.toggleHelp(false)
    })
    this.$('.help .sheet').addEventListener('click', (e) => e.stopPropagation())
    on('#btn-help-close', 'click', () => this.toggleHelp(false))

    this.settings.onChange(() => this.syncSettings())
  }

  // ── state in ────────────────────────────────────────────────────────────────────────

  syncSettings() {
    for (const c of this.controls) c.sync()
    this.$('.fps').classList.toggle('on', Boolean(this.settings.get('showFps')))
  }

  setStats(stats) {
    for (const def of STAT_DEFS) {
      const n = stats[def.key] ?? 0
      const el = this.statEls[def.key]
      if (this._last['stat:' + def.key] === n) continue
      this._last['stat:' + def.key] = n
      el.querySelector('.n').textContent = String(n)
      el.dataset.empty = String(n === 0)
      el.setAttribute('aria-label', `${n} ${def.label}`)
    }
  }

  /**
   * "76 of 387 on the map · 308 dormant · 3 over capacity", under the counters. Hidden when
   * everything is on the map, because a line that always says "445 of 445" is a line nobody
   * reads when it stops being true.
   *
   * The two reasons are told apart because they are different facts. Dormant is a rule — nothing
   * for three days, and left off on purpose — while over capacity is the island running out of
   * builders or building slots, and the thing worth knowing about if it is not zero.
   */
  setCoverage(coverage) {
    this.coverage = coverage
    const el = this.$('.scan .coverage')
    const partial = Boolean(coverage) && coverage.shown < coverage.total
    const bits = []
    if (partial) {
      if (coverage.dormant) bits.push(`${coverage.dormant} dormant`)
      if (coverage.over) bits.push(`${coverage.over} over capacity`)
    }
    const text = partial ? `${coverage.shown} of ${coverage.total} on the map${bits.length ? ` · ${bits.join(' · ')}` : ''}` : ''
    if (this._last.coverage === text) return
    this._last.coverage = text
    el.textContent = text
    el.hidden = !partial
    el.title = partial
      ? 'On the map is the number of builders you can see. Dormant threads have been quiet for three days. Over capacity means the crew is capped or the zone is out of building slots — those are listed under Asleep in each zone. Search finds every one of them.'
      : ''
  }

  /**
   * What the last poll said about itself: when it ran, which harnesses could not be read, and
   * whether it failed outright. `ok: false` keeps the previous `scannedAt` and warnings, since
   * the map is still showing that picture and the note's job is to say how old it is.
   */
  setHealth(next) {
    const prev = this.health || {}
    this.health = next.ok
      ? { ok: true, warnings: next.warnings, scannedAt: next.scannedAt, stale: next.stale }
      : { ...prev, ok: false, error: next.error }
    this._renderHealth()
  }

  _renderHealth() {
    const h = this.health
    if (!h) return
    const age = h.scannedAt ? Math.max(0, (Date.now() - h.scannedAt) / 1000) : null
    const notes = []
    if (!h.ok) notes.push(`Offline — ${h.error || 'no answer'}`)
    if (age !== null) {
      notes.push(h.ok ? `updated ${age < 5 ? 'just now' : `${duration(age)} ago`}` : `showing the scan from ${duration(age)} ago`)
    }
    if (h.ok && h.stale) notes.push('some n8n data is out of date')
    const amber = !h.ok || (age !== null && age > 60) || Boolean(h.stale)
    const warnings = h.warnings || []
    const signature = `${notes.join('|')}~${amber}~${warnings.join('|')}`
    if (this._last.health === signature) return
    this._last.health = signature

    const fresh = this.$('.scan .fresh')
    fresh.textContent = notes.join(' · ')
    fresh.classList.toggle('amber', amber)
    const warns = this.$('.scan .warns')
    warns.innerHTML = warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')
    warns.hidden = warnings.length === 0
  }

  /**
   * Every repo, in the sidebar. This was a strip of chips along the bottom of the screen;
   * it is a list now because the sidebar is where all the chrome lives, and because a list
   * can carry a count and an alarm without running out of room at eleven repos.
   */
  setLegend(projects, activeName = null, hidden = [], folded = []) {
    const signature =
      projects.map((p) => `${p.name}:${p.drawn}/${p.count}:${p.accent}:${p.urgent ? 1 : 0}`).join('|') +
      `~${activeName}~` +
      hidden.map((p) => `${p.name}:${p.count}`).join('|') +
      `~${folded.length}`
    if (this._last.legend === signature) return
    this._last.legend = signature

    const wrap = this.$('.projects')
    wrap.innerHTML = ''
    for (const p of projects) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'repo'
      const partial = p.drawn !== undefined && p.drawn < p.count
      b.title = partial
        ? `${p.drawn} of ${p.count} threads drawn in ${p.name}`
        : `${p.count} thread${p.count === 1 ? '' : 's'} in ${p.name}`
      b.setAttribute('aria-pressed', String(p.name === activeName))
      b.innerHTML =
        `<i class="swatch" style="background:${hex(p.accent)};color:${hex(p.accent)}"></i>` +
        `<span class="n">${escapeHtml(p.name)}</span>` +
        (p.urgent ? '<i class="alarm"></i>' : '') +
        `<span class="count">${partial ? `${p.drawn} / ${p.count}` : p.count}</span>`
      b.addEventListener('click', () => this.actions.pickProject?.(p.name))
      wrap.appendChild(b)
    }
    this.$('.sec-head span').textContent = `${projects.length} zone${projects.length === 1 ? '' : 's'}`

    // The hidden list is its own block at the foot of the sidebar: collapsed by default, because
    // the whole point of hiding a repo is not to look at it.
    const block = this.$('.hidden-block')
    block.hidden = hidden.length === 0 && folded.length === 0
    const hiddenWrap = this.$('.hidden-projects')
    hiddenWrap.innerHTML = ''
    for (const p of hidden) {
      // Same palette the colony is drawing with, or a hidden repo shows a swatch in a
      // colour that world does not use.
      const palette = PLANETS[this.settings.get('planet')]?.palette ?? PLOT_PALETTE
      const accent = palette[hashString(p.name) % palette.length]
      const row = document.createElement('div')
      row.className = 'repo hidden-repo'
      row.innerHTML =
        `<i class="swatch" style="background:${hex(accent)};color:${hex(accent)}"></i>` +
        `<span class="n">${escapeHtml(p.name)}</span>` +
        `<span class="count">${p.count}</span>`
      const show = document.createElement('button')
      show.type = 'button'
      show.className = 'btn ghost show-repo'
      show.title = `Show ${p.name} on the map again`
      show.textContent = 'Show'
      show.addEventListener('click', () => this.actions.unhideProject?.(p.name))
      row.appendChild(show)
      hiddenWrap.appendChild(row)
    }

    // The dormant fold gets one line rather than a row each: it is a setting, not a list of
    // decisions, and the thing worth offering is the way back rather than per-repo control.
    if (folded.length) {
      const n = folded.reduce((sum, p) => sum + p.count, 0)
      const row = document.createElement('div')
      row.className = 'repo hidden-repo folded-note'
      row.innerHTML =
        `<span class="n">${folded.length} quiet zone${folded.length === 1 ? '' : 's'}` +
        `, ${n} thread${n === 1 ? '' : 's'}</span>`
      const show = document.createElement('button')
      show.type = 'button'
      show.className = 'btn ghost show-repo'
      show.title = 'Put dormant zones back on the map'
      show.textContent = 'Show'
      show.addEventListener('click', () => this.settings.set('hideDormant', false))
      row.appendChild(show)
      hiddenWrap.appendChild(row)
    }

    const total = hidden.length + folded.length
    this.$('#btn-hidden-toggle .label').textContent = `${total} off the map`
    this._syncHiddenList()
  }

  toggleHiddenList() {
    this.hiddenOpen = !this.hiddenOpen
    this._syncHiddenList()
  }

  _syncHiddenList() {
    this.$('#btn-hidden-toggle').setAttribute('aria-expanded', String(this.hiddenOpen))
    this.$('.hidden-projects').hidden = !this.hiddenOpen
  }

  /**
   * Every thread the colony knows about, drawn or not — what the search box looks through.
   * Called on every poll with the whole list, so it only does work when something in it moved.
   */
  setDirectory(items) {
    // The minute is in the signature for the same reason it is in `setProject`'s: the rows say
    // "4m ago", and a list nobody touched should not keep saying it for an hour.
    const signature =
      `${Math.floor(Date.now() / 60000)}~` +
      items.map((t) => `${t.id}:${t.status}:${t.title}:${t.drawn ? 1 : 0}:${t.lastActivityAt}:${t.lastRunAt}`).join('|')
    if (this._last.directory === signature) return
    this._last.directory = signature
    this.directory = items

    const sources = new Map()
    for (const t of items) if (t.harness && !sources.has(t.harness)) sources.set(t.harness, t.harnessName || t.harness)
    // A chip for a harness that has gone cannot be un-pressed, and would filter everything out.
    for (const id of [...this.find.sources]) if (!sources.has(id)) this.find.sources.delete(id)
    const sourceKey = [...sources].map(([id, name]) => `${id}:${name}`).join('|')
    if (this._last.sourceChips !== sourceKey) {
      this._last.sourceChips = sourceKey
      const wrap = this.$('.find .source-chips')
      wrap.innerHTML = ''
      this.sourceChips = new Map()
      for (const [id, name] of sources) {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'chip'
        b.title = `Only threads from ${name}`
        b.setAttribute('aria-pressed', 'false')
        b.innerHTML = `<span>${escapeHtml(name)}</span><span class="c"></span>`
        b.addEventListener('click', () => this._toggleFilter(this.find.sources, id))
        wrap.appendChild(b)
        this.sourceChips.set(id, b)
      }
      // One harness needs no chip: there is nothing to tell apart.
      wrap.hidden = sources.size < 2
    }

    const counts = new Map()
    for (const t of items) {
      counts.set(t.status, (counts.get(t.status) ?? 0) + 1)
      counts.set(`src:${t.harness}`, (counts.get(`src:${t.harness}`) ?? 0) + 1)
    }
    for (const [id, b] of this.statusChips) b.querySelector('.c').textContent = String(counts.get(id) ?? 0)
    for (const [id, b] of this.sourceChips || []) b.querySelector('.c').textContent = String(counts.get(`src:${id}`) ?? 0)
    this._renderResults()
  }

  _toggleFilter(set, id) {
    if (!set.delete(id)) set.add(id)
    this._renderResults()
  }

  /** True when the search block is narrowing the list at all. */
  get searching() {
    const f = this.find
    return Boolean(f.query.trim()) || f.sources.size > 0 || f.statuses.size > 0
  }

  _renderResults() {
    clearTimeout(this._findTimer)
    const f = this.find
    const active = this.searching
    this.$('.side').classList.toggle('searching', active)
    this.$('#btn-find-clear').hidden = !active
    for (const [id, b] of this.statusChips) b.setAttribute('aria-pressed', String(f.statuses.has(id)))
    for (const [id, b] of this.sourceChips || []) b.setAttribute('aria-pressed', String(f.sources.has(id)))

    const list = this.$('.results')
    const meta = this.$('.find .find-meta')
    if (!active) {
      this._last.results = null
      meta.textContent = ''
      list.innerHTML = ''
      return
    }

    const signature = `${this._last.directory}~${JSON.stringify([f.query, [...f.sources], [...f.statuses]])}`
    if (this._last.results === signature) return
    this._last.results = signature

    const hits = filterThreads(this.directory, f)
    const shown = hits.slice(0, RESULT_CAP)
    meta.textContent = `${hits.length} of ${this.directory.length} thread${this.directory.length === 1 ? '' : 's'}`
    list.innerHTML = ''
    if (!hits.length) {
      list.innerHTML = '<div class="empty">Nothing matches. Check the spelling, or clear a filter.</div>'
      return
    }
    for (const t of shown) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = `thread ${statusClass(t.status)}${t.drawn ? '' : ' nodraw'}`
      b.dataset.id = t.id
      b.setAttribute('aria-pressed', String(t.id === this.selectedId))
      b.title = t.drawn
        ? `${STATUS_LABEL[t.status] || t.status} — fly to its builder`
        : `${STATUS_LABEL[t.status] || t.status} — no builder on the island, open it in ${t.harnessName || 'its harness'}`
      b.innerHTML =
        pipHtml(t.status) +
        `<span class="t">${escapeHtml(t.title || 'Untitled thread')}</span>` +
        `<span class="when">${whenLabel(t)}</span>` +
        (t.drawn ? '' : '<span class="open">Open</span>') +
        `<span class="wt">${escapeHtml(t.project || 'unknown')} · ${escapeHtml(t.harnessName || t.harness || '')}</span>`
      b.addEventListener('click', () => (t.drawn ? this.actions.focusThread?.(t.id) : this.actions.openById?.(t.id)))
      list.appendChild(b)
    }
    if (hits.length > shown.length) {
      const more = document.createElement('div')
      more.className = 'empty'
      more.textContent = `${hits.length - shown.length} more — type or filter further to narrow it down`
      list.appendChild(more)
    }
  }

  /** Put the cursor in the search box, bringing the chrome back first if H had hidden it. */
  focusSearch() {
    if (!this.visible) this.toggleUi(true)
    const input = this.$('#find-q')
    input.focus()
    input.select()
  }

  /** Empty the search box and turn every chip off. Says whether there was anything to clear. */
  clearSearch() {
    const had = this.searching
    this.find.query = ''
    this.find.sources.clear()
    this.find.statuses.clear()
    this.$('#find-q').value = ''
    this._renderResults()
    return had
  }

  /**
   * What you have archived, so it can come back. Colony-only, like the archive itself: the
   * list is `state.archived`, and Unarchive removes from it and nothing else.
   */
  setArchived(list) {
    const signature = list.map((a) => `${a.id}:${a.title}`).join('|')
    if (this._last.archived === signature) return
    this._last.archived = signature
    this.archived = list

    this.$('.archived-block').hidden = list.length === 0
    this.$('#btn-archived-toggle .label').textContent = `Archived (${list.length})`
    const wrap = this.$('.archived-list')
    wrap.innerHTML = ''
    for (const a of list.slice(0, RESULT_CAP)) {
      const row = document.createElement('div')
      row.className = 'repo hidden-repo'
      row.title = a.project ? `${a.title} — ${a.project}` : a.title
      row.innerHTML = `<span class="n">${escapeHtml(a.title)}</span>`
      const undo = document.createElement('button')
      undo.type = 'button'
      undo.className = 'btn ghost show-repo'
      undo.title = `Put ${a.title} back on the island`
      undo.setAttribute('aria-label', `Unarchive ${a.title}`)
      undo.textContent = 'Unarchive'
      undo.addEventListener('click', () => this.actions.unarchiveThread?.(a.id))
      row.appendChild(undo)
      wrap.appendChild(row)
    }
    this._syncArchivedList()
  }

  toggleArchivedList() {
    this.archivedOpen = !this.archivedOpen
    this._syncArchivedList()
  }

  _syncArchivedList() {
    this.$('#btn-archived-toggle').setAttribute('aria-expanded', String(this.archivedOpen))
    this.$('.archived-list').hidden = !this.archivedOpen
  }

  /**
   * The project sidebar: what a zone is, and the things you can do to the *repo* rather
   * than to one thread in it. Opened by clicking a zone, its name plate, its legend chip,
   * or any astronaut standing on it.
   */
  setProject(project) {
    const panel = this.$('.side')
    if (!project) {
      this.project = null
      if (this._last.project === null) return
      this._last.project = null
      panel.classList.remove('drilled')
      return
    }

    this.project = project
    // The minute is part of the signature because `ago()` is: without it a repo where
    // nothing is happening keeps whatever "4m ago" it was first drawn with, for as long as
    // you leave the panel open.
    const signature =
      `${project.name}~${project.path}~${project.accent}~${project.selectedId}~${Math.floor(Date.now() / 60000)}~` +
      `${this.asleepOpen ? 1 : 0}~` +
      project.threads.map((t) => `${t.id}:${t.status}:${t.title}:${t.lastActivityAt}:${t.lastRunAt}:${t.drawn ? 1 : 0}`).join('|')
    panel.classList.add('drilled')
    if (this._last.project === signature) return
    this._last.project = signature

    const swatch = this.$('.side .who .swatch')
    swatch.style.background = hex(project.accent)
    swatch.style.color = hex(project.accent) // the halo is `currentColor`
    this.$('.side .name').textContent = project.name
    const path = this.$('.side .path')
    path.textContent = project.path ? shortPath(project.path) : 'folder unknown'
    path.title = project.path || ''
    // Nothing to open a new thread in, and nothing to reveal, without a folder on disk.
    this.$('#btn-new-session').disabled = !project.path
    this.$('#btn-reveal').disabled = !project.path
    this.$('#btn-copy-path').disabled = !project.path

    // Only threads with a builder get a row that can fly anywhere. The rest go in a group of
    // their own, below, where the row does the one thing it can.
    const drawn = project.threads.filter((t) => t.drawn)
    const asleep = project.threads.filter((t) => !t.drawn)
    const n = project.threads.length
    const waiting = project.threads.filter((t) => t.status === 'waiting' || t.status === 'blocked').length
    this.$('.side .threads-head').innerHTML =
      `<span>${asleep.length ? `${drawn.length} / ${n}` : n} thread${n === 1 ? '' : 's'}</span>` +
      (waiting ? `<span class="want">${waiting} need you</span>` : '')

    const list = this.$('.side .threads')
    // A poll rewrites these rows every time a live thread's timestamp moves. Losing your
    // place in a forty-thread repo every fifteen seconds would make the list unusable.
    const scroll = list.scrollTop
    list.innerHTML = ''
    for (const t of drawn) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = `thread ${statusClass(t.status)}`
      b.setAttribute('aria-pressed', String(t.id === project.selectedId))
      b.title = STATUS_LABEL[t.status] || t.status
      b.innerHTML =
        pipHtml(t.status) +
        `<span class="t">${escapeHtml(t.title || 'Untitled thread')}</span>` +
        `<span class="when">${whenLabel(t)}</span>` +
        (t.worktree ? `<span class="wt">⑂ ${escapeHtml(t.worktree)}</span>` : '')
      b.addEventListener('click', () => this.actions.focusThread?.(t.id))
      list.appendChild(b)
      // A long repo can hide the astronaut you just clicked in the world. Scrolled by hand
      // rather than with `scrollIntoView`, which walks up the ancestors and will happily
      // scroll the *page* — and a page that can scroll at all is one keystroke away from
      // the whole HUD sitting sideways with nothing to put it back.
      if (t.id === project.selectedId && this._scrolledTo !== t.id) {
        this._scrolledTo = t.id
        const row = b
        requestAnimationFrame(() => {
          const top = row.offsetTop
          const bottom = top + row.offsetHeight
          if (top < list.scrollTop) list.scrollTop = top
          else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight
        })
      }
    }

    if (asleep.length) {
      const toggle = document.createElement('button')
      toggle.type = 'button'
      toggle.className = 'asleep-toggle'
      toggle.setAttribute('aria-expanded', String(this.asleepOpen))
      toggle.title = 'Threads with no builder on the island — the crew is capped, or this zone is out of building slots'
      toggle.innerHTML = `<span>Asleep (${asleep.length})</span>`
      toggle.addEventListener('click', () => {
        this.asleepOpen = !this.asleepOpen
        // The signature carries the open state, so this repaints the list and nothing else.
        this.setProject(this.project)
      })
      list.appendChild(toggle)
      if (this.asleepOpen) {
        for (const t of asleep) {
          const row = document.createElement('button')
          row.type = 'button'
          row.className = 'thread asleep'
          row.title = `No builder on the island — open in ${t.harness || 'its harness'}`
          row.innerHTML =
            pipHtml(t.status) +
            `<span class="t">${escapeHtml(t.title || 'Untitled thread')}</span>` +
            `<span class="when">${whenLabel(t)}</span>` +
            '<span class="open">Open</span>'
          row.addEventListener('click', () => this.actions.openById?.(t.id))
          list.appendChild(row)
        }
      }
    }
    list.scrollTop = scroll
    if (!project.selectedId) this._scrolledTo = null
  }

  /**
   * The selected thread, shown inside the zone sidebar rather than in a panel of its own —
   * one thread and its repo are the same context, and splitting them across the screen made
   * you look in two places to act on one astronaut.
   */
  setSelection(agent, thread) {
    const card = this.$('.thread-pop')
    // Only ever one accent button in the panel: whichever action is the immediate one.
    this.$('#btn-new-session').classList.toggle('primary', !agent || !thread)
    if (!agent || !thread) {
      card.classList.remove('on')
      this.selected = null
      this.selectedId = null
      this._syncResultsSelection()
      return
    }
    this.selected = { agent, thread }
    this.selectedId = thread.id
    this._syncResultsSelection()
    card.classList.add('on')

    this.$('.thread-pop .title').textContent = thread.title || 'Untitled thread'
    const status = STATUS_LABEL[agent.status] || agent.status
    const meta = this.$('.thread-pop .meta')
    const bits = [
      `<span class="tag"><i class="swatch" style="background:${hex(agent.trim.getHex())}"></i>${escapeHtml(status)}</span>`,
    ]
    // Which harness it came from — the card is the one place a thread's origin is always said.
    if (thread.harnessName) bits.push(`<span class="tag">${escapeHtml(thread.harnessName)}</span>`)
    // A workflow is switched on or off, which is the first thing to know about one.
    if (thread.harness === 'n8n' && thread.source) {
      bits.push(`<span class="tag wf ${thread.source === 'active' ? 'on' : 'off'}">workflow ${escapeHtml(thread.source)}</span>`)
    }
    // The repo is the panel's own heading now, so the card says what the *thread* is.
    if (thread.worktree) bits.push(`<span class="tag">⑂ ${escapeHtml(thread.worktree)}</span>`)
    if (thread.gitBranch) bits.push(`<span class="tag">${escapeHtml(thread.gitBranch)}</span>`)
    if (thread.model) bits.push(`<span class="tag">${escapeHtml(shortModel(thread.model))}</span>`)
    bits.push(`<span>${whenLabel(thread)}</span>`)
    meta.innerHTML = bits.join('')

    // What went wrong, for a workflow: the adapter's one-line account of its last run, and the
    // execution it is about. Claude Code threads have neither, and the block stays shut.
    const detail = this.$('.thread-pop .detail')
    const lines = []
    if (thread.harness === 'n8n') {
      const failed = thread.hasError || agent.status === 'blocked'
      if (failed && thread.preview) lines.push(`<div class="err">${escapeHtml(thread.preview)}</div>`)
      if (thread.ref?.executionId) lines.push(`<div class="kv">Execution <code>${escapeHtml(thread.ref.executionId)}</code></div>`)
    }
    detail.innerHTML = lines.join('')
    detail.hidden = lines.length === 0

    const pct = Math.round((this.actions.progressFor?.(thread.id) ?? 0) * 100)
    this.$('.thread-pop .progress > i').style.width = `${pct}%`
    this.$('.thread-pop .progress > i').style.background = hex(agent.trim.getHex())
    // Measured once per selection rather than per frame: placing the card beside its
    // astronaut needs its size sixty times a second, and asking the layout for it that
    // often is how a HUD starts costing frames.
    this._cardSize = { w: card.offsetWidth, h: card.offsetHeight }
    this.$('#btn-open').disabled = thread.canOpen === false
    // Only offered when there is something to dismiss. A third button on every card would
    // crowd the two that are always worth having, and "Viewed" on a thread that is not asking
    // for anything is a control with no effect.
    this.$('#btn-viewed').hidden = !thread.unread
    // Same rule as Viewed, and for the same reason: a control that cannot do anything is
    // worse than no control. Which threads can be re-run is the harness's business — the page
    // only reads the flag.
    this.$('#btn-retry').hidden = !thread.canRetry
  }

  /** Keep the highlighted result in step with the selected builder. */
  _syncResultsSelection() {
    for (const b of this.el.querySelectorAll('.results .thread')) {
      b.setAttribute('aria-pressed', String(b.dataset.id === this.selectedId))
    }
  }

  /** Disabled while a retry is on the wire, so the button cannot be clicked twice. */
  setRetryBusy(busy) {
    this.$('#btn-retry').disabled = Boolean(busy)
  }

  /**
   * Put the thread card beside its own astronaut, in screen space, every frame.
   *
   * `screen` is where the astronaut is right now, in CSS pixels, or null when it is behind
   * the camera. The card prefers the astronaut's right, flips to its left rather than slide
   * under the sidebar, and never leaves the window — so it stays reachable at any zoom
   * without ever covering the thing it is describing.
   */
  placeCard(screen) {
    const el = this.$('.thread-pop')
    if (!screen || !this.selected) {
      if (this._cardOn) {
        this._cardOn = false
        el.classList.remove('on')
      }
      return
    }
    const size = this._cardSize || { w: 280, h: 150 }
    const margin = 12
    const gap = 26
    const rightWall = window.innerWidth - margin - (this._sideWidth || 0)

    let flip = false
    let left = screen.x + gap
    if (left + size.w > rightWall) {
      left = screen.x - gap - size.w
      flip = true
      // Nowhere to go on either side — sit over the middle rather than off the edge.
      if (left < margin) left = Math.min(Math.max(margin, screen.x - size.w / 2), rightWall - size.w)
    }
    const top = Math.min(Math.max(margin, screen.y - size.h / 2), window.innerHeight - margin - size.h)

    if (!this._cardOn) {
      this._cardOn = true
      el.classList.add('on')
    }
    // Whole pixels, and only when it actually moved: a transform written every frame with a
    // fractional delta is a repaint the compositor cannot skip.
    const x = Math.round(left)
    const y = Math.round(top)
    if (x !== this._cardX || y !== this._cardY) {
      this._cardX = x
      this._cardY = y
      el.style.transform = `translate3d(${x}px, ${y}px, 0)`
    }
    // The nib points back at the astronaut, so it changes sides with the card.
    if (flip !== this._cardFlip) {
      this._cardFlip = flip
      el.classList.toggle('flip', flip)
    }
    // And it tracks the astronaut vertically when the card has been pushed off-centre.
    const nib = Math.min(Math.max(14, screen.y - y), size.h - 14)
    if (nib !== this._cardNib) {
      this._cardNib = nib
      el.style.setProperty('--nib-y', `${Math.round(nib)}px`)
    }
  }

  /** How much of the right-hand edge the sidebar is taking, so the card can avoid it. */
  setSideWidth(px) {
    this._sideWidth = px
  }

  /** Redraw the card's face so it blinks in step with the builder it belongs to. */
  updateAvatar(faceAtlasCanvas) {
    if (!this.selected || !faceAtlasCanvas) return
    const agent = this.selected.agent
    const frame = agent.faceFrame ?? FACE.idle
    const color = agent.eye
    const css = cssFromGlow(color)
    if (this._avatarState.frame === frame && this._avatarState.color === css) return
    this._avatarState = { frame, color: css }

    const size = 108
    const cell = faceAtlasCanvas.width / FRAME_COLS
    const sx = (frame % FRAME_COLS) * cell
    const sy = Math.floor(frame / FRAME_COLS) * (faceAtlasCanvas.height / FRAME_ROWS)

    // The atlas is an opaque white-on-black mask, so the tint is a `multiply`, not a
    // `source-in`: black stays black and the white features take the eye colour. Keying on
    // alpha instead would flood the whole cell, because every pixel in it is opaque.
    const t = this.avatarTmpCtx
    t.globalCompositeOperation = 'source-over'
    t.clearRect(0, 0, size, size)
    t.drawImage(faceAtlasCanvas, sx, sy, cell, cell, 0, 0, size, size)
    t.globalCompositeOperation = 'multiply'
    t.fillStyle = css
    t.fillRect(0, 0, size, size)
    t.globalCompositeOperation = 'source-over'

    const c = this.avatarCtx
    c.fillStyle = '#06070c'
    c.fillRect(0, 0, size, size)
    c.drawImage(this.avatarTmp, 0, 0)
    // Scanlines, so the card's face reads as the same little screen as the one in the world.
    c.globalAlpha = 0.2
    c.fillStyle = '#000'
    for (let y = 0; y < size; y += 3) c.fillRect(0, y, size, 1)
    c.globalAlpha = 1
  }

  setFps(perf, viewport, extra) {
    if (!this.settings.get('showFps')) return
    const el = this.$('.fps')
    const fps = Math.round(perf.fps)
    if (this._last.fps === fps && this._last.calls === perf.drawCalls) return
    this._last.fps = fps
    this._last.calls = perf.drawCalls
    el.innerHTML =
      `<b>${fps}</b> fps · ${perf.frameMs.toFixed(1)} ms<br>` +
      `${perf.drawCalls} draws · ${(perf.triangles / 1000).toFixed(0)}k tris<br>` +
      // The setting is a share of the display, so the readout is too — otherwise a retina
      // machine sitting exactly on the 100% slider reads back "200%".
      `${viewport.bw}×${viewport.bh} (${Math.round((viewport.scale / (window.devicePixelRatio || 1)) * 100)}%)` +
      (extra ? `<br>${extra}` : '')
  }

  hint(text, ms = 3200) {
    const el = this.$('.hint-pill')
    el.textContent = text
    el.classList.add('on')
    clearTimeout(this._hintTimer)
    this._hintTimer = setTimeout(() => el.classList.remove('on'), ms)
  }

  /**
   * A line at the bottom. `action` makes it carry one button — `{ label, run }` — for the few
   * things worth undoing, and `ms` keeps it up long enough to reach for.
   */
  toast(message, kind = '', { action, ms = 3600 } = {}) {
    const el = document.createElement('div')
    el.className = `toast panel ${kind}`
    const text = document.createElement('span')
    text.textContent = message
    el.appendChild(text)
    let timer = 0
    const dismiss = () => {
      clearTimeout(timer)
      el.classList.add('leaving')
      setTimeout(() => el.remove(), 260)
    }
    if (action) {
      el.classList.add('has-action')
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'btn ghost toast-action'
      b.textContent = action.label
      b.addEventListener('click', () => {
        dismiss()
        action.run()
      })
      el.appendChild(b)
    }
    this.$('.toasts').appendChild(el)
    timer = setTimeout(dismiss, ms)
  }

  // ── visibility ──────────────────────────────────────────────────────────────────────

  /** Reflect orbit mode on the rail button. */
  setOrbit(on) {
    this.$('#btn-orbit').setAttribute('aria-pressed', String(Boolean(on)))
  }

  toggleSettings(force) {
    const panel = this.$('.settings')
    const open = force ?? panel.classList.contains('closed')
    panel.classList.toggle('closed', !open)
    // Slid off the edge is not gone: without this its controls stay in the tab order.
    panel.inert = !open
    this.$('#btn-settings').setAttribute('aria-pressed', String(open))
    // Both live in the same slot on the right; the sidebar steps aside rather than hides.
    this.$('.side').classList.toggle('shifted', open)
  }

  isSettingsOpen() {
    return !this.$('.settings').classList.contains('closed')
  }

  toggleHelp(force) {
    const el = this.$('.help')
    const open = force ?? !el.classList.contains('open')
    el.classList.toggle('open', open)
    // A sheet that covers the page has to take the keyboard with it.
    if (open) this.$('#btn-help-close').focus()
  }

  /**
   * Dismiss everything. This is the mode the game is really meant to be left in — the
   * colony carries its own state above the astronauts' heads, so the panels are for
   * setting things up, not for playing.
   */
  toggleUi(force) {
    this.visible = force ?? !this.visible
    this.el.classList.toggle('hidden', !this.visible)
    this.el.inert = !this.visible
    this.$('#btn-hide').innerHTML = this.visible ? ICON.eye : ICON.eyeOff
    this.actions.uiVisibility?.(this.visible)
    if (!this.visible) this.toggleHelp(false)
    return this.visible
  }

  removeBoot() {
    const boot = document.querySelector('.boot')
    if (!boot) return
    boot.classList.add('gone')
    setTimeout(() => boot.remove(), 550)
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────────────

function group(title, child) {
  const el = document.createElement('div')
  el.className = 'group'
  el.innerHTML = `<h3>${title}</h3>`
  if (child) el.appendChild(child)
  return el
}

function chips(items, current, onPick, registry) {
  const wrap = document.createElement('div')
  wrap.className = 'chips'
  const buttons = []
  for (const item of items) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'chip'
    b.textContent = item.label
    if (item.title) b.title = item.title
    b.addEventListener('click', () => onPick(item.id))
    wrap.appendChild(b)
    buttons.push([item.id, b])
  }
  registry.push({
    el: wrap,
    sync: () => {
      const now = current()
      for (const [id, b] of buttons) b.setAttribute('aria-pressed', String(id === now))
    },
  })
  return wrap
}

const hex = (n) => '#' + (n >>> 0).toString(16).padStart(6, '0').slice(-6)
/**
 * Eye colours are authored above 1.0 so the bloom pass catches them in the scene. For the
 * card they are normalised by the brightest channel — which keeps the hue the astronaut
 * actually has rather than clipping a 3.0-red down to the same white as a 3.0-blue.
 */
function cssFromGlow(color) {
  const peak = Math.max(color.r, color.g, color.b, 1)
  const enc = (v) => Math.round(Math.pow(Math.min(1, v / peak), 1 / 2.2) * 255)
  return `rgb(${enc(color.r)},${enc(color.g)},${enc(color.b)})`
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

/** The status dot, with the status said for anyone who cannot see the colour. */
function pipHtml(status) {
  return `<i class="pip" role="img" aria-label="${escapeHtml(STATUS_LABEL[status] || status || 'Unknown')}"></i>`
}

/** Status → the colour family the top-bar counters already use for it. */
function statusClass(status) {
  if (status === 'working') return 'working'
  if (status === 'waiting') return 'waiting'
  if (status === 'blocked') return 'blocked'
  if (status === 'celebrating') return 'done'
  return 'idle'
}

function shortModel(model) {
  return String(model).replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

function clockLabel(t) {
  const total = t * 24 * 60
  const h = Math.floor(total / 60) % 24
  const m = Math.floor(total % 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function nearestTime(value) {
  let best = TIMES[0]
  let bestD = Infinity
  for (const t of TIMES) {
    // Wrap-aware, so 0.99 is nearest to dawn rather than to noon.
    const d = Math.min(Math.abs(t.value - value), 1 - Math.abs(t.value - value))
    if (d < bestD) {
      bestD = d
      best = t
    }
  }
  return bestD < 0.03 ? best.id : null
}

/**
 * When a thread last did something, as a person would say it.
 *
 * An n8n workflow's `lastActivityAt` is adjusted so it lands on the right side of the dormancy
 * line — a switched-off one is pushed days back, an active one with no run left on record is
 * floated to just inside it — which makes it a fine sort key and a false thing to print. The
 * adapter keeps the real time in `lastRunAt`, and `null` there means there is none.
 */
function whenLabel(t) {
  if (t.lastRunAt) return `last run ${ago(t.lastRunAt)}`
  if (t.harness === 'n8n' && t.lastRunAt === null) return 'never run on record'
  return ago(t.lastActivityAt)
}

/** A span of seconds, as short as it can be: 40s, 3m, 2h. */
function duration(s) {
  if (s < 60) return `${Math.floor(s)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}

function ago(ts) {
  if (!ts) return 'never'
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

const TEMPLATE = `
<aside class="side panel" aria-label="Zones and threads">
  <header class="brandbar">
    <div class="brand"><i class="dot"></i>BotsBay World</div>
    <button class="btn icon ghost" id="btn-shot" title="Screenshot (P)">${ICON.camera}</button>
    <button class="btn icon ghost" id="btn-help" title="Help (?)">${ICON.help}</button>
    <button class="btn icon ghost" id="btn-hide" title="Hide all UI (H)">${ICON.eye}</button>
    <button class="btn icon ghost" id="btn-settings" title="Settings (S)" aria-pressed="false">${ICON.settings}</button>
  </header>

  <div class="stats"></div>
  <div class="scan">
    <div class="coverage" hidden></div>
    <div class="fresh"></div>
    <ul class="warns" hidden></ul>
  </div>

  <div class="find" role="search">
    <div class="find-row">
      <input id="find-q" class="find-input" type="search" placeholder="Search threads  ( / )" aria-label="Search threads by title or project" autocomplete="off" spellcheck="false">
      <button type="button" class="btn ghost" id="btn-find-clear" title="Clear search and filters (Esc)" aria-label="Clear search and filters" hidden>${ICON.close}</button>
    </div>
    <div class="chips find-chips source-chips" role="group" aria-label="Filter by source" hidden></div>
    <div class="chips find-chips status-chips" role="group" aria-label="Filter by status"></div>
    <div class="find-meta" aria-live="polite"></div>
  </div>

  <div class="side-body">
    <div class="results threads" aria-label="Search results"></div>
    <div class="projects-pane">
      <div class="sec-head"><span>Zones</span></div>
      <div class="projects"></div>
      <div class="hidden-block" hidden>
        <button type="button" class="hidden-toggle" id="btn-hidden-toggle" aria-expanded="false">
          <span class="label">0 hidden</span>
        </button>
        <div class="hidden-projects" hidden></div>
      </div>
      <div class="archived-block" hidden>
        <button type="button" class="hidden-toggle" id="btn-archived-toggle" aria-expanded="false">
          <span class="label">Archived (0)</span>
        </button>
        <div class="archived-list hidden-projects" hidden></div>
      </div>
    </div>

    <div class="project-detail">
      <button class="btn ghost back" id="btn-close-project" title="Back to every zone (Esc)">${ICON.back} All zones</button>
      <div class="who">
        <i class="swatch"></i>
        <div class="text">
          <div class="name"></div>
          <div class="path"></div>
        </div>
        <button class="btn icon ghost" id="btn-locate" title="Fly to this zone">${ICON.locate}</button>
      </div>
      <div class="project-actions">
        <button class="btn primary" id="btn-new-session" title="Start a new thread in this folder (C)">${ICON.plus} New conversation</button>
        <div class="pair">
          <button class="btn" id="btn-reveal" title="Show this folder in ${FILE_MANAGER}">${ICON.folder} ${FILE_MANAGER}</button>
          <button class="btn" id="btn-copy-path" title="Copy the folder path">${ICON.copy} Copy path</button>
        </div>
        <button class="btn" id="btn-hide-project" title="Hide this zone from the island — does not archive its threads">${ICON.eyeOff} Hide from island</button>
      </div>
      <div class="threads-head"></div>
      <div class="threads"></div>
    </div>
  </div>
</aside>

<div class="rail panel" role="toolbar" aria-label="View controls">
  <button class="btn icon" id="btn-home" title="Reset the view (0)">${ICON.home}</button>
  <button class="btn icon" id="btn-next" title="Next builder waiting on you (N)">${ICON.next}</button>
  <div class="sep"></div>
  <button class="btn icon" id="btn-orbit" title="Orbit mode — sweep around the island (O)" aria-pressed="false">${ICON.orbit}</button>
  <button class="btn icon" id="btn-planet" title="Change world (W)">${ICON.globe}</button>
  <button class="btn icon" id="btn-time" title="Change the time of day (L)">${ICON.sun}</button>
</div>

<div class="settings panel closed" role="complementary" aria-label="Settings" inert>
  <header>Settings <button class="btn icon ghost" id="btn-close-settings" title="Close">${ICON.close}</button></header>
  <div class="body"></div>
</div>

<div class="thread-pop panel" role="region" aria-label="Selected thread">
  <i class="nib"></i>
  <div class="top">
    <div class="avatar"><canvas></canvas></div>
    <div class="info">
      <div class="title"></div>
      <div class="meta"></div>
    </div>
    <button class="btn icon ghost" id="btn-deselect" title="Deselect (Esc)">${ICON.close}</button>
  </div>
  <div class="progress"><i></i></div>
  <div class="detail" hidden></div>
  <div class="pair">
    <button class="btn primary" id="btn-open" title="Open this thread in the harness it came from (Enter)">${ICON.open} Open</button>
    <button class="btn" id="btn-viewed" title="Stop this thread asking for you until it moves on again (V)">${ICON.eye} Viewed</button>
    <button class="btn" id="btn-retry" title="Run this again in the harness it came from (R)">${ICON.retry} Retry</button>
    <button class="btn" id="btn-archive" title="Archive — this builder walks back to the boat (A)">${ICON.archive} Archive</button>
  </div>
</div>

<div class="toasts" role="status" aria-live="polite"></div>
<div class="fps panel"></div>
<div class="hint-pill panel" role="status" aria-live="polite"></div>

<div class="help" role="dialog" aria-modal="true" aria-label="Help">
  <div class="sheet panel">
    <h2>BotsBay World</h2>
    <p class="sub">Every agent working for BotsBay is a builder on this island. They come off the boat, claim a plot for their project, and build. Click one to open its thread; click a zone — its deck or its name — for the project itself, and start a new conversation there. Hide a project from that panel if you would rather not see it — its threads stay in your harness, and you can show it again from the list. Navigation works like Google Earth — drag the ground itself, right-drag to tilt, scroll to zoom in on whatever is under the cursor.</p>
    <div class="cols">
      <div>
        <div class="k"><span>Drag the ground</span><kbd>drag</kbd></div>
        <div class="k"><span>Tilt &amp; rotate</span><kbd>right-drag</kbd></div>
        <div class="k"><span>&nbsp;</span><kbd>⌃ or ⇧ + drag</kbd></div>
        <div class="k"><span>Zoom to cursor</span><kbd>scroll</kbd></div>
        <div class="k"><span>Move / zoom</span><kbd>arrows</kbd> <kbd>+ −</kbd></div>
        <div class="k"><span>Reset view</span><kbd>0</kbd></div>
        <div class="k"><span>Hide all UI</span><kbd>H</kbd> <kbd>${IS_MAC ? '⌘' : 'Ctrl'}\\</kbd></div>
        <div class="k"><span>Settings</span><kbd>S</kbd></div>
        <div class="k"><span>Screenshot</span><kbd>P</kbd></div>
        <div class="k"><span>Search threads</span><kbd>/</kbd></div>
      </div>
      <div>
        <div class="k"><span>Next needing you</span><kbd>N</kbd></div>
        <div class="k"><span>Open thread</span><kbd>Enter</kbd></div>
        <div class="k"><span>Mark viewed</span><kbd>V</kbd></div>
        <div class="k"><span>Archive</span><kbd>A</kbd></div>
        <div class="k"><span>Undo archive</span><kbd>U</kbd></div>
        <div class="k"><span>New conversation</span><kbd>C</kbd></div>
        <div class="k"><span>Orbit mode</span><kbd>O</kbd></div>
        <div class="k"><span>Retry a failed run</span><kbd>R</kbd></div>
        <div class="k"><span>Change world</span><kbd>W</kbd></div>
        <div class="k"><span>Time of day</span><kbd>L</kbd></div>
        <div class="k"><span>Back out, close, clear</span><kbd>Esc</kbd></div>
        <div class="k"><span>This sheet</span><kbd>?</kbd></div>
      </div>
    </div>
    <div style="margin-top:16px">
      <div class="legend-row"><i class="badge" style="background:#1a2b46;color:#8fb4ee">?</i> waiting on your reply — click to open the thread</div>
      <div class="legend-row"><i class="badge" style="background:#3d1c1c;color:#e88b8b">!</i> the session or workflow run hit an error</div>
      <div class="legend-row"><i class="badge" style="background:#16301f;color:#7fd39a">⚒</i> running right now, building</div>
      <div class="legend-row"><i class="badge" style="background:#332b12;color:#e6c67f">✓</i> its pull request landed, or its last run succeeded</div>
      <div class="legend-row"><i class="badge none" style="color:#b6b5be">·</i> <span><b>idle</b> — no badge. Awake, standing about its plot, now and then visiting a neighbour</span></div>
      <div class="legend-row"><i class="badge none" style="color:#7c7b86">·</i> <span><b>asleep</b> — no badge. Nothing for three days: it sits on the floor with its eyes shut. Settings hides these from the map by default; search still finds them</span></div>
      <div class="legend-row legend-pips">
        <span class="pips" aria-hidden="true">
          <i style="color:#7fd39a"></i><i style="color:#8fb4ee"></i><i style="color:#e88b8b"></i><i style="color:#e6c67f"></i><i style="color:#b6b5be"></i>
        </span>
        <span>counters and list dots: <span style="color:#7fd39a">building</span>, <span style="color:#8fb4ee">need you</span>, <span style="color:#e88b8b">blocked</span>, <span style="color:#e6c67f">shipped</span>, <span style="color:#b6b5be">builders / idle</span></span>
      </div>
    </div>
    <div style="margin-top:18px;display:flex;justify-content:flex-end">
      <button class="btn primary" id="btn-help-close">Got it</button>
    </div>
  </div>
</div>
`
