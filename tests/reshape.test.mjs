// Reshaping, offline: SVG paths flattened, lines matched point for point, the arrow only for a local move, the
// contract's checks, and a film with a reshape step played on the recording canvas. No models, no renderer.
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flatten, resample, morph } from '../src/solvers/reshape.mjs'
import { validateContract } from '../src/solvers/contracts.mjs'
import { relayout } from '../src/pipeline/relayout.mjs'
import { readRun, filmProgram } from '../src/film/film.mjs'
import { recordingCanvas, offlineEnv } from '../scripts/offline-canvas.mjs'

const near = (a, b, e = 0.05) => Math.abs(a - b) <= e

test('paths flatten: absolute and relative, implicit lines, curves, arcs, closed subpaths', () => {
  const [a, b] = flatten('M10 10 h20 v5 a5 5 0 0 1 -5 5 z m 1 1 l 2 2 2 3')
  assert.equal(a.closed, true); assert.deepEqual(a.pts.slice(0, 3), [[10, 10], [30, 10], [30, 15]])
  assert.ok(a.pts.slice(3).every(([x, y]) => near(Math.hypot(x - 25, y - 15), 5, 0.01)), 'the arc keeps its radius')
  assert.deepEqual(b.pts, [[11, 11], [13, 13], [15, 16]])
  const [c] = flatten('M0 0 C 0 10 10 10 10 0 S 20 -10 20 0 Q 25 5 30 0 T 40 0')
  assert.deepEqual(c.pts.at(-1), [40, 0]); assert.ok(c.pts.length > 40)
  assert.deepEqual(flatten('nonsense'), []); assert.deepEqual(flatten('M 5 5'), [])
})

test('resampling spaces points evenly along a line and round a loop', () => {
  const open = resample([[0, 0], [10, 0], [10, 10]], 5, false)
  assert.deepEqual(open, [[0, 0], [5, 0], [10, 0], [10, 5], [10, 10]])
  const loop = resample([[0, 0], [10, 0], [10, 10], [0, 10]], 4, true)
  assert.deepEqual(loop, [[0, 0], [10, 0], [10, 10], [0, 10]])
})

test('a bend matches point for point, the bent end gets the arrow; a redrawn shape gets none', () => {
  const straight = { width: 100, height: 60, shapes: [{ d: 'M10 50 H90', fill: 'none', stroke: '#888888' }] }
  const bent = { width: 100, height: 60, shapes: [{ d: 'M90 50 H40 L40 10', fill: 'none', stroke: '#888888' }] } // (drawn from the other end)
  const r = morph(straight, bent, { width: 400, height: 240 })
  assert.equal(r.pairs.length, 1); assert.equal(r.fadeIn.length, 0)
  const { a, b } = r.pairs[0]
  // (the right end stays put and the left end bends up: the after line, drawn from the fixed end, is turned round)
  assert.deepEqual(a[0], [40, 200]); assert.deepEqual(b[0], [160, 40]); assert.deepEqual(b.at(-1), [360, 200])
  assert.deepEqual(r.moved, { from: [40, 200], to: [160, 40] })
  assert.equal(r.lineWidth, 8)
  // dough rolled out to twice its size: every point moves alike, so no arrow
  const small = { width: 10, height: 10, shapes: [{ d: 'M3 3 H7 V7 H3 Z', fill: '#e8c890', stroke: 'none' }] }
  const big = { width: 10, height: 10, shapes: [{ d: 'M1 1 H9 V9 H1 Z', fill: '#e8c890', stroke: 'none' }] }
  assert.equal(morph(small, big, { width: 100, height: 100 }).moved, null)
  // no drawing before: the new shape fades in
  const fresh = morph(null, bent, { width: 400, height: 240 })
  assert.equal(fresh.pairs.length, 0); assert.equal(fresh.fadeIn.length, 1)
})

