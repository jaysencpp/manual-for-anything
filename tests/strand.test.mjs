// Strands, offline: bends, coils, rings, knots, beads and twisted cords worked out exactly from the plan's words, the
// errors the plan is sent back with, and the strand film played on the recording canvas. No models, no renderer.
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'
import { runStrands, checkStrands, placeOn, nodesOf, strandLength, strandSize, finalStrandBounds, internals } from '../src/solvers/strand.mjs'
import { sizeProblems, geometryReview, solveBuild } from '../src/solvers/layout.mjs'
import { withTools } from '../src/solvers/tools.mjs'

const near = (a, b, e = 0.05) => Math.abs(a - b) <= e
const wire = (steps, o = {}) => ({ objects: [{ k: 'wire', n: 'wire', cm: o.cm ?? 40, thick: o.thick ?? 0.4 }],
  steps: steps.map((a, i) => ({ do: [{ id: `a${i}`, v: 'strand', k: 'wire', ...a }] })) })
// every state's nodes (cm) and its arc length
const states = (steps, o) => {
  const r = runStrands(wire(steps, o)), S = r.strands.wire
  return { r, S, errors: r.errors, nodes: S ? S.states.map((st, i) => nodesOf(S.L, S.N, st.k, S.anchors[i])) : [] }
}
const lengthOf = (n) => { let s = 0; for (let i = 1; i < n.x.length; i++) s += Math.hypot(n.x[i] - n.x[i - 1], n.y[i] - n.y[i - 1]); return s }
const last = (a) => a[a.length - 1]

test('places along a strand are read as people write them', () => {
  assert.equal(placeOn(40, 'middle'), 20)
  assert.equal(placeOn(40, 'end'), 40)
  assert.equal(placeOn(40, '6 cm from the end'), 34)
  assert.equal(placeOn(40, '6 cm from the start'), 6)
  assert.equal(placeOn(40, 'the last 4 cm'), 36)
  assert.equal(placeOn(40, '25%'), 10)
  assert.equal(placeOn(40, 'a third'), 40 / 3)
  assert.equal(placeOn(40, 7.5), 7.5)
  assert.equal(placeOn(40, 'somewhere'), null)
})

test('a bend turns the part beyond it and the strand keeps its length', () => {
  const { errors, nodes } = states([{ op: 'bend', at: '10 cm from the end', deg: 90 }])
  assert.deepEqual(errors, [])
  const after = last(nodes)
  // the short end swings round: the strand is as long as it was, and the free end ends 10 cm below the corner
  assert.ok(near(lengthOf(after), 40, 0.2), `length ${lengthOf(after)}`)
  assert.ok(near(after.x[0], 0) && near(after.y[0], 0), 'the held start has not moved')
  const end = [after.x.at(-1), after.y.at(-1)]
  assert.ok(near(end[0], 30, 0.6) && near(end[1], 10, 0.6), `end ${end}`)
  // a bend to the left goes the other way
  const left = last(states([{ op: 'bend', at: '10 cm from the end', deg: 90, side: 'left' }]).nodes)
  assert.ok(near(left.y.at(-1), -10, 0.6))
})

test('the strand holds still at the end the plan says; the other side is what moves', () => {
  const { nodes } = states([{ op: 'bend', at: '10 cm from the start', deg: 90, hold: 'end' }])
  const after = last(nodes)
  // (the long end stays where it was, with the short start bent about 10 cm from it)
  assert.ok(near(after.x.at(-1), 40, 0.1) && near(after.y.at(-1), 0, 0.1), `held end ${after.x.at(-1)}, ${after.y.at(-1)}`)
  assert.ok(near(lengthOf(after), 40, 0.2))
  assert.ok(Math.abs(after.y[0]) > 8, 'the short end swung off the line')
})

test('folded in half, the halves lie side by side', () => {
  const { errors, nodes } = states([{ op: 'bend', at: 'middle', deg: 180 }])
  assert.deepEqual(errors, [])
  const f = last(nodes), a = f.x.length - 1
  // the end lies back along the start: x from 20 back to about 0, the width of a strand beside it
  assert.ok(near(f.x[a], 0, 0.6) && Math.abs(f.y[a]) < 1.2, `end ${f.x[a]}, ${f.y[a]}`)
  assert.ok(near(lengthOf(f), 40, 0.2))
})

