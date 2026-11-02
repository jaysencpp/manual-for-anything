import test from 'node:test'
import assert from 'node:assert/strict'
import { plain } from '../src/pipeline/script.mjs'
import { mixtureColor, stirOffset, settleProcesses } from '../src/solvers/processes.mjs'
import { familyDrawings, vesselDrawing } from '../src/solvers/families.mjs'
import { withTools } from '../src/solvers/tools.mjs'
import { solveBuild } from '../src/solvers/layout.mjs'
import { program, timeline } from '../src/film/engine.mjs'
import { validatePlan } from '../src/pipeline/validate.mjs'
import { recordingCanvas, offlineEnv } from '../scripts/offline-canvas.mjs'
import { refusedIn } from '../src/pipeline/words.mjs'

function example() {
  const object = (k, n, cm, b, part, other = {}) => ({ k, n, cm, b, part, measurements: { cm: { status: 'estimated', source: 'test photo estimate' } }, ...other })
  const objects = [
    object('powder-dish', 'green powder in small black dish', 6, [0, 0, 100, 100], { family: 'cylinder', size: [6, 6, 2] }),
    object('bowl', 'red ceramic bowl', 12, [300, 0, 200, 200], { family: 'cylinder', size: [12, 12, 7] }),
    object('whisk', 'bamboo whisk', 11, [0, 300, 200, 60], { family: 'loose', size: [6, 6, 11] }, { toolKind: 'whisk', tip: [0, 330] }),
    object('scoop', 'bamboo scoop', 18, [0, 500, 200, 10], { family: 'rod', size: [18, 1, 1] }, { toolKind: 'spoon', tip: [0, 505] }),
  ]
  const actions = [
    ['Place bowl', 'Place the bowl', { v: 'place', k: 'bowl', rel: 'floor' }],
    ['Place pot', 'Place the water pot', { v: 'place', k: 'pot', rel: 'floor' }],
    ['Heat water', 'Heat the water', { v: 'heat', k: 'pot', to: 'pot', level: 'high' }],
    ['Cool slightly', 'Cool the water to the labelled temperature', { v: 'heat', k: 'pot', to: 'pot', level: 'low', label: '80°C' }],
    ['Add powder', 'Sprinkle 2 g powder into the bowl', { v: 'sprinkle', k: 'powder-dish', to: 'bowl', color: '#4a7c2f', label: '2 g' }],
    ['Pour water', 'Pour 70 ml water into the bowl', { v: 'pour', k: 'pot', to: 'bowl', color: '#cfe8f5', label: '70 ml' }],
    ['Whisk briskly', 'Whisk briskly in an M motion', { v: 'stir', k: 'whisk', to: 'bowl', with: 'whisk' }],
    ['Finish froth', 'Whisk gently to finish the froth', { v: 'stir', k: 'whisk', to: 'bowl', with: 'whisk' }],
  ]
  return { contractVersion: 2, objects, tools: [{ k: 'pot', use: 'pot' }], joints: [], goals: [], makes: [], finale: [],
    title: 'Whisked drink', sub: 'A process test', tag: 'Test', end: 'Serve', view: 'side', pick: 0,
    ideas: Array.from({ length: 3 }, () => ({ title: 'Whisked drink', pitch: 'Mix a drink', kind: 'recipe' })),
    design: { purpose: 'Mix a drink', standard: 'One serving', parts: objects.map((o) => ({ k: o.k, from: o.k, cm: 0, n: 1 })) },
    steps: actions.map(([t, c, a], i) => ({ t, c, claims: [`a${i}`], do: [{ id: `a${i}`, intent: a.v, ...a }] })) }
}

test('literal process instructions normalize without changing timing or mutating the original inventory', () => {
  const raw = example(), s = plain(raw), acts = s.steps.flatMap((s) => s.do)
  assert.equal(acts[3].level, 'off'); assert.equal(acts[3].intent, 'cool')
  assert.equal(acts[4].with, 'scoop'); assert.equal(s.objects[0].contents.form, 'powder')
  assert.equal(raw.objects[0].contents, undefined)
  assert.equal(acts[5].opacity, 0); assert.equal(acts[5].with, undefined, 'water is poured directly, not ladled')
  assert.equal(acts[6].pattern, 'zigzag'); assert.equal(acts[6].pace, 'brisk')
  assert.equal(acts[7].pace, 'gentle'); assert.equal(acts[7].finish, 'foam')
  assert.equal(timeline(s).duration, timeline(raw).duration)
  assert.deepEqual(plain(s), s)
  assert.equal(validatePlan(s).valid, true)
  const noFoam = { objects: [], steps: [{ c: 'Stir gently without foaming', do: [{ v: 'stir' }] }] }
  settleProcesses(noFoam); assert.equal(noFoam.steps[0].do[0].finish, undefined)
})

