// The plan's mistakes that have one reading, settled in code instead of a repair round (contracts.mjs settleOperations,
// jsonfix.mjs). Each case is one a real plan made (runs named in the test).
import test from 'node:test'
import assert from 'node:assert/strict'
import { validatePlan } from '../src/pipeline/validate.mjs'
import { settleOperations, settleStates, settleCaptions } from '../src/solvers/contracts.mjs'
import { plain } from '../src/pipeline/script.mjs'
import { mendJson } from '../src/pipeline/jsonfix.mjs'
import { json } from '../src/pipeline/json.mjs'
import { solve, solveBuild, builtProblems } from '../src/solvers/layout.mjs'
import { withTools } from '../src/solvers/tools.mjs'

const photo = { width: 400, height: 100 }
const settle = (s) => [...settleOperations(s), ...settleStates(s), ...settleCaptions(s)]
const errorsOf = (s) => { const v = validatePlan(s, photo); return [...v.errors, ...v.soft] }

// A stool from logs: three legs cut from logs and a seat on them, screwed down through the seat.
function stool() {
  const m = { status: 'estimated', source: 'test input' }
  const log = (k, cm, x) => ({ k, n: 'log', segment: 'log', b: [x, 0, 90, 30], cm, w: 10, thick: 10, measurements: { cm: m, w: m, thick: m } })
  const sites = [{ x: 0.5, lat: 0 }]
  return { contractVersion: 2, view: 'iso', title: 'Log stool', sub: 'Three legs', tag: 'Wood', end: 'Done', finale: [], goals: [],
    ideas: [0, 1, 2].map((i) => ({ title: `Idea ${i}`, pitch: 'An example', kind: 'build' })), pick: 0,
    design: { purpose: 'A low seat', standard: 'Seat height 30 cm', size: [40, 10, 40], joins: 'One 14 cm screw per leg', stands: 'On three legs',
      parts: [{ k: 'leg-1', from: 'log-1', cm: 30 }, { k: 'leg-2', from: 'log-2', cm: 30 }, { k: 'seat', from: 'seat', cm: 40 }] },
    objects: [log('log-1', 35, 0), log('log-2', 35, 100), log('seat', 40, 200)],
    tools: [{ k: 'saw', use: 'saw' }, { k: 'driver', use: 'screwdriver' }, { k: 'screws', use: 'screw', cm: 14 }],
    joints: ['leg-1', 'leg-2'].map((k, i) => ({ id: `j${i + 1}`, a: 'seat', b: k, face: 'upper', otherFace: 'upper', method: 'fasten', depthCm: 14, sites })),
    steps: [
      { t: 'Cut', c: 'Saw each log to a 30 cm leg', claims: ['cut-1', 'cut-2'], do: [
        { id: 'cut-1', intent: 'cut', v: 'cut', k: 'log-1', with: 'saw', into: [{ k: 'leg-1', cm: 30, label: '30 cm' }, { k: 'offcut-1', cm: 5, label: '5 cm' }] },
        { id: 'cut-2', intent: 'cut', v: 'cut', k: 'log-2', with: 'saw', into: [{ k: 'leg-2', cm: 30, label: '30 cm' }, { k: 'offcut-2', cm: 5, label: '5 cm' }] }] },
      { t: 'Stand', c: 'Stand the legs and lay the seat on them', claims: ['p1'], do: [
        { id: 'p1', intent: 'place', v: 'place', k: 'leg-1', rel: 'floor', stand: 'end' },
        { id: 'p2', intent: 'place', v: 'place', k: 'leg-2', rel: 'floor', stand: 'end' },
        { id: 'p3', intent: 'place', v: 'place', k: 'seat', rel: 'on', to: 'leg-1', also: ['leg-2'] }] },
      { t: 'Screw', c: 'Drive a 14 cm screw into each leg', claims: ['f1', 'f2'], do: [
        { id: 'f1', intent: 'fasten', v: 'use', k: 'seat', to: 'leg-1', joint: 'j1', with: 'driver', part: 'screws', n: 1, sites },
        { id: 'f2', intent: 'fasten', v: 'use', k: 'seat', to: 'leg-2', joint: 'j2', with: 'driver', part: 'screws', n: 1, sites }] }] }
}