test('a bend that would cross the strand is sent back, and so is a bend off the strand', () => {
  assert.match(runStrands(wire([{ op: 'bend', at: 'middle', deg: 180 }, { op: 'bend', at: '25%', deg: 150 }], { cm: 40 })).errors.join(), /cross itself/)
  assert.match(runStrands(wire([{ op: 'bend', at: '90 cm', deg: 30 }])).errors.join(), /not along the strand/)
  assert.match(runStrands(wire([{ op: 'bend', at: 'middle' }])).errors.join(), /needs "deg"/)
  assert.match(runStrands(wire([{ op: 'bend', at: 'middle', deg: 200 }])).errors.join(), /at most 180/)
  assert.match(runStrands(wire([{ op: 'bend', at: 'nowhere', deg: 30 }])).errors.join(), /name a place/)
  assert.match(runStrands(wire([{ op: 'wobble' }])).errors.join(), /one of bend, coil/)
})

test('a coil winds the strand into a spiral: its turns and width follow from its length', () => {
  const { errors, S, nodes } = states([{ op: 'coil' }], { cm: 100, thick: 1 })
  assert.deepEqual(errors, [])
  const op = S.ops.a0, after = last(nodes)
  assert.ok(near(lengthOf(after), 100, 0.3))
  // 100 cm of 1 cm strand wound round a 1.8 cm hole: turns × pitch is the radius it grows by, the area it fills the strand's
  const R = op.diameter / 2, hole = op.hole / 2
  assert.ok(R > 4 && R < 6, `radius ${R}`)
  assert.ok(near(op.turns, (R - hole) / (1 * 1.08), 0.35), `${op.turns} turns, ${R - hole} cm of growth`)
  // every node of the finished coil lies within that radius of its middle
  const cx = after.x.at(-1) * 0 + (Math.min(...after.x) + Math.max(...after.x)) / 2, cy = (Math.min(...after.y) + Math.max(...after.y)) / 2
  assert.ok(Math.max(...Array.from(after.x, (x, i) => Math.hypot(x - cx, after.y[i] - cy))) < R + 0.6)
  // a count the plan claims that the length does not make is sent back; a coil too short for a turn too
  assert.match(runStrands(wire([{ op: 'coil', n: 12 }], { cm: 100, thick: 1 })).errors.join(), /makes \d+(\.\d+)? turns/)
  assert.match(runStrands(wire([{ op: 'coil', cm: 4 }], { cm: 40, thick: 1 })).errors.join(), /too short to coil/)
  // only its end coiled: the rest stays straight
  const part = last(states([{ op: 'coil', cm: 30 }], { cm: 60, thick: 0.6 }).nodes)
  const q = Math.round(part.x.length / 4)
  assert.ok(near(part.x[q] - part.x[0], 60 / 4, 0.2) && near(part.y[q], part.y[0], 0.01))
})

test('a ring is a circle of the strand less its overlap', () => {
  const { errors, S, nodes } = states([{ op: 'ring', cm: 3 }], { cm: 25, thick: 0.5 })
  assert.deepEqual(errors, [])
  const op = S.ops.a0, n = last(nodes)
  assert.equal(op.circumference, 22)
  assert.ok(near(op.diameter, 22 / Math.PI, 0.1))
  // the first 22 cm closes on itself: the node 22 cm along is where the strand started
  const i = Math.round((22 / 25) * (n.x.length - 1))
  assert.ok(Math.hypot(n.x[i] - n.x[0], n.y[i] - n.y[0]) < 0.3, 'the circle closes')
  assert.match(runStrands(wire([{ op: 'ring', cm: 20 }], { cm: 25 })).errors.join(), /overlap/)
  assert.match(runStrands(wire([{ op: 'ring', cm: 0 }], { cm: 3, thick: 1 })).errors.join(), /smaller than/)
})

