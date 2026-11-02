import { physicalPlan } from './support/physical-plan.mjs'
// Parts that are not plain boxes (shapes.mjs, joints.mjs), crochet motifs (engine.mjs) and the catalogue's prism
// (thumbs.mjs): numbers checked, and the film's program run on the recording canvas. No renderer, no models.
import test from 'node:test'
import assert from 'node:assert/strict'
import { outline, solid, visible } from '../src/solvers/shapes.mjs'
import { solve, solveBuild } from '../src/solvers/layout.mjs'
import { withTools } from '../src/solvers/tools.mjs'
import { validatePlan } from '../src/pipeline/validate.mjs'
import { program, timeline } from '../src/film/engine.mjs'
import { plain } from '../src/pipeline/script.mjs'
import { refusedIn } from '../src/pipeline/words.mjs'
import { recordingCanvas, offlineEnv } from '../scripts/offline-canvas.mjs'
import { checkLook, drawThumb } from '../src/film/thumbs.mjs'

const area = (o) => Math.abs(o.reduce((n, q, i) => { const r = o[(i + 1) % o.length]; return n + q[0] * r[1] - r[0] * q[1] }, 0) / 2)

test('outlines: a taper narrows at its start, notches and angled ends cut it, corners round', () => {
  const t = outline({ taper: 0.5 }, 40, 10)
  assert.deepEqual(t, [[0, 2.5], [40, 0], [40, 10], [0, 7.5]])
  const n = outline({ notches: [{ at: 10, w: 2, d: 5, edge: 'a' }] }, 40, 10)
  assert.equal(area(n), 400 - 10)
  const e = outline({ ends: [45, 0] }, 40, 10)
  assert.ok(Math.abs(area(e) - (400 - 50)) < 1e-6)
  assert.ok(area(outline({ round: 3 }, 40, 10)) < 400 && area(outline({ round: 3 }, 40, 10)) > 390)
  // (an outline is its own points, kept inside the part)
  assert.deepEqual(outline({ outline: [[0, 0], [50, 0], [0, 20]] }, 40, 10), [[0, 0], [40, 0], [0, 10]])
})

test('a plain part as a solid shows the three faces an iso view shows of a box', () => {
  const box = { o: { L: 'x', W: 'y', T: 'z' }, e: { x: 40, y: 10, z: 2 }, p: { x: 0, y: 0, z: 0 } }
  const faces = visible(solid(box), { x: 1, y: -1, z: 1 }, (x, y, z) => [x + y, y - x - z])
  assert.deepEqual(faces.map((f) => f.kind).sort(), ['front', 'side', 'upper'])
  assert.ok(faces.every((f) => f.shaped && f.pts.length === 4))
})

// Boards from three photo objects, cut as the steps say, solved and drawn as a film's program.
function build(steps, extra = {}) {
  const m = { status: 'estimated', source: 'test' }
  const objects = ['a', 'b', 'c'].map((k, i) => ({ k: `board-${k}`, n: 'pine board', b: [i * 50, 0, 50, 20], cm: 120, w: 15, thick: 2, measurements: { cm: m, w: m, thick: m } }))
  const script = physicalPlan({ view: 'iso', title: 'Test', sub: '', tag: '', end: '', ideas: [], objects, tools: [{ k: 'saw', use: 'saw' }], steps, ...extra })
  const cut = Object.fromEntries(objects.map((o) => [o.k, { origin: [0, 0], seat: [50, 2], base: [50, 20], color: '#c8a070' }]))
  const { geometry, sizes, vectors } = withTools(script, cut, Object.fromEntries(objects.map((o) => [o.k, { width: 100, height: 20 }])), {})
  return { script, geometry, sizes, vectors }
}
const cutInto = (from, parts) => ({ t: 'Cut', c: 'Cut the parts', do: [{ v: 'place', k: from, rel: 'floor' }, { v: 'cut', k: from, with: 'saw', into: parts.map(([k, cm]) => ({ k, cm, label: `${cm} cm` })) }] })

function runs(b, layout) {
  const old = globalThis.Path2D; globalThis.Path2D = class {}
  try {
    const script = plain(b.script), source = program({ script, geometry: b.geometry, sizes: b.sizes, vectors: b.vectors, layout, boxes: {}, photo: { width: 100, height: 20 } })
    assert.deepEqual(refusedIn(source), [])
    const draw = new Function(`return (${source})`)(), times = timeline(script)
    for (const t of [...times.starts.map((s) => s + 1), times.finale - 0.5]) { const c = recordingCanvas(); draw(c.ctx, t, offlineEnv()); assert.equal(c.depth(), 0) }
  } finally { globalThis.Path2D = old }
}

