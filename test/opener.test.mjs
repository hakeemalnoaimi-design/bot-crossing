/**
 * The opener's argument construction per platform, with an injected spawn: no process is launched.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { openTarget } from '../server/lib/opener.mjs'

/** A spawn stand-in. `failFor` names the commands that cannot be started at all. */
function fakeSpawn({ failFor = [], throwFor = [] } = {}) {
  const calls = []
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    if (throwFor.includes(cmd)) throw new Error('EACCES')
    const child = new EventEmitter()
    child.unref = () => {}
    setImmediate(() => (failFor.includes(cmd) ? child.emit('error', new Error('ENOENT')) : child.emit('spawn')))
    return child
  }
  return { fn, calls }
}

const URL_TARGET = 'claude://code/new?folder=C%3A%5Cdemo'

test('win32 tries rundll32 first, with the target as one untouched argument', async () => {
  const { fn, calls } = fakeSpawn()
  const target = String.raw`C:\Users\me\%USERPROFILE% backup^v2`
  await openTarget(target, { spawn: fn, platform: 'win32' })
  assert.equal(calls.length, 1, 'the fallback is not reached when rundll32 starts')
  assert.equal(calls[0].cmd, 'rundll32')
  assert.deepEqual(calls[0].args, ['url.dll,FileProtocolHandler', target])
  assert.equal(calls[0].opts.windowsHide, true)
  assert.equal(calls[0].opts.detached, true)
  assert.equal(calls[0].opts.stdio, 'ignore')
})

test('win32 falls back to cmd /c start only when rundll32 cannot be spawned', async () => {
  for (const mode of [{ failFor: ['rundll32'] }, { throwFor: ['rundll32'] }]) {
    const { fn, calls } = fakeSpawn(mode)
    await openTarget(URL_TARGET, { spawn: fn, platform: 'win32' })
    assert.deepEqual(calls.map((c) => c.cmd), ['rundll32', 'cmd'])
    assert.deepEqual(calls[1].args, ['/c', 'start', '', URL_TARGET])
  }
})

test('win32 stops after both openers fail, and never throws', async () => {
  const { fn, calls } = fakeSpawn({ failFor: ['rundll32', 'cmd'] })
  await assert.doesNotReject(openTarget(URL_TARGET, { spawn: fn, platform: 'win32' }))
  assert.equal(calls.length, 2)
})

test('darwin uses open(1) and linux uses xdg-open', async () => {
  const mac = fakeSpawn()
  await openTarget('/Users/me/repo', { spawn: mac.fn, platform: 'darwin' })
  assert.equal(mac.calls[0].cmd, 'open')
  assert.deepEqual(mac.calls[0].args, ['/Users/me/repo'])

  const lin = fakeSpawn()
  await openTarget(URL_TARGET, { spawn: lin.fn, platform: 'linux' })
  assert.equal(lin.calls[0].cmd, 'xdg-open')
  assert.deepEqual(lin.calls[0].args, [URL_TARGET])
})

test('an unknown platform, an empty target or a non-string does nothing', async () => {
  const { fn, calls } = fakeSpawn()
  await openTarget('x', { spawn: fn, platform: 'plan9' })
  await openTarget('', { spawn: fn, platform: 'linux' })
  await openTarget(undefined, { spawn: fn, platform: 'linux' })
  await openTarget(['a'], { spawn: fn, platform: 'linux' })
  assert.equal(calls.length, 0)
})

test('a missing xdg-open is swallowed rather than becoming an unhandled error event', async () => {
  const { fn, calls } = fakeSpawn({ failFor: ['xdg-open'] })
  await assert.doesNotReject(openTarget('/tmp', { spawn: fn, platform: 'linux' }))
  assert.equal(calls.length, 1)
})
