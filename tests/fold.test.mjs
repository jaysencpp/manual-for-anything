// Folding, offline: each fold worked out exactly from the plan's references (the dart's nose symmetric, an edge onto a
// line, layers stacked and turned), the plan's errors for references that name nothing, and the paper-plane fixture's
// film played on the recording canvas. No models, no renderer.
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runFolds, checkFolds, foldLength, sheetSize } from '../src/solvers/fold.mjs'
import { validatePlan } from '../src/pipeline/validate.mjs'
import { settleOperations } from '../src/solvers/contracts.mjs'
import { readRun, filmProgram } from '../src/film/film.mjs'
import { recordingCanvas, offlineEnv } from '../scripts/offline-canvas.mjs'
import { refusedIn } from '../src/pipeline/words.mjs'

const near = (a, b, e = 0.01) => Math.abs(a - b) <= e
const sheet = (steps, size = [21, 29.7, 0.05]) => ({ objects: [{ k: 'paper', part: { family: 'sheet', size } }],
  steps: steps.map((d) => ({ do: d.map(([id, x]) => ({ id, v: 'fold', k: 'paper', ...x })) })) })
const box = (facets) => { const P = facets.flatMap((f) => f.p); return [Math.min(...P.map((q) => q[0])), Math.min(...P.map((q) => q[1])), Math.max(...P.map((q) => q[0])), Math.max(...P.map((q) => q[1]))] }
const area = (P) => Math.abs(P.reduce((s, p, i) => s + p[0] * P[(i + 1) % P.length][1] - P[(i + 1) % P.length][0] * p[1], 0)) / 2
const DART = [
  [['a1', { move: 'left edge', onto: 'right edge', unfold: true, name: 'centre crease' }]],
  [['a2', { move: 'top-left', onto: 'centre crease' }], ['a3', { move: 'top-right', onto: 'centre crease' }]],
  [['a4', { move: 'top-left edge', onto: 'centre crease' }], ['a5', { move: 'top-right edge', onto: 'centre crease' }]],
  [['a6', { move: 'left edge', onto: 'right edge', crease: 'mountain' }]],
  [['a7', { move: 'right edge', onto: 'left edge', layers: 'top' }], ['a8', { move: 'over' }], ['a9', { move: 'left edge', onto: 'right edge', layers: 'top' }]],
]

test('a dart folds exactly: the crease kept, the nose symmetric, its edges on the centre line', () => {
  const { sheets, errors } = runFolds(sheet(DART))
  assert.deepEqual(errors, [])
  const F = sheets.paper.folds
  // folded in half and unfolded: still the whole sheet, one crease down its middle
  assert.deepEqual(box(F.a1.after), [0, 0, 21, 29.7])
  assert.deepEqual(F.a1.after[0].l.map((L) => [...L].sort((p, q) => p[1] - q[1])), [[[10.5, 0], [10.5, 29.7]]])
  // each corner lands on the crease, as far down it as the half width: a 90° nose, the same both sides
  assert.deepEqual(F.a2.to, [10.5, 10.5]); assert.deepEqual(F.a3.to, [10.5, 10.5])
  assert.equal(F.a2.after.filter((f) => f.b).length, 1, 'the folded flap shows its back')
  // the slanted edges onto the crease: their middles land on it
  assert.ok(near(F.a4.to[0], 10.5) && near(F.a5.to[0], 10.5) && near(F.a4.to[1], F.a5.to[1]))
  // the sheet keeps its area through every fold (layers on layers): the flat sheet's 623.7 cm² (each corner rounded to 0.1 mm)
  for (const f of Object.values(F)) assert.ok(near(f.after.reduce((s, x) => s + area(x.p), 0), 21 * 29.7, 0.25))
  // in half along the crease: half as wide, the far half behind (mountain), the flaps still in front
  assert.deepEqual(box(F.a6.after).map((v) => +v.toFixed(2)), [10.5, 0, 21, 29.7])
  assert.equal(F.a6.mountain, true)
})