test('the stool example is a valid plan as written', () => {
  const s = stool(); settle(s)
  assert.deepEqual(errorsOf(s), [])
})

test('a place whose intent is cut and that carries its pieces is a cut; a tool used for its own purpose is a use (photo-mvs9xzzj-4)', () => {
  const s = stool(); s.steps[0].do[0].v = 'place'; s.steps[0].do[0].rel = 'floor'
  s.tools.push({ k: 'level', use: 'level' })
  s.steps[2].do.push({ id: 'check', intent: 'level', v: 'use', k: 'seat', with: 'level' }); s.steps[2].claims.push('check')
  assert.ok(errorsOf(structuredClone(s)).length)
  const notes = settle(s)
  assert.equal(s.steps[0].do[0].v, 'cut'); assert.equal(s.steps[2].do[2].intent, 'use'); assert.equal(s.steps[2].do[2].purpose, 'level')
  assert.ok(notes.some((n) => /place made cut/.test(n)))
  assert.deepEqual(errorsOf(s), [])
})

test('the stock named after its cut means the piece cut from it, in operations and joints (photo-mvs9xzzj-4)', () => {
  const s = stool()
  s.joints[0].b = 'log-1'; s.steps[2].do[0].to = 'log-1'; s.steps[1].do[2].to = 'log-1'
  settle(s)
  assert.equal(s.joints[0].b, 'leg-1'); assert.equal(s.steps[2].do[0].to, 'leg-1'); assert.equal(s.steps[1].do[2].to, 'leg-1')
  // (not before the cut: the cut itself still names its stock)
  assert.equal(s.steps[0].do[0].k, 'log-1')
  assert.deepEqual(errorsOf(s), [])
})

test('an undeclared name that means a declared one is that one; a fastener named by its kind is declared (corrected-cleats)', () => {
  const s = stool(); s.steps[2].do[0].part = 'screw'
  settle(s); assert.equal(s.steps[2].do[0].part, 'screws')
  assert.deepEqual(errorsOf(s), [])
  const n = stool(); n.tools = n.tools.filter((t) => t.k !== 'screws'); for (const a of n.steps[2].do) a.part = 'nails'
  n.tools.push({ k: 'hammer', use: 'hammer' }); for (const a of n.steps[2].do) a.with = 'hammer'
  settle(n)
  assert.deepEqual(n.tools.find((t) => t.k === 'nails'), { k: 'nails', use: 'nail', cm: 14 })
  assert.deepEqual(errorsOf(n), [])
})

test('an operation that makes a joint takes the joint\'s parts and count (photo-mvsbnqz0-11)', () => {
  const s = stool(); Object.assign(s.steps[2].do[0], { k: 'driver', n: 2 })
  assert.ok(errorsOf(structuredClone(s)).some((e) => /contradicts joint j1/.test(e)))
  settle(s)
  assert.equal(s.steps[2].do[0].k, 'seat'); assert.equal(s.steps[2].do[0].n, 1)
  assert.deepEqual(errorsOf(s), [])
})

test('a joint fastened before its parts are placed gets the places the joint implies', () => {
  const s = stool(); s.steps.splice(1, 1)
  assert.ok(errorsOf(structuredClone(s)).some((e) => /position both joint parts/.test(e)))
  const notes = settle(s), ops = s.steps[1].do
  assert.deepEqual(ops.slice(0, 2).map((a) => [a.k, a.rel, a.to]), [['leg-1', 'floor', undefined], ['seat', 'on', 'leg-1']])
  assert.ok(ops.some((a) => a.v === 'place' && a.k === 'leg-2'))
  assert.ok(notes.some((n) => /placed on leg-1 before f1/.test(n)))
  assert.deepEqual(errorsOf(s).filter((e) => !/design/.test(e)), [])
})