// The groceries fixture with the cheese pressed flat before it is cubed.
function pressed() {
  const script = JSON.parse(readFileSync(new URL('../examples/fixtures/groceries/script.json', import.meta.url), 'utf8'))
  const cheese = script.objects.find((o) => o.k === 'pepperjack')
  cheese.state = 'block'
  cheese.states = [{ id: 'block', label: 'Block', appearance: { width: 100, height: 60, shapes: [{ d: 'M10 10 H90 V50 H10 Z', fill: '#f2e6b0', stroke: '#1d2b4f' }] } },
    { id: 'flat', label: 'Pressed flat', appearance: { width: 100, height: 60, shapes: [{ d: 'M0 35 H100 V50 H0 Z', fill: '#f2e6b0', stroke: '#1d2b4f' }] } }]
  const step = script.steps.find((s) => s.do.some((a) => a.k === 'pepperjack' && a.v === 'cut'))
  const at = step.do.findIndex((a) => a.k === 'pepperjack' && a.v === 'cut')
  step.claims.push('press-cheese')
  step.do.splice(at, 0, { id: 'press-cheese', v: 'reshape', k: 'pepperjack', intent: 'Press the cheese flat', requires: [{ k: 'pepperjack', state: 'block' }], effects: [{ k: 'pepperjack', state: 'flat' }], label: '1 cm' })
  return script
}

test('the contract wants the shape a reshape ends in, drawn', () => {
  assert.deepEqual(validateContract(pressed()).errors, [])
  const undrawn = pressed(); delete undrawn.objects.find((o) => o.k === 'pepperjack').states[1].appearance
  assert.match(validateContract(undrawn).errors.join('; '), /needs a drawing \(appearance\) of pepperjack:flat/)
  const noEnd = pressed(); noEnd.steps.flatMap((s) => s.do).find((a) => a.v === 'reshape').effects = []
  assert.match(validateContract(noEnd).errors.join('; '), /must declare the shape pepperjack ends in/)
})

test('a film with a reshape step plays: the thing moves between its drawings, then keeps its new one', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'reshape-film-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  cpSync(fileURLToPath(new URL('../examples/fixtures/groceries', import.meta.url)), dir, { recursive: true })
  writeFileSync(join(dir, 'script.json'), JSON.stringify(pressed()))
  relayout(dir)
  const run = readRun(dir)
  const screens = Object.fromEntries(Object.entries(run.screens).map(([k, s]) => [k, { width: s.width, height: s.height, regions: s.regions || [] }]))
  const old = globalThis.Path2D; globalThis.Path2D = class {}
  try {
    const { source, duration } = filmProgram(run, { name: 'replay' })
    const act = run.times.acts.find((a) => a.v === 'reshape')
    assert.ok(act && act.len === 2.4)
    assert.match(source, /"pairs":\[\{"a":/)
    const draw = new Function(`return (${source})`)(), env = { ...offlineEnv(), screens }
    for (let time = 0; time <= duration; time += 0.2) {
      const { ctx, depth } = recordingCanvas(); draw(ctx, time, env); assert.equal(depth(), 0, `balanced at ${time}`)
    }
    // mid-move the cheese is drawn as moving lines, in its own colour; the label comes as it arrives
    const mid = recordingCanvas(); draw(mid.ctx, act.at + act.len * 0.5, env)
    assert.ok(mid.calls.some((c) => c.method === 'fill' && c.fill === '#f2e6b0'))
    const late = recordingCanvas(); draw(late.ctx, act.at + act.len * 0.8, env)
    assert.ok(late.calls.some((c) => c.method === 'fillText' && c.args[0] === '1 cm'))
    // the step gets the engine's own panel, from the same drawings: its card titled with the step, the label by its arrow
    assert.match(source, new RegExp(`"own":\\{"${act.step}":`))
    assert.ok(late.calls.some((c) => c.method === 'fillText' && c.args[0] === run.script.steps[act.step].t))
    assert.ok(late.calls.filter((c) => c.method === 'fillText' && c.args[0] === '1 cm').length >= 2, 'on the stage and in the panel')
  } finally { globalThis.Path2D = old }
})
