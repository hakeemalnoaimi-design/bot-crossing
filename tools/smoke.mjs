/**
 * Draw the island in every quality preset and every world, and read the pixels back.
 *
 *   npm run build && npm run smoke
 *
 * This exists because of a bug the tests could never have caught. A post-processing pass
 * tone-mapped the frame itself, which three only compiles a material to do when it draws to
 * the screen — so switching antialiasing on, which puts another pass after it, made its
 * fragment shader fail to compile. A pass that will not compile draws nothing. The result
 * was a completely black canvas on exactly two of the five presets, with the HUD alive on
 * top of it and not one exception thrown anywhere.
 *
 * Nothing short of drawing a frame and looking at the pixels finds that. So this walks the
 * combinations, reads the drawing buffer back after each, and fails on a black frame, a GL
 * error, a shader that would not compile, or anything thrown along the way. It runs against
 * the synthetic roster, so it touches no real harness, no colony file and no key.
 */
import fs from 'node:fs'
import path from 'node:path'
import { openApp } from './headless.mjs'

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]))

/**
 * One configuration: apply it, let the world settle, draw a frame, and sample the buffer.
 * The samples are spread over the lower two thirds of the frame, where the island is; a
 * frame that is black everywhere there is a frame nobody would keep looking at.
 */
const PROBE = `(async (opts) => {
  const bc = window.botsBay || window.botCrossing
  const { engine, settings, rig } = bc
  if (opts.preset) settings.applyPreset(opts.preset)
  if (opts.planet) settings.set('planet', opts.planet)
  settings.set('clockTime', false)
  settings.set('autoTime', false)
  settings.set('timeOfDay', opts.time)
  settings.set('autoQuality', false)
  if (opts.dist) { rig.desiredDistance = opts.dist; rig.distance = opts.dist }
  await new Promise((r) => setTimeout(r, 1400))

  const renderer = engine.renderer
  const gl = renderer.getContext()
  renderer.info.reset()
  engine.renderFrame()
  renderer.setRenderTarget(null)
  const w = renderer.domElement.width
  const h = renderer.domElement.height
  const buf = new Uint8Array(4)
  let sum = 0
  let max = 0
  const points = [[0.5,0.5],[0.25,0.7],[0.75,0.7],[0.5,0.85],[0.5,0.25],[0.15,0.35],[0.85,0.35],[0.35,0.6],[0.65,0.6]]
  for (const [fx, fy] of points) {
    gl.readPixels(Math.floor(w * fx), Math.floor(h * fy), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf)
    const lum = buf[0] + buf[1] + buf[2]
    sum += lum
    max = Math.max(max, lum)
  }
  const passes = (engine.composer?.passes || []).filter((p) => p.enabled).map((p) => p.name || p.constructor.name)
  return {
    mean: Math.round(sum / points.length), max,
    calls: renderer.info.render.calls, buffer: w + 'x' + h,
    glError: gl.getError(), lost: gl.isContextLost(), passes: passes.join(' > '),
  }
})`

const cases = []
for (const preset of ['potato', 'low', 'balanced', 'high', 'ultra']) {
  cases.push({ label: `preset ${preset}`, preset, planet: 'bahrain', time: 0.42 })
}
for (const planet of ['bahrain', 'moon', 'mars', 'terra']) {
  cases.push({ label: `world ${planet}`, preset: 'balanced', planet, time: 0.42 })
}
// Dusk and night as well: most of the lighting only exists at one end of the day.
for (const time of [0.255, 0.72, 0.94]) {
  cases.push({ label: `time ${time}`, preset: 'high', planet: 'bahrain', time })
}
for (const dist of [6, 22, 120]) {
  cases.push({ label: `distance ${dist}`, preset: 'balanced', planet: 'bahrain', time: 0.42, dist })
}

const { cdp, close } = await openApp({ threads: Number(args.threads) || 40, dist: args.dist || 'dist', port: 5396, debugPort: 9346, uncapped: false })
process.on('exit', close)

let failures = 0
try {
  console.log('case              mean  max  draws  buffer       chain')
  for (const c of cases) {
    const r = await cdp.eval(`${PROBE}(${JSON.stringify(c)})`).catch((e) => ({ threw: e.message.slice(0, 200) }))
    let bad = ''
    if (r.threw) bad = 'THREW: ' + r.threw
    else if (r.lost) bad = 'CONTEXT LOST'
    else if (r.max === 0) bad = 'BLACK FRAME'
    else if (r.glError) bad = 'GL ERROR ' + r.glError
    if (bad) failures++
    console.log(
      c.label.padEnd(17),
      String(r.mean ?? '-').padStart(4),
      String(r.max ?? '-').padStart(4),
      String(r.calls ?? '-').padStart(6),
      String(r.buffer ?? '-').padStart(11),
      ' ' + (r.passes ?? ''),
      bad ? '  <<< ' + bad : ''
    )
  }

  const { errors, warnings } = cdp.problems()
  const shaderErrors = [...errors, ...warnings].filter((m) => /Shader Error|not compiled|VALIDATE_STATUS|no matching overloaded/i.test(m))
  if (shaderErrors.length) {
    failures += shaderErrors.length
    console.log('\nshader errors:')
    for (const m of shaderErrors.slice(0, 4)) console.log('  ' + m.split('\n').slice(0, 14).join('\n  '))
  }
  if (errors.length) {
    console.log('\nuncaught exceptions:')
    for (const m of errors.slice(0, 5)) console.log('  ' + m.split('\n')[0])
    failures += errors.length
  }

  if (args.shot) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const file = path.resolve(String(args.shot))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
    console.log('\nsaved', file)
  }

  console.log(failures ? `\nFAILED — ${failures} problem${failures === 1 ? '' : 's'}` : `\nOK — ${cases.length} configurations all drew something`)
  process.exitCode = failures ? 1 : 0
} catch (err) {
  console.error('smoke failed:', err.message)
  process.exitCode = 1
} finally {
  close()
  process.exit()
}