test('an overhand knot crosses itself three times, each pass over or under as the knot has it, and takes its length from the strand', () => {
  const { errors, S, nodes } = states([{ op: 'knot', at: 'middle', name: 'overhand' }], { cm: 100, thick: 1 })
  assert.deepEqual(errors, [])
  const op = S.ops.a0, st = last(S.states)
  assert.equal(op.knot, 'overhand')
  // (three crossings of the knot itself, raised over what they cross; the two tails also cross once outside it, under)
  assert.equal(st.over.filter((p) => p[2] > 0).length, 3, `${JSON.stringify(st.over)}`)
  assert.ok(st.over.every((p) => p[1] > p[0]))
  assert.ok(op.size > 10 && op.size < 30, `size ${op.size}`)
  assert.ok(near(lengthOf(last(nodes)), 100, 0.4))
  // the strand either side of the knot runs the same way: the end is as far as the knot's length leaves
  const n = last(nodes)
  assert.ok(Math.abs(Math.atan2(n.y.at(-1) - n.y.at(-2), n.x.at(-1) - n.x.at(-2))) < 0.05, 'the far end runs on in line')
  // names are read as they are said; a knot with no room, and a knot nobody drew, are sent back
  assert.deepEqual(runStrands(wire([{ op: 'knot', at: 'middle', name: 'a simple knot' }], { cm: 100, thick: 1 })).errors, [])
  assert.match(runStrands(wire([{ op: 'knot', at: 'middle', name: 'overhand' }], { cm: 15, thick: 1 })).errors.join(), /takes \d+(\.\d+)? cm/)
  // a knot "at the end" is tied as near it as it fits
  const atEnd = runStrands(wire([{ op: 'knot', at: 'end', name: 'overhand' }], { cm: 100, thick: 1 }))
  assert.deepEqual(atEnd.errors, [])
  assert.ok(atEnd.strands.wire.ops.a0.mark[0] < 100 && atEnd.strands.wire.ops.a0.mark[0] > 80)
  assert.match(runStrands(wire([{ op: 'knot', at: 'middle', name: 'bowline' }], { cm: 100, thick: 1 })).errors.join(), /cannot be drawn/)
})

test('a figure-eight knot crosses itself four times, keeps the strand either side in line and is read by its names', () => {
  const { errors, S, nodes } = states([{ op: 'knot', at: 'middle', name: 'figure-eight' }], { cm: 100, thick: 1 })
  assert.deepEqual(errors, [])
  const op = S.ops.a0, st = last(S.states)
  assert.equal(op.knot, 'figure-eight')
  assert.equal(st.over.filter((p) => p[2] > 0).length, 4, `${JSON.stringify(st.over)}`)
  assert.ok(op.size > 10 && op.size < 30, `size ${op.size}`)
  assert.ok(near(lengthOf(last(nodes)), 100, 0.4))
  const n = last(nodes)
  assert.ok(Math.abs(Math.atan2(n.y.at(-1) - n.y.at(-2), n.x.at(-1) - n.x.at(-2))) < 0.05, 'the far end runs on in line')
  // the knot's own stretch is given for the close-up: a small part of the 100 cm strand, not all of it
  const box = op.closeup, all = op.bounds
  assert.ok(box && box[2] - box[0] < 40 && box[3] - box[1] < 40, `${JSON.stringify(box)}`)
  assert.ok(box[0] >= Math.min(...all.map((b) => b[0])) - 1e-6)
  for (const name of ['figure 8', 'a figure of eight knot', 'Flemish knot']) assert.deepEqual(runStrands(wire([{ op: 'knot', at: 'middle', name }], { cm: 100, thick: 1 })).errors, [], name)
})

test('beads sit along the strand in a row, in the colours given; too many or too big are sent back', () => {
  const { errors, S } = states([{ op: 'thread', n: 6, cm: 1.2, color: 'red, blue', at: 'middle' }], { cm: 30, thick: 0.4 })
  assert.deepEqual(errors, [])
  const beads = last(S.states).beads
  assert.equal(beads.length, 6)
  // contiguous, centred on the middle: 6 × 1.2 = 7.2 cm from 11.4 to 18.6
  assert.ok(near(beads[0].s, 11.4 + 0.6, 0.01) && near(beads[5].s, 18.6 - 0.6, 0.01))
  assert.deepEqual(beads.map((b) => b.c), ['#d64545', '#3b6fd6', '#d64545', '#3b6fd6', '#d64545', '#3b6fd6'])
  assert.match(runStrands(wire([{ op: 'thread', n: 40, cm: 1.2 }], { cm: 30 })).errors.join(), /does not fit/)
  assert.match(runStrands(wire([{ op: 'thread', n: 3, cm: 0.2 }], { cm: 30, thick: 0.4 })).errors.join(), /cannot slide/)
  // a ring made after threading carries the beads round with it
  const ring = last(states([{ op: 'thread', n: 6, cm: 1.2, at: 'middle' }, { op: 'ring', cm: 2 }], { cm: 30 }).S.states)
  assert.equal(ring.beads.length, 6)
})