test('a mitred frame: rails at their full length share the corners, each cut along the diagonal', () => {
  const b = build([cutInto('board-c', [['r1', 40], ['r2', 30], ['r3', 40]]),
    { t: 'Frame', c: 'Lay the frame', do: [{ v: 'place', k: 'r1', rel: 'floor' }, { v: 'place', k: 'r2', rel: 'end', to: 'r1', at: 'end', side: '+' }, { v: 'place', k: 'r3', rel: 'end', to: 'r2', at: 'end', side: '-' }] }],
  { view: 'plan', profiles: ['r1', 'r2', 'r3'].map((k) => ({ k, ends: ['mitre', 'mitre'] })) })
  const layout = solve(b.script, b.geometry, b.sizes), W = layout.world
  // (r2 runs over r1's end square and r3 over r2's: the outer corners meet)
  assert.equal(W.r2.p.y, W.r1.p.y); assert.equal(W.r2.p.x + W.r2.e.x, W.r1.p.x + W.r1.e.x)
  assert.equal(W.r3.p.y + W.r3.e.y, W.r2.p.y + W.r2.e.y)
  assert.deepEqual(['r1', 'r2', 'r3'].map((k) => W[k].cuts?.length || 0), [1, 2, 1])
  // (the corner square shared: half to each, on the diagonal from the outer corner to the inner one)
  const c = W.r1.cuts[0], outer = { x: W.r1.p.x + W.r1.e.x, y: W.r1.p.y }, inner = { x: W.r1.p.x + W.r1.e.x - W.r2.e.x, y: W.r1.p.y + W.r1.e.y }
  for (const q of [outer, inner]) assert.ok(Math.abs(c.n.x * q.x + c.n.y * q.y - c.d) < 1e-6)
  assert.ok(layout.boards.r1.faces.some((f) => f.shaped && f.box))
  runs(b, layout)
})

test('an A-frame: a side tilted, the other leaning on it, their tops meeting, its height as it stands', () => {
  const b = build([cutInto('board-b', [['side-a', 60], ['side-b', 60]]),
    { t: 'Stand', c: 'Lean the sides together', do: [{ v: 'place', k: 'side-a', rel: 'floor', stand: 'end', tilt: 20 }, { v: 'place', k: 'side-b', rel: 'lean', to: 'side-a' }] }])
  const layout = solveBuild(b.script, b.geometry, b.sizes)
  const tops = ['side-a', 'side-b'].map((k) => layout.turnedBox[k]), high = (q) => q.p.z + q.e.z
  assert.ok(Math.abs(high(tops[0]) - 60 * Math.cos(Math.PI / 9)) < 1.5, `stands ${high(tops[0])} cm, not 60`)
  assert.ok(Math.abs(high(tops[0]) - high(tops[1])) < 0.01)
  // (each leans the other way along the same line, the two meeting at the ridge)
  const ax = ['x', 'y'].find((a) => Math.abs(tops[0].p[a] - tops[1].p[a]) > 1)
  assert.ok(ax && tops[0].p[ax] < tops[1].p[ax] && Math.abs(tops[0].p[ax] + tops[0].e[ax] - tops[1].p[ax]) < 0.01)
  for (const q of tops) assert.ok(q.p.z > -0.01, 'nothing below the floor')
  runs(b, layout)
})

test('splayed legs turn out from the seat they carry, cut level with the floor and the seat', () => {
  const b = build([cutInto('board-c', [['seat', 36]]), cutInto('board-a', [['l1', 30], ['l2', 30]]), cutInto('board-b', [['l3', 30], ['l4', 30]]),
    { t: 'Legs', c: 'Set the seat on its legs', do: [...['l1', 'l2', 'l3', 'l4'].map((k) => ({ v: 'place', k, rel: 'floor', stand: 'end' })), { v: 'place', k: 'seat', rel: 'on', to: 'l1', also: ['l2', 'l3', 'l4'], splay: 12 }] }],
  { profiles: [{ k: 'seat', round: 4 }, ...['l1', 'l2', 'l3', 'l4'].map((k) => ({ k, taper: 0.6 }))] })
  b.script.objects.forEach((o) => { o.w = o.k === 'board-c' ? 30 : 6; o.thick = 4 })
  const layout = solveBuild(b.script, b.geometry, b.sizes), W = layout.world
  for (const leg of ['l1', 'l2', 'l3', 'l4']) {
    assert.ok(W[leg].turn, `${leg} splayed`)
    const q = layout.turnedBox[leg]
    assert.ok(Math.abs(q.p.z) < 0.01 && Math.abs(q.p.z + q.e.z - W.seat.p.z) < 0.01, `${leg} from the floor to the seat`)
    // (its foot further out from the seat's middle than its top)
    const mid = W.seat.p.x + W.seat.e.x / 2
    assert.ok(Math.abs(q.p.x + q.e.x / 2 - mid) > Math.abs(W[leg].p.x + W[leg].e.x / 2 - mid) - 0.01)
  }
  runs(b, layout)
})