test('a step that uses a part a later step cuts is moved after it when it can be', () => {
  const s = stool(); const [cut] = s.steps.splice(0, 1); s.steps.push(cut)
  // (the legs are stood up in step 1, cut in step 3)
  assert.ok(errorsOf(structuredClone(s)).some((e) => /used before it is created/.test(e)))
  settle(s)
  assert.deepEqual(s.steps.map((x) => x.t), ['Cut', 'Stand', 'Screw'])
  assert.deepEqual(errorsOf(s), [])
})

test('operations without an id, an intent or a claim are named and claimed (photo-mvse0gv4)', () => {
  const s = stool(); delete s.steps[0].do[1].id; delete s.steps[0].do[1].intent; s.steps[0].claims = ['cut-1']
  settle(s)
  const op = s.steps[0].do[1]
  assert.equal(op.intent, 'cut'); assert.ok(s.steps[0].claims.includes(op.id))
  assert.deepEqual(errorsOf(s), [])
})

test('an answer with an escaped quote ending a key is mended; one cut off is closed only when asked (photo-mvse0gv4)', () => {
  assert.deepEqual(JSON.parse(mendJson('{"tools":[{"k":"screws","cm\\":15}],"a":1}')), { tools: [{ k: 'screws', cm: 15 }], a: 1 })
  assert.deepEqual(json('{"a":[1,2,],"b":"two\nlines"}'), { a: [1, 2], b: 'two\nlines' })
  // (a quote escaped inside a value is the value's)
  assert.deepEqual(json('{"c":"say \\"hi\\", then"}'), { c: 'say "hi", then' })
  const cut = '{"title":"Stool","tools":[{"k":"screws","use":"screw","cm\\":15}],"' + ' \t'.repeat(50)
  assert.equal(mendJson(cut), null)
  assert.deepEqual(JSON.parse(mendJson(cut, { truncated: true })), { title: 'Stool', tools: [{ k: 'screws', use: 'screw', cm: 15 }] })
  // (what was being written when it stopped is left out: "Tw" may have been "Two", 1 may have been 15)
  assert.deepEqual(JSON.parse(mendJson('{"steps":[{"t":"One"},{"t":"Tw', { truncated: true })), { steps: [{ t: 'One' }] })
  assert.deepEqual(JSON.parse(mendJson('{"a":"x","cm":1', { truncated: true })), { a: 'x' })
  assert.deepEqual(JSON.parse(mendJson('{"steps":[{"t":"One"}],"view":', { truncated: true })), { steps: [{ t: 'One' }] })
})

test('a mended answer cut off at its view gets the view a build is seen in', () => {
  const s = stool(); delete s.view
  settle(s); assert.equal(s.view, 'iso')
})