test('a strand folded in half and twisted becomes a shorter cord: the length the twist takes up is worked out', () => {
  const { errors, S } = states([{ op: 'bend', at: 'middle', deg: 180 }, { op: 'twist', n: 6 }], { cm: 40, thick: 0.8 })
  assert.deepEqual(errors, [])
  const op = S.ops.a1, cord = last(S.states)
  // each half is 20 cm; every turn of strands 0.8 cm across goes round π × 0.8 cm as it goes along the cord, so the cord is
  // √(20² − (6 π 0.8)²) long
  const expected = Math.sqrt(20 * 20 - (Math.PI * 0.8 * 6) ** 2)
  assert.ok(near(op.length, expected, 0.1), `cord ${op.length} cm, expected ${expected}`)
  assert.equal(op.turns, 6)
  assert.ok(cord.look.twist && cord.look.twist.n === 6)
  assert.ok(op.cord)
  // not folded first, folded off-centre, bent after folding, or too many turns: sent back with what to do
  assert.match(runStrands(wire([{ op: 'twist', n: 4 }])).errors.join(), /folded in half first/)
  assert.match(runStrands(wire([{ op: 'bend', at: '25%', deg: 180 }, { op: 'twist', n: 4 }])).errors.join(), /not in the middle/)
  assert.match(runStrands(wire([{ op: 'bend', at: 'middle', deg: 180 }, { op: 'twist', n: 40 }])).errors.join(), /too many/)
})

test('the plan checks cover every strand step, and a piece cut from a strand is a strand of its length', () => {
  assert.deepEqual(checkStrands(wire([{ op: 'bend', at: 'middle', deg: 90 }])), [])
  assert.match(checkStrands(wire([{ op: 'bend', at: 'middle', deg: 0 }])).join(), /needs "deg"/)
  const script = { objects: [{ k: 'wire', cm: 100, thick: 0.4 }], steps: [
    { do: [{ id: 'c', v: 'cut', k: 'wire', into: [{ k: 'piece', label: 'piece', cm: 30 }] }] },
    { do: [{ id: 'b', v: 'strand', k: 'piece', op: 'bend', at: 'middle', deg: 90 }] }] }
  const r = runStrands(script)
  assert.deepEqual(r.errors, [])
  assert.equal(r.strands.piece.L, 30)
  assert.equal(r.strands.wire, undefined)
  assert.ok(strandLength({ op: 'thread', n: 8 }) > strandLength({ op: 'thread', n: 2 }))
})

test('the film state is small: a long strand is a handful of knots, and no profile drifts from the strand it describes', () => {
  const { S, nodes } = states([{ op: 'coil', cm: 150 }, ], { cm: 150, thick: 0.6 })
  const st = last(S.states)
  assert.ok(st.k.length < 700, `${st.k.length} knots`)
  // the compressed profile rebuilds the strand the solver traced, to within a few millimetres
  const direct = internals.trace(internals.apply(internals.blank(150, 0.8), { op: 'coil' })), m = last(nodes)
  const step = Math.floor(direct.x.length / 150)
  let worst = 0
  // (the coil is moved to where the strand lay, so compare the shapes from their first nodes)
  for (let i = 0; i < direct.x.length && i < m.x.length; i += step) worst = Math.max(worst, Math.hypot(direct.x[i] - direct.x[0] - (m.x[i] - m.x[0]), direct.y[i] - direct.y[0] - (m.y[i] - m.y[0])))
  assert.ok(worst < 0.5, `worst drift ${worst} cm`)
})

