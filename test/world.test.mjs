/**
 * The two things about BotsBay World that are a specification rather than a taste call: the
 * hours the sky keeps, and the fact that Bahrain is an island.
 *
 * Neither needs a GPU. The clock is arithmetic, and the terrain is built on the CPU and baked
 * into a buffer, so both can be checked exactly rather than looked at.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'

import { PLANETS, createTerrain, createScatter, terrainHeight, COLONY_RADIUS } from '../src/world/planet.js'
import { TIMES, timeOfDayForMinute, systemTimeOfDay, WORLD_TIMEZONE } from '../src/world/sky.js'
import { PLOT_PALETTE, deckColor } from '../src/world/plots.js'

/** sRGB to CIE Lab (D65), so "can you tell these two apart" is a number rather than a taste. */
function toLab(hex) {
  const c = new THREE.Color(hex)
  const lin = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
  const [r, g, b] = [lin(c.r), lin(c.g), lin(c.b)]
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b
  const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))]
}

/** The smallest CIE76 distance between any two colours in a palette. */
function closestPair(palette) {
  let worst = Infinity
  for (let i = 0; i < palette.length; i++) {
    for (let j = i + 1; j < palette.length; j++) {
      const a = toLab(palette[i])
      const b = toLab(palette[j])
      worst = Math.min(worst, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]))
    }
  }
  return worst
}

const at = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number)
  return timeOfDayForMinute(h * 60 + m)
}
const named = (id) => TIMES.find((t) => t.id === id).value
/** The elevation the sky derives from `timeOfDay`; above zero is daylight. */
const SUN_APEX = 0.95
const sunHeight = (t) => Math.sin((t - 0.25) * Math.PI * 2) * Math.sin(SUN_APEX)

// ── the clock ─────────────────────────────────────────────────────────────────

test('the four anchored hours land exactly on their named times of day', () => {
  assert.equal(at('05:30'), named('dawn'))
  assert.equal(at('12:00'), named('noon'))
  assert.equal(at('17:45'), named('dusk'))
  assert.equal(at('19:30'), named('night'))
})

test('the sun is up between dawn and dusk, and down outside them', () => {
  for (const hhmm of ['07:00', '09:30', '12:00', '15:00', '17:00']) {
    assert.ok(sunHeight(at(hhmm)) > 0, `${hhmm} should be daylight`)
  }
  for (const hhmm of ['19:30', '21:00', '23:00', '00:00', '03:00', '05:00']) {
    assert.ok(sunHeight(at(hhmm)) < 0, `${hhmm} should be after dark`)
  }
})

test('noon is the highest the sun gets all day', () => {
  const noon = sunHeight(at('12:00'))
  for (let i = 0; i < 1440; i += 5) {
    const h = String(Math.floor(i / 60)).padStart(2, '0')
    const m = String(i % 60).padStart(2, '0')
    assert.ok(sunHeight(at(`${h}:${m}`)) <= noon + 1e-9, `${h}:${m} outshines noon`)
  }
})

test('the day never jumps, including across midnight', () => {
  // A visible step would be the light snapping rather than moving. One minute of wall clock
  // may not move the sky by more than a slider notch.
  for (let i = 0; i < 1440; i++) {
    const a = timeOfDayForMinute(i)
    const b = timeOfDayForMinute(i + 1)
    const step = Math.min(Math.abs(b - a), 1 - Math.abs(b - a))
    assert.ok(step < 0.005, `a minute at ${i} moved the sky by ${step}`)
  }
})

test('the colony runs on Bahrain time, not on this machine', () => {
  assert.equal(WORLD_TIMEZONE, 'Asia/Bahrain')
  // Fixed instant: 09:00 UTC is noon in Bahrain (UTC+3, and it keeps no summer time), so
  // this is the one assertion that would fail if the conversion were dropped for local time.
  const noonThere = new Date('2026-06-15T09:00:00Z')
  assert.equal(systemTimeOfDay(noonThere), named('noon'))
  // And the same instant is 02:00 in New York and 18:00 in Tokyo — the answer must not move.
  assert.equal(systemTimeOfDay(new Date('2026-01-15T09:00:00Z')), named('noon'), 'no summer-time drift')
})

// ── the island ────────────────────────────────────────────────────────────────

test('Bahrain is the default world, and still cycles with the others', () => {
  assert.ok(PLANETS.bahrain, 'Bahrain exists')
  assert.equal(Object.keys(PLANETS)[0], 'bahrain', 'Tab starts here')
  assert.equal(Object.keys(PLANETS).length, 4)
})

