import * as THREE from 'three'
import { atlasTexture, hasPart, part } from './kit.js'

/**
 * The worlds you can put the colony on, and the terrain generator that draws them.
 *
 * A planet is nothing but a bag of colours and a couple of switches — terrain, scatter, sky
 * and lighting all read from the same preset, so adding a world is a data change rather than
 * a code change.
 *
 * These fields are optional, and exist because Bahrain wanted things the first three worlds
 * did not. Every one falls back to what those worlds already did, so none of them changed:
 *
 *   `sea`          — turns the far field into water and the middle into an island
 *   `night`        — the after-dark sky, instead of the day palette crushed toward black
 *   `dusk`         — what a low sun bleeds into, instead of the atmosphere rule
 *   `foliage`      — a tint over the scatter pack's own green, for a drier kind of tree
 *   `scatterScale` — how planted this world is, under whatever the quality preset asked for
 *   `palette`      — the zone colours, instead of `PLOT_PALETTE`
 *   `accent`       — the default building accent, for a structure with no zone colour
 */

/** Night falling, for the water. Written once a frame beside `buildingUniforms.uNight`. */
export const waterUniforms = { uNight: { value: 0 } }

export const PLANETS = {
  /**
   * Home. Sand, shallow turquoise water and a haze that never quite clears — and the one
   * world here that is a real place, which is why it is the default rather than the Moon.
   */
  bahrain: {
    id: 'bahrain',
    name: 'Bahrain',
    blurb: 'Pale sand, turquoise shallows, and a Gulf haze.',
    ground: { low: 0xc7a972, high: 0xe8d5a8, tint: 0xf5e9cc },
    rock: 0xb09b78,
    horizon: 0x2bb5ae,
    sky: { top: 0x3d7fbe, bottom: 0xe6d4ab },
    // Indigo overhead, deep Gulf blue at the waterline — not the day palette dimmed.
    night: { top: 0x151b3e, horizon: 0x0b1f3a },
    dusk: 0xe8763a,
    fog: { color: 0xd6c39c, near: 88, far: 245 },
    sun: { color: 0xfff2d8, intensity: 2.5, night: 0.11 },
    ambient: { sky: 0x9fcfe0, ground: 0x8a7448, intensity: 0.95 },
    atmosphere: 1,
    craters: 0,
    // Low, because dunes are dunes and not hills. The island shaping below does the shape.
    roughness: 0.5,
    scatter: 'palms',
    // Sparse on purpose: a palm every few metres is a plantation, not a Gulf island.
    scatterScale: 0.4,
    foliage: 0xd2dc9e,
    accent: 0xf2ede3,
    /**
     * Zone colours, re-rooted on pearl white. Overrides `PLOT_PALETTE` for this world only.
     *
     * Pearl is a narrow band to pick twelve distinguishable colours out of, so these spread
     * across *value* as well as hue — pearl down through champagne and greige to oyster —
     * rather than being twelve tints of the same lightness, which would be a dozen zones
     * nobody could tell apart. Measured, the closest pair here is ΔE 9.0; the closest pair
     * in `PLOT_PALETTE` is ΔE 1.0, so this is the more separable of the two.
     */
    palette: [
      0xf2ede3, 0xe6d9bc, 0xd4e2df, 0xf0dbd0, 0xdcd6c6, 0xdde4f2,
      0xf3e9cc, 0xd7e2d2, 0xecd8e0, 0xc6d2d6, 0xe6e0f0, 0xd8cbb4,
    ],
    sea: {
      /**
       * Below every dune, not at zero. The hollows between the dunes reach about -3 at this
       * roughness, and a waterline at zero puts the sea *above* them — sand sitting in a
       * basin with the water standing over it, which reads as a hole in the world rather
       * than as an island. Dropping the sea instead of raising the land leaves the colony
       * floor where every other system expects it, and the island gains a coastal bank.
       */
      level: -3.6,
      shore: 100,
      falloff: 34,
      shallow: 0x2bb5ae,
      deep: 0x0b1f3a,
    },
    companion: { name: 'Moon', color: 0xdcd8cc, size: 3.2, glow: 0xfff6e0 },
    dust: 0.5,
  },
  moon: {
    id: 'moon',
    name: 'Luna',
    blurb: 'Airless, high contrast, very long shadows.',
    ground: { low: 0x4a4a52, high: 0x8f8d90, tint: 0xb9b4ae },
    rock: 0x6d6a70,
    horizon: 0x14141c,
    sky: { top: 0x05060c, bottom: 0x101018 },
    fog: { color: 0x07080e, near: 100, far: 235 },
    sun: { color: 0xfff4e2, intensity: 2.6, night: 0.05 },
    ambient: { sky: 0x3a4258, ground: 0x4a423a, intensity: 0.7 },
    // No atmosphere: shadows stay black and the stars never wash out.
    atmosphere: 0,
    craters: 26,
    roughness: 0.9,
    scatter: 'rocks',
    companion: { name: 'Earth', color: 0x4a7fc9, size: 5.4, glow: 0x6ea8ff },
    dust: 0,
  },
  mars: {
    id: 'mars',
    name: 'Mars',
    blurb: 'Rust, dust, and a pink sky at noon.',
    ground: { low: 0x6b3320, high: 0xb56b40, tint: 0xd89464 },
    rock: 0x8a4a2c,
    horizon: 0x3a2118,
    sky: { top: 0x2b1a1e, bottom: 0xc4703c },
    fog: { color: 0x50301f, near: 82, far: 205 },
    sun: { color: 0xffd9b0, intensity: 2.2, night: 0.09 },
    ambient: { sky: 0xc07a52, ground: 0x4a2418, intensity: 0.75 },
    atmosphere: 0.55,
    craters: 12,
    roughness: 1.15,
    scatter: 'rocks',
    companion: { name: 'Phobos', color: 0x9a8878, size: 1.5, glow: 0xb8a494 },
    dust: 1,
  },
  terra: {
    id: 'terra',
    name: 'Terra',
    blurb: 'An earthlike one. Grass, blue hour, fireflies.',
    ground: { low: 0x2f5a34, high: 0x6d9a4a, tint: 0x86ae5c },
    rock: 0x6b6f63,
    horizon: 0x6fa8d8,
    sky: { top: 0x1d4d8f, bottom: 0x9ec8e8 },
    fog: { color: 0x6b8fa8, near: 92, far: 230 },
    sun: { color: 0xfff0d4, intensity: 2.4, night: 0.13 },
    ambient: { sky: 0x88bfe8, ground: 0x3f5a30, intensity: 0.95 },
    atmosphere: 1,
    craters: 0,
    roughness: 0.75,
    scatter: 'flora',
    companion: { name: 'Moon', color: 0xdcd8cc, size: 3.2, glow: 0xfff6e0 },
    dust: 0.25,
  },
}

