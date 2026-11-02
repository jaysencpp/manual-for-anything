import test from 'node:test'
import assert from 'node:assert/strict'
import { readPlayback, savePlayback, initialPlayback } from '../public/playback.mjs'

test('a finished film reopens paused at its saved position with every drawing ready', () => {
  assert.deepEqual(initialPlayback({ restore: true, ready: true, finished: true, saved: { t: 42 }, duration: 60 }),
    { name: 'replay', at: 42, play: false })
  assert.deepEqual(initialPlayback({ restore: true, ready: true, finished: true, saved: null, duration: 60 }),
    { name: 'replay', at: 0, play: false })
  assert.equal(initialPlayback({ restore: true, ready: true, finished: true, saved: { t: 90 }, duration: 60 }).at, 60)
})

test('returning during generation keeps the live film; a new film still plays from its prelude', () => {
  assert.deepEqual(initialPlayback({ restore: true, ready: true, finished: false, saved: { t: 12 }, duration: 60 }),
    { name: 'live', at: 12, play: false })
  for (const options of [{ restore: false, ready: true }, { restore: true, ready: false }]) {
    assert.deepEqual(initialPlayback({ ...options, finished: false, saved: null, duration: 60, preludeAt: 3 }),
      { name: 'live', at: 3, play: true })
  }
})

test('playback positions stay separate by film and unavailable storage does not break playback', () => {
  const values = new Map(), storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
  savePlayback(storage, 'first', { t: 23 })
  savePlayback(storage, 'second', { t: 7 })
  assert.deepEqual(readPlayback(storage, 'first'), { t: 23 })
  assert.deepEqual(readPlayback(storage, 'second'), { t: 7 })
  assert.equal(readPlayback(storage, 'missing'), null)
  for (const value of ['bad json', '{"t":-1}', '{"t":"23"}']) {
    storage.setItem('film-playback:broken', value)
    assert.equal(readPlayback(storage, 'broken'), null)
  }
  const blocked = { getItem() { throw Error('blocked') }, setItem() { throw Error('full') } }
  assert.equal(readPlayback(blocked, 'first'), null)
  assert.doesNotThrow(() => savePlayback(blocked, 'first', { t: 23 }))
})
