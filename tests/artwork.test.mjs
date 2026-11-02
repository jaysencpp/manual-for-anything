import test from 'node:test'
import assert from 'node:assert/strict'
import { earlyDrawingKeys, drawingQueue, drawingReference, requiredDrawingKeys, usableDrawing, suppliedDrawingPrompt, checkedArtwork } from '../src/pipeline/artwork.mjs'
import { captionIdentityProblems, validatePlan } from '../src/pipeline/validate.mjs'
import { withTools } from '../src/solvers/tools.mjs'
import { settlePlanningInputs } from '../src/pipeline/planning-inputs.mjs'

const objects = [
  { k: 'machine', n: 'white capsule espresso machine', b: [134, 549, 565, 895], cm: 33 },
  { k: 'frother', n: 'black electric milk frother', b: [527, 734, 208, 369], cm: 21 },
  { k: 'rack', n: 'capsule holder rack', b: [862, 285, 338, 748], cm: 35 },
  ...Array.from({ length: 14 }, (_, i) => ({ k: `capsule-${i}`, n: 'coffee capsule', b: [900, 600, 90, 80], cm: 5 })),
  { k: 'table', n: 'wooden table', b: [0, 0, 1200, 1600], cm: 120 },
]

test('supplied pouring ingredients must declare a valid outlet', () => {
  const script = { title: 'Milk', steps: [{ do: [{ v: 'pour', k: 'milk', to: 'glass' }] }] }
  const drawing = { width: 100, height: 300, parts: [{ id: 'milk', parent: null, pivot: [50, 300], shapes: [{ d: 'M10 10H90V300H10Z', fill: '#fff' }] }] }
  const options = { width: 100, height: 300, script, key: 'milk' }
  assert.match(suppliedDrawingPrompt(script, { k: 'milk', n: 'milk' }, { width: 25, height: 75 }), /top-level "outlet"/)
  for (const outlet of [undefined, [-1, 10], [50, 301], [NaN, 10]])
    assert.throws(() => checkedArtwork({ ...drawing, outlet }, options), /pouring outlet/)
  assert.deepEqual(checkedArtwork({ ...drawing, outlet: [75, 20] }, options).outlet, [75, 20])
})

test('playback requires artwork only for photographed objects used by the film', () => {
  const layout = { order: ['pineapple', 'pineapple', 'slice', 'board', 'book'], extras: ['knife'], boards: { board: {} },
    scene: { book: { family: 'box', size: [20, 15, 3] } } }
  assert.deepEqual(requiredDrawingKeys(layout, { pineapple: {}, slice: { sliceOf: 'pineapple' }, knife: { tool: true } }), ['pineapple'])
  const valid = { width: 10, height: 20, parts: [{ shapes: [{ d: 'M0 0L10 10' }] }] }
  assert.equal(usableDrawing(valid), true)
  for (const value of [null, {}, { ...valid, width: 0 }, { ...valid, parts: [] }, { ...valid, parts: [{ shapes: [] }] }]) {
    assert.equal(usableDrawing(value), false)
  }
})

test('coffee inventory starts the machine and rack early, without flooding calls for every capsule or the table', () => {
  assert.deepEqual(earlyDrawingKeys(objects), ['machine', 'rack'])
  assert.equal(earlyDrawingKeys([]).length, 0)
  assert.deepEqual(earlyDrawingKeys([{ k: 'hook', toolKind: 'hook', b: [0, 0, 1000, 1000] }]), [])
})