test('only the uppermost layer folds when asked; a turn over mirrors the sheet and reverses its stack', () => {
  const F = runFolds(sheet(DART)).sheets.paper.folds
  // the wing: the half in front folds over at the wing line, the half behind stays
  assert.equal(F.a7.layers, 'top')
  assert.ok(F.a7.still.length > 0 && F.a7.moving.length > 0)
  assert.deepEqual(box(F.a7.after).map((v) => +v.toFixed(2)), [10.5, 0, 21, 29.7])
  // over: the same outline mirrored about its middle, every facet's side flipped, the stack reversed
  const before = F.a7.after, after = F.a8.after
  assert.equal(after.length, before.length)
  assert.deepEqual(box(after).map((v) => +v.toFixed(2)), [10.5, 0, 21, 29.7])
  assert.equal(after.filter((f) => f.b).length, before.filter((f) => !f.b).length)
  assert.ok(near(foldLength({ move: 'over' }), 1.8) && near(foldLength({ move: 'top-left', onto: 'centre' }), 2.6) && near(foldLength({ move: 'left edge', unfold: true }), 3.0))
})

test('the other ways to name a fold: corner to corner, an edge folded in by cm, through a point, a rotation', () => {
  const { sheets, errors } = runFolds(sheet([
    [['d', { move: 'top-left', onto: 'bottom-right' }]],
  ], [20, 20, 0.05]))
  assert.deepEqual(errors, [])
  // a square folded corner to corner is a triangle
  const d = sheets.paper.folds.d
  assert.equal(d.after.length, 2); assert.ok(near(d.after.reduce((s, x) => s + area(x.p), 0), 400))
  assert.deepEqual(d.line.map((q) => q.map((v) => +v.toFixed(2))).sort(), [[0, 20], [20, 0]])
  const hem = runFolds(sheet([[['h', { move: 'bottom edge', cm: 3 }]]], [20, 30, 0.05])).sheets.paper.folds.h
  assert.deepEqual(box(hem.after).map((v) => +v.toFixed(2)), [0, 0, 20, 27])
  const through = runFolds(sheet([[['p', { move: 'top-left', onto: 'centre line', through: 'top' }]]])).sheets.paper.folds.p
  assert.deepEqual(through.to, [10.5, 10.5])
  const turned = runFolds(sheet([[['r', { move: 'rotate', deg: 90 }]]])).sheets.paper.folds.r
  // (a quarter turn about its middle: 21 × 29.7 becomes 29.7 × 21, centred where it was)
  assert.deepEqual(box(turned.after).map((v) => +v.toFixed(2)), [-4.35, 4.35, 25.35, 25.35])
})

test('a part cut from a sheet is a sheet: as wide as its stock, as long as its cut', () => {
  // (a snowflake's plan cut a 21 cm square off A4 and folded it: every fold was refused as not a sheet)
  const script = { objects: [{ k: 'paper', part: { family: 'sheet', size: [21, 29.7, 0.05] } }], steps: [
    { do: [{ id: 'c', v: 'cut', k: 'paper', into: [{ k: 'square', cm: 21, label: '21 cm' }, { k: 'offcut', cm: 8.7, label: '8.7 cm' }] }] },
    { do: [{ id: 'f', v: 'fold', k: 'square', move: 'top-left', onto: 'bottom-right' }] }] }
  const { sheets, errors } = runFolds(script)
  assert.deepEqual(errors, []); assert.deepEqual([sheets.square.w, sheets.square.d], [21, 21])
  assert.equal(sheets.square.folds.f.after.length, 2)
  assert.match(checkFolds({ ...script, steps: [{ do: [{ id: 'f', v: 'fold', k: 'nothing', move: 'top', onto: 'bottom' }] }] }).join(), /or a part cut from one/)
})

