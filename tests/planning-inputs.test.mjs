import { chromePresent } from '../benchmarks/drawing-chrome.mjs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { settlePlanningInputs, materialPlanningPrompt, hydrateInventory } from '../src/pipeline/planning-inputs.mjs'
import { schemaProblems, inventoryProblems, gradePlan } from '../benchmarks/planning-grade.mjs'
import { PHYSICAL_PLAN_SCHEMA, frozenPlanningSchema } from '../src/pipeline/plan-schema.mjs'
import { designProblems, validatePlan } from '../src/pipeline/validate.mjs'
import { sheetExample } from './support/sheet-example.mjs'
import { solveJoints } from '../src/solvers/joints.mjs'
import { checkConnections } from '../src/solvers/connections.mjs'
import { openPlanningBrowser } from '../benchmarks/planning-browser.mjs'
import { checkDemonstration, demonstrationDrawing } from '../src/film/demonstrations.mjs'
import { preparePhoto, writePlan } from '../src/pipeline/plan.mjs'
import { stubModel, wood8Plan } from './support/stub-model.mjs'
import { fixtureProjection } from '../benchmarks/stage-bench-cases.mjs'

test('schemas reject missing cut outputs, work progress, demonstration data and brick height', () => {
  const schema = PHYSICAL_PLAN_SCHEMA.properties.steps.items.properties.do.items
  const cut = { v: 'cut', id: 'c', intent: 'cut', k: 'board', with: 'saw' }
  assert.ok(schemaProblems(cut, schema).length)
  assert.deepEqual(schemaProblems({ ...cut, into: [{ k: 'side', cm: 20, label: '20 cm' }] }, schema), [])
  assert.ok(schemaProblems({ ...cut, into: [{ k: 'side', label: '20 cm' }] }, schema).length)
  assert.deepEqual(schemaProblems({ ...cut, shape: [[0, 0], [1, 0], [1, 1]] }, schema), [])
  assert.ok(schemaProblems({ v: 'work', id: 'w', intent: 'work', k: 'basket' }, schema).length)
  assert.ok(schemaProblems({ v: 'demonstrate', id: 'd', intent: 'stitch', k: 'basket' }, schema).length)
  const part = PHYSICAL_PLAN_SCHEMA.properties.objects.items.properties.part
  assert.ok(schemaProblems({ family: 'brick', studs: [2, 2] }, part).length)
  assert.deepEqual(schemaProblems({ family: 'brick', studs: [2, 2], plates: 3 }, part), [])
})

test('finished crochet size is independent of skein envelope while rigid stock stays conserved', () => {
  const script = { objects: [{ k: 'yarn', cm: 20 }], makes: [{ k: 'basket' }], steps: [],
    design: { parts: [{ k: 'basket', from: 'yarn', cm: 28 }] } }
  assert.deepEqual(designProblems(script), [])
  script.makes = []
  assert.match(designProblems(script).join('; '), /only 20 cm/)
  script.makes = [{ k: 'basket' }]
  script.design.parts.push({ k: 'stick', from: 'yarn', cm: 40 })
  assert.match(designProblems(script).join('; '), /only 20 cm/)
})

test('declared supply sheets compile, retain photo identity, and execute cuts and joins in Chrome', { skip: !chromePresent, timeout: 120000 }, async t => {
  const script = sheetExample(), stock = script.objects[0]
  script.objects = [{ k: 'scissors', n: 'Scissors', segment: 'scissors', b: [0, 0, 100, 50], cm: 18,
    measurements: { cm: { status: 'estimated', source: 'photo estimate' } }, toolKind: 'scissors' }]
  script.tools = script.tools.filter(o => o.k !== 'scissors')
  const inventory = structuredClone(script.objects)
  script.materials = [{ k: stock.k, n: 'Required extra card sheet', family: 'sheet', size: [40, 30, 0.1] }]
  script.supplies = ['One 40 × 30 cm sheet of card']
  settlePlanningInputs(script)
  const before = structuredClone(script)
  settlePlanningInputs(script); assert.deepEqual(script, before)
  assert.equal(script.objects[1].b, undefined)
  assert.deepEqual(inventoryProblems(script, inventory), [])
  script.objects[0].cm++
  assert.ok(inventoryProblems(script, inventory).length)
  script.objects[0].cm--
  const browser = await openPlanningBrowser(); t.after(browser.close)
  const grade = await gradePlan({ candidate: script, inventory, photo: { width: 100, height: 50 },
    cut: { geometry: { scissors: { origin: [0, 0], seat: [50, 0], base: [50, 50] } }, sizes: { scissors: { width: 100, height: 50 } } }, smoke: browser.smoke })
  assert.equal(grade.machine, 'pass', JSON.stringify(grade.findings))
  assert.ok(grade.grades.execution.frames > 0)
  const bad = structuredClone(script); bad.materials[0].k = 'scissors'
  assert.equal(validatePlan(bad).valid, false)
  const missing = structuredClone(script); delete missing.materials
  assert.equal(validatePlan(missing).valid, false)
})