test('added recipe supplies require generated artwork and retain their colors and proportions', () => {
  const script = { objects: [{ k: 'rum', n: 'Rum bottle', cm: 25 }], steps: [], materials: [
    { k: 'pitcher', n: 'Pitcher', family: 'cylinder', size: [18, 18, 24] },
    { k: 'juice', n: 'Juice carton', family: 'box', size: [7, 7, 20] },
    { k: 'ice', n: 'Ice cubes', family: 'loose', size: [10, 10, 5] },
    ...Array.from({ length: 4 }, (_, i) => ({ k: `glass-${i}`, n: 'Glass', family: 'cylinder', size: [8, 8, 12] })),
  ] }
  settlePlanningInputs(script)
  const pitcher = { width: 864, height: 1152, parts: [{ id: 'pitcher', parent: null, pivot: [432, 1152], shapes: [{ d: 'M100 100L700 100L600 1152Z', fill: '#a0d8ef' }] }] }
  const { geometry, vectors, sizes } = withTools(script, { rum: {} }, { rum: { width: 100, height: 300 } }, { pitcher })
  const layout = { order: ['rum', ...script.materials.map(m => m.k)], extras: [] }
  assert.deepEqual(requiredDrawingKeys(layout, geometry), layout.order)
  assert.equal(vectors.pitcher, pitcher)
  assert.equal(sizes.pitcher.height / sizes.pitcher.width, 24 / 18)
  assert.equal(sizes.juice.height / sizes.juice.width, 20 / 7)
  for (const m of script.materials) {
    assert.equal(geometry[m.k].supplied, true)
    assert.equal(usableDrawing(vectors[m.k]), true)
  }
  // A genuinely missing photographed drawing still blocks playback.
  assert.equal(usableDrawing(vectors.rum), false)
  const prompt = suppliedDrawingPrompt({ ...script, view: 'side', title: 'Punch', steps: [
    { t: 'Stir', c: 'Stir juice in the pitcher', do: [{ v: 'stir', k: 'pitcher' }] },
    { t: 'Unused', c: 'Unrelated step', do: [{ v: 'place', k: 'rum' }] },
  ] }, script.objects.find(o => o.k === 'pitcher'), sizes.pitcher)
  assert.match(prompt, /NOT in the photo/)
  assert.match(prompt, /Stir juice in the pitcher/)
  assert.ok(!prompt.includes('Unrelated step'))
  assert.match(prompt, /864×1152 canvas/)
  assert.match(prompt, /handle, open rim and spout/)
  const plan = withTools({ ...script, view: 'plan' }, { rum: {} }, { rum: { width: 100, height: 300 } }, {})
  assert.equal(plan.sizes.pitcher.height / plan.sizes.pitcher.width, 1)
})

test('drawing references identify the neighboring frother within the contaminated machine cutout', async () => {
  const ref = JSON.parse(drawingReference('machine', objects, { origin: [134, 549] }, { width: 587, height: 887 }))
  assert.deepEqual(ref.target.approximateBox, [0, 0, 2260, 3548])
  assert.equal(ref.neighbors.find(o => o.key === 'frother').name, 'black electric milk frother')
  assert.ok(!ref.neighbors.some(o => o.key === 'rack'))
  for (const neighbor of ref.neighbors) {
    const [x, y, w, h] = neighbor.approximateBox
    assert.ok(x >= 0 && y >= 0 && x + w <= 587 * 4 && y + h <= 887 * 4)
  }
})

for (const concurrency of [4, 2]) test(`drawing concurrency ${concurrency} stays bounded and a failed call releases its slot`, async () => {
  const queue = drawingQueue(concurrency === 4 ? {} : { concurrency }), gates = [], started = []
  let active = 0, peak = 0
  const initial = Array.from({ length: concurrency }, (_, i) => i)
  const calls = [...initial, concurrency, concurrency + 1].map(i => queue(async () => {
    started.push(i); active++; peak = Math.max(peak, active)
    await new Promise(resolve => { gates[i] = resolve }); active--
    if (i === 1) throw Error('drawing failed')
    return i
  }))
  const all = Promise.allSettled(calls)
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(started, initial)
  gates[1](); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(started, [...initial, concurrency])
  for (const i of [...initial, concurrency]) if (i !== 1) gates[i]()
  await new Promise(resolve => setImmediate(resolve)); gates[concurrency + 1]()
  const results = await all
  assert.equal(peak, concurrency); assert.equal(results[1].status, 'rejected'); assert.equal(results[concurrency + 1].value, concurrency + 1)
})

test('queued drawings do not invoke a provider after cancellation', async () => {
  const controller = new AbortController(), queue = drawingQueue({ concurrency: 1, signal: controller.signal })
  let finish, called = false
  const first = queue(() => new Promise(resolve => { finish = resolve }))
  const pending = queue(() => { called = true })
  const rejected = assert.rejects(pending)
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); finish()
  await first; await rejected; assert.equal(called, false)
})