const GROUND_SIZE = 340
/** Everything inside this radius is the buildable colony, and is kept nearly flat. */
export const COLONY_RADIUS = 46
const DETAIL_SEGMENTS = { low: 72, medium: 128, high: 190 }

/**
 * Terrain is one plane, displaced and vertex-coloured on the CPU at build time. Doing it
 * once and baking it into the buffer means the GPU only ever sees static geometry — no
 * displacement map sample, no per-frame work — and vertex colours give the surface its
 * mottling for free rather than costing a texture fetch.
 */
export function createTerrain(planet, detail, seed = 1337) {
  const segments = DETAIL_SEGMENTS[detail] || DETAIL_SEGMENTS.medium
  const geo = new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE, segments, segments)
  geo.rotateX(-Math.PI / 2)

  const noise = makeNoise(seed)
  const craters = makeCraters(planet.craters, seed)
  const pos = geo.attributes.position
  const colors = new Float32Array(pos.count * 3)

  const low = new THREE.Color(planet.ground.low)
  const high = new THREE.Color(planet.ground.high)
  const tint = new THREE.Color(planet.ground.tint)
  const c = new THREE.Color()

  // Only a world with a sea pays for any of this; the other three allocate nothing.
  const water = planet.sea ? new Float32Array(pos.count) : null
  const shallow = planet.sea ? new THREE.Color(planet.sea.shallow) : null
  const deep = planet.sea ? new THREE.Color(planet.sea.deep) : null
  const sea = new THREE.Color()

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const z = pos.getZ(i)
    const dist = Math.hypot(x, z)

    // Flat where the colony lives, then hills that ramp in over the next forty metres —
    // so nothing ever builds on a slope but the horizon still has shape to it.
    const outside = THREE.MathUtils.smoothstep(dist, COLONY_RADIUS - 6, COLONY_RADIUS + 40)
    const gentle = fbm(noise, x * 0.035, z * 0.035, 3) * 0.5
    const hills = fbm(noise, x * 0.012, z * 0.012, 4) * 9 + fbm(noise, x * 0.05, z * 0.05, 2) * 1.4
    let y = gentle * planet.roughness * (1 - outside) + hills * outside * planet.roughness

    for (const crater of craters) {
      const d = Math.hypot(x - crater.x, z - crater.z)
      if (d > crater.r * 1.5) continue
      // A bowl with a raised rim — the rim is what makes it read as an impact.
      const t = d / crater.r
      if (t < 1) y -= (1 - t * t) * crater.depth
      else y += (1 - Math.abs(t - 1.22) / 0.28) * crater.depth * 0.32
    }

    // Past the shore the dunes settle to the waterline, which is what turns the plane into
    // an island rather than ground that happens to stop. Same call the height sampler makes,
    // so anything walking or building on this surface agrees with what is drawn.
    const wet = seaMix(dist, planet)
    if (wet > 0) y = THREE.MathUtils.lerp(y, planet.sea.level, wet)

    pos.setY(i, y)
    if (water) water[i] = wet

    // Colour: height-driven blend, mottled with a second noise band so it never bands.
    const shade = THREE.MathUtils.clamp(0.42 + y * 0.09 + fbm(noise, x * 0.09, z * 0.09, 2) * 0.5, 0, 1)
    c.copy(low).lerp(high, shade)
    const speck = fbm(noise, x * 0.55, z * 0.55, 1)
    c.lerp(tint, Math.max(0, speck) * 0.22)
    // Darken the far field hard so the eye settles on the colony and the hills read as a
    // silhouette rather than as more ground competing with the plots for attention.
    c.multiplyScalar(1 - THREE.MathUtils.smoothstep(dist, COLONY_RADIUS * 0.7, GROUND_SIZE * 0.35) * 0.75)

    // Water is laid over that darkening rather than under it: a sea crushed to near-black
    // by the far-field falloff is just more silhouette, and the turquoise is the point.
    // Fog is what takes it to the horizon instead.
    if (wet > 0) {
      const depth = THREE.MathUtils.smoothstep(dist, planet.sea.shore, planet.sea.shore + planet.sea.falloff * 2.6)
      c.lerp(sea.copy(shallow).lerp(deep, depth * 0.72), wet)
    }

    colors[i * 3] = c.r
    colors[i * 3 + 1] = c.g
    colors[i * 3 + 2] = c.b
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  if (water) geo.setAttribute('aWater', new THREE.BufferAttribute(water, 1))
  geo.computeVertexNormals()

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.97,
    metalness: 0,
    // Flat-ish shading keeps the low-poly read; a dielectric surface with no spec highlight
    // is what sells "dust" rather than "plastic".
    envMapIntensity: 0.3,
  })
  if (planet.sea) makeWet(mat, planet.sea)
  const mesh = new THREE.Mesh(geo, mat)
  mesh.receiveShadow = true
  mesh.name = 'terrain'

  // Sampler so anything placed later can sit exactly on the surface.
  mesh.userData.heightAt = (x, z) => sampleHeight(x, z, noise, craters, planet)
  return mesh
}

