import { chromePresent } from '../benchmarks/drawing-chrome.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { finalFoldBounds } from '../src/solvers/fold.mjs'
import { sizeProblems } from '../src/solvers/layout.mjs'
import { validatePlan } from '../src/pipeline/validate.mjs'
import { PHYSICAL_PLAN_SCHEMA } from '../src/pipeline/plan-schema.mjs'
import { schemaProblems, gradePlan } from '../benchmarks/planning-grade.mjs'
import { wood8Plan } from './support/stub-model.mjs'
import { physicalPlan } from './support/physical-plan.mjs'
import { openPlanningBrowser } from '../benchmarks/planning-browser.mjs'

function foldedSheet() {
  return physicalPlan({ title: 'Folded sheet', view: 'plan',
    objects: [{ k: 'paper', n: 'Paper sheet', b: [0, 0, 200, 300], cm: 20, w: 30, thick: 0.01, part: { family: 'sheet', size: [20, 30, 0.01] } }],
    design: { purpose: 'A folded sheet', standard: 'Half-width sheet', size: [10, 30, 0.01], parts: [{ k: 'paper', from: 'paper', cm: 0 }] },
    steps: [{ t: 'Lay sheet', c: 'Lay the sheet flat', do: [{ id: 'lay', intent: 'place', v: 'place', k: 'paper', rel: 'floor' }] },
      { t: 'Fold in half', c: 'Fold the left edge onto the right edge', do: [{ id: 'fold', intent: 'fold', v: 'fold', k: 'paper', move: 'left edge', onto: 'right edge' }] }] })
}
const sheetLayout = () => ({ world: { paper: { p: { x: 0, y: 0, z: 0 }, e: { x: 20, y: 30, z: 0.01 }, o: { L: 'x', W: 'y', T: 'z' } } }, transients: [] })

test('finished sheet dimensions use final folds and still reject stock dimensions as the finished size', () => {
  const plan = foldedSheet(), layout = sheetLayout(), original = structuredClone(layout)
  assert.deepEqual(finalFoldBounds(plan).bounds.paper.size, [10, 30])
  assert.deepEqual(sizeProblems(plan, layout), [])
  assert.deepEqual(layout, original, 'Dimension checking must not move the physical layout or its joint geometry')
  plan.design.size = [20, 30, 0.01]
  assert.match(sizeProblems(plan, layout).join(';'), /steps build 10 × 30/)
  plan.design.size = [100, 100, 100]
  assert.ok(sizeProblems(plan, layout).length)
})

test('opening, rotation and cuts change the final measured sheet extent', () => {
  const plan = foldedSheet()
  plan.steps.push({ do: [{ id: 'open', v: 'fold', k: 'paper', move: 'open' }] })
  assert.deepEqual(finalFoldBounds(plan).bounds.paper.size, [20, 30])
  plan.design.size = [20, 30, 0.01]
  assert.deepEqual(sizeProblems(plan, sheetLayout()), [])
  plan.steps.pop()
  plan.steps.push({ do: [{ id: 'rotate', v: 'fold', k: 'paper', move: 'rotate', deg: 90 }] })
  const rotated = finalFoldBounds(plan)
  assert.deepEqual(rotated.errors, [])
  assert.deepEqual(rotated.bounds.paper.size, [30, 10])
  const cut = foldedSheet(); cut.steps[1].do = [{ id: 'trim', v: 'cut', k: 'paper', with: 'scissors', shape: [[-0.1, -0.1], [0.5, -0.1], [0.5, 1.1], [-0.1, 1.1]] }]
  const trimmed = finalFoldBounds(cut)
  assert.deepEqual(trimmed.errors, [])
  assert.deepEqual(trimmed.bounds.paper.size, [10, 30])
  const invalid = foldedSheet(); invalid.steps[1].do[0].onto = 'nonexistent crease'
  assert.ok(sizeProblems(invalid, sheetLayout()).some(e => e.startsWith('finished fold geometry:')))
})

test('folded dimensions survive production geometry and real Chrome playback', { skip: !chromePresent, timeout: 45000 }, async t => {
  const browser = await openPlanningBrowser(); t.after(browser.close)
  const plan = foldedSheet(), cut = { geometry: { paper: { origin: [0, 0], seat: [100, 0], base: [100, 300] } }, sizes: { paper: { width: 200, height: 300 } } }
  const grade = await gradePlan({ candidate: plan, cut, photo: { width: 200, height: 300 }, smoke: browser.smoke })
  assert.equal(grade.machine, 'pass', JSON.stringify(grade.findings))
  assert.ok(grade.grades.execution.frames > 0)
})

test('fastening schemas require nonempty joint, tool and fastener references', () => {
  const schema = PHYSICAL_PLAN_SCHEMA.properties.steps.items.properties.do.items
  const act = { v: 'use', intent: 'fasten', id: 'drive', k: 'front', joint: 'corner', with: 'driver', part: 'screws' }
  assert.deepEqual(schemaProblems(act, schema), [])
  for (const key of ['joint', 'with', 'part']) for (const value of [undefined, null, '']) {
    const bad = { ...act, [key]: value }; if (value === undefined) delete bad[key]
    assert.ok(schemaProblems(bad, schema).length, `${key}=${value} must fail`)
  }
  assert.deepEqual(schemaProblems({ v: 'use', intent: 'sand', id: 'sand', k: 'front', with: 'sander' }, schema), [])
})

test('missing fasteners receive a specific error while real length and driver mismatches stay rejected', () => {
  const source = wood8Plan(), first = p => p.steps.flatMap(s => s.do).find(a => a.intent === 'fasten')
  const missing = structuredClone(source), action = first(missing); delete action.part
  const errors = validatePlan(missing).errors.filter(e => e.startsWith(`${action.id}:`))
  assert.ok(errors.some(e => /explicit part reference/.test(e)))
  assert.ok(!errors.some(e => /declared fastener length|incompatible with the fastener/.test(e)))
  const unknown = structuredClone(source); first(unknown).part = 'missing-screws'
  assert.match(validatePlan(unknown).errors.join(';'), /unknown fastener missing-screws/)
  const length = structuredClone(source); first(length).part = 'bad-screws'; length.tools.push({ k: 'bad-screws', use: 'screw', cm: 999 })
  assert.match(validatePlan(length).errors.join(';'), /declared fastener length/)
  const tool = structuredClone(source); first(tool).with = 'wrong-driver'; tool.tools.push({ k: 'wrong-driver', use: 'hammer' })
  assert.match(validatePlan(tool).errors.join(';'), /incompatible with the fastener/)
  const path = structuredClone(source); first(path).path = [[0, 0], [1, 1]]
  assert.match(validatePlan(path).errors.join(';'), /fastening uses joint sites/)
})