function boxAssembly(endLength = 14) {
  const size = { base: [40, 18, 2], front: [40, 15, 2], back: [40, 15, 2], left: [endLength, 15, 2], right: [endLength, 15, 2] }
  const script = { view: 'iso', objects: Object.entries(size).map(([k, [cm, w, thick]]) => ({ k, cm, w, thick })),
    assembly: { kind: 'open-box', base: 'base', front: 'front', back: 'back', left: 'left', right: 'right' },
    steps: Object.keys(size).map(k => ({ do: [{ v: 'place', k, rel: 'floor' }] })),
    joints: [
      ...['front', 'back'].map(a => ({ id: `${a}-base`, a: 'base', b: a, method: 'fasten', face: 'lower', otherFace: 'lower', sites: [{ x: 0.5, lat: a === 'front' ? -0.45 : 0.45 }], depthCm: 3 })),
      ...['front', 'back'].flatMap(a => ['left', 'right'].map(b => ({ id: `${a}-${b}`, a, b, method: 'fasten', face: a, otherFace: a,
        sites: [{ x: b === 'left' ? 0.025 : 0.975, lat: -0.1 }], depthCm: 3 }))),
    ] }
  const geometry = Object.fromEntries(Object.keys(size).map(k => [k, { origin: [0, 0], seat: [50, 0], base: [50, 30] }]))
  const sizes = Object.fromEntries(Object.keys(size).map(k => [k, { width: 100, height: 30 }]))
  settlePlanningInputs(script)
  return { script, geometry, sizes }
}
test('box assembly compiles relationships with all joints touching and refuses an impossible end length', () => {
  const { script, geometry, sizes } = boxAssembly()
  const before = structuredClone(script); settlePlanningInputs(script); assert.deepEqual(script, before)
  const layout = solveJoints(script, geometry, sizes)
  assert.deepEqual(layout.diagnostics, [])
  assert.deepEqual(checkConnections(script, layout.world).problems, [])
  const bad = boxAssembly(18), wrong = solveJoints(bad.script, bad.geometry, bad.sizes)
  assert.ok(wrong.diagnostics.some(d => d.code === 'inconsistent-fit'))
  const missing = boxAssembly(); missing.script.steps.pop()
  assert.throws(() => settlePlanningInputs(missing.script), /explicit place action/)
})

test('material guidance distinguishes crochet progress, techniques and missing stock declarations', () => {
  const inventory = JSON.parse(readFileSync(new URL('../examples/fixtures/yarn/script.json', import.meta.url))).objects
  const prompt = materialPlanningPrompt(inventory)
  assert.match(prompt, /never its available yarn length/)
  assert.match(prompt, /intent:"work"/)
  assert.match(prompt, /materials:/)
})

test('inventory annotations cannot rewrite identity, duplicate keys or introduce stock', () => {
  const inventory = [{ k: 'yarn', n: 'Blue yarn', cm: 20, b: [1, 2, 3, 4], measurements: { cm: { status: 'estimated', source: 'photo' } } }]
  const wire = { objectUpdates: [{ k: 'yarn', part: { family: 'loose', size: [20, 10, 10] } }] }
  const plan = hydrateInventory(wire, inventory)
  assert.deepEqual(plan.objects[0].measurements, inventory[0].measurements)
  assert.deepEqual(plan.objects[0].b, inventory[0].b)
  plan.objects[0].b[0] = 999
  assert.equal(inventory[0].b[0], 1)
  for (const objectUpdates of [[{ k: 'paper' }], [{ k: 'yarn' }, { k: 'yarn' }], [{ k: 'yarn', cm: 999 }], [{ k: 'yarn', n: 'Paper' }]])
    assert.throws(() => hydrateInventory({ objectUpdates }, inventory))
  assert.throws(() => hydrateInventory({ ...wire, objects: inventory }, inventory), /cannot be combined/)
  const schema = frozenPlanningSchema(inventory)
  assert.equal(schema.properties.objects, undefined)
  assert.ok(schema.required.includes('objectUpdates'))
  const annotations = schema.properties.objectUpdates
  assert.deepEqual(schemaProblems(wire.objectUpdates, annotations), [])
  assert.ok(schemaProblems([{ k: 'paper' }], annotations).length)
  assert.ok(schemaProblems([{ k: 'yarn', cm: 999 }], annotations).length)
})

