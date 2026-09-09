import * as THREE from 'three'
import { mulberry } from './planet.js'

/**
 * Gulls. A few loose flocks wheeling over the shore, in one instanced draw.
 *
 * They carry no information and that is the point: they are there so the island is never
 * completely still, and so that a glance at the map finds something moving even when every
 * thread on it is idle. Each flock drifts round the island on a slow lap; each bird orbits
 * its flock on a loop of its own, and flaps or glides on its own clock — a crowd flapping
 * in unison reads as a screensaver.
 *
 * The wingbeat is in the vertex shader, so the whole thing is eighteen matrix writes a
 * frame and one draw. Only a world with air gets them.
 */

const COUNT = 18
const FLOCKS = 3
/** Wingspan in world units. A gull next to a 1.2-unit builder is about this. */
const SPAN = 1.3

/** The bird: a body and two wings, ten triangles, coloured per vertex. */
function gullGeometry() {
  const body = 0.42
  const half = SPAN / 2
  const positions = []
  const colors = []
  const flap = []
  const white = [0.96, 0.96, 0.95]
  const grey = [0.62, 0.65, 0.7]
  const dark = [0.28, 0.3, 0.34]

  const tri = (a, b, c, ca, cb, cc, fa, fb, fc) => {
    positions.push(...a, ...b, ...c)
    colors.push(...ca, ...cb, ...cc)
    flap.push(fa, fb, fc)
  }

  // Body: a flattened diamond, nose forward along +z.
  const nose = [0, 0, body * 0.55]
  const tail = [0, 0.02, -body * 0.45]
  const top = [0, 0.07, 0]
  const bottom = [0, -0.06, 0]
  const l = [-0.09, 0, 0]
  const r = [0.09, 0, 0]
  tri(nose, top, l, white, white, white, 0, 0, 0)
  tri(nose, r, top, white, white, white, 0, 0, 0)
  tri(tail, l, top, grey, white, white, 0, 0, 0)
  tri(tail, top, r, grey, white, white, 0, 0, 0)
  tri(nose, l, bottom, white, grey, grey, 0, 0, 0)
  tri(nose, bottom, r, white, grey, grey, 0, 0, 0)

  // Wings: a swept quad each, tips darker, and `flap` says how far out along the wing a
  // vertex is so the shader can lift the tips and leave the roots be.
  for (const side of [-1, 1]) {
    const root0 = [side * 0.08, 0.03, 0.12]
    const root1 = [side * 0.08, 0.03, -0.1]
    const mid0 = [side * half * 0.55, 0.05, 0.02]
    const mid1 = [side * half * 0.55, 0.05, -0.2]
    const tip = [side * half, 0.02, -0.28]
    const f = 0.55
    if (side < 0) {
      tri(root0, mid0, root1, white, white, white, 0, f, 0)
      tri(root1, mid0, mid1, white, white, grey, 0, f, f)
      tri(mid0, tip, mid1, white, dark, grey, f, 1, f)
    } else {
      tri(root0, root1, mid0, white, white, white, 0, 0, f)
      tri(root1, mid1, mid0, white, grey, white, 0, f, f)
      tri(mid0, mid1, tip, white, grey, dark, f, f, 1)
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geo.setAttribute('aFlap', new THREE.Float32BufferAttribute(flap, 1))
  geo.computeVertexNormals()
  return geo
}

export class Gulls {
  constructor(scene) {
    this.scene = scene
    this.uniforms = { uTime: { value: 0 } }

    const geo = gullGeometry()
    // Per bird: where in its wingbeat it is, and its own slow flap-or-glide cycle.
    const phase = new Float32Array(COUNT)
    const rand = mulberry(7373)
    for (let i = 0; i < COUNT; i++) phase[i] = rand() * Math.PI * 2
    geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1))

    const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uniforms.uTime
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           attribute float aFlap;
           attribute float aPhase;
           uniform float uTime;`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           // Flap, then glide, then flap again, on a cycle of the bird's own; while gliding
           // the wings hold a shallow V. The beat itself is quick, as a gull's is.
           float cycle = sin( uTime * 0.13 + aPhase * 2.7 );
           float amp = smoothstep( -0.35, 0.25, cycle );
           float beat = sin( uTime * 7.5 + aPhase );
           float lift = mix( 0.12, beat * 0.42, amp );
           transformed.y += lift * aFlap * ${SPAN.toFixed(2)} * 0.5;
           transformed.x *= 1.0 - 0.14 * aFlap * max( lift, 0.0 );`
        )
    }
    material.customProgramCacheKey = () => 'gull'

    this.mesh = new THREE.InstancedMesh(geo, material, COUNT)
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.frustumCulled = false
    this.mesh.castShadow = false
    this.mesh.receiveShadow = false
    this.mesh.name = 'gulls'
    this.mesh.visible = false
    scene.add(this.mesh)

    this._dummy = new THREE.Object3D()
    this._flocks = []
    this._birds = []
    this._seed(rand)
  }

  /** Where the flocks fly and how each bird circles its own. Deterministic, so it looks the same each day. */
  _seed(rand) {
    for (let f = 0; f < FLOCKS; f++) {
      this._flocks.push({
        // Each flock laps the island at its own distance and pace, a few minutes a lap.
        radius: 62 + rand() * 40,
        angle: rand() * Math.PI * 2,
        rate: (0.018 + rand() * 0.014) * (rand() > 0.5 ? 1 : -1),
        height: 9 + rand() * 8,
        bob: rand() * Math.PI * 2,
      })
    }
    for (let i = 0; i < COUNT; i++) {
      this._birds.push({
        flock: i % FLOCKS,
        radius: 2.5 + rand() * 5,
        angle: rand() * Math.PI * 2,
        rate: (0.32 + rand() * 0.38) * (rand() > 0.3 ? 1 : -1),
        rise: (rand() - 0.5) * 3,
        bob: rand() * Math.PI * 2,
      })
    }
  }

  /** Gulls want air. A world without an atmosphere has none. */
  setPlanet(planet) {
    this.mesh.visible = (planet?.atmosphere ?? 0) >= 0.9
  }

  update(dt, elapsed, anim = 1) {
    if (!this.mesh.visible) return
    this.uniforms.uTime.value = elapsed
    const d = this._dummy
    for (const flock of this._flocks) flock.angle += flock.rate * dt * anim
    for (let i = 0; i < COUNT; i++) {
      const b = this._birds[i]
      const f = this._flocks[b.flock]
      b.angle += b.rate * dt * anim
      const cx = Math.cos(f.angle) * f.radius
      const cz = Math.sin(f.angle) * f.radius
      const cy = f.height + Math.sin(elapsed * 0.21 + f.bob) * 1.2
      const x = cx + Math.cos(b.angle) * b.radius
      const z = cz + Math.sin(b.angle) * b.radius
      const y = cy + b.rise + Math.sin(elapsed * 0.7 + b.bob) * 0.35
      // Heading from the motion itself: the flock's drift plus the bird's own circling.
      const vx = -Math.sin(f.angle) * f.radius * f.rate - Math.sin(b.angle) * b.radius * b.rate
      const vz = Math.cos(f.angle) * f.radius * f.rate + Math.cos(b.angle) * b.radius * b.rate
      d.position.set(x, y, z)
      d.rotation.set(0, Math.atan2(vx, vz), -b.rate * 0.35, 'YXZ')
      d.updateMatrix()
      this.mesh.setMatrixAt(i, d.matrix)
    }
    this.mesh.instanceMatrix.needsUpdate = true
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
    this.scene.remove(this.mesh)
  }
}