function placement(c, k = 'pouch', extra = {}) {
  return { objects: [{ k: 'pouch', n: 'teal fabric pouch' }, { k: 'mat', n: 'cork mat' }],
    tools: [{ k: 'cup', use: 'bowl' }], steps: [{ c, do: [{ v: 'place', k, to: 'mat' }] }], ...extra }
}

test('the saved coffee caption/pouch contradiction is identified without rewriting identities', () => {
  const script = placement('Rest the finished cup on the cork mat'), original = structuredClone(script)
  assert.match(captionIdentityProblems(script).join(), /caption names a cup but placement moves pouch/)
  assert.deepEqual(script, original)
  assert.ok(validatePlan(script, null).errors.some(e => e.includes('caption names')))
  assert.ok(validatePlan(script).warnings.some(e => e.includes('caption names')))
  assert.deepEqual(captionIdentityProblems(placement('Rest the finished cup on the cork mat', 'cup')), [])
})

test('caption identity checking leaves correct, ambiguous and multi-action descriptions alone', () => {
  assert.deepEqual(captionIdentityProblems(placement('Place the pouch on the mat')), [])
  assert.deepEqual(captionIdentityProblems(placement('Move the mat beside the cup', 'mat')), [])
  assert.deepEqual(captionIdentityProblems(placement('Place the assembly on the mat')), [])
  const compound = placement('Put the cup on the mat'); compound.objects[0].n = 'cup-shaped fabric pouch'
  assert.deepEqual(captionIdentityProblems(compound), [])
  const multiple = placement('Place the cup, then move the pouch'); multiple.steps[0].do.push({ v: 'place', k: 'cup' })
  assert.deepEqual(captionIdentityProblems(multiple), [])
})

test('single-part container metadata is promoted and checked without weakening geometry validation', async () => {
  const { checkedArtwork } = await import('../src/pipeline/artwork.mjs')
  const script = { steps: [{ do: [{ v: 'pour', k: 'frother', to: 'frother' }] }] }
  const vessel = { seat: [50, 20], rx: 30, ry: 5, interior: [[20, 20], [80, 20], [70, 90], [30, 90]] }
  const input = { width: 100, height: 100, parts: [{ id: 'frother', parent: null, pivot: [50, 100],
    outlet: [20, 20], vessel, shapes: [{ d: 'M20 20L80 20L70 90Z', fill: '#fff' }] }] }
  const options = { width: 100, height: 100, observed: true, script, key: 'frother' }
  const result = checkedArtwork(input, options)
  assert.deepEqual(result.outlet, [20, 20]); assert.deepEqual(result.vessel.interior, vessel.interior)
  assert.equal(result.artworkMode, 'complete'); assert.equal(result.parts[0].vessel, undefined)
  assert.ok(input.parts[0].vessel, 'input is not mutated')
  assert.throws(() => checkedArtwork({ ...input, outlet: [-1, 20] }, options), /top-level outlet/)
  assert.throws(() => checkedArtwork({ ...input, vessel: { ...vessel, rx: 100 } }, options), /invalid container geometry/)
  assert.throws(() => checkedArtwork({ ...input, parts: [...input.parts, { id: 'second', parent: null, pivot: [0, 0], shapes: [] }] }, options), /top-level outlet/)
  assert.throws(() => checkedArtwork(input, { ...options, width: 101 }), /dimensions do not match/)
  const missing = structuredClone(input); delete missing.parts[0].vessel
  assert.throws(() => checkedArtwork(missing, options), /top-level vessel.*outside parts\[0\]/)
  const prompt = suppliedDrawingPrompt({ title: 'Pour', ...script }, { k: 'frother', n: 'frother' }, { width: 25, height: 25 }, { observed: true })
  const example = prompt.split('Answer with ONE JSON object and nothing else:')[1]
  assert.match(example, /"height":100,"outlet":\[/)
  assert.match(example, /"vessel":\{.*"parts":/)
})
