import test from 'node:test'
import assert from 'node:assert/strict'
import { program, sizesEstimated, timeline, usedRequirements, unpacksInto, foodColor } from '../src/film/engine.mjs'
import { withTools } from '../src/solvers/tools.mjs'
import { solveBuild } from '../src/solvers/layout.mjs'
import { physicalPlan } from './support/physical-plan.mjs'
import { recordingCanvas, offlineEnv } from '../scripts/offline-canvas.mjs'

function compile(script) {
  const raw = Object.fromEntries(script.objects.map(o => [o.k, { origin: [0, 0], seat: [50, 20], base: [50, 150] }]))
  const sizes = Object.fromEntries(script.objects.map(o => [o.k, { width: 100, height: 150 }]))
  const vectors = Object.fromEntries(script.objects.map((o, i) => [o.k, { width: 400, height: 600,
    parts: [{ id: o.k, parent: null, pivot: [200, 600], shapes: [{ d: 'M40 80H360V580H40Z', fill: `#abc${String(i).padStart(3, '0')}` }] }],
    ...(o.k === 'juice' ? { outlet: [50, 20] } : {}),
    ...(o.k === 'glass' ? { vessel: { seat: [200, 100], rx: 150, ry: 30,
      interior: [[50, 100], [350, 100], [320, 570], [80, 570]] } } : {}) }]))
  const fitted = withTools(script, raw, sizes, vectors), layout = solveBuild(script, fitted.geometry, fitted.sizes)
  return new Function(`return (${program({ script, ...fitted, layout, photo: { width: 200, height: 150 }, boxes: {} })})`)()
}

function frame(draw, time) {
  const old = globalThis.Path2D; globalThis.Path2D = class { constructor(d) { this.d = d } }
  try { const canvas = recordingCanvas(); draw(canvas.ctx, time, offlineEnv()); assert.equal(canvas.depth(), 0); return canvas.calls }
  finally { globalThis.Path2D = old }
}

test('placed bottles and a carton persist through other pours and stirring', () => {
  const script = physicalPlan({ objects: ['glass', 'rum', 'whisky', 'juice'].map(k => ({ k, n: k, cm: 20,
    b: [0, 0, 100, 150], part: { family: 'cylinder', size: [10, 10, 20] },
    ...(['rum', 'whisky'].includes(k) ? { contents: { name: k, color: '#eeeeee', form: 'liquid' } } : {}) })), steps: [
    ...['glass', 'rum', 'whisky'].map(k => ({ t: `Place ${k}`, c: `Place ${k}`, do: [{ v: 'place', k, rel: 'floor' }] })),
    { t: 'Pour rum', c: 'Pour rum', do: [{ v: 'pour', k: 'rum', to: 'glass', color: '#ffffff' }] },
    { t: 'Place juice', c: 'Place juice', do: [{ v: 'place', k: 'juice', rel: 'floor' }] },
    { t: 'Pour juice', c: 'Pour juice', do: [{ v: 'pour', k: 'juice', to: 'glass', color: '#ffff00' }] },
    { t: 'Stir', c: 'Stir', do: [{ v: 'stir', k: 'glass', to: 'glass' }] },
  ] })
  const draw = compile(script), times = timeline(script)
  const pours = times.acts.filter(a => a.v === 'pour' || a.v === 'stir')
  for (const act of pours) for (const time of [act.at - 0.01, act.at + act.len * 0.6, act.at + act.len + 0.01]) {
    const calls = frame(draw, time)
    for (const color of ['#abc000', '#abc001', '#abc002', ...(time > times.starts[5] ? ['#abc003'] : [])])
      assert.ok(calls.some(c => c.method === 'fill' && c.fill === color), `${color} disappears at ${time}`)
  }
})