// The log footstool of photo-mvsdowsl: three logs on the floor, three across them (10, 11 and 12 cm thick), three on
// top, each top log screwed with 15 cm screws into one of the middle three.
function footstool() {
  const m = { status: 'estimated', source: 'test input' }
  const log = (k, d, i) => ({ k, n: 'log', segment: 'log', b: [i * 40, 0, 40, 30], cm: 30, w: d, thick: d, measurements: { cm: m, w: m, thick: m } })
  const sizes = [12, 12, 12, 10, 11, 12, 11, 12, 11], keys = sizes.map((_, i) => `log-${i + 1}`)
  const sites = [{ x: 0.25, lat: -0.25 }, { x: 0.75, lat: 0.25 }]
  const place = (k, rel, to, more = {}) => ({ id: `p-${k}`, intent: 'place', v: 'place', k, rel, to, ...more })
  const script = { contractVersion: 2, view: 'iso', title: 'Log footstool', objects: keys.map((k, i) => log(k, sizes[i], i)),
    tools: [{ k: 'driver', use: 'screwdriver' }, { k: 'screws', use: 'screw', cm: 15 }],
    joints: [[7, 4], [8, 5], [9, 6]].map(([a, b], i) => ({ id: `j${i + 1}`, a: `log-${a}`, b: `log-${b}`, face: 'upper', otherFace: 'upper', method: 'fasten', depthCm: 15, sites })),
    steps: [{ t: 'Lay', c: 'Lay the logs in three layers', do: [
      place('log-1', 'floor'), place('log-2', 'parallel', 'log-1', { side: '+' }), place('log-3', 'parallel', 'log-2', { side: '+' }),
      place('log-4', 'across', 'log-1'), place('log-5', 'parallel', 'log-4', { side: '+' }), place('log-6', 'parallel', 'log-5', { side: '+' }),
      place('log-7', 'on', 'log-4', { also: ['log-5', 'log-6'] }), place('log-8', 'parallel', 'log-7', { side: '+' }), place('log-9', 'parallel', 'log-8', { side: '+' })] },
    { t: 'Screw', c: 'Drive 15 cm screws through each top log', caption: { template: 'Drive {count} 15 cm screws', actions: ['f1', 'f2', 'f3'] }, do: [1, 2, 3].map((i) =>
      ({ id: `f${i}`, intent: 'fasten', v: 'use', k: `log-${i + 6}`, to: `log-${i + 3}`, joint: `j${i}`, with: 'driver', part: 'screws', label: '15 cm', sites })) }] }
  const geometry = Object.fromEntries(keys.map((k) => [k, { origin: [0, 0], seat: [50, 2], base: [50, 30], color: '#a0703a' }]))
  return { script, geometry, sizes: Object.fromEntries(keys.map((k) => [k, { width: 100, height: 30 }])) }
}

test('a layer laid across a row spans the row, and one laid from a centred first log is centred as a whole', () => {
  const { script, geometry, sizes } = footstool(), W = solve(script, geometry, sizes, { unchecked: true }).world
  // (the middle layer over the floor layer's 36 cm, the top layer over the middle layer's 30 cm)
  const span = (keys, ax) => [Math.min(...keys.map((k) => W[k].p[ax])), Math.max(...keys.map((k) => W[k].p[ax] + W[k].e[ax]))]
  const mid = ([lo, up]) => (lo + up) / 2
  assert.equal(mid(span(['log-4', 'log-5', 'log-6'], 'y')), mid(span(['log-1', 'log-2', 'log-3'], 'y')))
  assert.equal(mid(span(['log-4', 'log-5', 'log-6'], 'x')), mid(span(['log-1'], 'x')))
  assert.equal(mid(span(['log-7', 'log-8', 'log-9'], 'y')), mid(span(['log-4'], 'y')))
  // (each top log over the middle layer for most of its width: the layer is 34 cm wide on logs 30 cm long)
  const over = (k) => Math.min(W[k].p.y + W[k].e.y, W['log-4'].p.y + W['log-4'].e.y) - Math.max(W[k].p.y, W['log-4'].p.y)
  for (const k of ['log-7', 'log-8', 'log-9']) assert.ok(over(k) > W[k].e.y * 0.8, `${k} rests on the middle layer`)
})

test('screws into a log the top log does not touch join the one it rests on, and are made long enough (photo-mvsdowsl)', () => {
  const { script, geometry, sizes } = footstool()
  // (solved without settling the fasteners: the joints meet, but 15 cm screws go only 3–4 cm into the log under)
  const plain = structuredClone(script)
  assert.deepEqual(builtProblems(plain, solve(plain, geometry, sizes)).map((p) => /goes only/.test(p)), [true, true, true])
  const layout = solveBuild(script, geometry, sizes)
  assert.deepEqual(builtProblems(script, layout), [])
  // (the top layer rests on the thickest middle log, 12 cm)
  assert.deepEqual(script.joints.map((j) => j.b), ['log-6', 'log-6', 'log-6'])
  assert.deepEqual(script.steps[1].do.map((a) => a.to), ['log-6', 'log-6', 'log-6'])
  assert.equal(script.tools[1].cm, 17); assert.deepEqual(script.joints.map((j) => j.depthCm), [17, 17, 17])
  assert.equal(script.steps[1].c, 'Drive 17 cm screws through each top log'); assert.equal(script.steps[1].caption.template, 'Drive {count} 17 cm screws')
  assert.deepEqual(script.steps[1].do.map((a) => a.label), ['17 cm', '17 cm', '17 cm'])
  assert.ok(layout.settled.some((n) => /15 cm → 17 cm/.test(n)))
})

