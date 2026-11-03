import test from 'node:test'
import assert from 'node:assert/strict'
import { checkSheets, pathPoint } from '../src/solvers/sheets.mjs'
import { validatePlan, designProblems } from '../src/pipeline/validate.mjs'
import { auditInstruction } from '../src/pipeline/evaluation.mjs'
import { withTools } from '../src/solvers/tools.mjs'
import { solveBuild } from '../src/solvers/layout.mjs'
import { program, timeline } from '../src/film/engine.mjs'
import { runFolds } from '../src/solvers/fold.mjs'
import { recordingCanvas, offlineEnv } from '../scripts/offline-canvas.mjs'
import { refusedIn } from '../src/pipeline/words.mjs'
import { PLAN_SCHEMA, PATCH_SCHEMA } from '../src/pipeline/plan-schema.mjs'
import { checkProject, catalogueSchema } from '../src/pipeline/catalogue.mjs'
import { settleStates } from '../src/solvers/contracts.mjs'
import { entities } from '../src/solvers/operations.mjs'

import { sheetExample } from './support/sheet-example.mjs'

test('sheet cutting fits across width, preserves distinct copies and rejects overlapping or missing stock', () => {
  const s = sheetExample()
  assert.deepEqual(checkSheets(s), [])
  assert.equal(validatePlan(s).valid, true)
  assert.deepEqual(designProblems(s), [])
  const outputs = s.steps[1].do[0].into
  outputs[1].origin = [10, 0]
  assert.match(checkSheets(s).join(';'), /overlaps/)
  outputs[1].origin = [30, 0]
  assert.match(checkSheets(s).join(';'), /outside source/)
  delete outputs[1].size
  assert.match(checkSheets(s).join(';'), /every sheet cut output/)
})

test('nested cuts use the immediate sheet and retain its two dimensional stock accounting', () => {
  const s = sheetExample()
  s.steps.push({ t: 'Cut nested part', c: 'Cut the nested part', claims: ['nested'], do: [{ id: 'nested', intent: 'cut', v: 'cut', k: 'panel-b', with: 'scissors', into: [{ k: 'nested', label: '5 × 10 cm', size: [5, 10], origin: [3, 4] }] }] })
  s.design.parts.push({ k: 'nested', from: 'panel-b', cm: 0 })
  assert.deepEqual(checkSheets(s), [])
  assert.deepEqual(designProblems(s), [])
  s.design.parts[0].n = 2
  assert.match(designProblems(s).join(';'), /every physical copy its own key/)
})

test('path work needs real geometry and a faithful method, including matching receiver paths', () => {
  const s = sheetExample(), a = s.steps[4].do[0]
  a.otherPath = [[1, 1], [1, 10]]
  assert.match(checkSheets(s).join(';'), /equal lengths/)
  delete a.path
  assert.match(checkSheets(s).join(';'), /needle work needs/)
  a.path = [[100, 0], [100, 5]]
  assert.match(checkSheets(s).join(';'), /inside a known sheet/)
  assert.deepEqual(pathPoint([[0, 0], [2, 0], [2, 8]], 0.5), [2, 3])
})

test('a path cannot cross a cut-out notch and malformed outlines cannot become sheets', () => {
  const s = sheetExample(), part = s.steps[1].do[0].into[1], a = s.steps[4].do[0]
  part.outline = [[0, 0], [18, 0], [18, 25], [12, 25], [12, 10], [6, 10], [6, 25], [0, 25]]
  a.path = [[3, 20], [15, 20]]
  assert.match(checkSheets(s).join(';'), /inside a known sheet/)
  part.outline = [[0, 0], [18, 25], [0, 25], [18, 0]]
  assert.match(checkSheets(s).join(';'), /nonempty outline/)
})

test('audit reports unresolved design problems rather than returning valid true', () => {
  const s = sheetExample()
  s.design.parts.push({ k: 'missing-part', from: 'stock', cm: 10 })
  assert.equal(validatePlan(s).valid, true, 'planner still repairs soft design problems through its existing flow')
  const audit = auditInstruction(s)
  assert.equal(audit.valid, false)
  assert.match(audit.blockers.join(';'), /missing-part/)
})

test('full cut-part appearances survive shallow schema declarations and state normalization', () => {
  const s = sheetExample()
  const appearance = { width: 180, height: 250, shapes: [{ d: 'M0 0 L180 0 L180 250 L0 250 Z', fill: '#b83c32', stroke: '#1d2b4f' }] }
  s.states = [{ k: 'panel-a', state: 'flat', states: [{ id: 'flat', label: 'Flat panel', appearance }] }]
  assert.equal(entities(s).find((p) => p.k === 'panel-a').states[0].appearance, appearance)
  settleStates(s)
  assert.equal(s.states, undefined)
  assert.equal(s.steps[1].do[0].into[0].state, 'flat')
  assert.equal(validatePlan(s).valid, true)
})

test('matching path lengths cannot pass a join whose actors are separated in the layout', () => {
  const s = sheetExample()
  s.steps[3].do[0] = { ...s.steps[3].do[0], rel: 'floor', to: null }
  const cut = withTools(s, { stock: { origin: [0, 0], color: '#b83c32', base: [200, 300], seat: [200, 0] } }, { stock: { width: 400, height: 300 } }, {})
  assert.throws(() => solveBuild(s, cut.geometry, cut.sizes), /stitched paths do not meet/)
})