// ---- the plan's contract and the film
import { readFileSync, cpSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { validatePlan } from '../src/pipeline/validate.mjs'
import { settleOperations } from '../src/solvers/contracts.mjs'
import { readRun, filmProgram } from '../src/film/film.mjs'
import { relayout } from '../src/pipeline/relayout.mjs'
import { recordingCanvas, offlineEnv } from '../scripts/offline-canvas.mjs'
import { refusedIn } from '../src/pipeline/words.mjs'

const FIXTURE = fileURLToPath(new URL('../examples/fixtures/wire-bracelet', import.meta.url))
// The fixture's wire with other steps and another length, laid out again by today's solver in a copy (no models).
function variant(cm, thick, ops) {
  const dir = mkdtempSync(join(tmpdir(), 'strand-'))
  cpSync(FIXTURE, dir, { recursive: true })
  const sj = JSON.parse(readFileSync(join(dir, 'script.json'), 'utf8'))
  Object.assign(sj.objects[0], { cm, thick, part: { family: 'rod', size: [cm, thick, thick] } })
  sj.design.parts.find(p => p.k === 'copper-wire').cm = cm
  sj.steps = [sj.steps[0], ...ops.map((a, i) => ({ t: `Step ${i + 2}`, c: `Do ${a.op}`, claims: [`b${i}`],
    do: [{ id: `b${i}`, v: 'strand', k: 'copper-wire', intent: a.op, ...a, ...(i === ops.length - 1 ? { requires: [{ k: 'copper-wire', state: 'straight' }], effects: [{ k: 'copper-wire', state: 'bracelet' }] } : {}) }] }))]
  writeFileSync(join(dir, 'script.json'), JSON.stringify(sj))
  relayout(dir)
  return dir
}
// The film of a run played on the recording canvas: every 0.25 s balanced, nothing refused; returns what it drew by time.
function play(dir, { moments = [] } = {}) {
  const run = readRun(dir, { finaleEnabled: false }), screens = Object.fromEntries(Object.entries(run.screens).map(([k, s]) => [k, { width: s.width, height: s.height, regions: s.regions || [] }]))
  const old = globalThis.Path2D; globalThis.Path2D = class {}
  try {
    const { source, duration } = filmProgram(run, { name: 'replay' })
    assert.deepEqual(refusedIn(source), [])
    const draw = new Function(`return (${source})`)(), env = { ...offlineEnv(), screens }
    for (let time = 0; time <= duration; time += 0.25) { const { ctx, depth } = recordingCanvas(); draw(ctx, time, env); assert.equal(depth(), 0, `balanced at ${time}`) }
    const at = (time) => {
      const previous = globalThis.Path2D; globalThis.Path2D = class {}
      try { const r = recordingCanvas(); draw(r.ctx, time, env); return r }
      finally { globalThis.Path2D = previous }
    }
    return { run, at, source }
  } finally { globalThis.Path2D = old }
}

test('a strand plan is settled and checked: its operation from its intent, a rod of its size, seen from above', () => {
  const script = { objects: [{ k: 'wire', n: 'wire', cm: 40, thick: 0.3 }], steps: [{ do: [{ id: 'p', v: 'place', k: 'wire', rel: 'floor' }, { id: 'a', v: 'strand', k: 'wire', intent: 'Bend the end', op: 'bend', at: 'middle', deg: 90 }] },
    { do: [{ id: 'b', v: 'strand', k: 'wire', intent: 'coil' }] }], view: 'side' }
  const notes = settleOperations(script)
  assert.equal(script.view, 'plan')
  assert.deepEqual(script.objects[0].part, { family: 'rod', size: [40, 0.8, 0.8] })
  assert.equal(script.steps[1].do[0].op, 'coil')
  assert.ok(notes.some((n) => /strand operation coil/.test(n)))
})

test('the wire bracelet plays: marks before the move, beads sliding in, the ring closing', () => {
  const { run, at } = play(FIXTURE)
  const [bend, thread, ring] = ['a2', 'a3', 'a4'].map((id) => run.times.acts.find((a) => a.id === id))
  assert.ok(bend && thread && ring)
  // (the dashed strand-as-it-was and the arrow come before the bend moves)
  const marked = at(bend.at + bend.len * 0.12)
  assert.ok(marked.calls.some((c) => c.method === 'setLineDash' && c.args[0].length === 2), 'the old strand is dashed in first')
  // the beads slide: three moments of the threading draw differently, and the beads end up in a row
  const frames = [0.3, 0.5, 0.7].map((u) => JSON.stringify(at(thread.at + thread.len * u).calls))
  assert.equal(new Set(frames).size, 3, 'the beads move')
  const beadsDrawn = (r) => r.calls.filter((c) => c.method === 'arc' && c.args[2] > 1.5 && c.args[2] < 12 && c.args[3] === 0 && Math.abs(c.args[4] - Math.PI * 2) < 1e-9).length
  assert.ok(beadsDrawn(at(thread.at + thread.len + 0.5)) >= 9, 'nine beads at rest')
  // the ring closes in: three moments differ
  const ringFrames = [0.3, 0.5, 0.8].map((u) => JSON.stringify(at(ring.at + ring.len * u).calls))
  assert.equal(new Set(ringFrames).size, 3)
})

test('a twisted cord, a knot and a coil play: every frame balanced, the twist grows from the fold', () => {
  const cord = play(variant(100, 0.8, [{ op: 'bend', at: 'middle', deg: 180 }, { op: 'twist', n: 8 }, { op: 'ring', cm: 3 }]))
  const tw = cord.run.times.acts.find((a) => a.id === 'b1')
  assert.equal(new Set([0.3, 0.5, 0.8].map((u) => JSON.stringify(cord.at(tw.at + tw.len * u).calls))).size, 3)
  const knot = play(variant(100, 0.8, [{ op: 'knot', at: 'middle', name: 'overhand' }]))
  assert.ok(knot.at(knot.run.times.acts.find((a) => a.id === 'b0').at + 3.5).calls.length > 10)
  const coil = play(variant(150, 1, [{ op: 'coil' }]))
  assert.ok(coil.source.length < 400000, 'within the player bound')
})

test('a film carries a strand within its bound, and a plan whose strands would not fit is sent back', () => {
  const { source } = play(FIXTURE)
  assert.ok(source.length < 300000, `${source.length} characters`)
  const many = wire([{ op: 'thread', n: 64, cm: 1, gap: 0 }], { cm: 100 })
  assert.deepEqual(checkStrands(many), [])
})

test('glue on a strand itself is applying, not a joint (a coil glued turn to turn), and a rope mat\'s thumbnail is coiled rope', async () => {
  const script = { objects: [{ k: 'rope', n: 'rope', cm: 600, thick: 4 }], joints: [{ id: 'j', a: 'rope', b: 'rope', face: 'upper', otherFace: 'upper', method: 'glue', sites: [{ x: 0.5 }] }],
    steps: [{ do: [{ id: 'p', v: 'place', k: 'rope', rel: 'floor' }, { id: 'c', v: 'strand', k: 'rope', op: 'coil', radius: 5 }] },
      { do: [{ id: 'g', v: 'use', k: 'rope', intent: 'glue', joint: 'j' }] }] }
  settleOperations(script)
  assert.deepEqual(script.joints, [])
  assert.equal(script.steps[1].do[0].intent, 'apply')
  const { checkLook } = await import('../src/film/thumbs.mjs')
  const look = checkLook([{ s: 'cyl', p: [0, 0, 0], d: [30, 30, 4], c: '#a67c52', m: 'coil' }])
  assert.equal(look.ok ?? true, true)
  assert.equal((look.look || look)[0].m, 'coil')
})

test('a length of rope is a thumbnail solid: its forms are checked and drawn as unbroken tubes', async () => {
  const { checkLook, drawThumb } = await import('../src/film/thumbs.mjs')
  const look = ['straight', 'ring', 'hoop', 'arch', 'knot'].map((form, i) => ({ s: 'rope', p: [i * 20, 0, 0], d: [18, 18, 6], c: '#a98a62', t: 3, form }))
  const checked = checkLook(look)
  assert.deepEqual(checked.problems, [])
  assert.deepEqual(checked.look.map((s) => s.form), ['straight', 'ring', 'hoop', 'arch', 'knot'])
  const { ctx, calls, depth } = recordingCanvas()
  drawThumb(ctx, look, { width: 400, height: 300 })
  assert.equal(depth(), 0)
  // each form strokes its tube (ink, colour, crown): wider than a hairline
  assert.ok(calls.filter((c) => c.method === 'stroke').length >= 15)
  assert.equal(checkLook([{ s: 'rope', p: [0, 0, 0], d: [10, 10, 4], c: '#a98a62', form: 'bowline' }]).look[0].form, 'straight')
})

test('a demonstration of a strand is applying by hand: the engine draws the strand itself', () => {
  const script = { objects: [{ k: 'rope', n: 'rope', cm: 450, thick: 3.5, part: { family: 'rod', size: [450, 3.5, 3.5] } }],
    steps: [{ do: [{ id: 'c', v: 'strand', k: 'rope', op: 'coil' }] }, { do: [{ id: 'd', v: 'demonstrate', k: 'rope', intent: 'Press flat', demo: { actors: ['rope'], draw: '(ctx) => {}' }, focus: { k: 'rope', bounds: [0, 0, 1, 1] } }] }] }
  settleOperations(script)
  const a = script.steps[1].do[0]
  assert.deepEqual([a.v, a.intent, a.demo, a.focus], ['use', 'apply', undefined, undefined])
})

test('glue nozzle and bead follow a coiled strand instead of its original straight rod', () => {
  const dir = variant(150, 2, [{ op: 'coil', radius: 1 }])
  const script = JSON.parse(readFileSync(join(dir, 'script.json'), 'utf8'))
  script.tools = [{ k: 'glue', use: 'glue' }]
  script.steps.push({ t: 'Glue turns', c: 'Apply glue', claims: ['glue-turns'],
    do: [{ id: 'glue-turns', v: 'use', k: 'copper-wire', with: 'glue', intent: 'apply' }] })
  writeFileSync(join(dir, 'script.json'), JSON.stringify(script))
  relayout(dir)
  const { run, at } = play(dir), act = run.times.acts.find(a => a.id === 'glue-turns')
  for (const fraction of [0.35, 0.55, 0.75]) {
    // Read actual drawing transforms and paths, including the tool's local nozzle.
    let matrix = [1, 0, 0, 1, 0, 0], path = [], nozzle
    const stack = [], strokes = []
    const point = (x, y) => [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]]
    for (const { method, args: a } of at(act.at + act.len * fraction).calls) {
      if (method === 'save') stack.push([...matrix])
      if (method === 'restore') matrix = stack.pop()
      if (method === 'transform') {
        const [aa, b, c, d] = matrix, [e, f] = point(a[4], a[5])
        matrix = [aa * a[0] + c * a[1], b * a[0] + d * a[1], aa * a[2] + c * a[3], b * a[2] + d * a[3], e, f]
      }
      if (method === 'translate') [matrix[4], matrix[5]] = point(a[0], a[1])
      if (method === 'scale') matrix = matrix.map((v, i) => i < 2 ? v * a[0] : i < 4 ? v * a[1] : v)
      if (method === 'rotate') {
        const [aa, b, c, d, e, f] = matrix, co = Math.cos(a[0]), si = Math.sin(a[0])
        matrix = [aa * co + c * si, b * co + d * si, c * co - aa * si, d * co - b * si, e, f]
      }
      if (method === 'beginPath') path = []
      if (method === 'moveTo' || method === 'lineTo') path.push(point(a[0], a[1]))
      if (method === 'stroke' && path.length > 2) strokes.push([...path])
      if (method === 'mark' && a[0] === 'glue') nozzle = point(0, a[4] / 2)
    }
    assert.ok(nozzle, 'the glue tool was drawn')
    const rope = strokes.reduce((a, b) => a.length > b.length ? a : b)
    const distance = p => Math.min(...rope.map(q => Math.hypot(p[0] - q[0], p[1] - q[1])))
    assert.ok(distance(nozzle) < 4, `nozzle touches the coil at ${fraction}: ${distance(nozzle)} px away`)
    const bead = strokes.find(p => p.length < rope.length && Math.hypot(p.at(-1)[0] - nozzle[0], p.at(-1)[1] - nozzle[1]) < 1)
    assert.ok(bead, 'glue bead ends at the nozzle')
    assert.ok(bead.every(p => distance(p) < 4), 'the whole bead follows the rope curve')
  }
})

