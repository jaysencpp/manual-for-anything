// Pencil drawings traced on a sheet: the plan from a real run (a cat drawn on an A4 sheet, 7 traced steps), its size
// as the board solver builds it, the technique's checks, and the film drawing the pencil and keeping the lines.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validatePlan } from '../src/pipeline/validate.mjs'
import { withTools } from '../src/solvers/tools.mjs'
import { solveBuild, sizeProblems } from '../src/solvers/layout.mjs'
import { program, timeline } from '../src/film/engine.mjs'
import { checkDemonstration, demonstrationDrawing, demoFraction, traceStrokes } from '../src/film/demonstrations.mjs'
import { recordingCanvas, offlineEnv } from '../scripts/offline-canvas.mjs'
import { refusedIn } from '../src/pipeline/words.mjs'

const plan = () => JSON.parse(readFileSync(new URL('./support/cat-drawing-plan.json', import.meta.url), 'utf8'))
// (the photographed sheet as segmentation found it in that run: a 196 × 277 cut-out)
const GEOMETRY = { 'paper-sheet-1': { origin: [130, 49], box: [130, 49, 196, 277], turn: 0, center: [226.3, 187.1], seat: [98, 34], base: [98, 275], ends: [[192, 275], [2, 1]], color: '#f0f0f0' } }
const SIZES = { 'paper-sheet-1': { width: 196, height: 277 } }

test('a sheet keeps its given size and lies as it says: an A4 sheet is 21 across and 29.7 deep, whichever side its cm names', () => {
  const s = plan(), { geometry, sizes } = withTools(s, GEOMETRY, SIZES, {})
  const layout = solveBuild(s, geometry, sizes)
  assert.deepEqual(sizeProblems(s, layout), [])
  const board = layout.world['paper-sheet-1']
  assert.deepEqual([board.e.x, board.e.y].sort((a, b) => a - b), [21, 29.7])
  // A sheet lies as its size says (w across, d deep), whichever side its cm names: portrait, so a traced picture is not
  // squashed. (A real run gave cm 29.7, and the solver laid the sheet along it, landscape.)
  for (const cm of [21, 29.7]) {
    s.objects[0].cm = cm
    const laid = solveBuild(s, geometry, sizes)
    assert.deepEqual(sizeProblems(s, laid), [])
    assert.deepEqual([laid.world['paper-sheet-1'].e.x, laid.world['paper-sheet-1'].e.y], [21, 29.7], `cm ${cm}`)
  }
})

test('the traced cat plan validates, and the technique refuses what it cannot draw', () => {
  const s = plan()
  assert.deepEqual(validatePlan(s).errors, [])
  const demo = s.steps[1].do[0].demo
  assert.equal(checkDemonstration(demo), null)
  assert.match(demonstrationDrawing(demo), /point01/)
  assert.match(checkDemonstration({ ...demo, strokes: [{ points: [[0.2, 0.2], [1.3, 0.2]] }] }), /fractions of the sheet/)
  assert.match(checkDemonstration({ ...demo, strokes: [{ ellipse: [0.95, 0.5, 0.1, 0.1] }] }), /leaves the sheet/)
  assert.match(checkDemonstration({ ...demo, strokes: Array.from({ length: 16 }, () => ({ ellipse: [0.5, 0.5, 0.1, 0.1] })) }), /at most 360 points/)
  assert.match(checkDemonstration({ ...demo, tool: 'paper-sheet-1' }), /distinct declared sheet and tool/)
  assert.match(checkDemonstration({ ...demo, draw: '(ctx)=>{}' }), /one supported technique/)
  // a smooth stroke is a curve through its points, its ends kept
  const [curve] = traceStrokes([{ points: [[0.1, 0.1], [0.5, 0.9], [0.9, 0.1]], smooth: true }])
  assert.deepEqual([curve.points[0], curve.points.at(-1)], [[0.1, 0.1], [0.9, 0.1]])
  assert.ok(curve.points.length > 3)

  const noPencil = plan(); noPencil.tools = [{ k: 'pencil', use: 'brush' }]
  assert.match(validatePlan(noPencil).errors.join(';'), /tracing needs a declared pencil/)
  const outside = plan(); outside.steps[1].do[0].focus.bounds = [0, 0, 0.5, 0.5]
  assert.match(validatePlan(outside).errors.join(';'), /traced strokes must stay inside the focus region/)
})

test('a fractional scene.point is read as scene.point01', () => {
  assert.equal(demoFraction([0.5, 0.337]), true)
  assert.equal(demoFraction([0, 1]), false)
  assert.equal(demoFraction([120, 40]), false)
  assert.equal(demoFraction(undefined), false)
})

test('the film draws the pencil along each stroke and keeps every finished line on the sheet', () => {
  const s = plan(), { geometry, sizes, vectors } = withTools(s, GEOMETRY, SIZES, {})
  // (a drawing of a traced state from the plan is not used: it would cover the sheet and draw the lines twice)
  s.objects[0].states[1].appearance = { width: 100, height: 100, shapes: [{ d: 'M0 0 H100 V100 H0 Z', fill: '#cc00cc', stroke: 'none' }] }
  const layout = solveBuild(s, geometry, sizes), times = timeline(s)
  const source = program({ script: s, geometry, sizes, vectors, boxes: { 'paper-sheet-1': GEOMETRY['paper-sheet-1'].box }, layout, photo: { width: 471, height: 360 } })
  assert.deepEqual(refusedIn(source), [])
  // (a sheet laid out as a board is plain paper: no wood grain)
  assert.match(source, /"plainBoard":\{"paper-sheet-1":true\}/)
  const draw = new Function(`return (${source})`)(), env = offlineEnv(), oldPath = globalThis.Path2D
  globalThis.Path2D = class {}
  try {
    const frame = (time) => { const r = recordingCanvas(); draw(r.ctx, time, env); assert.equal(r.depth(), 0, `balanced at ${time}`); return r.calls }
    for (let time = 0; time <= times.duration; time += 0.5) frame(time)
    const traces = times.acts.filter((a) => a.demo?.technique === 'trace')
    assert.equal(traces.length, 7)
    const lines = (calls) => calls.filter((c) => c.method === 'lineTo').length
    const pencil = (calls) => calls.some((c) => c.method === 'fillRect' && c.fill === '#f2c14e')
    const [head, ears] = traces
    // drawing the head: the pencil on the sheet and the circle growing behind it
    const early = frame(head.at + head.len * 0.3), late = frame(head.at + head.len * 0.8)
    assert.ok(pencil(early) && pencil(late))
    assert.ok(lines(late) > lines(early), 'the line grows as the pencil moves')
    // after it, between steps: no pencil, the head's 25-point circle still there, the plan's drawing of the state unused
    const between = frame(ears.at - 0.05)
    assert.ok(!pencil(between))
    assert.ok(lines(between) >= 24)
    assert.ok(!between.some((c) => c.fill === '#cc00cc'))
    // at the end every traced line is kept: more of them than after the head alone
    const end = frame(traces.at(-1).at + traces.at(-1).len + 0.5)
    assert.ok(lines(end) > lines(between) + 100)
  } finally { globalThis.Path2D = oldPath }
})