test('a plan whose folds name nothing on the sheet, or move none or all of it, is sent back', () => {
  assert.match(checkFolds(sheet([[['x', { move: 'nose', onto: 'centre line' }]]])).join(), /x\): "nose" is not a place on the sheet/)
  assert.match(checkFolds(sheet([[['x', { move: 'left edge', onto: 'left edge' }]]])).join(), /already on/)
  assert.match(checkFolds(sheet([[['x', { move: 'top-left' }]]])).join(), /needs "onto"/)
  assert.match(checkFolds({ objects: [], steps: [{ do: [{ id: 'x', v: 'fold', k: 'ghost', move: 'top', onto: 'bottom' }] }] }).join(), /one sheet/)
  // a later fold can name a crease an earlier one made; an unknown one is an error, not a guess
  assert.deepEqual(checkFolds(sheet([[['a', { move: 'left edge', onto: 'right edge', unfold: true, name: 'spine' }], ['b', { move: 'top-left', onto: 'spine' }]]])), [])
  assert.match(checkFolds(sheet([[['b', { move: 'top-left edge', onto: 'spine crease' }]]])).join(), /b\)/)
})

test('the paper-plane fixture validates, a fold-only plan is seen from above, a sheet without a size gets one', () => {
  const script = JSON.parse(readFileSync(new URL('../examples/fixtures/paper-plane/script.json', import.meta.url), 'utf8'))
  const result = validatePlan(script)
  assert.deepEqual(result.errors, [])
  const side = structuredClone(script); side.view = 'side'; delete side.objects[0].part
  const notes = settleOperations(side)
  assert.equal(side.view, 'plan')
  assert.deepEqual(side.objects[0].part.size.slice(0, 2), sheetSize({ cm: script.objects[0].cm }))
  assert.ok(notes.some((n) => /view plan/.test(n)) && notes.some((n) => /folded, so a sheet/.test(n)))
})

test('the paper-plane film plays: flaps turn about their fold lines, marks then a still beat, the panel from the same facets', () => {
  const run = readRun(fileURLToPath(new URL('../examples/fixtures/paper-plane', import.meta.url)))
  const screens = Object.fromEntries(Object.entries(run.screens).map(([k, s]) => [k, { width: s.width, height: s.height, regions: s.regions || [] }]))
  const old = globalThis.Path2D; globalThis.Path2D = class {}
  try {
    const { source, duration } = filmProgram(run, { name: 'replay' })
    assert.deepEqual(refusedIn(source), [])
    const draw = new Function(`return (${source})`)(), env = { ...offlineEnv(), screens }
    for (let time = 0; time <= duration; time += 0.25) {
      const { ctx, depth } = recordingCanvas(); draw(ctx, time, env); assert.equal(depth(), 0, `balanced at ${time}`)
    }
    const act = run.times.acts.find((a) => a.id === 'a3')
    // announced: the dashed fold line comes in before the flap moves
    const early = recordingCanvas(); draw(early.ctx, act.at + act.len * 0.15, env)
    assert.ok(early.calls.some((c) => c.method === 'setLineDash' && c.args[0].length === 2 && c.args[0][0] > 0))
    // mid-fold the flap's back shows, a shade darker; held still after it lands (nothing differs between two late frames)
    const mid = recordingCanvas(); draw(mid.ctx, act.at + act.len * 0.55, env)
    const late = [act.at + act.len * 0.9, act.at + act.len * 0.97].map((time) => { const r = recordingCanvas(); draw(r.ctx, time, env); return JSON.stringify(r.calls) })
    assert.equal(late[0], late[1], 'the beat after a fold is still')
    assert.notEqual(JSON.stringify(mid.calls), late[0])
    // the step's panel is the engine's own, from the solver's facets
    assert.match(source, new RegExp(`"${act.step}":\\{"k":"paper-sheet","before":`))
  } finally { globalThis.Path2D = old }
})

