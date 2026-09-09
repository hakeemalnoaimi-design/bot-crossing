/**
 * Screenshots of the built app against the synthetic roster, at fixed views and times of
 * day, so a change to how the island looks can be looked at rather than guessed at.
 *
 *   npm run build && npm run shot -- --out=shots --time=0.42,0.75,0.94 --views=overview,close,wide
 *
 * Views: overview (the resting camera), close (a zone), ground (down among the builders),
 * wide (the whole island and the sea). Time is the sky's own 0..1 — 0.5 is noon.
 */
import fs from 'node:fs'
import path from 'node:path'
import { openApp } from './headless.mjs'

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]))
const outDir = path.resolve(args.out || 'shots')
const times = String(args.time ?? '0.42').split(',').map(Number)
const views = String(args.views ?? 'overview,close').split(',')
fs.mkdirSync(outDir, { recursive: true })

const VIEWS = {
  overview: 'rig.resetView(); rig.distance = 62; rig.desiredDistance = 62',
  close: 'rig.resetView(); rig.desiredDistance = 18; rig.distance = 18',
  ground: 'rig.resetView(); rig.desiredDistance = 9; rig.distance = 9; rig.desiredPolar = 1.25; rig.polar = 1.25',
  wide: 'rig.resetView(); rig.desiredDistance = 120; rig.distance = 120',
}

const { cdp, close } = await openApp({ threads: Number(args.threads) || 65, dist: args.dist || 'dist', port: 5398, debugPort: 9334, uncapped: false })
process.on('exit', close)

try {
  // Fixed conditions, panels hidden so the world is what is captured, and a few seconds
  // for the builders to walk to their sites.
  await cdp.eval(`(async () => {
    const { settings, rig, hud } = window.botsBay || window.botCrossing
    settings.set('autoQuality', false)
    settings.set('clockTime', false)
    settings.set('autoTime', false)
    settings.set('renderScale', 1)
    hud.toggleUi(false)
    hud.toggleHelp(false)
    rig.resetView()
    await new Promise((r) => setTimeout(r, ${Number(args.settle) || 4000}))
    return true
  })()`)

  for (const t of times) {
    for (const view of views) {
      await cdp.eval(`(async () => {
        const { settings, rig } = window.botsBay || window.botCrossing
        settings.set('timeOfDay', ${t})
        ${VIEWS[view] || VIEWS.overview}
        await new Promise((r) => setTimeout(r, 1200))
        return true
      })()`)
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
      const file = path.join(outDir, `${args.tag ? args.tag + '-' : ''}${view}-t${String(t).replace('.', '')}.png`)
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
      console.log('saved', file)
    }
  }
  const problems = cdp.problems()
  if (problems.errors.length) console.log('page errors:\n' + problems.errors.join('\n'))
} catch (err) {
  console.error('shot failed:', err.message)
  process.exitCode = 1
} finally {
  close()
  process.exit()
}
