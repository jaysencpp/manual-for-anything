// The frame checker: what it reads from a caption, and the fixtures held to their baseline (no kind of problem may
// get worse; a fix that lowers a count updates the baseline with node frames.mjs --all --baseline).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { claimedNumbers, checkFixtures, counts } from '../scripts/frames.mjs'

test('numbers a caption gives a unit', () => {
  assert.deepEqual(claimedNumbers('Mark board A at 80, 96 and 112 cm.'), ['80', '96', '112'])
  assert.deepEqual(claimedNumbers('Simmer uncovered 20 minutes on low; cut 100 g pepper jack.'), ['20', '100'])
  assert.deepEqual(claimedNumbers('Rnd 2: 2 sc in each st around. 12 sts.'), ['2', '12'])
  assert.deepEqual(claimedNumbers('Pre-drill 3 mm, drive one 60 mm screw per corner.'), ['3', '60'])
  assert.deepEqual(claimedNumbers('Pour in 1 can broth; tilt it about 8°.'), ['8'])
  assert.deepEqual(claimedNumbers('Drive 4 screws through each side.'), [])
})

test('no fixture gets worse on any frame check', async () => {
  const baseline = JSON.parse(readFileSync(new URL('../benchmarks/frames-baseline.json', import.meta.url), 'utf8'))
  const all = await checkFixtures()
  const worse = []
  for (const [name, r] of Object.entries(all)) for (const [kind, n] of Object.entries(counts(r)))
    if (n > (baseline[name]?.[kind] ?? 0)) worse.push(`${name}: ${n} ${kind} (baseline ${baseline[name]?.[kind] ?? 0})`)
  assert.deepEqual(worse, [])
})