test('a seat laid on one leg but screwed down into three rests on all three', () => {
  const s = stool(); delete s.steps[1].do[2].also
  settle(s); assert.deepEqual(s.steps[1].do[2].also, ['leg-2'])
  assert.deepEqual(errorsOf(s), [])
})

test('a design part that is a whole object, never cut, named by its design name in the steps, is that object (photo-mvsfpo7r)', () => {
  const s = stool()
  // (the seat used whole, called "top" in the design, the steps and the joints)
  s.design.parts = s.design.parts.map((p) => (p.k === 'seat' ? { ...p, k: 'top' } : p))
  for (const j of s.joints) j.a = 'top'
  s.steps[1].do[2].k = 'top'; for (const a of s.steps[2].do) a.k = 'top'
  assert.ok(errorsOf(structuredClone(s)).some((e) => /unknown object top/.test(e)))
  const notes = settle(s)
  assert.ok(notes.includes('top is seat, used whole'))
  assert.deepEqual(s.joints.map((j) => j.a), ['seat', 'seat']); assert.equal(s.steps[1].do[2].k, 'seat')
  assert.deepEqual(errorsOf(s), [])
})

test('logs laid side by side on the same legs are one seat over them, each leg under the log screwed to it (photo-mvsfpo7r)', () => {
  const m = { status: 'estimated', source: 'test input' }
  const log = (k, i) => ({ k, n: 'split log', segment: 'log', b: [i * 40, 0, 40, 30], cm: 35, w: 12, thick: 10, measurements: { cm: m, w: m, thick: m } })
  const tops = ['top-1', 'top-2', 'top-3'], legs = ['leg-1', 'leg-2', 'leg-3'], keys = [...tops, ...legs.map((_, i) => `log-${i + 1}`)]
  const sites = [{ x: 0.5, lat: 0 }]
  const script = { contractVersion: 2, view: 'iso', title: 'Split-log footstool', objects: keys.map(log),
    tools: [{ k: 'saw', use: 'saw' }, { k: 'driver', use: 'screwdriver' }, { k: 'screws', use: 'screw', cm: 15 }],
    joints: tops.map((k, i) => ({ id: `j${i + 1}`, a: k, b: legs[i], face: 'upper', otherFace: 'upper', method: 'fasten', depthCm: 15, sites })),
    steps: [
      { t: 'Cut', c: 'Cut three 22 cm legs', do: legs.map((k, i) => ({ id: `c${i}`, intent: 'cut', v: 'cut', k: `log-${i + 1}`, with: 'saw', into: [{ k, cm: 22, label: '22 cm' }, { k: `offcut-${i}`, cm: 13, label: '13 cm' }] })) },
      { t: 'Stand', c: 'Stand the legs', do: legs.map((k) => ({ id: `s-${k}`, intent: 'place', v: 'place', k, rel: 'floor', stand: 'end' })) },
      { t: 'Seat', c: 'Lay three logs across the legs', do: tops.map((k) => ({ id: `p-${k}`, intent: 'place', v: 'place', k, rel: 'on', to: 'leg-1', also: ['leg-2', 'leg-3'] })) },
      { t: 'Screw', c: 'Screw each log to its leg', do: tops.map((k, i) => ({ id: `f${i}`, intent: 'fasten', v: 'use', k, to: legs[i], joint: `j${i + 1}`, with: 'driver', part: 'screws', sites })) }] }
  const cut = Object.fromEntries(keys.map((k) => [k, { origin: [0, 0], seat: [50, 2], base: [50, 30], color: '#a0703a' }]))
  const { geometry, sizes } = withTools(script, cut, Object.fromEntries(keys.map((k) => [k, { width: 100, height: 30 }])), {})
  const layout = solveBuild(script, geometry, sizes), W = layout.world
  assert.deepEqual(builtProblems(script, layout), [])
  // (the logs side by side, touching; each leg under its own log; the legs not in a line)
  assert.deepEqual(tops.map((k) => W[k].p.y), [0, 12, 24].map((y) => y + W['top-1'].p.y))
  for (const [i, k] of legs.entries()) assert.ok(W[k].p.y >= W[tops[i]].p.y - 0.01 && W[k].p.y + W[k].e.y <= W[tops[i]].p.y + W[tops[i]].e.y + 0.01, `${k} under ${tops[i]}`)
  assert.notEqual(W['leg-1'].p.x, W['leg-2'].p.x)
})