// A six-pointed snowflake from a 20 cm square: diagonal, in half, thirds at 30°, three cuts, opened out.
const SNOWFLAKE = [
  ['s1', { move: 'top-right', onto: 'bottom-left' }], ['s2', { move: 'top-left', onto: 'bottom-right' }],
  ['s3', { move: 'top-right edge', through: 'top', deg: 30 }], ['s4', { move: 'top-left edge', through: 'top', deg: 30 }],
  ['c1', { move: 'cut', shape: [[-0.1, 0.8], [1.1, 0.8], [1.1, 1.1], [-0.1, 1.1]] }],
  ['c2', { move: 'cut', shape: [[-0.1, 0.35], [0.45, 0.5], [-0.1, 0.65]] }],
  ['c3', { move: 'cut', shape: [[0.55, 0.55], [0.75, 0.62], [0.55, 0.7]] }],
  ['o', { move: 'open' }],
]
const covers = (facets, [x, y]) => facets.some((f) => f.p.every((a, i) => { const b = f.p[(i + 1) % f.p.length]; return (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) >= -1e-9 })
  || f.p.every((a, i) => { const b = f.p[(i + 1) % f.p.length]; return (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) <= 1e-9 }))

test('a snowflake: folded to a 30° wedge, cut through every layer, opened out mirrored about every fold', () => {
  const { sheets, errors } = runFolds(sheet([SNOWFLAKE], [20, 20, 0.05]))
  assert.deepEqual(errors, [])
  const F = sheets.paper.folds
  // thirds about the apex: a wedge whose point is 30°
  const apex = [10, 10], P = F.s4.after.flatMap((f) => f.p), far = P.filter((q) => Math.hypot(q[0] - apex[0], q[1] - apex[1]) > 13)
  const angles = far.map((q) => Math.atan2(q[0] - apex[0], q[1] - apex[1]) * 180 / Math.PI)
  assert.ok(near(Math.max(...angles) - Math.min(...angles), 30, 0.2), `wedge ${Math.max(...angles) - Math.min(...angles)}°`)
  // each cut takes from every layer under it; the paper left keeps its area minus what was cut
  assert.ok(F.c1.moving.length >= 8 && F.c2.moving.length > 0 && F.c3.moving.length > 0)
  // opened: the square again, each fold undone in turn, and the cuts repeated as mirror images across every fold line
  const flat = F.o.after
  // (back where the flat square lay — inside its 20 × 20, the trimmed points nearly as wide — all of it front up)
  const [bx0, by0, bx1, by1] = box(flat)
  assert.ok(bx0 >= -0.01 && by0 >= -0.01 && bx1 <= 20.01 && by1 <= 20.01 && bx1 - bx0 > 18 && by1 - by0 > 18, `opened box ${box(flat)}`)
  assert.equal(F.o.subs.length, 4)
  assert.ok(flat.every((f) => !f.b), 'all of it front up again')
  const mirrors = [([x, y]) => [y, x], ([x, y]) => [20 - y, 20 - x]]
  let checked = 0, differ = 0
  for (let i = 1; i < 60; i++) for (let j = 1; j < 60; j++) {
    const q = [i / 3, j / 3], here = covers(flat, q)
    for (const m of mirrors) { checked++; if (here !== covers(flat, m(q))) differ++ }
  }
  assert.ok(differ / checked < 0.01, `${differ} of ${checked} sample points differ from their mirror image`)
  // creases radiate from the middle; the seams the cuts left inside each layer are not drawn as edges
  assert.ok(flat.reduce((n, f) => n + f.l.length, 0) >= 12)
  const edges = F.c3.after.reduce((n, f) => n + f.p.length, 0), strokes = F.c3.after.reduce((n, f) => n + f.s.length, 0)
  assert.ok(strokes < edges, 'seams between pieces of one layer are left unstroked')
})

