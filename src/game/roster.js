/**
 * Who gets drawn when there are more threads than the island can hold.
 *
 * The design targeted forty to sixty-five threads. A real machine with a workflow harness on it
 * has hundreds, so two limits bite: the crew is capped (`maxAgents`), and a zone only has so
 * many building slots. Either way somebody is left off the map, and what matters is *who*.
 * Cutting in zone-sort order drops whoever happens to sort last — which was a thread waiting on
 * you, as often as not. So the cut is made by what a thread is asking for.
 *
 * Pure, and free of three and the DOM, so the rule can be tested without a renderer.
 */

/**
 * How badly each status wants to be on the map; lower is first. Blocked and waiting share a rank
 * on purpose: both are a thread asking for a person, and which of the two is louder is not for a
 * cap to decide.
 */
const RANK = { blocked: 0, waiting: 0, working: 1, celebrating: 2, idle: 3, sleeping: 4 }

export const priorityRank = (status) => RANK[status] ?? RANK.idle

/**
 * Choose which items survive a cap: needs-you and blocked first, then running, then
 * celebrating, then idle, then dormant, and within a rank the most recently active.
 *
 * Returns a Set of the chosen items themselves. The caller keeps its own order and filters by
 * membership, because that order is what keeps a session in its slot.
 *
 * @param items any list
 * @param limit how many may be kept
 * @param get   `item => { id, status, at }` — `at` is the last activity in ms
 */
export function pickByPriority(items, limit, get) {
  const keep = Math.max(0, Math.floor(limit))
  if (items.length <= keep) return new Set(items)
  const ranked = items.map((item) => ({ item, ...get(item) }))
  ranked.sort((a, b) => {
    const rank = priorityRank(a.status) - priorityRank(b.status)
    if (rank) return rank
    const recent = (b.at ?? 0) - (a.at ?? 0)
    if (recent) return recent
    // Last, so the answer never depends on the order the scan happened to arrive in.
    return String(a.id).localeCompare(String(b.id))
  })
  return new Set(ranked.slice(0, keep).map((r) => r.item))
}

/**
 * One zone against its slots. `rows` is the zone's threads, oldest first, each `{ thread, status }`.
 *
 * `drawn` keeps that oldest-first order, so a session's slot is its position among the drawn
 * and does not move when a newer sibling arrives — exactly as before the zone was full. `overflow`
 * is how many had no slot, which the name plate and the sidebar report as "+N more".
 */
export function fitToSlots(rows, slots) {
  const chosen = pickByPriority(rows, slots, (r) => ({ id: r.thread.id, status: r.status, at: r.thread.lastActivityAt }))
  const drawn = rows.filter((r) => chosen.has(r))
  return { drawn, overflow: rows.length - drawn.length }
}

/**
 * The same cut across the whole crew. `entries` are roster entries (`{ id, status, thread }`);
 * the survivors are returned in the order given.
 */
export function capRoster(entries, limit) {
  const chosen = pickByPriority(entries, limit, (e) => ({ id: e.id, status: e.status, at: e.thread?.lastActivityAt }))
  return entries.filter((e) => chosen.has(e))
}
