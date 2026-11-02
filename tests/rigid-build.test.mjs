import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { physicalPlan } from './support/physical-plan.mjs'
import { compileCutPlans } from '../src/solvers/rigid-build.mjs'
import { settlePlanningInputs } from '../src/pipeline/planning-inputs.mjs'
import { gradePlan, schemaProblems, productionGeometryCheck } from '../benchmarks/planning-grade.mjs'
import { frozenPlanningSchema } from '../src/pipeline/plan-schema.mjs'
import { plain } from '../src/pipeline/script.mjs'
import { validatePlan } from '../src/pipeline/validate.mjs'
import { patched, preparePhoto, writePlan } from '../src/pipeline/plan.mjs'
import { openPlanningBrowser } from '../benchmarks/planning-browser.mjs'
import { stubModel } from './support/stub-model.mjs'
import { withTools } from '../src/solvers/tools.mjs'

const read = file => JSON.parse(readFileSync(new URL(file, import.meta.url)))
// Use tracked fixture input rather than run artifacts for all executable tests.
function stockObjects() {
  const script = read('../examples/fixtures/wood8/script.json')
  return script.objects.map(o => ({ ...o, segment: o.segment || 'wooden board' }))
}
function example() {
  const parts = [['front', 'board-a', 40], ['back', 'board-a', 40], ['left', 'board-a', 14], ['right', 'board-a', 14], ['base', 'board-b', 40]]
  const actions = [
    [{ id: 'stock-a', v: 'place', intent: 'place', k: 'board-a', rel: 'floor' }],
    [{ id: 'saw-a', v: 'cut', intent: 'cut', k: 'board-a', cut: 'cut-a' }],
    [{ id: 'stock-b', v: 'place', intent: 'place', k: 'board-b', rel: 'floor' }],
    [{ id: 'saw-b', v: 'cut', intent: 'cut', k: 'board-b', cut: 'cut-b' }],
    ...['base', 'front', 'back', 'left', 'right'].map(k => [{ id: `place-${k}`, v: 'place', intent: 'place', k, rel: 'floor' }]),
    ...['front-left', 'front-right', 'back-left', 'back-right', 'base-front', 'base-back', 'base-left', 'base-right'].map(suffix => [{
      id: `fasten-${suffix}`, v: 'use', intent: 'fasten', k: suffix.split('-')[0], joint: `box-${suffix}`, with: 'driver', part: 'screws',
    }]),
  ]
  const plan = physicalPlan({ title: 'Compiled planter', view: 'iso', objects: stockObjects(), tools: [{ k: 'saw', use: 'saw' }, { k: 'driver', use: 'screwdriver' }, { k: 'screws', use: 'screw', cm: 7 }],
    design: { purpose: 'Open planter', standard: '20 cm sides on a 2 cm base', size: [40, 18, 22],
      parts: parts.map(([k, from, cm]) => ({ k, from, cm, n: 1 })), joins: 'Eight screwed joints', stands: 'A closed box on its base' },
    cuts: [{ id: 'cut-a', stock: 'board-a', with: 'saw', parts: ['front', 'back', 'left', 'right'] }, { id: 'cut-b', stock: 'board-b', with: 'saw', parts: ['base'] }],
    assembly: { kind: 'open-box', id: 'box', base: 'base', front: 'front', back: 'back', left: 'left', right: 'right', fastener: 'screws', driver: 'driver' },
    steps: actions.map((do_, i) => ({ t: `Operation ${i + 1}`, c: do_[0].intent === 'fasten' ? 'Drive the screws at the joint' : 'Follow the declared operation',
      claims: do_.map(a => a.id), do: do_, ...(do_[0].intent === 'fasten' ? { caption: { template: 'Drive {count} screws at this joint', actions: [do_[0].id] } } : {}) })),
  })
  plan.ideas = [0, 1, 2].map(i => ({ title: `Planter ${i}`, pitch: 'An open planter', kind: 'build' }))
  return plan
}
const acts = p => p.steps.flatMap(s => s.do)