test('requirements include used photographed stock, unnamed materials and tools, and exclude unused inventory', () => {
  const script = physicalPlan({ objects: [
    { k: 'malibu', n: 'Malibu coconut rum' }, { k: 'whisky', n: 'Crown Royal whisky' }, { k: 'unused', n: 'Unrelated bottle' },
    { k: 'juice', n: 'Pineapple juice', source: 'additional-supply' },
  ], materials: [{ k: 'glass', n: '.' }], tools: [{ k: 'spoon', use: 'spoon' }], supplies: ['Pineapple juice', 'Ice cubes'], steps: [
    { do: [{ v: 'pour', k: 'malibu', to: 'glass' }, { v: 'pour', k: 'whisky', to: 'glass' },
      { v: 'pour', k: 'juice', to: 'glass' }, { v: 'stir', k: 'glass', to: 'glass', with: 'spoon' }] },
  ] })
  const needs = usedRequirements(script)
  assert.deepEqual(needs, ['Pineapple juice', 'Ice cubes', 'Malibu coconut rum', 'Crown Royal whisky', 'glass', 'spoon'])
  script.materials = [{ k: 'cocktail-glass', n: '.' }]
  script.steps[0].do.push({ v: 'place', k: 'cocktail-glass', rel: 'floor' })
  script.supplies.push('250 ml tumbler')
  assert.equal(usedRequirements(script).filter(n => /glass|tumbler/.test(n)).length, 1)
})

test('the end card renders every requirement beyond nine items in bounded columns', () => {
  const script = physicalPlan({ objects: [{ k: 'glass', n: 'glass', cm: 20, b: [0, 0, 100, 150], part: { family: 'cylinder', size: [10, 10, 20] } }],
    supplies: Array.from({ length: 22 }, (_, i) => `Ingredient ${i + 1}`),
    steps: [{ t: 'Place', c: 'Place glass', do: [{ v: 'place', k: 'glass', rel: 'floor' }] }] })
  const calls = frame(compile(script), timeline(script).end + 0.7)
  for (const name of usedRequirements(script)) {
    const label = calls.find(c => c.method === 'fillText' && c.args[0] === name)
    assert.ok(label, `${name} was omitted`)
    assert.ok(label.args[1] >= 100 && label.args[1] <= 1460 && label.args[2] >= 450 && label.args[2] < 760)
  }
  assert.ok(!calls.some(c => c.method === 'fillText' && /\+ \d+ more/.test(c.args[0])))
})

test('packaged food going into cookware is emptied in; other things placed in things stay whole', () => {
  assert.equal(unpacksInto({ k: 'turkey-package-1', n: 'Kirkwood ground turkey package' }, 'pot'), true)
  assert.equal(unpacksInto({ k: 'rice', n: 'bag of rice' }, 'bowl'), true)
  assert.equal(unpacksInto({ k: 'ice', n: 'ice cube' }, 'glass'), false, 'not packaging')
  assert.equal(unpacksInto({ k: 'pear', n: 'whole pear' }, 'bowl'), false, 'not packaging')
  assert.equal(unpacksInto({ k: 'box', n: 'gift box' }, 'crate'), false, 'not cookware')
  const script = physicalPlan({ objects: [{ k: 'turkey-package', n: 'ground turkey package', cm: 20, b: [0, 0, 100, 150], part: { family: 'loose', size: [30, 20, 5] } }], tools: [{ k: 'pot', use: 'pot' }, { k: 'spoon', use: 'spoon' }], steps: [
    { t: 'Set out pot', c: 'Put the pot out', do: [{ v: 'place', k: 'pot', rel: 'floor' }] },
    { t: 'Add turkey', c: 'Add ground turkey to the pot', do: [{ v: 'place', k: 'turkey-package', rel: 'in', to: 'pot' }] },
    { t: 'Stir', c: 'Stir it', do: [{ v: 'stir', k: 'pot', to: 'pot', with: 'spoon' }] },
  ] })
  const times = timeline(script), add = times.acts.find((a) => a.k === 'turkey-package')
  const draw = compile(script), packageFill = '#abc000'
  // Each fill of the package's colour with the alpha it was drawn at.
  const fills = (time) => {
    const old = globalThis.Path2D; globalThis.Path2D = class { constructor(d) { this.d = d } }
    try {
      const { ctx } = recordingCanvas(), seen = []
      const spy = new Proxy(ctx, { get: (o, k) => k === 'fill' ? (...args) => { if (o.fillStyle === packageFill) seen.push(o.globalAlpha); return o.fill(...args) } : o[k], set: (o, k, v) => { o[k] = v; return true } })
      draw(spy, time, offlineEnv())
      return seen
    } finally { globalThis.Path2D = old }
  }
  assert.ok(fills(add.at + add.len * 0.4).length, 'the package comes over the pot')
  // (afterwards it may show faded in the tray, as a used can does, but nowhere solid)
  const after = fills(times.acts.find((a) => a.v === 'stir').at + 0.5)
  assert.ok(after.every((alpha) => alpha < 0.9), `it is used up, not left on the rim: ${after}`)
  assert.equal(add.v, 'sprinkle'); assert.equal(add.unpacked, true); assert.equal(add.color, foodColor('turkey'))
})