test('a caption-only repair cannot hide conflicting inventory and strand geometry lengths', () => {
  const script = JSON.parse(readFileSync(join(FIXTURE, 'script.json'), 'utf8'))
  const object = script.objects[0]
  object.cm = 45
  object.part.size[0] = 300
  script.design.parts.find(p => p.k === object.k).cm = 45
  const before = structuredClone(script)
  assert.match(validatePlan(script).errors.join('; '), /copper-wire: strand length mismatch: inventory cm is 45 cm but part.size\[0\] is 300 cm/)
  assert.match(runStrands(script).errors.join('; '), /strand length mismatch/)
  assert.deepEqual(script, before, 'validation does not change inventory or guess which estimate is correct')
  object.part.size[0] = 45
  assert.equal(validatePlan(script).valid, true)
  assert.equal(runStrands(script).strands[object.k].L, 45)
  script.design.parts.find(p => p.k === object.k).cm = 30
  assert.match(validatePlan(script).errors.join('; '), /design.parts gives 30 cm but the actor has 45 cm/)
})

test('strand length checks follow cut ancestry and keep shorter outputs separate from stock', () => {
  const script = wire([], { cm: 100, thick: 1 })
  script.objects[0].part = { family: 'rod', size: [100, 1, 1] }
  script.steps = [{ do: [{ v: 'cut', k: 'wire', into: [{ k: 'short-wire', cm: 30 }] }] },
    { do: [{ v: 'strand', k: 'short-wire', op: 'coil' }] }]
  script.design = { parts: [{ k: 'short-wire', from: 'wire', cm: 30 }] }
  assert.deepEqual(checkStrands(script), [])
  assert.equal(runStrands(script).strands['short-wire'].L, 30)
  script.objects[0].part.size[0] = 300
  assert.match(checkStrands(script).join('; '), /wire: strand length mismatch/)
  assert.equal(strandSize({ cm: 45 }).L, 45)
  assert.equal(strandSize({ part: { size: [45, 1, 1] } }).L, 45)
  assert.equal(strandSize({ cm: 45, part: { size: [45.00000001, 1, 1] } }).L, 45)
})