/**
 * How much of the surface at `dist` from the middle is water: 0 on the island, 1 out at sea,
 * with the beach in between. Worlds without a `sea` are dry everywhere.
 */
function seaMix(dist, planet) {
  if (!planet.sea) return 0
  return THREE.MathUtils.smoothstep(dist, planet.sea.shore, planet.sea.shore + planet.sea.falloff)
}

/**
 * Sea that darkens after sunset, without rebuilding a 190×190 vertex buffer to do it.
 *
 * The water colour is baked into the vertex buffer with everything else, so night has to
 * happen in the shader: `aWater` says which vertices are sea, `uNight` says how dark it is
 * outside, and the fragment stage mixes between them. Sand is untouched because `aWater` is
 * zero there — the whole terrain stays one mesh, one material, one draw.
 *
 * Water is also flat and horizontal, which means it faces almost none of a low sun. Left at
 * the ground's own roughness it goes matte grey at dusk; a smoother, slightly metallic
 * surface takes its colour from the sky instead, which is what a shallow lagoon does.
 */
function makeWet(material, sea) {
  const deep = new THREE.Color(sea.deep)
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = waterUniforms.uNight
    shader.uniforms.uDeep = { value: deep }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n attribute float aWater;\n varying float vWater;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n vWater = aWater;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n varying float vWater;\n uniform float uNight;\n uniform vec3 uDeep;')
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\n diffuseColor.rgb = mix( diffuseColor.rgb, uDeep, vWater * uNight );'
      )
      // `roughnessFactor` and `metalnessFactor` are declared by these two chunks, so the
      // water's own values have to be applied after them rather than up at the colour.
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n roughnessFactor = mix( roughnessFactor, 0.22, vWater );'
      )
      .replace(
        '#include <metalnessmap_fragment>',
        '#include <metalnessmap_fragment>\n metalnessFactor = mix( metalnessFactor, 0.35, vWater );'
      )
  }
  // Two materials that compile to different programs must not share a cache key.
  material.customProgramCacheKey = () => 'terrain-sea'
}