test('the colony stands on dry land, and the open sea is flat', () => {
  const planet = PLANETS.bahrain
  const mesh = createTerrain(planet, 'medium')
  const pos = mesh.geometry.attributes.position
  const water = mesh.geometry.getAttribute('aWater')
  assert.ok(water, 'the terrain carries a water attribute')

  let wetInsideColony = 0
  let notFlat = 0
  let openWater = 0
  for (let i = 0; i < pos.count; i++) {
    const dist = Math.hypot(pos.getX(i), pos.getZ(i))
    const wet = water.getX(i)
    if (dist < COLONY_RADIUS && wet > 0) wetInsideColony++
    // Fully water, not merely mostly: the last fraction of the beach is still sloping, so
    // anything short of 1 is shoreline and is *supposed* to have height left in it.
    if (wet === 1) {
      openWater++
      // Open water that is not level is a lake with waves baked into the buffer.
      if (Math.abs(pos.getY(i) - planet.sea.level) > 1e-6) notFlat++
    }
  }
  assert.equal(wetInsideColony, 0, 'no plot is ever under water')
  assert.equal(notFlat, 0, 'the sea is level')
  assert.ok(openWater > 1000, 'there is actually a sea out there')
})

test('no dune sits below the waterline', () => {
  // The hollows between dunes go to about -3. A sea at zero would stand *over* them, which
  // reads as a hole in the world rather than as an island — so the waterline is under them.
  const planet = PLANETS.bahrain
  let lowest = Infinity
  for (let a = 0; a < 360; a += 3) {
    for (let d = 0; d <= planet.sea.shore; d += 2) {
      const rad = (a * Math.PI) / 180
      lowest = Math.min(lowest, terrainHeight(Math.cos(rad) * d, Math.sin(rad) * d, planet))
    }
  }
  assert.ok(lowest > planet.sea.level, `land bottoms out at ${lowest}, sea is at ${planet.sea.level}`)
})

test('nothing is planted in the sea, and the planting is sparse', () => {
  const planet = PLANETS.bahrain
  const group = createScatter(planet, 1)
  const m = new THREE.Matrix4()
  let planted = 0
  for (const mesh of group.children) {
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m)
      planted++
      const x = m.elements[12]
      const y = m.elements[13]
      const z = m.elements[14]
      assert.ok(y > planet.sea.level, `a prop at ${Math.hypot(x, z).toFixed(1)}m is in the water`)
    }
  }
  const terra = createScatter(PLANETS.terra, 1).children.reduce((n, mesh) => n + mesh.count, 0)
  assert.ok(planted > 0, 'something grows here')
  assert.ok(planted < terra * 0.6, `Bahrain (${planted}) should be sparser than Terra (${terra})`)
})

test('Bahrain paints its zones pearl, and the tones stay tellable apart', () => {
  const palette = PLANETS.bahrain.palette
  assert.equal(palette.length, PLOT_PALETTE.length, 'as many zone colours as the default')
  const hsl = {}
  for (const accent of palette) {
    new THREE.Color(accent).getHSL(hsl)
    assert.ok(hsl.l > 0.55, `#${accent.toString(16)} is not a pearl tone (lightness ${hsl.l})`)
  }
  // Pearl is a narrow band, so the risk is twelve zones nobody can distinguish. Measured
  // against the palette it replaces, which has two blues 1.0 apart and gets away with it.
  const worst = closestPair(palette)
  assert.ok(worst > closestPair(PLOT_PALETTE), `pearl (ΔE ${worst}) is less separable than the default`)
  assert.ok(worst > 6, `two zone colours are only ΔE ${worst} apart`)
})

test('a pale accent still gets a deck the buildings can be seen against', () => {
  const hsl = {}
  // The cap exists for pearl; it must not have moved a single existing deck to get there.
  for (const accent of PLOT_PALETTE) {
    const before = new THREE.Color(accent).offsetHSL(0, -0.38, 0).multiplyScalar(0.9)
    const after = deckColor(accent)
    assert.deepEqual([after.r, after.g, after.b], [before.r, before.g, before.b], `#${accent.toString(16)} moved`)
  }
  for (const accent of PLANETS.bahrain.palette) {
    deckColor(accent).getHSL(hsl)
    assert.ok(hsl.l <= 0.341, `a pearl deck came out at lightness ${hsl.l}`)
  }
})

test('the three older worlds are exactly as they were', () => {
  assert.equal(PLANETS.moon.palette, undefined, 'Luna uses the default palette')
  for (const id of ['moon', 'mars', 'terra']) {
    const planet = PLANETS[id]
    assert.equal(planet.sea, undefined, `${id} has no sea`)
    const mesh = createTerrain(planet, 'low')
    assert.equal(mesh.geometry.getAttribute('aWater'), undefined, `${id} gains no water attribute`)
    // three puts a no-op on the prototype, so truthiness proves nothing — own property does.
    assert.equal(
      Object.prototype.hasOwnProperty.call(mesh.material, 'onBeforeCompile'),
      false,
      `${id}'s terrain shader is untouched`
    )
  }
})