test('planner and grader share the annotation contract through real HTTP and Chrome', { skip: !chromePresent, timeout: 120000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'annotation-plan-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const authored = wood8Plan(); authored.design.standard ||= 'Saved test dimensions'
  const inventory = structuredClone(authored.objects)
  for (const o of inventory) o.segment ||= 'wooden board'
  authored.objects = inventory
  const schema = frozenPlanningSchema(inventory)
  const { objects, ...rest } = authored
  const wire = fixtureProjection({ ...rest, objectUpdates: objects.map(o => ({ k: o.k, ...(o.part ? { part: o.part } : {}) })) }, schema)
  assert.deepEqual(schemaProblems(wire, schema), [])
  const seen = [], stub = await stubModel({ answers: { InstructionPlan: wire }, seen }); t.after(stub.close)
  const photo = await preparePhoto(fileURLToPath(new URL('../examples/photos/wood8.png', import.meta.url)), dir)
  let publications = 0
  const result = await writePlan(dir, photo, { inventory, provider: 'meta', apiKey: 'stub', baseURL: stub.url, maxRepairs: 0,
    onObjects: os => { publications++; assert.deepEqual(os, inventory) } })
  assert.equal(publications, 1); assert.equal(result.validation.valid, true)
  assert.equal(seen[0].schema.properties.objects, undefined)
  const cutDir = new URL('../examples/fixtures/wood8/screens/', import.meta.url)
  const screens = JSON.parse(readFileSync(new URL('screens.json', cutDir)))
  const browser = await openPlanningBrowser(); t.after(browser.close)
  const cut = { geometry: JSON.parse(readFileSync(new URL('geometry.json', cutDir))), sizes: Object.fromEntries(Object.entries(screens).filter(([k]) => k !== 'photo').map(([k, s]) => [k, { width: s.width, height: s.height }])) }
  const grade = await gradePlan({ candidate: result.script, rawText: JSON.stringify(wire), rawSchema: schema, photo, cut, inventory, smoke: browser.smoke })
  assert.equal(grade.machine, 'pass', JSON.stringify(grade.findings))
  assert.equal(grade.rawFirstResponseValid, true)
  const malformed = { ...wire, objectUpdates: [{ k: inventory[0].k, cm: 999 }] }
  const rejected = await gradePlan({ candidate: result.script, rawText: JSON.stringify(malformed), rawSchema: schema, photo, cut, inventory, smoke: browser.smoke })
  assert.equal(rejected.machine, 'fail', 'A normalized candidate must not hide an invalid raw annotation')
})

test('structured weaving validates and plays in Chrome; invalid actors, paths and tools stay rejected', { skip: !chromePresent, timeout: 120000 }, async t => {
  const script = JSON.parse(readFileSync(new URL('../examples/fixtures/yarn/script.json', import.meta.url)))
  const piece = script.makes[0]; piece.state = 'unfinished'; piece.states = [{ id: 'unfinished', label: 'Ends loose' }, { id: 'finished', label: 'Ends woven in' }]
  script.tools.push({ k: 'needle', use: 'needle' })
  const demo = { actors: [piece.k, 'blue-yarn', 'needle'], technique: 'weave-ends', piece: piece.k, yarn: 'blue-yarn', needle: 'needle', path: [[0.2, 0.65], [0.35, 0.6], [0.5, 0.65], [0.65, 0.6]] }
  script.steps.push({ t: 'Weave ends', c: 'Pass the needle under and over the stitches, drawing the tail through.', claims: ['weave'], do: [{ id: 'weave', intent: 'weave-ends', v: 'demonstrate', k: piece.k,
    demo, focus: { k: piece.k, bounds: [0.1, 0.5, 0.7, 0.3] }, requires: [{ k: piece.k, state: 'unfinished' }], effects: [{ k: piece.k, state: 'finished' }] }] })
  script.goals.push({ k: piece.k, state: 'finished' })
  assert.equal(checkDemonstration(demo), null)
  assert.match(demonstrationDrawing(demo), /point01/)
  assert.equal(validatePlan(script).valid, true, JSON.stringify(validatePlan(script).errors))
  const folder = new URL('../examples/fixtures/yarn/screens/', import.meta.url), screens = JSON.parse(readFileSync(new URL('screens.json', folder)))
  const browser = await openPlanningBrowser(); t.after(browser.close)
  const grade = await gradePlan({ candidate: script, photo: screens.photo,
    cut: { geometry: JSON.parse(readFileSync(new URL('geometry.json', folder))), sizes: Object.fromEntries(Object.entries(screens).filter(([k]) => k !== 'photo').map(([k, s]) => [k, { width: s.width, height: s.height }])) }, smoke: browser.smoke })
  assert.equal(grade.machine, 'pass', JSON.stringify(grade.findings))
  assert.notEqual(checkDemonstration({ ...demo, path: [[0, 0], [0, 0], [1, 1]] }), null)
  assert.notEqual(checkDemonstration({ ...demo, draw: '(ctx)=>{}' }), null)
  const wrong = structuredClone(script); wrong.tools[0].use = 'hammer'
  assert.match(validatePlan(wrong).errors.join(';'), /needle tool/)
  const outside = structuredClone(script); outside.steps.at(-1).do[0].demo.path[0] = [0, 0]
  assert.match(validatePlan(outside).errors.join(';'), /focus region/)
})