function sampleHeight(x, z, noise, craters, planet) {
  const dist = Math.hypot(x, z)
  const outside = THREE.MathUtils.smoothstep(dist, COLONY_RADIUS - 6, COLONY_RADIUS + 40)
  const gentle = fbm(noise, x * 0.035, z * 0.035, 3) * 0.5
  const hills = fbm(noise, x * 0.012, z * 0.012, 4) * 9 + fbm(noise, x * 0.05, z * 0.05, 2) * 1.4
  let y = gentle * planet.roughness * (1 - outside) + hills * outside * planet.roughness
  for (const crater of craters) {
    const d = Math.hypot(x - crater.x, z - crater.z)
    if (d > crater.r * 1.5) continue
    const t = d / crater.r
    if (t < 1) y -= (1 - t * t) * crater.depth
    else y += (1 - Math.abs(t - 1.22) / 0.28) * crater.depth * 0.32
  }
  const wet = seaMix(dist, planet)
  return wet > 0 ? THREE.MathUtils.lerp(y, planet.sea.level, wet) : y
}

/** Craters only ever land outside the colony, so they never eat a build plot. */
function makeCraters(count, seed) {
  const rand = mulberry(seed ^ 0x9e37)
  const out = []
  for (let i = 0; i < count; i++) {
    const a = rand() * Math.PI * 2
    const d = COLONY_RADIUS + 14 + rand() * 110
    const r = 4 + rand() * 16
    out.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, r, depth: r * (0.18 + rand() * 0.16) })
  }
  return out
}

// ── scatter ───────────────────────────────────────────────────────────────────────────

const SCATTER_BUDGET = 900

/**
 * Rocks, boulders and plants. All instanced, all placed with a deterministic RNG so the
 * same planet always looks the same, and all kept clear of the plots and walkways.
 */