test('profiles are checked: a part the steps make, a taper, ends, notches inside it', () => {
  const b = build([cutInto('board-a', [['top', 40], ['off', 80]])])
  const errors = (profiles) => validatePlan({ ...b.script, ideas: [0, 1, 2].map((i) => ({ title: `i${i}`, pitch: 'x' })), pick: 0, profiles }, null).errors.filter((e) => /profile/.test(e))
  assert.deepEqual(errors([{ k: 'top', round: 3, ends: ['mitre', 15], notches: [{ at: 5, w: 2, d: 4 }] }]), [])
  assert.equal(errors([{ k: 'nothing' }]).length, 1)
  assert.equal(errors([{ k: 'top', taper: 1.5 }]).length, 1)
  assert.equal(errors([{ k: 'top', ends: ['mitre'] }]).length, 1)
  assert.equal(errors([{ k: 'top', notches: [{ at: 39, w: 4, d: 2 }] }]).length, 1)
})

test('crochet motifs — square, hexagon, flower, four joined squares — draw at every stage with balanced state', () => {
  for (const shape of [{ shape: 'square' }, { shape: 'hexagon' }, { shape: 'flower', petals: 6 }, { shape: 'square', motifs: 4, cols: 2 }]) {
    const script = physicalPlan({ view: 'side', title: 'Motif', sub: '', tag: '', end: '', ideas: [], objects: [{ k: 'yarn', n: 'yarn ball', b: [0, 0, 40, 40], cm: 8 }, { k: 'hook', n: 'crochet hook', b: [50, 0, 5, 40], cm: 15 }],
      tools: [], makes: [{ k: 'piece', n: 'piece', size: 1.5, cm: 12, weight: 'worsted', rows: 3, start: 6, stitches: 12, colors: ['#a9c9a4', '#8fa9e8'], ...shape }],
      steps: [{ t: 'Start', c: 'Work it', do: [{ v: 'place', k: 'yarn', rel: 'floor' }, { v: 'work', k: 'piece', to: 'yarn', with: 'hook', p: 0.5 }] }, { t: 'End', c: 'Finish', do: [{ v: 'work', k: 'piece', to: 'yarn', with: 'hook', p: 1 }] }] })
    const cut = { yarn: { origin: [0, 0], seat: [20, 0], base: [20, 40], color: '#a9c9a4' }, hook: { origin: [50, 0], seat: [2, 0], base: [2, 40], color: '#c08050' } }
    const drawn = (k, w, h, fill) => ({ width: w * 4, height: h * 4, parts: [{ id: k, parent: null, pivot: [w * 2, h * 4], shapes: [{ d: `M0 0 H${w * 4} V${h * 4} H0 Z`, fill, stroke: 'none' }] }] })
    const { geometry, sizes, vectors } = withTools(script, cut, { yarn: { width: 40, height: 40 }, hook: { width: 5, height: 40 } }, { yarn: drawn('yarn', 40, 40, '#a9c9a4'), hook: drawn('hook', 5, 40, '#c08050') })
    if (shape.motifs) assert.equal(geometry.piece.piece.motifs, 4)
    runs({ script, geometry, sizes, vectors }, solve(script, geometry, sizes))
  }
})

test('the catalogue\'s prism: an outline through its box, checked and drawn', () => {
  const ok = checkLook([{ s: 'prism', p: [0, 0, 0], d: [60, 3, 70], c: '#c49a6c', o: [[0, 0], [0.2, 0], [0.5, 1]] }, { s: 'prism', p: [0, 0, 0], d: [20, 18, 1], c: '#a9b2e6', axis: 'z', o: [[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]] }])
  assert.deepEqual(ok.problems, []); assert.equal(ok.look[1].axis, 'z')
  // (an outline that encloses nothing: the plain block its box fills, noted, rather than no picture)
  const flat = checkLook([{ s: 'prism', p: [0, 0, 0], d: [1, 1, 1], c: '#000000', o: [[0, 0], [1, 1]] }])
  assert.deepEqual(flat.look.map((x) => x.s), ['box']); assert.match(flat.problems[0], /drawn as a plain block/)
  const c = recordingCanvas(); drawThumb(c.ctx, ok.look, { width: 200, height: 150 }); assert.equal(c.depth(), 0)
})
