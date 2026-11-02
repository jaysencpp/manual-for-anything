import test from 'node:test'
import assert from 'node:assert/strict'
import { fixedReveal } from '../src/pipeline/reveal.mjs'
import { refusedIn } from '../src/pipeline/words.mjs'

test('an assembly reveal draws the original stage once and does not move individual parts', () => {
  const layout = { order: ['a', 'b', 'stock'], transients: ['stock'],
    poses: Object.fromEntries(['a', 'b', 'stock'].map((k, i) => [k, { x: 300 + 100 * i, y: 500, scale: 1, anchor: [50, 20] }])),
    boards: Object.fromEntries(['a', 'b', 'stock'].map((k) => [k, { w: 100, h: 40 }])) }
  const source = fixedReveal({ title: 'A window stand', tag: '20 cm', steps: [{ do: [{ v: 'place', k: ['a', 'b', 'stock'] }] }] }, layout)
  assert.deepEqual(refusedIn(source), [])
  const draw = new Function(`return (${source})`)(), commands = [], ctx = new Proxy({}, { get: (_, k) => (...args) => commands.push([k, ...args]), set: () => true })
  const stage = { draw: (...args) => commands.push(['stage', args.length]) }
  draw(ctx, 0.5, { font: 'Inter' }, {}, stage); const first = structuredClone(commands); commands.length = 0
  draw(ctx, 4.5, { font: 'Inter' }, {}, stage)
  assert.deepEqual(commands, first)
  assert.deepEqual(commands.filter((c) => c[0] === 'stage'), [['stage', 1]])
})

test('side-view process films retain their existing finale path', () => {
  assert.equal(fixedReveal({ steps: [] }, { order: [], boards: {} }), null)
})