/**
 * What grows on a world, and how it is planted.
 *
 * `weight` is how often a shape comes up relative to its siblings, `size` the range of its
 * base scale, and `sink` how far into the ground it settles as a fraction of that scale.
 * A boulder half-buried reads as bedrock; a tree buried by the same amount reads as a
 * mistake, so the two want very different numbers.
 *
 * All of it comes from KayKit's Forest Nature Pack, which is why the same list can dress a
 * meadow and a crater field: its boulders are painted neutral grey, so a per-instance tint
 * takes them to lunar dust or Martian rust without touching the atlas.
 */
const SCATTER = {
  flora: [
    { part: 'Tree_1_A_Color1', weight: 3, size: [0.35, 0.6], sink: 0.02, upright: true },
    { part: 'Tree_3_A_Color1', weight: 3, size: [0.35, 0.6], sink: 0.02, upright: true },
    { part: 'Tree_4_A_Color1', weight: 2, size: [0.3, 0.55], sink: 0.02, upright: true },
    { part: 'Tree_1_C_Color1', weight: 1, size: [0.25, 0.4], sink: 0.02, upright: true },
    { part: 'Tree_3_C_Color1', weight: 1, size: [0.22, 0.38], sink: 0.02, upright: true },
    { part: 'Tree_4_C_Color1', weight: 1, size: [0.2, 0.35], sink: 0.02, upright: true },
    { part: 'Bush_1_E_Color1', weight: 3, size: [0.5, 1.1], sink: 0.06, upright: true },
    { part: 'Bush_3_B_Color1', weight: 3, size: [0.5, 1.1], sink: 0.06, upright: true },
    { part: 'Grass_2_D_Color1', weight: 4, size: [0.6, 1.3], sink: 0.05, upright: true },
    { part: 'Rock_1_D_Color1', weight: 2, size: [0.4, 0.9], sink: 0.3, tint: true },
  ],
  /**
   * Bahrain: Terra's trees and bushes and nothing else — no grass tufts, no scattered
   * boulders. A palm is taller and thinner than the pack's firs, so the size ranges run
   * higher than Terra's while the planting stays sparse, which is the `scatterScale` on
   * the preset rather than a change here.
   */
  palms: [
    { part: 'Tree_1_A_Color1', weight: 4, size: [0.5, 0.85], sink: 0.02, upright: true },
    { part: 'Tree_3_A_Color1', weight: 3, size: [0.5, 0.85], sink: 0.02, upright: true },
    { part: 'Tree_4_A_Color1', weight: 2, size: [0.45, 0.8], sink: 0.02, upright: true },
    { part: 'Tree_1_C_Color1', weight: 1, size: [0.35, 0.6], sink: 0.02, upright: true },
    { part: 'Bush_1_E_Color1', weight: 3, size: [0.4, 0.9], sink: 0.08, upright: true },
    { part: 'Bush_3_B_Color1', weight: 2, size: [0.4, 0.9], sink: 0.08, upright: true },
  ],
  rocks: [
    { part: 'Rock_1_D_Color1', weight: 4, size: [0.5, 1.2], sink: 0.3, tint: true },
    { part: 'Rock_2_C_Color1', weight: 4, size: [0.5, 1.2], sink: 0.3, tint: true },
    { part: 'Rock_3_E_Color1', weight: 3, size: [0.6, 1.4], sink: 0.15, tint: true },
    { part: 'Rock_1_J_Color1', weight: 1, size: [0.3, 0.7], sink: 0.25, tint: true },
    { part: 'Rock_2_G_Color1', weight: 1, size: [0.3, 0.7], sink: 0.25, tint: true },
    { part: 'Rock_3_L_Color1', weight: 2, size: [0.4, 0.9], sink: 0.12, tint: true },
    { part: 'Rock_3_Q_Color1', weight: 1, size: [0.25, 0.55], sink: 0.1, tint: true },
  ],
}