test('clear liquid does not turn pigment blue and unspecified mixtures retain their colour rule', () => {
  assert.equal(mixtureColor([{ color: '#4a7c2f' }, { color: '#cfe8f5', opacity: 0 }]), '#4a7c2f')
  assert.equal(mixtureColor([{ color: '#000000' }, { color: '#ffffff' }]), '#808080')
  assert.equal(mixtureColor([{ color: '#cfe8f5', opacity: 0 }]), '#cfe8f5')
  assert.equal(mixtureColor([{ color: '#000000', opacity: 0.25 }, { color: '#ffffff', opacity: 0.75 }]), '#bfbfbf')
})

test('zigzag and circular stirring have distinct bounded trajectories and a gentle pace', () => {
  let brisk = 0, gentle = 0
  for (let i = 0; i < 100; i++) {
    const a = stirOffset('zigzag', 'brisk', i / 100), b = stirOffset('zigzag', 'gentle', i / 100)
    assert.ok(Math.abs(a[0]) <= 1 && Math.abs(a[1]) <= 0.3)
    brisk = Math.max(brisk, Math.abs(a[0])); gentle = Math.max(gentle, Math.abs(b[0]))
  }
  assert.ok(gentle < brisk)
  assert.notDeepEqual(stirOffset('zigzag', 'normal', 0.2), stirOffset('circle', 'normal', 0.2))
})

test('a top-view photo yields a coherent side-view vessel without changing its photo frame', () => {
  const o = example().objects[1], v = vesselDrawing(o, 800, 1000, '#a8424a')
  assert.equal(v.width, 800); assert.equal(v.height, 1000)
  assert.ok(v.bounds[1] > 0 && v.bounds[3] < 800)
  assert.ok(v.vessel.seat[1] >= v.bounds[1] && v.vessel.seat[1] < v.bounds[1] + v.bounds[3])
  assert.ok(v.vessel.rx > v.vessel.ry)
})

test('saved process geometry draws a scoop, extinguishes flames, preserves colour and retains foam', () => {
  const s = plain(example()), geometry = {}, sizes = {}, traces = {}
  for (const o of s.objects) {
    const [x, y, width, height] = o.b
    geometry[o.k] = { origin: [x, y], center: [x + width / 2, y + height / 2], turn: 0, seat: [width / 2, height * 0.12], base: [width / 2, height], ends: [[0, height / 2], [width, height / 2]], color: '#a8424a' }
    sizes[o.k] = { width, height }
    traces[o.k] = { width: width * 4, height: height * 4, parts: [{ id: o.k, parent: null, pivot: [width * 2, height * 4], shapes: [{ d: `M0 0 H${width * 4} V${height * 4} H0 Z`, fill: o.k === 'powder-dish' ? '#222222' : '#a8424a', stroke: '#1d2b4f' }] }] }
  }
  const vectors = { ...traces, ...familyDrawings(s, traces) }, fitted = withTools(s, geometry, sizes, vectors), layout = solveBuild(s, fitted.geometry, fitted.sizes), times = timeline(s)
  const source = program({ script: s, ...fitted, layout, boxes: Object.fromEntries(s.objects.map((o) => [o.k, o.b])), photo: { width: 1000, height: 1000 } })
  assert.deepEqual(refusedIn(source), [])
  const old = globalThis.Path2D; globalThis.Path2D = class {}
  try {
    const draw = new Function(`return (${source})`)(), env = offlineEnv()
    const frame = (time) => { const c = recordingCanvas(); draw(c.ctx, time, env); assert.equal(c.depth(), 0); return c }
    for (const a of times.acts) for (const fraction of [0.1, 0.5, 0.95]) frame(a.at + a.len * fraction)
    assert.ok(frame(times.acts[2].at + 0.8).calls.some((c) => c.method === 'fill' && c.fill === '#ff8a00'))
    assert.ok(!frame(times.acts[3].at + 0.8).calls.some((c) => c.method === 'fill' && c.fill === '#ff8a00'))
    const transfer = frame(times.acts[4].at + times.acts[4].len * 0.75)
    assert.ok(transfer.calls.some((c) => c.method === 'mark' && c.args[0] === 'scoop'))
    assert.ok(transfer.calls.some((c) => c.method === 'mark' && c.args[0] === 'powder-dish'))
    const complete = frame(times.acts.at(-1).at + times.acts.at(-1).len + 0.05)
    assert.ok(complete.calls.some((c) => c.method === 'fill' && c.fill === '#4a7c2f'))
    assert.ok(complete.calls.some((c) => c.method === 'ellipse' && c.args[2] === 2.5 && c.fill === '#e4edcf'))
  } finally { globalThis.Path2D = old }
})

test('bad process metadata is rejected before rendering', () => {
  const s = plain(example())
  s.objects[0].contents.opacity = 2
  s.steps[6].do[0].pattern = 'unknown'
  const errors = validatePlan(s).errors.join(';')
  assert.match(errors, /invalid container contents/); assert.match(errors, /invalid stirring pattern/)
})