test('the summary keeps objects whose names contain each other, and counts repeats', () => {
  const place = (k) => ({ v: 'place', k })
  const objects = [['red-a', 'red 2×4 brick'], ['lime', 'lime green 2×4 brick'], ['green', 'green 2×4 brick'], ['sky', 'light blue 2×4 brick'],
    ['blue', 'blue 2×4 brick'], ['red-b', 'red 2×4 brick'], ['spare', 'yellow 2×4 brick']].map(([k, n]) => ({ k, n }))
  const script = { objects, steps: [{ do: objects.slice(0, 6).map(o => place(o.k)) }] }
  assert.deepEqual(usedRequirements(script), ['2 × red 2×4 brick', 'lime green 2×4 brick', 'green 2×4 brick', 'light blue 2×4 brick', 'blue 2×4 brick'])
})

test('a supply that names an object still stands for it', () => {
  const script = { supplies: ['400 g chopped tomatoes'], objects: [{ k: 'tin', n: 'tomatoes' }], steps: [{ do: [{ v: 'place', k: 'tin' }] }] }
  assert.deepEqual(usedRequirements(script), ['400 g chopped tomatoes'])
})

test('a supply giving the same count of a fastener is not listed twice', () => {
  const tools = [{ k: 'screws', cm: 7 }]
  const uses = (n) => ({ do: [{ v: 'use', k: 'board', part: 'screws', n }] })
  const objects = [{ k: 'board', n: 'pine board' }]
  assert.deepEqual(usedRequirements({ supplies: ['16 screws, 7 cm'], objects, tools, steps: [uses(16)] }), ['16 screws, 7 cm', 'pine board'])
  assert.deepEqual(usedRequirements({ objects, tools, steps: [uses(16)] }), ['pine board', '16 screws · 70 mm'])
  assert.deepEqual(usedRequirements({ supplies: ['8 screws, 7 cm'], objects, tools, steps: [uses(16)] }), ['8 screws, 7 cm', 'pine board', '16 screws · 70 mm'], 'different counts both stay')
})

test('sizes count as estimated only when an estimated thing is cut or joined', () => {
  const measured = (status) => ({ measurements: { cm: { status } } })
  const cut = { do: [{ v: 'cut', k: 'board', into: [{ k: 'side', cm: 40 }] }] }
  assert.equal(sizesEstimated({ objects: [{ k: 'board', ...measured('estimated') }], steps: [cut] }), true)
  assert.equal(sizesEstimated({ objects: [{ k: 'board', ...measured('confirmed') }], steps: [cut] }), false)
  assert.equal(sizesEstimated({ objects: [{ k: 'a', ...measured('estimated') }, { k: 'b', ...measured('confirmed') }], joints: [{ a: 'b', b: 'a' }], steps: [] }), true)
  assert.equal(sizesEstimated({ objects: [{ k: 'board', ...measured('estimated') }], joints: [{ a: 'side', b: 'side' }], steps: [{ do: [{ v: 'cut', k: 'board', into: [{ k: 'side', cm: 40 }] }] }] }), true, 'a joint on a cut part')
  assert.equal(sizesEstimated({ objects: [{ k: 'can', ...measured('estimated') }], steps: [{ do: [{ v: 'pour', k: 'can', to: 'pot' }] }] }), false, 'a recipe')
})