/** The fallback when the kit has not loaded: the primitives this used to be made of. */
function fallbackShapes(isFlora) {
  const shapes = isFlora
    ? [new THREE.IcosahedronGeometry(0.5, 0), new THREE.ConeGeometry(0.42, 1.5, 5), new THREE.SphereGeometry(0.5, 6, 4)]
    : [
        new THREE.DodecahedronGeometry(0.55, 0),
        new THREE.IcosahedronGeometry(0.6, 0),
        new THREE.TetrahedronGeometry(0.72, 0),
      ]
  for (const g of shapes) g.computeVertexNormals()
  return shapes.map((geo) => ({ geo, sink: 0.25, size: [0.28, 0.83], tint: true, upright: false }))
}

export function createScatter(planet, density, keepClear = [], seed = 4242) {
  const group = new THREE.Group()
  group.name = 'scatter'
  // `scatterScale` is the world's own idea of how planted it is, under whatever the quality
  // preset asked for — so turning quality up on a sparse world gets you a better-looking
  // sparse world rather than a lush one.
  const planted = THREE.MathUtils.clamp(density, 0, 1) * (planet.scatterScale ?? 1)
  const count = Math.round(SCATTER_BUDGET * planted)
  if (count <= 0) return group

  const rand = mulberry(seed)
  const isFlora = planet.scatter === 'flora' || planet.scatter === 'palms'
  const recipe = SCATTER[planet.scatter] || SCATTER.rocks
  const ready = recipe.every((r) => hasPart(r.part, 'forest'))

  const kinds = ready
    ? recipe.map((r) => ({ ...r, geo: part(r.part, 'forest'), weight: r.weight }))
    : fallbackShapes(isFlora).map((r) => ({ ...r, weight: 1 }))

  // One material for the lot. The pack's atlas carries the greens and the greys, and the
  // per-instance colour is a *tint* on top of it — white for anything already the right
  // colour, the planet's own rock for a boulder that has to belong to this world.
  //
  // Lambert rather than the PBR material everything else wears: leaves and boulders are
  // matte, and a specular lobe on them was never visible — but it was paid for, on the far
  // palms in particular, which are scaled up and fill a good deal of the horizon. Lambert
  // still takes the sky's irradiance from the environment map, so the shading changes
  // character through the day with everything else; it just stops computing a highlight
  // nobody could see.
  const atlas = ready ? atlasTexture('forest') : null
  const material = new THREE.MeshLambertMaterial({
    map: atlas,
    color: 0xffffff,
    flatShading: !ready,
  })

  const total = kinds.reduce((sum, k) => sum + k.weight, 0)
  const meshes = kinds.map((k) =>
    new THREE.InstancedMesh(k.geo, material, Math.ceil((count * k.weight) / total) + 8)
  )

  const rock = new THREE.Color(planet.rock)
  // What foliage is tinted with. White leaves the pack's own green alone, which is what
  // Terra wants; Bahrain hands over a pale olive that multiplies the green down to the
  // drier, dustier palm colour without darkening it the way a saturated tint would.
  const leaf = new THREE.Color(planet.foliage ?? 0xffffff)
  const dummy = new THREE.Object3D()
  const color = new THREE.Color()
  const fill = new Array(kinds.length).fill(0)

  // Pick by weight: a cumulative table beats a uniform index when a fir should be rarer
  // than a grass tuft.
  const pickKind = () => {
    let roll = rand() * total
    for (let i = 0; i < kinds.length; i++) {
      roll -= kinds[i].weight
      if (roll <= 0) return i
    }
    return kinds.length - 1
  }

  for (let i = 0; i < count; i++) {
    // Bias outward: a ring is thicker where there is more area, which √ gives for free.
    const a = rand() * Math.PI * 2
    const d = 9 + Math.sqrt(rand()) * 150
    const x = Math.cos(a) * d
    const z = Math.sin(a) * d
    if (keepClear.some((p) => Math.hypot(x - p.x, z - p.z) < p.r)) continue
    // Nothing grows in the sea, and the beach itself stays clear — a palm standing in the
    // surf is the one thing that would give the island away as a painted plane.
    if (seaMix(d, planet) > 0.02) continue

    const which = pickKind()
    const kind = kinds[which]
    const mesh = meshes[which]
    const slot = fill[which]
    if (slot >= mesh.instanceMatrix.count) continue

    // Far-field props are allowed to be much bigger, which reads as distance.
    const far = THREE.MathUtils.smoothstep(d, COLONY_RADIUS, 130)
    const [lo, hi] = kind.size
    const s = (lo + rand() * (hi - lo)) * (1 + far * 1.9)

    dummy.position.set(x, sampleY(x, z, planet, seed) - s * kind.sink, z)
    // A tree that leans is a fallen tree. Boulders may lie however they landed.
    if (kind.upright) dummy.rotation.set(0, rand() * Math.PI * 2, 0)
    else dummy.rotation.set((rand() - 0.5) * 0.5, rand() * Math.PI * 2, (rand() - 0.5) * 0.5)
    const jitter = kind.upright ? 0.14 : 0.35
    dummy.scale.set(
      s * (1 - jitter / 2 + rand() * jitter),
      s * (1 - jitter / 2 + rand() * jitter),
      s * (1 - jitter / 2 + rand() * jitter)
    )
    dummy.updateMatrix()
    mesh.setMatrixAt(slot, dummy.matrix)

    // Foliage keeps the colour it was painted; rock takes the planet's. The tint is lifted
    // because it *multiplies* the atlas rather than replacing it — the pack's stone is a
    // mid grey, and rust times mid grey is a much darker rust than the ground it sits on.
    if (kind.tint) color.copy(rock).multiplyScalar(1.55)
    else color.copy(leaf)
    color.offsetHSL((rand() - 0.5) * 0.03, (rand() - 0.5) * 0.08, (rand() - 0.5) * 0.14)
    mesh.setColorAt(slot, color)
    fill[which] = slot + 1
  }

  meshes.forEach((mesh, i) => {
    mesh.count = fill[i]
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    group.add(mesh)
  })
  return group
}