test('shaped sheets and moving tools execute with persistent seam marks and no wood drawing', () => {
  const s = sheetExample(), base = { stock: { origin: [0, 0], color: '#b83c32', base: [200, 300], seat: [200, 0] } }
  // Unplaced waste is still a real cut output and must draw during separation without a solved final pose.
  s.steps[1].do[0].into.push({ k: 'offcut', label: 'offcut', size: [2, 25], origin: [18, 0] })
  const cut = withTools(s, base, { stock: { width: 400, height: 300 } }, {})
  const layout = solveBuild(s, cut.geometry, cut.sizes), times = timeline(s)
  assert.equal(layout.sheetLayout, true)
  assert.equal(cut.geometry['panel-a'].sheet.outline.length, 5)
  const folded = runFolds(s)
  assert.deepEqual(folded.errors, [])
  assert.equal(folded.sheets['panel-a'].w, 18)
  const source = program({ script: s, geometry: cut.geometry, sizes: cut.sizes, vectors: cut.vectors, boxes: { stock: [0, 0, 400, 300] }, layout, photo: { width: 400, height: 300 } })
  assert.deepEqual(refusedIn(source), [])
  const draw = new Function(`return (${source})`)(), env = offlineEnv(), oldPath = globalThis.Path2D
  globalThis.Path2D = class {}
  try {
    for (const a of times.acts) for (const fraction of [0.1, 0.5, 0.95]) {
      const c = recordingCanvas(); draw(c.ctx, a.at + a.len * fraction, env); assert.equal(c.depth(), 0)
    }
    const a = times.acts.find((a) => a.id === 'join'), after = recordingCanvas()
    draw(after.ctx, a.at + a.len + 0.05, env)
    assert.ok(after.calls.some((c) => c.method === 'setLineDash' && c.args[0].length === 2 && c.args[0][0] > 0), 'stitched line persists after the needle leaves')
    // A demonstrated assembly must retain its resulting appearance instead of reverting to the flat sheet.
    s.states = [{ k: 'panel-b', state: 'flat', states: [{ id: 'flat', label: 'Flat panel' }, { id: 'formed', label: 'Formed assembly',
      appearance: { width: 180, height: 250, shapes: [{ d: 'M0 0 L180 0 L130 250 L50 250 Z', fill: '#cc00cc', stroke: 'none' }] } }] }]
    s.steps.push({ t: 'Form assembly', c: 'Show the changed assembly', claims: ['form'], do: [{ id: 'form', intent: 'form', v: 'demonstrate', k: 'panel-b',
      focus: { k: 'panel-b', bounds: [0, 0, 1, 1] }, demo: { actors: ['panel-b'], draw: '(ctx,p,env,scene) => { scene.draw("panel-b"); }' },
      requires: [{ k: 'panel-b', state: 'flat' }], effects: [{ k: 'panel-b', state: 'formed' }] }] })
    const formedSource = program({ script: s, geometry: cut.geometry, sizes: cut.sizes, vectors: cut.vectors, boxes: { stock: [0, 0, 400, 300] }, layout: structuredClone(layout), photo: { width: 400, height: 300 } })
    const formed = recordingCanvas(), form = timeline(s).acts.at(-1)
    new Function(`return (${formedSource})`)()(formed.ctx, form.at + form.len + 0.05, env)
    assert.ok(formed.calls.some((c) => c.method === 'fill' && c.fill === '#cc00cc'), 'resulting state overrides the sheet outline after the demonstration')
    assert.equal(formed.depth(), 0)
  } finally { globalThis.Path2D = oldPath }
})

test('schemas stay inside provider nesting bounds and catalogue accepts honest dependencies and no ideas', () => {
  const depth = (s, n = 0) => !s || typeof s !== 'object' ? n : Math.max(n, ...Object.values(s).filter((v) => v && typeof v === 'object').map((v) => depth(v, n + (['object', 'array'].includes(s.type) ? 1 : 0))))
  assert.ok(depth(PLAN_SCHEMA) <= 10); assert.ok(depth(PATCH_SCHEMA) <= 10)
  assert.equal(catalogueSchema(20).properties.projects.minItems, 0)
  const { project } = checkProject({ title: 'Joined panels', uses: ['stock'], needs: [], supplies: ['matching thread'], confirmations: ['measure usable stock'], look: [] }, sheetExample().objects)
  assert.deepEqual(project.supplies, ['matching thread'])
  assert.deepEqual(project.confirmations, ['measure usable stock'])
})

test('work shown from underneath leaves a sheet flat, while a tilted or turned pose still needs a demonstration', () => {
  const objects = [{ k: 'paper', n: 'paper', part: { family: 'sheet', size: [15, 15, 0.02], outline: [[0, 0], [15, 0], [15, 15], [0, 15]] } }]
  const errors = (action) => checkSheets({ objects, steps: [{ do: [action] }] }).filter((e) => e.includes('non-flat sheet pose'))
  assert.deepEqual(errors({ id: 'a1', v: 'use', k: 'paper', face: 'lower', with: 'pin', turn: true }), [])
  assert.equal(errors({ id: 'a1', v: 'place', k: 'paper', turn: true }).length, 1)
  assert.equal(errors({ id: 'a1', v: 'place', k: 'paper', tilt: 10 }).length, 1)
})