test('a screwed joint meets its part through the same named face; glue through the opposite (photo-mvsh1d7p)', () => {
  const s = stool(); for (const j of s.joints) j.otherFace = 'lower'
  const notes = settle(s)
  assert.deepEqual(s.joints.map((j) => j.otherFace), ['upper', 'upper']); assert.ok(notes.some((n) => /through its upper face, not its lower/.test(n)))
  const g = stool(); for (const j of g.joints) { j.method = 'glue'; j.otherFace = 'upper' }
  settle(g); assert.deepEqual(g.joints.map((j) => j.otherFace), ['lower', 'lower'])
})

test('screws as long as the depth their joints agree on; joints that disagree take the screws\' length (photo-mvsh1d7p)', () => {
  const s = stool(); for (const j of s.joints) j.depthCm = 16
  settle(s); assert.equal(s.tools.find((t) => t.k === 'screws').cm, 16)
  assert.deepEqual(errorsOf(s), [])
  const d = stool(); d.joints[0].depthCm = 16; d.joints[1].depthCm = 18
  settle(d); assert.deepEqual(d.joints.map((j) => j.depthCm), [14, 14])
  assert.deepEqual(errorsOf(d), [])
})

// A flower glued to its stem, then the stem stood in a vase: the flower was left behind and the joint reported as open,
// so the order a person would really work in failed planning.
test('parts glued together move as one when either is placed again', () => {
  const sites = [{ x: 0.5, lat: 0 }]
  const place = (id, k, rel, to) => ({ id, intent: 'place', v: 'place', k, rel, ...(to ? { to } : {}) })
  const glue = { id: 'g', intent: 'glue', v: 'use', k: 'flower', to: 'stem', joint: 'j', sites }
  const plan = (steps) => ({ view: 'plan', objects: [['stem', 16, 2, 0.5], ['flower', 5, 5, 0.5], ['vase', 20, 20, 2]].map(([k, cm, w, thick]) => ({ k, n: k, cm, w, thick })),
    tools: [], joints: [{ id: 'j', a: 'flower', b: 'stem', face: 'lower', otherFace: 'upper', method: 'glue', sites }], steps: steps.map((a) => ({ do: [a] })) })
  const geometry = { stem: {}, flower: {}, vase: {} }, sizes = { stem: { width: 160, height: 20 }, flower: { width: 50, height: 50 }, vase: { width: 200, height: 200 } }
  const layout = (steps) => solve(plan(steps), geometry, sizes, { unchecked: true })
  const open = (l) => l.diagnostics.filter((d) => d.code === 'no-contact')

  const moved = layout([place('s', 'stem', 'floor'), place('v', 'vase', 'floor'), glue, place('f', 'flower', 'on', 'stem'), place('i', 'stem', 'in', 'vase')])
  assert.deepEqual(open(moved), [])
  const { stem, flower, vase } = moved.world
  assert.equal(stem.p.z, vase.e.z); assert.equal(flower.p.z, stem.p.z + stem.e.z)
  assert.ok(flower.p.x + flower.e.x > stem.p.x && flower.p.x < stem.p.x + stem.e.x, 'still over its stem')
  assert.ok(moved.order.indexOf('flower') > moved.order.indexOf('stem'), 'drawn over the stem it travelled with')

  // Placing a part on its own partner closes the joint: the partner stays where it is.
  const closed = layout([place('s', 'stem', 'floor'), place('p', 'flower', 'floor'), glue, place('f', 'flower', 'on', 'stem')])
  assert.deepEqual(open(closed), [])
  assert.equal(closed.world.stem.p.z, 0)

  // Glue spread on parts that never met holds nothing together: the stem goes alone and the joint stays open.
  const apart = layout([place('p', 'flower', 'floor'), place('s', 'stem', 'floor'), place('v', 'vase', 'floor'), glue, place('i', 'stem', 'in', 'vase')])
  assert.equal(open(apart).length, 1)
  assert.match(open(apart)[0].message, /Put the glue on first, then add a place action .*flower rel:"on" to:stem/)
  assert.equal(apart.world.flower.p.z, 0)

  // A joint not made yet moves nothing, even with the faces together.
  const unglued = layout([place('s', 'stem', 'floor'), place('v', 'vase', 'floor'), place('f', 'flower', 'on', 'stem'), place('i', 'stem', 'in', 'vase'), glue])
  assert.equal(open(unglued).length, 1)
})