/**
 * Terrain height at a world point — the same field the mesh was built from, evaluated on
 * demand. Used to place scatter, and to keep anything that walks on the ground *on* it.
 */
export function terrainHeight(x, z, planet) {
  return sampleY(x, z, planet, 1337)
}

// A private terrain sampler for scatter placement — the same field the mesh was built from.
const _samplers = new Map()
function sampleY(x, z, planet, seed) {
  let s = _samplers.get(planet.id)
  if (!s) {
    s = { noise: makeNoise(1337), craters: makeCraters(planet.craters, 1337) }
    _samplers.set(planet.id, s)
  }
  return sampleHeight(x, z, s.noise, s.craters, planet)
}

// ── noise ─────────────────────────────────────────────────────────────────────────────

/** Small deterministic PRNG — same seed, same world, every reload. */
export function mulberry(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Value noise on a hashed lattice with smoothstep interpolation — cheap and smooth enough. */
function makeNoise(seed) {
  const rand = mulberry(seed)
  const size = 256
  const table = new Float32Array(size * size)
  for (let i = 0; i < table.length; i++) table[i] = rand() * 2 - 1

  return function noise(x, y) {
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    const xf = x - xi
    const yf = y - yi
    const u = xf * xf * (3 - 2 * xf)
    const v = yf * yf * (3 - 2 * yf)
    const at = (a, b) => table[(((a % size) + size) % size) * size + (((b % size) + size) % size)]
    const a = at(xi, yi)
    const b = at(xi + 1, yi)
    const c = at(xi, yi + 1)
    const d = at(xi + 1, yi + 1)
    return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v
  }
}

function fbm(noise, x, y, octaves) {
  let sum = 0
  let amp = 1
  let freq = 1
  let norm = 0
  for (let i = 0; i < octaves; i++) {
    sum += noise(x * freq, y * freq) * amp
    norm += amp
    amp *= 0.5
    freq *= 2.07
  }
  return sum / norm
}