test('wire output must explicitly choose construction and include every compiled-box binding', () => {
  const plan = example(), { objects, ...wire } = plan
  wire.objectUpdates = []
  const schema = frozenPlanningSchema(objects)
  assert.deepEqual(schemaProblems(wire, schema), [])
  for (const field of ['cuts', 'assembly']) {
    const missing = structuredClone(wire); delete missing[field]
    assert.ok(schemaProblems(missing, schema).some(e => e.includes(`missing required field ${field}`)))
  }
  for (const field of ['id', 'fastener', 'driver']) {
    const missing = structuredClone(wire); delete missing.assembly[field]
    assert.ok(schemaProblems(missing, schema).some(e => e.includes(`missing required field ${field}`)))
  }
  assert.deepEqual(schemaProblems(null, schema.properties.assembly), [], 'Manual or other construction remains supported')
  const action = schema.properties.steps.items.properties.do.items
  assert.deepEqual(schemaProblems({ v: 'place', intent: 'place', id: 'put', k: 'left', to: 'base' }, action), [])
  assert.ok(schemaProblems({ v: 'place', intent: 'place', id: 'put', k: 'left' }, action).length)
})

test('named cuts use design lengths, account for the final saw cut and create numeric offcuts', () => {
  const plan = example(); delete plan.assembly
  const notes = compileCutPlans(plan)
  assert.equal(notes.length, 2)
  const cut = acts(plan).find(a => a.cut === 'cut-a')
  assert.deepEqual(cut.into.map(p => [p.k, p.cm]), [['front', 40], ['back', 40], ['left', 14], ['right', 14], ['cut-a-offcut', 10.8]])
  assert.equal(cut.with, 'saw'); assert.equal(cut.kerfCm, 0.3)
  const before = structuredClone(plan); assert.deepEqual(compileCutPlans(plan), []); assert.deepEqual(plan, before)
})

test('cut declarations reject impossible stock budgets, duplicated material and work that is not shown', () => {
  const cases = [
    [p => { p.design.parts[0].cm = 100 }, /only 120 cm/],
    [p => { p.design.parts[0].cm = 119.9; p.cuts[0].parts = ['front'] }, /final 0.3 cm saw kerf/],
    [p => { p.cuts[0].parts.push('front') }, /duplicates/],
    [p => { p.cuts.push({ ...p.cuts[0], id: 'second' }) }, /one named cut/],
    [p => { p.steps.splice(1, 1) }, /exactly one explicit cut action/],
    [p => { acts(p).find(a => a.cut === 'cut-a').v = 'place' }, /v\/intent cut/],
    [p => { p.steps.shift() }, /explicitly place board-a/],
    [p => { p.cuts[0].with = 'driver' }, /declared saw/],
    [p => { p.cuts[0].parts[0] = 'base' }, /from board-a/],
    [p => { acts(p).find(a => a.cut === 'cut-a').into = [{ k: 'front', cm: 999, label: '999 cm' }] }, /contradict/],
    [p => { delete p.cuts }, /Unknown named cut/],
  ]
  for (const [mutate, pattern] of cases) { const plan = example(); mutate(plan); assert.throws(() => settlePlanningInputs(plan), pattern) }
})

test('compiled box geometry joins every part and preserves the input dimensions through plain()', () => {
  const plan = example(), identity = structuredClone(plan.objects), designed = structuredClone(plan.design.parts), steps = plan.steps.length
  settlePlanningInputs(plan)
  assert.equal(plan.joints.length, 8)
  assert.deepEqual(plan.objects, identity); assert.deepEqual(plan.design.parts, designed); assert.equal(plan.steps.length, steps)
  const before = structuredClone(plan); assert.deepEqual(settlePlanningInputs(plan), []); assert.deepEqual(plan, before)
  assert.equal(validatePlan(plan).valid, true, JSON.stringify(validatePlan(plan).errors))
  assert.deepEqual(validatePlan(plan).soft, [])
  const normalized = plain(plan); assert.deepEqual(plain(normalized), normalized)
  settlePlanningInputs(normalized)
  const folder = '../examples/fixtures/wood8/screens/', screens = read(`${folder}screens.json`)
  const cut = { geometry: read(`${folder}geometry.json`), sizes: Object.fromEntries(Object.entries(screens).filter(([k]) => k !== 'photo').map(([k, s]) => [k, { width: s.width, height: s.height }])) }
  assert.deepEqual(productionGeometryCheck(normalized, cut).errors, [])
  const fitted = withTools(normalized, cut.geometry, cut.sizes, {})
  assert.ok(fitted.geometry.back.slice[0] > fitted.geometry.front.slice[1], 'The drawing must leave space for the saw kerf')
})