test('cuts and openings that cannot be done are sent back', () => {
  assert.match(checkFolds(sheet([[['o', { move: 'open' }]]])).join(), /nothing to open/)
  assert.match(checkFolds(sheet([[['f', { move: 'top-left', onto: 'bottom-right' }], ['c', { move: 'cut', shape: [[2, 2], [3, 2], [3, 3]] }]]])).join(), /fractions of the folded sheet's box/)
  assert.match(checkFolds(sheet([[['c', { move: 'cut', shape: [[0, 0]] }]]])).join(), /3 to 24 points/)
  assert.match(checkFolds(sheet([[['c', { move: 'cut', shape: [[-0.2, -0.2], [1.2, -0.2], [1.2, 1.2], [-0.2, 1.2]] }]]])).join(), /whole sheet/)
  assert.match(checkFolds(sheet([[['a', { move: 'left edge', through: 'top', deg: 200 }]]])).join(), /between 0 and 180/)
  // a cut with a shape, as a planner writes it, is settled into the sheet's folds
  const script = sheet([[['f', { move: 'top-left', onto: 'bottom-right' }]]])
  script.steps[0].do.push({ id: 'c', v: 'cut', k: 'paper', with: 'scissors', shape: [[0, 0.5], [0.5, 0.5], [0, 1]] })
  assert.deepEqual(checkFolds(script), [])
  settleOperations(script)
  assert.deepEqual([script.steps[0].do[1].v, script.steps[0].do[1].move], ['fold', 'cut'])
  assert.ok(near(foldLength({ v: 'cut', shape: [] }), 1.8))
})

test('the snowflake film plays: a cut drops away, the opening turns its folds back one by one', () => {
  const run = readRun(fileURLToPath(new URL('../examples/fixtures/paper-snowflake', import.meta.url)))
  const screens = Object.fromEntries(Object.entries(run.screens).map(([k, s]) => [k, { width: s.width, height: s.height, regions: s.regions || [] }]))
  const old = globalThis.Path2D; globalThis.Path2D = class {}
  try {
    const { source, duration } = filmProgram(run, { name: 'replay' })
    assert.deepEqual(refusedIn(source), [])
    const draw = new Function(`return (${source})`)(), env = { ...offlineEnv(), screens }
    for (let time = 0; time <= duration; time += 0.25) {
      const { ctx, depth } = recordingCanvas(); draw(ctx, time, env); assert.equal(depth(), 0, `balanced at ${time}`)
    }
    const spread = run.times.acts.find((a) => a.id === 'a10'), cut = run.times.acts.find((a) => a.id === 'a7')
    // (an opening's length grows with the folds it undoes: four here)
    assert.ok(near(spread.len, 1.2 + 0.75 * 4))
    const frames = [0.3, 0.5, 0.7].map((u) => { const r = recordingCanvas(); draw(r.ctx, spread.at + spread.len * u, env); return JSON.stringify(r.calls) })
    assert.equal(new Set(frames).size, 3, 'the sheet moves through the opening')
    const marked = recordingCanvas(); draw(marked.ctx, cut.at + cut.len * 0.12, env)
    assert.ok(marked.calls.some((c) => c.method === 'setLineDash' && c.args[0].length === 2), 'the cut is marked before it is made')
  } finally { globalThis.Path2D = old }
})

test('a film carries a folded sheet within its bound; a plan whose cuts would not fit is sent back', async () => {
  const { MAX_CORNERS, cornersOf } = await import('../src/solvers/fold.mjs')
  // (a snowflake plan's program came out at 422 070 characters, over the player's 400 000: it never started)
  const run = readRun(fileURLToPath(new URL('../examples/fixtures/paper-snowflake', import.meta.url)))
  const old = globalThis.Path2D; globalThis.Path2D = class {}
  try { assert.ok(filmProgram(run, { name: 'replay' }).source.length < 300000) } finally { globalThis.Path2D = old }
  const snow = runFolds(sheet([SNOWFLAKE], [20, 20, 0.05])).sheets.paper
  assert.ok(cornersOf(snow) < MAX_CORNERS / 2)
  // many fine cuts through the wedge: too many pieces, refused with what to do
  const cuts = Array.from({ length: 30 }, (_, i) => [`x${i}`, { move: 'cut', shape: [[-0.1, 0.1 + i * 0.025], [0.3 + (i % 3) * 0.1, 0.11 + i * 0.025], [-0.1, 0.12 + i * 0.025]] }])
  const many = sheet([[...SNOWFLAKE.slice(0, 4), ...cuts, ['o', { move: 'open' }]]], [20, 20, 0.05])
  assert.match(checkFolds(many).join(), /too many pieces for the film to carry/)
})