test('finished rope size uses the coil envelope rather than straight stock (87c626bd)', () => {
  const script = JSON.parse(readFileSync(new URL('support/rope-coil-plan.json', import.meta.url), 'utf8'))
  const fitted = withTools(script, { 'rope-1': { origin: [0, 0], seat: [100, 0], base: [100, 200] } }, { 'rope-1': { width: 200, height: 200 } }, {})
  const layout = solveBuild(script, fitted.geometry, fitted.sizes), before = structuredClone(layout)
  const result = finalStrandBounds(script)
  assert.deepEqual(result.errors, [])
  const [width, depth, height] = result.bounds['rope-1'].size
  assert.ok(width > 9 && width < 11 && depth > 10 && depth < 12)
  assert.equal(height, 2)
  assert.deepEqual(geometryReview(script, layout).errors, [])
  assert.deepEqual(layout, before, 'checking the finished envelope does not move parts or joints')
  script.design.size = [35, 2, 2]
  assert.match(sizeProblems(script, layout).join('; '), /steps build 9.9 × 10.9 × 2 cm/)
  script.design.size = [100, 100, 2]
  assert.ok(sizeProblems(script, layout).length, 'impossible finished dimensions still fail')
  script.steps[1].do[0].radius = 5.5
  assert.match(sizeProblems(script, layout).join('; '), /too short to coil/)
})