test('compiled boxes reject altered part lengths and conflicts, and still require all attachments', () => {
  const bad = example(); bad.design.parts.find(p => p.k === 'left').cm = 18
  assert.throws(() => settlePlanningInputs(bad), /ends must fit the 14 cm gap/)
  const badBase = example(); badBase.design.parts.find(p => p.k === 'base').cm = 39
  assert.throws(() => settlePlanningInputs(badBase), /matching lengths/)
  const conflict = example(); conflict.joints = [{ id: 'box-front-left', a: 'base', b: 'left' }]
  assert.throws(() => settlePlanningInputs(conflict), /conflicts with compiled box geometry/)
  const missing = example(); missing.steps.pop(); settlePlanningInputs(missing)
  assert.match(validatePlan(missing).errors.join(';'), /box-base-right: no attachment operation/)
  const tool = example(); tool.tools.find(t => t.k === 'driver').use = 'hammer'
  assert.throws(() => settlePlanningInputs(tool), /compatible driving tool/)
  const short = example(); short.tools.find(t => t.k === 'screws').cm = 1
  assert.throws(() => settlePlanningInputs(short), /fastener must be/)
  const long = example(); long.tools.find(t => t.k === 'screws').cm = 99
  assert.throws(() => settlePlanningInputs(long), /fastener must be/)
  const early = example(); [early.steps[3], early.steps[4]] = [early.steps[4], early.steps[3]]
  settlePlanningInputs(early)
  assert.match(validatePlan(early).errors.join(';'), /base is used before it is created/)
})

test('named cut repairs can rewrite a step and clear derived box joints without changing photo identity', () => {
  const base = example(); settlePlanningInputs(base)
  const patch = { cuts: base.cuts, joints: [], steps: [{ at: 2, ...example().steps[1] }] }
  const repaired = patched(base, patch); settlePlanningInputs(repaired)
  assert.deepEqual(repaired.objects, base.objects)
  assert.deepEqual(repaired.joints, base.joints)
})

test('the compact wire plan survives HTTP planning, schema checks, geometry and actual Chrome playback', { timeout: 45000 }, async t => {
  const plan = example(), frozen = structuredClone(plan.objects), { objects, ...authored } = plan
  const wire = { ...authored, objectUpdates: [] }, schema = frozenPlanningSchema(frozen)
  for (const a of acts(wire).filter(a => a.v === 'place' && ['left', 'right'].includes(a.k))) { delete a.rel; a.to = 'base' }
  assert.deepEqual(schemaProblems(wire, schema), [])
  const dir = mkdtempSync(join(tmpdir(), 'rigid-build-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const stub = await stubModel({ answers: { InstructionPlan: wire } }); t.after(stub.close)
  const photo = await preparePhoto(fileURLToPath(new URL('../examples/photos/wood8.png', import.meta.url)), dir)
  const result = await writePlan(dir, photo, { inventory: frozen, provider: 'meta', baseURL: stub.url, apiKey: 'stub', maxRepairs: 0 })
  const screens = read('../examples/fixtures/wood8/screens/screens.json'), browser = await openPlanningBrowser(); t.after(browser.close)
  const cut = { geometry: read('../examples/fixtures/wood8/screens/geometry.json'), sizes: Object.fromEntries(Object.entries(screens).filter(([k]) => k !== 'photo').map(([k, s]) => [k, { width: s.width, height: s.height }])) }
  const graded = await gradePlan({ candidate: result.script, rawText: JSON.stringify(wire), rawSchema: schema, inventory: frozen, photo, cut, smoke: browser.smoke })
  assert.equal(graded.machine, 'pass', JSON.stringify(graded.findings))
  assert.equal(graded.rawFirstResponseValid, true)
  assert.ok(graded.grades.execution.frames > 0)
  const left = acts(graded.normalizedPlan).find(a => a.v === 'place' && a.k === 'left')
  assert.equal(left.rel, 'between'); assert.equal(left.to, 'front')
})
