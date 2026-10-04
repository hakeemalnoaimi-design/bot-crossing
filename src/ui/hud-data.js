/** UI-facing slices of the settings model, kept apart so the HUD never reaches into the engine. */
export { PRESETS } from '../core/settings.js'

/** Display order for the planet picker — home first, then nearest to furthest from it. */
export const PLANETS_ORDER = ['bahrain', 'moon', 'mars', 'terra']

/**
 * The status chips in the search block, in the order the colony ranks them. `id` is the status
 * `statusFor` returns, so a chip is a filter on that value and needs no translation.
 */
export const STATUS_FILTERS = [
  { id: 'waiting', label: 'Needs you', title: 'Waiting on a reply from you' },
  { id: 'blocked', label: 'Blocked', title: 'The session or run hit an error' },
  { id: 'working', label: 'Running', title: 'Running right now' },
  { id: 'celebrating', label: 'Shipped', title: 'Its pull request landed, or its last run succeeded' },
  { id: 'idle', label: 'Idle', title: 'Awake, but not doing anything' },
  { id: 'sleeping', label: 'Asleep', title: 'Dormant — nothing for three days' },
]

/** Same order as `STATUS_ORDER` in the colony, which this file cannot import without dragging three in. */
const RANK = Object.fromEntries(STATUS_FILTERS.map((s, i) => [s.id, i]))

/**
 * The thread directory behind the search box: every thread the colony knows about, drawn or not,
 * narrowed by what was typed and which chips are on.
 *
 * Text is matched against the title and the project, each word on its own, so "n8n lead" finds a
 * workflow called "Lead intake" in the n8n zone whichever order the words are in. Chips within a
 * group add (any of these sources), the groups themselves narrow (this source *and* that status).
 * Whoever wants something first, then the most recently touched — the sidebar's own order.
 */
export function filterThreads(items, { query = '', sources = new Set(), statuses = new Set() } = {}) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean)
  const out = items.filter((t) => {
    if (sources.size && !sources.has(t.harness)) return false
    if (statuses.size && !statuses.has(t.status)) return false
    if (!words.length) return true
    const hay = `${t.title || ''}\n${t.project || ''}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
  return out.sort((a, b) => {
    const rank = (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9)
    return rank || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)
  })
}

/**
 * A path that fits, trimmed from the *left* so the repo end survives — the deep end is the
 * part that identifies it. CSS can only ellipsise the tail, and `direction: rtl` mangles a
 * leading `~`, so the trim is done here and the whole path lives in the title attribute.
 *
 * Windows paths come in with backslashes and a drive letter, and the home directory is
 * `C:\Users\name` rather than `/Users/name`; the separator the path arrived with is the one
 * it goes back out with, so a folder copied off the sidebar still looks like itself.
 */
export function shortPath(dir, max = 30) {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  const flat = dir.replace(/\\/g, '/')
  const home = flat.replace(/^(?:[A-Za-z]:)?\/(?:Users|home)\/[^/]+/, '~')
  const text = sep === '/' ? home : home.replace(/\//g, sep)
  if (text.length <= max) return text
  const parts = text.split(sep)
  let out = parts.pop() || ''
  while (parts.length) {
    const next = parts.pop()
    if (out.length + next.length + 3 > max) break
    out = `${next}${sep}${out}`
  }
  return `…${sep}${out}`
}