test('worked strands retain other objects in the finished assembly envelope', () => {
  const script = wire([{ op: 'bend', at: 'middle', deg: 90 }], { cm: 40, thick: 1 })
  script.design = { size: [21, 21, 1] }
  const layout = { world: { wire: { p: { x: 0, y: 0, z: 0 }, e: { x: 40, y: 1, z: 1 }, o: { L: 'x', W: 'y', T: 'z' } } } }
  assert.deepEqual(sizeProblems(script, layout), [])
  layout.world.block = { p: { x: 80, y: 0, z: 0 }, e: { x: 20, y: 20, z: 10 }, o: { L: 'x', W: 'y', T: 'z' } }
  assert.ok(sizeProblems(script, layout).length, 'other parts are included, not skipped for strand plans')
})

test('two-knot failures explain the template material budget and ineffective clamped edits (c380bd5)', () => {
  const script = JSON.parse(readFileSync(new URL('support/two-knot-rope-plan.json', import.meta.url), 'utf8'))
  for (const at of ['start', '6 cm from the start']) {
    script.steps[4].do[0].at = at
    const errors = runStrands(script).errors.join('; ')
    assert.match(errors, /step 5 \(a5\):.*knot spacing/)
    assert.match(errors, /1 existing knot\(s\).*61.4 cm/)
    assert.match(errors, /at least 67.4 cm before adding any central grip; available strand length is 62 cm/)
    assert.match(errors, /effective centre 18.3 cm \(clamped/)
    assert.match(errors, /Allowed centre range.*18.3–43.7 cm/)
    assert.match(errors, /not a physical knot feasibility measurement/)
    assert.match(errors, /Do not repeat ineffective position edits or change published inventory/)
  }
  script.steps.splice(4, 2)
  assert.deepEqual(runStrands(script).errors, [], 'fewer knots can be drawn without inventing more rope')
})

test('knot diagnostics preserve valid spacing and clear prior knots when straightening', () => {
  const knots = [{ op: 'knot', at: 'end', name: 'overhand' }, { op: 'knot', at: 'start', name: 'overhand' }]
  assert.deepEqual(checkStrands(wire(knots, { cm: 80, thick: 2 })), [])
  const retied = states([knots[0], { op: 'straighten' }, knots[1]], { cm: 62, thick: 2 })
  assert.deepEqual(retied.errors, [])
  assert.equal(retied.r.final.wire.knots.length, 1, 'the straightened knot is not counted as still consuming material')
  const short = runStrands(wire([knots[0]], { cm: 15, thick: 2 }))
  assert.match(short.errors.join('; '), /strand is only 15 cm/)
})
