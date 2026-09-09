/**
 * Repos you have taken off the map.
 *
 * Colony-only, and that is the whole point: hiding writes nothing to any harness and archives
 * nothing. The threads stay exactly where they are and keep working; the map just stops drawing
 * that repo until you show it again. It is for the checkout you have forty dead threads in and
 * do not want owning a third of your ground.
 *
 * Keyed on the project *name*, which is what plots are keyed on too. That has a consequence
 * worth knowing: a second checkout of the same repo appearing renames `foo` to `1/foo` (see
 * `disambiguateProjects` in server/scan.mjs) and the hide quietly stops matching. Keying on the
 * path instead would fix it and break the moment somebody moves a folder, and the layout has the
 * same trade — so both are wrong in the same direction, which is at least predictable.
 */

export function hideProject(hidden, name) {
  const id = String(name || '')
  if (!id || hidden.includes(id)) return [...hidden]
  return [...hidden, id]
}

export function unhideProject(hidden, name) {
  const id = String(name || '')
  return hidden.filter((n) => n !== id)
}

/** The threads the colony should actually draw. */
export function liveThreadsForColony(threads, archivedIds, hiddenProjects) {
  const archived = archivedIds instanceof Set ? archivedIds : new Set(archivedIds)
  const hidden = hiddenProjects instanceof Set ? hiddenProjects : new Set(hiddenProjects)
  return threads.filter((t) => !t.archived && !archived.has(t.id) && !hidden.has(t.project || 'unknown'))
}

/**
 * Split the map into what is drawn and which zones that emptied out.
 *
 * `isDormant` is handed in rather than imported, because the rule for it lives with the rest
 * of the thread→behaviour mapping and this module has no business knowing it — and because it
 * is what makes this testable without dragging a renderer in behind it.
 *
 * Two guarantees the caller depends on:
 *
 *   - **Nothing is ever emptied entirely.** A colony that answers a poll with a bare planet
 *     reads as broken rather than tidy, and there is nothing on screen to say which it was. If
 *     every last thread is dormant, none of them are hidden.
 *   - **`folded` is zones, not threads.** It is what the HUD offers back as a list, so it
 *     names only the zones that left the map completely.
 */
export function partitionDormant(live, isDormant) {
  const awake = live.filter((t) => !isDormant(t))
  if (!awake.length) return { shown: live, folded: new Set() }

  const kept = new Set(awake.map((t) => t.project || 'unknown'))
  const folded = new Set()
  for (const t of live) {
    const zone = t.project || 'unknown'
    if (!kept.has(zone)) folded.add(zone)
  }
  return { shown: awake, folded }
}

/**
 * What the sidebar lists, with a live count each — so a hidden repo that has since gone quiet
 * reads as `0` and you can tell it is safe to forget rather than having to show it to find out.
 */
export function hiddenCatalog(hidden, threads) {
  const names = [...new Set(hidden.map(String).filter(Boolean))].sort((a, b) => a.localeCompare(b))
  return names.map((name) => ({
    name,
    count: threads.filter((t) => !t.archived && (t.project || 'unknown') === name).length,
  }))
}
