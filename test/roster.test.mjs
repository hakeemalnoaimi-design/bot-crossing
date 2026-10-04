/**
 * Who is drawn when the roster outgrows the island.
 *
 * The design was for forty to sixty-five threads; a machine with a workflow harness has hundreds.
 * These pin the rule that decides who is left off the map — pure functions, no renderer.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { pickByPriority, fitToSlots, capRoster, priorityRank } from '../src/game/roster.js'
import { allocateCells, layoutExtent, layoutReach, ZONE_CAPACITY, PLOT_CELL } from '../src/world/plots.js'
import { COLONY_RADIUS, PLANETS, flatLimit, flatRadiusFor } from '../src/world/planet.js'
import { Navigation } from '../src/agents/navigation.js'

const row = (id, status, at, createdAt = at) => ({ thread: { id, lastActivityAt: at, createdAt }, status })

test('priority runs needs-you and blocked, running, celebrating, idle, dormant', () => {
  const order = ['waiting', 'blocked', 'working', 'celebrating', 'idle', 'sleeping'].map(priorityRank)
  assert.deepEqual(order, [0, 0, 1, 2, 3, 4])
})

test('a cap keeps the urgent threads even when they sort last', () => {
  // Zone-sort order puts the idle ones first; the old `slice(0, cap)` would have kept only them.
  const rows = [
    ...Array.from({ length: 10 }, (_, i) => row(`idle${i}`, 'idle', 1000 + i)),
    row('waiting', 'waiting', 1),
    row('blocked', 'blocked', 2),
    row('working', 'working', 3),
  ]
  const kept = capRoster(
    rows.map((r) => ({ id: r.thread.id, status: r.status, thread: r.thread })),
    3
  ).map((e) => e.id)
  assert.deepEqual(kept.sort(), ['blocked', 'waiting', 'working'])
})

test('within a rank the most recently active wins', () => {
  const rows = [row('old', 'idle', 100), row('new', 'idle', 900), row('mid', 'idle', 500)]
  const { drawn } = fitToSlots(rows, 2)
  assert.deepEqual(drawn.map((r) => r.thread.id).sort(), ['mid', 'new'])
})

test('dormant threads are the first to go', () => {
  const rows = [row('a', 'sleeping', 9999), row('b', 'idle', 1), row('c', 'celebrating', 1)]
  const { drawn, overflow } = fitToSlots(rows, 2)
  assert.equal(overflow, 1)
  assert.deepEqual(drawn.map((r) => r.thread.id).sort(), ['b', 'c'])
})

test('the survivors keep the order they came in, so a session keeps its slot', () => {
  // Oldest first, as the colony sorts them. Priority decides who is in, never where they stand:
  // t1 is the quietest, so it is the one left out, and the rest stay in creation order.
  const rows = [row('t1', 'idle', 10), row('t2', 'working', 20), row('t3', 'idle', 30), row('t4', 'waiting', 40)]
  const { drawn } = fitToSlots(rows, 3)
  assert.deepEqual(
    drawn.map((r) => r.thread.id),
    ['t2', 't3', 't4']
  )
})

test('nothing is dropped, and the order is untouched, while everything fits', () => {
  const rows = [row('t1', 'sleeping', 1), row('t2', 'idle', 2)]
  const { drawn, overflow } = fitToSlots(rows, 7)
  assert.equal(overflow, 0)
  assert.deepEqual(drawn, rows)
})

test('a tie is settled by id, so the answer does not depend on scan order', () => {
  const a = [row('x', 'idle', 5), row('y', 'idle', 5), row('z', 'idle', 5)]
  const b = [a[2], a[0], a[1]]
  const ids = (rows) => fitToSlots(rows, 2).drawn.map((r) => r.thread.id).sort()
  assert.deepEqual(ids(a), ids(b))
})

test('a limit of zero keeps nobody and a negative one does not throw', () => {
  const rows = [row('a', 'waiting', 1)]
  assert.equal(pickByPriority(rows, 0, (r) => ({ id: r.thread.id, status: r.status, at: 1 })).size, 0)
  assert.equal(pickByPriority(rows, -4, (r) => ({ id: r.thread.id, status: r.status, at: 1 })).size, 0)
})

test('a 184-thread zone is capped at its slots and every urgent thread gets one', () => {
  const rows = Array.from({ length: 184 }, (_, i) => row(`n${i}`, i % 23 === 0 ? 'waiting' : i % 5 === 0 ? 'working' : 'sleeping', i))
  const urgent = rows.filter((r) => r.status === 'waiting').length
  const { drawn, overflow } = fitToSlots(rows, ZONE_CAPACITY)
  assert.equal(ZONE_CAPACITY, 63)
  assert.equal(drawn.length, 63)
  assert.equal(overflow, 184 - 63)
  assert.equal(drawn.filter((r) => r.status === 'waiting').length, urgent)
  // Slots are positions among the drawn, so no two can share one.
  assert.equal(new Set(drawn.map((_, i) => i)).size, drawn.length)
})

test('a zone never claims more than its capacity, however many threads it has', () => {
  // The footprint cap is what keeps one big zone from pushing the rest of the colony out over
  // the dunes; "+N more" is the answer to a bigger roster, not a bigger zone.
  const layout = allocateCells([{ id: 'internal', size: 184 }, { id: 'small', size: 3 }])
  assert.ok(layout.get('internal').length * 7 <= ZONE_CAPACITY)
  assert.equal(layout.get('internal').length, 9)
})

test('a mid-sized roster still lays out inside the flat colony radius', () => {
  const sizes = [63, 40, 30, 20, 10, 8, 5, 5, 5, 3, 3, 2, 2, 1]
  const layout = allocateCells(sizes.map((size, i) => ({ id: `z${i}`, size })))
  let far = 0
  for (const cells of layout.values()) {
    for (const { q, r } of cells) {
      far = Math.max(far, Math.hypot(PLOT_CELL * 1.5 * q, PLOT_CELL * Math.sqrt(3) * (r + q / 2)))
    }
  }
  assert.ok(far <= COLONY_RADIUS, `furthest cell centre at ${far.toFixed(1)}, flat ground ends at ${COLONY_RADIUS}`)
})

// ── the layout stays on flat, walkable ground ─────────────────────────────────────────

/** A live roster: one big zone (216 threads, 63 drawn), a 43/7 one, and a scatter of small ones. */
const LIVE_DRAWN = [63, 7, 6, 5, 4, 4, 3, 3, 2, 2, 2, 1, 1, 1, 1, 1, 1]
const live = () => LIVE_DRAWN.map((size, i) => ({ id: `zone${i}`, size }))
const centreOf = ({ q, r }) => Math.hypot(PLOT_CELL * 1.5 * q, PLOT_CELL * Math.sqrt(3) * (r + q / 2))