// A paper bouquet stood three stems in one cone: all at its middle, so its three flowers drew as one.
test('things put in one container stand apart, and parts that still land together are reported', () => {
  const part = (k, cm, w, thick) => ({ k, n: k, cm, w, thick })
  const layout = (objects, steps) => solve({ view: 'plan', objects, tools: [], joints: [], steps: steps.map((a) => ({ do: [a] })) },
    Object.fromEntries(objects.map((o) => [o.k, {}])), Object.fromEntries(objects.map((o) => [o.k, { width: o.cm * 10, height: o.w * 10 }])), { unchecked: true })
  const put = (k, extra = {}) => ({ id: k, intent: 'place', v: 'place', k, rel: 'in', to: 'vase', ...extra })
  const floor = { id: 'v', intent: 'place', v: 'place', k: 'vase', rel: 'floor' }
  const overlaps = (l) => l.diagnostics.filter((d) => d.code === 'parts-overlap')
  const vase = part('vase', 30, 30, 2), stems = ['a', 'b', 'c'].map((k) => part(k, 16, 1, 0.5))

  const spread = layout([vase, ...stems], [floor, put('a'), put('b'), put('c')])
  const lows = ['a', 'b', 'c'].map((k) => spread.world[k].p.y - spread.world.vase.p.y)
  assert.deepEqual(lows, [4.5, 14.5, 24.5]); assert.deepEqual(overlaps(spread), [])

  // One thing alone stays centred, and one given its own position keeps it.
  const alone = layout([vase, stems[0]], [floor, put('a')])
  assert.equal(alone.world.a.p.y - alone.world.vase.p.y, 14.5)
  const told = layout([vase, ...stems], [floor, put('a', { cm: 1 }), put('b'), put('c')])
  assert.deepEqual(['b', 'c'].map((k) => told.world[k].p.y - told.world.vase.p.y), [7, 22])

  // Too wide to fit side by side: inside the container, and reported rather than hidden.
  const wide = ['a', 'b', 'c'].map((k) => part(k, 16, 20, 0.5))
  const full = layout([vase, ...wide], [floor, put('a'), put('b'), put('c')])
  for (const k of ['a', 'b', 'c']) { const { p, e } = full.world[k], { p: q, e: f } = full.world.vase; for (const ax of ['x', 'y']) { assert.ok(p[ax] >= q[ax]); assert.ok(p[ax] + e[ax] <= q[ax] + f[ax]) } }
  assert.match(overlaps(full)[0].message, /land in the same place/)

  // Parts stacked, or merely touching, are not in the same place.
  const stacked = layout([vase, part('a', 16, 1, 0.5), part('b', 16, 1, 0.5)], [floor, put('a'), { id: 'b', intent: 'place', v: 'place', k: 'b', rel: 'on', to: 'a' }])
  assert.deepEqual(overlaps(stacked), [])
})
