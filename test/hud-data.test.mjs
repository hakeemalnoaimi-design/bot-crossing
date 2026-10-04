/**
 * The pure halves of the HUD: what the search box returns, how a path is shortened, and where
 * the reduced-motion setting starts. No DOM, no renderer — the same rule as the roster tests.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { filterThreads, shortPath, STATUS_FILTERS } from '../src/ui/hud-data.js'
import { Settings } from '../src/core/settings.js'

const t = (id, title, project, harness, status, at = 0) => ({ id, title, project, harness, status, lastActivityAt: at })
const items = [
  t('a', 'Fix the Login bug', 'web', 'claude-code', 'working', 5),
  t('b', 'Lead intake', 'n8n-prod', 'n8n', 'blocked', 4),
  t('c', 'Nightly sync', 'n8n-prod', 'n8n', 'sleeping', 9),
  t('d', null, 'web', 'claude-code', 'idle', 1),
  t('e', 'Reply to Sam', 'web', 'claude-code', 'waiting', 2),
]

test('text matches title or project, case-insensitively, one word at a time', () => {
  assert.deepEqual(filterThreads(items, { query: 'LOGIN' }).map((x) => x.id), ['a'])
  assert.deepEqual(filterThreads(items, { query: 'n8n lead' }).map((x) => x.id), ['b'])
  assert.deepEqual(filterThreads(items, { query: 'nothing here' }), [])
})

test('a thread with no title is still searchable by project', () => {
  assert.ok(filterThreads(items, { query: 'web' }).some((x) => x.id === 'd'))
})

test('chips add within a group and narrow between groups', () => {
  const both = filterThreads(items, { sources: new Set(['n8n']), statuses: new Set(['blocked', 'sleeping']) })
  assert.deepEqual(both.map((x) => x.id).sort(), ['b', 'c'])
  const narrowed = filterThreads(items, { sources: new Set(['claude-code']), statuses: new Set(['blocked']) })
  assert.deepEqual(narrowed, [])
})

test('results put whoever wants something first, then the most recent', () => {
  const ids = filterThreads(items, {}).map((x) => x.id)
  // waiting and blocked lead, then running, then idle, then dormant — however recent the dormant one is.
  assert.deepEqual(ids, ['e', 'b', 'a', 'd', 'c'])
  assert.equal(STATUS_FILTERS.length, 6)
})

test('paths: home directories on every OS, and the separator survives', () => {
  assert.equal(shortPath('/Users/sam/code/app'), '~/code/app')
  assert.equal(shortPath('/home/sam/code/app'), '~/code/app')
  assert.equal(shortPath('C:\\Users\\Hakeem\\code\\app'), '~\\code\\app')
  assert.equal(shortPath('C:\\Users\\Hakeem'), '~')
  const long = shortPath('D:\\desktop backup 26-09-2026\\BotsBay LOGO\\Botsbay-world\\bot-crossing')
  assert.ok(long.startsWith('…\\') && long.endsWith('bot-crossing') && long.length <= 31, long)
  assert.ok(!long.includes('/'))
})

test('reduced motion starts from the OS until somebody chooses', () => {
  globalThis.matchMedia = () => ({ matches: true, addEventListener() {} })
  try {
    const s = new Settings()
    assert.equal(s.get('reducedMotion'), true)
    s.set('reducedMotion', false)
    assert.equal(s.get('reducedMotion'), false)
    assert.equal(s.get('reducedMotionChosen'), true)
    // A file saved by another browser's default does not override this one's OS.
    const fresh = new Settings()
    fresh.applyAll({ reducedMotion: false })
    assert.equal(fresh.get('reducedMotion'), true)
    fresh.applyAll({ reducedMotion: false, reducedMotionChosen: true })
    assert.equal(fresh.get('reducedMotion'), false)
  } finally {
    delete globalThis.matchMedia
  }
})