test('seventeen zones stay on the flat ground and inside the walkable grid', () => {
  const planet = PLANETS.bahrain
  const reach = layoutReach(flatLimit(planet))
  const layout = allocateCells(live(), new Map(), reach)
  assert.equal(layout.size, 17)
  assert.equal(layout.get('zone0').length, 9)

  const extent = layoutExtent(layout)
  const flat = flatRadiusFor(extent, planet)
  const nav = new Navigation(flat + 10)
  for (const cells of layout.values()) {
    assert.ok(cells.length > 0, 'every zone is placed')
    for (const cell of cells) {
      const d = centreOf(cell)
      assert.ok(d <= flat, `cell centre at ${d.toFixed(1)}, flat ground ends at ${flat}`)
      assert.ok(d + PLOT_CELL <= flat, 'the whole tile is on flat ground, not only its middle')
      assert.ok(d + PLOT_CELL < nav.half, `tile reaches ${(d + PLOT_CELL).toFixed(1)}, grid ends at ${nav.half}`)
    }
  }
  // The colony never gets near the water: Bahrain's shore is at 74.
  assert.ok(flat <= planet.sea.shore - 8)
})

test('a roster too big for the ground is packed tighter, not spread onto the dunes', () => {
  const planet = PLANETS.bahrain
  const reach = layoutReach(flatLimit(planet))
  const big = Array.from({ length: 40 }, (_, i) => ({ id: `big${i}`, size: 63 }))
  const layout = allocateCells(big, new Map(), reach)
  for (const cells of layout.values()) for (const cell of cells) assert.ok(centreOf(cell) <= reach)
  assert.ok(flatRadiusFor(layoutExtent(layout), planet) <= planet.sea.shore - 8)
  // Nothing is placed twice.
  const all = [...layout.values()].flat().map((c) => `${c.q},${c.r}`)
  assert.equal(new Set(all).size, all.length)
})

test('saved zones inside the bounds keep their cells', () => {
  const reach = layoutReach(flatLimit(PLANETS.bahrain))
  const first = allocateCells(live(), new Map(), reach)
  // Same roster with one more thread somewhere else: nobody who fits moves.
  const grown = live()
  grown[5].size += 3
  const second = allocateCells(grown, first, reach)
  for (const [id, cells] of first) {
    if (id === 'zone5') {
      assert.deepEqual(second.get(id).slice(0, cells.length), cells)
      continue
    }
    assert.deepEqual(second.get(id), cells, `${id} moved`)
  }
})

test('a saved zone that sits out past the flat ground is placed again, and the rest stay', () => {
  const reach = layoutReach(flatLimit(PLANETS.bahrain))
  const saved = new Map([
    ['near', [{ q: 0, r: 0 }, { q: 1, r: 0 }]],
    ['far', [{ q: 6, r: 0 }, { q: 6, r: 1 }]],
  ])
  assert.ok(centreOf({ q: 6, r: 0 }) > reach)
  const layout = allocateCells(
    [{ id: 'near', size: 14 }, { id: 'far', size: 14 }],
    saved,
    reach
  )
  assert.deepEqual(layout.get('near'), saved.get('near'))
  assert.equal(layout.get('far').length, 2)
  for (const cell of layout.get('far')) assert.ok(centreOf(cell) <= reach)
})

test('with no bound the layout is exactly what it always was', () => {
  const sizes = [63, 40, 30, 20, 10]
  const a = allocateCells(sizes.map((size, i) => ({ id: `z${i}`, size })))
  const b = allocateCells(sizes.map((size, i) => ({ id: `z${i}`, size })), new Map(), Infinity)
  assert.deepEqual([...a], [...b])
})

test('the flat radius never drops below the colony default and never reaches the shore', () => {
  const planet = PLANETS.bahrain
  assert.equal(flatRadiusFor(10, planet), COLONY_RADIUS)
  assert.equal(flatRadiusFor(500, planet), flatLimit(planet))
  assert.ok(planet.sea.shore - flatLimit(planet) >= 8)
})
