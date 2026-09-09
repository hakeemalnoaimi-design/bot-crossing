/**
 * Measure what a frame costs on this machine's GPU, feature by feature.
 *
 * Loads the built app in a headless browser against a synthetic roster, takes over the
 * frame loop, and brackets every render with a GPU timer query — so the numbers are GPU
 * milliseconds, not guesses from wall-clock frame times. Then it turns each optional
 * effect off in turn, and finally brackets each post-processing pass on its own.
 *
 *   npm run build && npm run profile
 *   node tools/profile.mjs --threads=120 --scale=1 --json
 *
 * The first line of the report names the GPU the browser is actually drawing with. On a
 * laptop with two, that is the number to read first: if it says the integrated one, every
 * other number is several times what the machine could do.
 */
import fs from 'node:fs'
import path from 'node:path'
import { openApp } from './headless.mjs'

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]))
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const { cdp, close } = await openApp({
  threads: Number(args.threads) || 65,
  dist: args.dist || 'dist',
})
process.on('exit', close)

try {
  const script = fs.readFileSync(path.join(here, 'profile-page.js'), 'utf8')
  const result = await cdp.eval(`${script}\n__profile({ scale: ${Number(args.scale) || 1}, quick: ${args.quick ? 'true' : 'false'} })`)
  const problems = cdp.problems()

  if (args.json) {
    console.log(JSON.stringify({ ...result, ...problems }, null, 2))
  } else {
    console.log(`GPU:      ${result.gpuName}`)
    console.log(`buffer:   ${result.buffer} at ${result.dpr}x  (css ${result.css})`)
    console.log(`scene:    ${result.scene.crew} builders, ${result.scene.buildings} buildings, ${result.scene.plots} plots, ${result.scene.scatter} scatter`)
    console.log(`timers:   ${result.timerQueries ? 'GPU timer queries' : 'no timer queries — wall clock only'}`)
    console.log('')
    const row = (l, ...c) => console.log(l.padEnd(30) + c.map((x) => String(x ?? '-').padStart(9)).join(''))
    row('configuration', 'gpu ms', 'p95', 'cpu ms', 'wall ms', 'draws', 'tris')
    for (const r of result.results) row(r.label, r.gpuMs?.mean, r.gpuMs?.p95, r.cpuRenderMs.mean, r.wallMs.mean, r.calls, r.triangles)
    console.log('')
    console.log('post-processing passes, GPU ms each (balanced):')
    for (const [name, s] of Object.entries(result.passes)) console.log(`  ${name.padEnd(20)} ${s ? s.mean : 'off'}`)
    if (result.shadowPass) console.log(`  ${'shadow map'.padEnd(20)} ${result.shadowPass.p95}  (p95 — the pass runs once a frame among many empty calls)`)
    if (problems.errors.length) console.log('\npage errors:\n' + problems.errors.join('\n'))
    if (problems.warnings.length) console.log('\npage warnings:\n' + problems.warnings.slice(0, 5).join('\n'))
  }
} catch (err) {
  console.error('profile failed:', err.message)
  const problems = cdp.problems()
  if (problems.errors.length) console.error(problems.errors.join('\n'))
  process.exitCode = 1
} finally {
  close()
  process.exit()
}
