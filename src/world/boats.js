import * as THREE from 'three'
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js'
import { mulberry } from './planet.js'

/**
 * Dhows on the water, in one instanced draw.
 *
 * Traffic for the sea, the way the gulls are traffic for the sky: a few lateen-rigged boats
 * making slow laps of the island just off the shore, riding a small swell. They carry no
 * information, exist only on a world that has a sea, and cost three matrix writes a frame.
 */

const COUNT = 3

/** A dhow: tapered hull, deck, raked mast, a yard and a lateen sail. Coloured per vertex. */
function dhowGeometry() {
  const parts = []
  const paint = (geo, hex) => {
    const c = new THREE.Color(hex)
    const n = geo.attributes.position.count
    const colors = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      colors[i * 3] = c.r
      colors[i * 3 + 1] = c.g
      colors[i * 3 + 2] = c.b
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geo.deleteAttribute('uv')
    parts.push(geo)
  }

  // Hull: a box pinched toward both ends and lifted at them, so it reads as a boat and not
  // a crate. The bow is the sharper end.
  const hull = new THREE.BoxGeometry(5.2, 1.0, 1.9, 8, 1, 1)
  const pos = hull.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const t = Math.abs(x) / 2.6
    const bow = x > 0 ? 0.25 * t : 0
    pos.setZ(i, pos.getZ(i) * (1 - 0.72 * t * t - bow))
    pos.setY(i, pos.getY(i) + 0.32 * t * t)
  }
  hull.computeVertexNormals()
  paint(hull, 0xe8dcc2)

  const deck = new THREE.BoxGeometry(4.0, 0.14, 1.35)
  deck.translate(0, 0.5, 0)
  paint(deck, 0x8a6746)

  const mast = new THREE.CylinderGeometry(0.05, 0.075, 4.4, 5)
  mast.rotateZ(-0.12)
  mast.translate(0.35, 2.55, 0)
  paint(mast, 0x6e5238)

  // The yard runs from low aft to high forward, and the sail hangs off it.
  const yardLen = 5.6
  const yard = new THREE.CylinderGeometry(0.035, 0.035, yardLen, 4)
  yard.rotateZ(-Math.PI / 2 + 0.62)
  yard.translate(0.55, 3.05, 0.04)
  paint(yard, 0x6e5238)

  const sail = new THREE.BufferGeometry()
  sail.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([-1.55, 1.45, 0.06, 2.55, 4.55, 0.06, 2.05, 1.05, 0.06], 3)
  )
  sail.setIndex([0, 1, 2])
  sail.computeVertexNormals()
  paint(sail, 0xf5f0e4)

  const merged = BufferGeometryUtils.mergeGeometries(parts, false)
  parts.forEach((g) => g.dispose())
  merged.computeBoundingBox()
  return merged
}

export class Boats {
  constructor(scene) {
    this.scene = scene
    const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })
    this.mesh = new THREE.InstancedMesh(dhowGeometry(), material, COUNT)
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.frustumCulled = false
    this.mesh.castShadow = false
    this.mesh.receiveShadow = false
    this.mesh.name = 'boats'
    this.mesh.visible = false
    scene.add(this.mesh)

    const rand = mulberry(2468)
    const tint = new THREE.Color()
    this._boats = []
    for (let i = 0; i < COUNT; i++) {
      this._boats.push({
        lane: i,
        angle: rand() * Math.PI * 2,
        // A slow lap, some one way and some the other — a knot or two.
        rate: (0.011 + rand() * 0.006) * (i % 2 ? -1 : 1),
        bob: rand() * Math.PI * 2,
        wobble: rand() * Math.PI * 2,
      })
      // Every hull a shade different, so the three are three boats and not one three times.
      tint.setHSL(0.09, 0.15, 0.9 + rand() * 0.1)
      this.mesh.setColorAt(i, tint)
    }
    this._dummy = new THREE.Object3D()
    this._level = 0
    this._radius = 0
  }

  /** Boats want water. `sea` says where it starts and how deep it sits. */
  setPlanet(planet) {
    const sea = planet?.sea
    this.mesh.visible = Boolean(sea)
    if (!sea) return
    this._level = sea.level
    // Open water begins past the beach; the lanes run just outside that line.
    this._radius = sea.shore + sea.falloff + 5
  }

  update(dt, elapsed, anim = 1) {
    if (!this.mesh.visible) return
    const d = this._dummy
    for (let i = 0; i < COUNT; i++) {
      const b = this._boats[i]
      b.angle += b.rate * dt * anim
      const r = this._radius + b.lane * 7 + Math.sin(b.angle * 3 + b.wobble) * 2.5
      const x = Math.cos(b.angle) * r
      const z = Math.sin(b.angle) * r
      const swell = Math.sin(elapsed * 1.1 + b.bob) * 0.09
      // Heading along the lane, bow first; the sail is on the +z side of the hull, and the
      // yaw puts the hull's +x along the direction of travel.
      const dir = Math.sign(b.rate)
      const yaw = Math.atan2(-Math.sin(b.angle) * dir, Math.cos(b.angle) * dir)
      d.position.set(x, this._level + 0.22 + swell, z)
      d.rotation.set(Math.sin(elapsed * 0.9 + b.bob) * 0.025, -yaw, Math.sin(elapsed * 0.7 + b.wobble) * 0.05, 'YXZ')
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
