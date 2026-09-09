/**
 * Every knob that costs frames, in one place.
 *
 * Settings are a flat object so they serialise straight to localStorage, and everything
 * that reads them subscribes rather than polling — a change fires `onChange` with the set
 * of keys that moved, so the renderer can rebuild only what actually needs rebuilding.
 */

const STORE_KEY = 'botsbay.settings.v1'
/** Where the settings lived before the rename. Read once, if the new key is empty. */
const OLD_STORE_KEY = 'botcrossing.settings.v1'

/**
 * What a fresh install opens on. Fixed rather than guessed from the device: `autoQuality`
 * scales the render buffer *under* whichever preset is chosen, so a slow machine is caught
 * by the governor within a second or two — which it does by measuring actual frame times
 * rather than by inferring speed from core counts.
 *
 * Only ever used when nothing is stored. An explicit choice always wins.
 */
export const DEFAULT_PRESET = 'balanced'

export const PRESETS = {
  potato: {
    label: 'Potato',
    hint: 'battery first — flat light, no extras',
    values: {
      renderScale: 0.5,
      shadows: 'off',
      bloom: false,
      antialias: false,
      particles: 'off',
      textureQuality: 'low',
      scatterDensity: 0.15,
      groundDetail: 'low',
      maxAgents: 40,
      stars: false,
      ibl: false,
      tiltShift: false,
    },
  },
  low: {
    label: 'Low',
    hint: 'for when you are on the go',
    values: {
      renderScale: 0.7,
      shadows: 'off',
      bloom: true,
      antialias: false,
      particles: 'low',
      textureQuality: 'low',
      scatterDensity: 0.35,
      groundDetail: 'low',
      maxAgents: 60,
      stars: true,
      ibl: false,
      tiltShift: false,
    },
  },
  balanced: {
    label: 'Balanced',
    hint: 'the default — looks good, runs cool',
    values: {
      renderScale: 1,
      shadows: 'low',
      bloom: true,
      antialias: false,
      particles: 'low',
      textureQuality: 'medium',
      scatterDensity: 0.6,
      groundDetail: 'medium',
      maxAgents: 90,
      stars: true,
      ibl: true,
      tiltShift: true,
    },
  },
  high: {
    label: 'High',
    hint: 'sharp shadows and a full sky',
    values: {
      renderScale: 1,
      shadows: 'high',
      bloom: true,
      antialias: true,
      particles: 'full',
      textureQuality: 'high',
      scatterDensity: 0.85,
      groundDetail: 'high',
      maxAgents: 140,
      stars: true,
      ibl: true,
      tiltShift: true,
    },
  },
  ultra: {
    label: 'Ultra',
    hint: 'everything on, plugged in',
    values: {
      renderScale: 1.5,
      shadows: 'ultra',
      bloom: true,
      antialias: true,
      particles: 'full',
      textureQuality: 'ultra',
      scatterDensity: 1,
      groundDetail: 'high',
      maxAgents: 200,
      stars: true,
      ibl: true,
      tiltShift: true,
    },
  },
}

export const SHADOW_SIZES = { off: 0, low: 1024, high: 2048, ultra: 4096 }
const TEXTURE_SIZES = { low: 256, medium: 512, high: 1024, ultra: 1024 }
const PARTICLE_BUDGET = { off: 0, low: 900, full: 3000 }

/**
 * The largest `maxAgents` any preset asks for. Anything sized once at boot — the badge buffers,
 * which are never rebuilt — allocates against this rather than against whatever preset happened
 * to be active, so raising quality later cannot outrun a buffer.
 */
export const MAX_AGENT_CAP = Math.max(...Object.values(PRESETS).map((p) => p.values.maxAgents || 0))

const DEFAULTS = {
  preset: 'balanced',
  ...PRESETS.balanced.values,

  // World
  planet: 'bahrain',
  /**
   * Whether this browser has already been moved onto the BotsBay defaults — see `migrate`.
   * True here so a fresh install is born migrated and never has the rule applied to a choice
   * it made itself.
   */
  worldMigrated: true,
  /**
   * Leave anything quiet for three days off the map, folding a zone away when nothing in it
   * is awake. On by default: with several harnesses read at once the map otherwise fills with
   * every checkout you have ever opened and every workflow anyone ever switched off, and the
   * few things actually being worked on get lost among them. It is reversible in one click,
   * and everything returns to the same ground the moment it stirs.
   */
  hideDormant: true,
  timeOfDay: 0.32, // 0..1 — 0 is midnight, 0.5 is noon
  autoTime: false,
  /**
   * Sky follows the wall clock in Bahrain — see `WORLD_TIMEZONE` in `world/sky.js`. Wins over
   * `autoTime`; both off is manual.
   *
   * On by default, because the light matching the office the agents are working in is the
   * whole point of the map being a place rather than a chart. Reaching for `L` or the
   * scrubber turns it off, on the grounds that asking for a particular light is asking for
   * that light to stay put; the Settings toggle is how it comes back.
   */
  clockTime: true,
  dayLength: 240, // seconds for a full cycle when autoTime is on

  // Look
  exposure: 1.0,
  bloomStrength: 0.25,
  tiltShiftStrength: 0.2, // 0..1 — share of the effect's full blur radius (2% of frame height)
  tiltShiftAngle: 0, // degrees — 0 keeps the sharp band horizontal
  iblIntensity: 1.0,
  fov: 38,

  // Behaviour
  autoQuality: true, // drop render scale when frames get expensive
  autoFrame: false, // ease the camera back to isometric when you stop dragging; opt-in
  showFps: false,
  showLabels: true,
  reducedMotion: false,
}

