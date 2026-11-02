import { physicalPlan } from './support/physical-plan.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { filmDrawings } from '../src/pipeline/drawings.mjs'

function run(t, repair = false) {
  const dir = mkdtempSync(join(tmpdir(), 'drawing-transition-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'screens'))
  const vector = { width: 400, height: 600, parts: [{ id: 'bag', parent: null, pivot: [200, 600], shapes: [] }] }
  writeFileSync(join(dir, 'screens/traced.json'), JSON.stringify({ bag: vector }))
  writeFileSync(join(dir, 'script.json'), JSON.stringify(physicalPlan({ title: repair ? 'Repair the torn seam' : 'Pack for a trip',
    objects: [{ k: 'bag', n: 'backpack', part: { family: 'loose', shape: 'loose', size: [30, 20, 45] } }], steps: [{ do: [{ v: 'use', k: 'bag', with: 'needle' }] }] })))
  return { dir, vector, artwork: { ...vector, artwork: true } }
}

test('artwork arriving after the final step still replaces the temporary drawing', t => {
  const { dir, artwork } = run(t)
  const result = filmDrawings(dir, { bag: artwork }, () => 35, [6, 12, 24])
  assert.equal(result.live.upgrades.bag, 35)
  assert.equal(result.live.vectors['bag@drawn'], artwork)
  assert.equal(result.replay.vectors.bag, artwork)
  assert.equal(filmDrawings(dir, { bag: artwork }, () => 10, [6, 12, 24]).live.upgrades.bag, 12)
  assert.deepEqual(filmDrawings(dir, { bag: artwork }).live.upgrades, {})
})

test('repair views keep photographed damage until artwork arrives, including failed drawings', t => {
  const { dir, artwork } = run(t, true)
  const pending = filmDrawings(dir)
  assert.equal(pending.live.vectors.bag.cutOut, true)
  assert.equal(pending.replay.vectors.bag.cutOut, true)
  assert.equal(pending.live.vectors.bag.width, 400)
  const ready = filmDrawings(dir, { bag: artwork }, () => -1)
  assert.equal(ready.live.vectors.bag, artwork)
  assert.equal(ready.replay.vectors.bag, artwork)
  const late = filmDrawings(dir, { bag: artwork }, () => 20, [6, 12])
  assert.equal(late.live.vectors.bag.cutOut, true)
  assert.equal(late.live.vectors['bag@drawn'], artwork)
})

test('ready artwork takes precedence over generic family shapes from the first frame', t => {
  const { dir, artwork } = run(t)
  const script = JSON.parse(readFileSync(join(dir, 'script.json')))
  delete script.objects[0].part
  script.objects[0].n = 'blue yarn ball'
  writeFileSync(join(dir, 'script.json'), JSON.stringify(script))
  assert.notEqual(filmDrawings(dir).live.vectors.bag, artwork)
  const ready = filmDrawings(dir, { bag: artwork }, () => 0)
  assert.equal(ready.live.vectors.bag, artwork)
  assert.equal(ready.replay.vectors.bag, artwork)
  assert.deepEqual(ready.live.upgrades, {})
})