/** Keys whose change forces a full rebuild of the world (terrain, scatter, sky). */
const WORLD_KEYS = new Set(['planet', 'groundDetail', 'scatterDensity', 'stars'])
/** Keys that only need the renderer reconfigured. */
const RENDER_KEYS = new Set([
  'renderScale',
  'shadows',
  'bloom',
  'antialias',
  'exposure',
  'bloomStrength',
  'tiltShift',
  'tiltShiftStrength',
  'tiltShiftAngle',
])

export class Settings {
  constructor() {
    this.values = { ...DEFAULTS, ...load() }
    this.listeners = new Set()
    this._saveTimer = 0
  }

  get(key) {
    return this.values[key]
  }

  /** True when `key` currently differs from what the active preset specifies. */
  isOverridden(key) {
    const preset = PRESETS[this.values.preset]
    return Boolean(preset && key in preset.values && preset.values[key] !== this.values[key])
  }

  set(key, value) {
    if (this.values[key] === value) return
    this.values[key] = value
    // Touching any quality knob directly means you are no longer on a named preset.
    const preset = PRESETS[this.values.preset]
    if (preset && key in preset.values) this.values.preset = 'custom'
    this._emit([key])
  }

  applyPreset(name) {
    const preset = PRESETS[name]
    if (!preset) return
    const changed = []
    for (const [k, v] of Object.entries(preset.values)) {
      if (this.values[k] !== v) {
        this.values[k] = v
        changed.push(k)
      }
    }
    this.values.preset = name
    this._emit(changed.length ? changed : ['preset'])
  }

  onChange(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  _emit(keys) {
    const changed = new Set(keys)
    const scope = {
      world: keys.some((k) => WORLD_KEYS.has(k)),
      render: keys.some((k) => RENDER_KEYS.has(k)),
    }
    for (const fn of this.listeners) fn(changed, scope, this.values)
    this._scheduleSave()
  }

  _scheduleSave() {
    clearTimeout(this._saveTimer)
    this._saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(this.values))
      } catch {
        /* private mode, quota — the game just forgets between sessions */
      }
    }, 400)
  }

  /**
   * Adopt a whole saved set at once — the colony file's copy, when this browser has none of
   * its own. One emit rather than one per key, so the renderer is reconfigured once instead
   * of thirty times on the way in.
   */
  applyAll(values) {
    const changed = []
    for (const [key, value] of Object.entries(values || {})) {
      if (!(key in this.values) || this.values[key] === value) continue
      this.values[key] = value
      changed.push(key)
    }
    if (changed.length) this._emit(changed)
    return changed.length
  }

  // Convenience readers used all over the render code.
  get shadowSize() {
    return SHADOW_SIZES[this.values.shadows] || 0
  }
  get textureSize() {
    return TEXTURE_SIZES[this.values.textureQuality] || 512
  }
  get particleBudget() {
    return PARTICLE_BUDGET[this.values.particles] ?? 0
  }
}

/**
 * Move a browser that has been here before onto the new world, once.
 *
 * Stored settings beat defaults, which is right — but it means changing a default reaches
 * nobody who has ever opened the page, and "Bahrain is the default" would have been true
 * only on a machine that had never run this. So the two keys the fork changed are moved
 * across, and only where they still hold the value the *old* default put there: a browser
 * sitting on Luna with the clock off is one that never chose either, and anything else is a
 * real choice and is left alone. `worldMigrated` makes it a one-time thing, so cycling back
 * to Luna afterwards sticks.
 */
const MIGRATIONS = [{ key: 'planet', was: 'moon', now: 'bahrain' }, { key: 'clockTime', was: false, now: true }]

function migrate(raw) {
  if (raw.worldMigrated) return raw
  for (const { key, was, now } of MIGRATIONS) {
    if (raw[key] === was) raw[key] = now
  }
  raw.worldMigrated = true
  return raw
}

function load() {
  try {
    const stored = localStorage.getItem(STORE_KEY) || localStorage.getItem(OLD_STORE_KEY)
    if (!stored) return {}
    const raw = JSON.parse(stored)
    return raw && typeof raw === 'object' ? migrate(raw) : {}
  } catch {
    return {}
  }
}

export function hasStoredSettings() {
  try {
    return Boolean(localStorage.getItem(STORE_KEY) || localStorage.getItem(OLD_STORE_KEY))
  } catch {
    return false
  }
}
