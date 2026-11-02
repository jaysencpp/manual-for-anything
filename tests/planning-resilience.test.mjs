import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stageEfforts, effortArgs } from '../src/pipeline/efforts.mjs'
import { solveJoints } from '../src/solvers/joints.mjs'
import { checkConnections } from '../src/solvers/connections.mjs'
import { preparePhoto, writePlan } from '../src/pipeline/plan.mjs'
import { stubModel, wood8Plan } from './support/stub-model.mjs'
import { groupedInventoryProblems } from '../src/pipeline/validate.mjs'
import { settleOperations } from '../src/solvers/contracts.mjs'
import { PERCEPTION_SCHEMA, PLAN_SCHEMA } from '../src/pipeline/plan-schema.mjs'

test('medium planning uses fast perception and separately configurable repair, drawing and catalogue effort', () => {
  assert.deepEqual(stageEfforts(['--effort', 'medium'], {}), { base: 'medium', plan: 'medium', perception: 'minimal', repair: 'low', drawing: 'minimal', catalogue: 'low' })
  const result = stageEfforts(['--effort', 'medium', '--repair-effort', 'high'], { DRAWING_EFFORT: 'minimal' })
  assert.equal(result.repair, 'high'); assert.equal(result.drawing, 'minimal')
  assert.equal(stageEfforts(effortArgs(result), {}).plan, 'medium')
  assert.throws(() => stageEfforts(['--perception-effort', 'invalid'], {}), /perception effort/)
  assert.ok(Object.values(stageEfforts(['--no-thinking', '--plan-effort', 'medium'], {})).every((value) => value === 'minimal'))
})

test('perception publishes inventory before a physical-only plan with no root union is requested', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'perception-plan-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const seen = [], stub = await stubModel({ answers: { InstructionPlan: wood8Plan() }, seen }); t.after(stub.close)
  const photo = await preparePhoto(fileURLToPath(new URL('../examples/photos/wood8.png', import.meta.url)), dir)
  let publishedAfter = null
  const result = await writePlan(dir, photo, { provider: 'meta', apiKey: 'stub', baseURL: stub.url, perception: true,
    effort: 'medium', perceptionEffort: 'minimal', onObjects: () => { publishedAfter = seen.length } })
  assert.equal(result.validation.valid, true)
  assert.equal(publishedAfter, 1)
  assert.deepEqual(seen.map((r) => [r.name, r.effort]), [['PhotoPerception', 'minimal'], ['InstructionPlan', 'medium']])
  assert.equal(seen[0].schema.anyOf, undefined); assert.equal(seen[1].schema.anyOf, undefined)
  assert.deepEqual(seen[1].schema.properties.mode.enum, ['physical'])
  assert.ok(seen[1].schema.required.includes('design')); assert.ok(seen[1].schema.required.includes('steps'))
  assert.match(seen[1].prompt, /Keep this inventory/)
  assert.equal(JSON.parse(readFileSync(join(dir, 'perception-validation.json'))).valid, true)
  assert.ok(JSON.parse(readFileSync(join(dir, 'request-0.json'))).schemaHash)
  assert.equal(JSON.parse(readFileSync(join(dir, 'planning.json'))).perception.model, 'muse-wonder-1.0')
})

test('invalid perception is saved and never published to segmentation or used for planning', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'perception-invalid-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const seen = [], stub = await stubModel({ answers: { PhotoPerception: { mode: 'physical', objects: [] } }, seen }); t.after(stub.close)
  const photo = await preparePhoto(fileURLToPath(new URL('../examples/photos/wood8.png', import.meta.url)), dir)
  let published = false
  await assert.rejects(writePlan(dir, photo, { provider: 'meta', apiKey: 'stub', baseURL: stub.url, perception: true,
    onObjects: () => { published = true } }), /Invalid photo perception/)
  assert.equal(published, false); assert.equal(seen.length, 2)
  assert.equal(JSON.parse(readFileSync(join(dir, 'perception-validation.json'))).valid, false)
})

test('off-photo detections are omitted before segmentation and planning without a repair request', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'perception-off-photo-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const photo = await preparePhoto(fileURLToPath(new URL('../examples/photos/wood8.png', import.meta.url)), dir)
  const outside = [[photo.width + 15, 218, 185, 647], [-30, 20, 30, 40], [20, photo.height, 30, 40], [20, -40, 30, 40]]
    .map((b, i) => ({ k: `off-photo-${i}`, n: 'Bottle', segment: 'glass bottle', b, cm: 27 }))
  const seen = [], stub = await stubModel({ seen, answers: {
    PhotoPerception: { mode: 'physical', objects: [...wood8Plan().objects, ...outside] }, InstructionPlan: wood8Plan(),
  } }); t.after(stub.close)
  let published
  const result = await writePlan(dir, photo, { provider: 'meta', apiKey: 'stub', baseURL: stub.url, perception: true,
    onObjects: objects => { published = objects } })
  assert.equal(result.validation.valid, true)
  assert.deepEqual(published, wood8Plan().objects)
  assert.deepEqual(result.script.objects.map(o => o.k), published.map(o => o.k))
  assert.deepEqual(seen.map(r => r.name), ['PhotoPerception', 'InstructionPlan'])
  assert.doesNotMatch(seen[1].prompt, /off-photo-/)
  const validation = JSON.parse(readFileSync(join(dir, 'perception-validation.json')))
  assert.equal(validation.valid, true)
  assert.deepEqual(validation.omittedObjects.map(o => o.k), outside.map(o => o.k))
})

test('an inventory entirely outside the photo still retries and fails without publishing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'perception-all-outside-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const photo = await preparePhoto(fileURLToPath(new URL('../examples/photos/wood8.png', import.meta.url)), dir)
  const seen = [], stub = await stubModel({ seen, answers: {
    PhotoPerception: { mode: 'physical', objects: [{ k: 'bottle', n: 'Bottle', segment: 'glass bottle', b: [photo.width + 15, 218, 185, 647], cm: 27 }] },
  } }); t.after(stub.close)
  let published = false
  await assert.rejects(writePlan(dir, photo, { provider: 'meta', apiKey: 'stub', baseURL: stub.url, perception: true,
    onObjects: () => { published = true } }), /objects must be a nonempty array/)
  assert.equal(published, false)
  assert.deepEqual(seen.map(r => r.name), ['PhotoPerception', 'PhotoPerception'])
})

test('the failed upload collection is rejected, while continuous ingredients and individual stock remain valid', () => {
  assert.match(groupedInventoryProblems([{ k: 'split-firewood-logs', n: 'Pile of split firewood logs', segment: 'freeform-stack' }]).join('; '), /each visible independently usable piece/)
  assert.deepEqual(groupedInventoryProblems([{ k: 'rice', n: 'Pile of rice', segment: 'rice' }, { k: 'log-a', n: 'Split log', segment: 'split log' }]), [])
})

test('grouped stock is re-read from the photo before segmentation receives the corrected inventory', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'perception-instances-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  let readings = 0
  const seen = [], answers = { InstructionPlan: wood8Plan(), get PhotoPerception() {
    return { mode: 'physical', objects: readings++ ? wood8Plan().objects : [{ k: 'logs', n: 'Pile of split firewood logs', segment: 'freeform-stack', cm: 35, b: [1, 1, 100, 100] }] }
  } }
  const stub = await stubModel({ answers, seen }); t.after(stub.close)
  const photo = await preparePhoto(fileURLToPath(new URL('../examples/photos/wood8.png', import.meta.url)), dir)
  let published = 0
  const result = await writePlan(dir, photo, { provider: 'meta', apiKey: 'stub', baseURL: stub.url, perception: true,
    onObjects: (objects) => { published++; assert.equal(seen.length, 2); assert.equal(objects.length, 3) } })
  assert.equal(result.validation.valid, true); assert.equal(published, 1)
  assert.deepEqual(seen.map((r) => r.name), ['PhotoPerception', 'PhotoPerception', 'InstructionPlan'])
  assert.match(seen[1].prompt, /Reinspect the ORIGINAL PHOTO/)
  assert.equal(JSON.parse(readFileSync(join(dir, 'perception-validation-0.json'))).valid, false)
  assert.equal(result.call.perception.attempts, 2)
})

test('the observed yarn metadata error is repaired before publishing physical yarn rather than blocking SAM', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'perception-yarn-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const yarn = { k: 'yarn', n: 'light blue yarn skein', segment: 'yarn skein', b: [1, 1, 10, 10], cm: 11,
    measurements: { cm: { source: 'single photo estimate', status: 'estimated' } } }
  const plan = { mode: 'physical', contractVersion: 2, objects: [yarn], title: 'Yarn example', sub: 'One skein', tag: 'Example', view: 'side',
    ideas: [0, 1, 2].map((i) => ({ title: `Idea ${i}`, pitch: 'Yarn example', kind: 'craft' })), pick: 0,
    design: { purpose: 'Present the yarn', standard: 'Photographed skein', parts: [{ k: 'yarn', from: 'yarn', cm: 11 }] },
    tools: [], joints: [], goals: [], steps: [{ t: 'Place the yarn', c: 'Place the skein', claims: ['p'], do: [{ id: 'p', intent: 'place', v: 'place', k: 'yarn', rel: 'floor' }] }], finale: [], end: 'Yarn ready' }
  let readings = 0, published = 0
  const seen = [], stub = await stubModel({ seen, answers: { InstructionPlan: plan, get PhotoPerception() {
    return { mode: 'physical', objects: [{ ...yarn, ...(readings++ ? {} : { contents: { name: 'light blue yarn skein with loose strand', form: 'pieces', color: 'pale blue', opacity: 1 } }) }] }
  } } }); t.after(stub.close)
  const photo = await preparePhoto(fileURLToPath(new URL('../examples/photos/yarn.png', import.meta.url)), dir)
  const result = await writePlan(dir, photo, { provider: 'meta', apiKey: 'stub', baseURL: stub.url, perception: true,
    onObjects: (objects) => { published++; assert.equal(seen.length, 2); assert.equal(objects[0].segment, 'yarn skein'); assert.equal(objects[0].contents, undefined) } })
  assert.equal(result.validation.valid, true); assert.equal(published, 1)
  assert.equal(result.script.mode, 'physical')
  assert.match(JSON.parse(readFileSync(join(dir, 'perception-validation-0.json'))).errors.join('; '), /contents/)
  assert.equal(PERCEPTION_SCHEMA.properties.objects.items.properties.contents, undefined)
  assert.equal(PERCEPTION_SCHEMA.properties.objects.items.additionalProperties, false)
  assert.ok(PLAN_SCHEMA.properties.objects.items.properties.contents.properties.color.pattern)
})

test('a dummy screw path does not turn a solid assembly into a flat sheet layout', () => {
  const script = { view: 'iso', objects: [{ k: 'log', n: 'log', cm: 35, part: { family: 'loose', shape: 'log', size: [35, 12, 12] } }],
    steps: [{ do: [{ v: 'place', k: 'log', rel: 'floor' }, { v: 'use', k: 'log', with: 'drill', intent: 'drill', path: [[0, 0], [1, 0]] }] }] }
  settleOperations(script)
  assert.equal(script.view, 'iso')
})

function uprightLogs() {
  const keys = ['a', 'b', 'c', 'd', 'e', 'f']
  const objects = keys.map((k) => ({ k, n: 'split log', cm: 25, part: { family: 'loose', shape: 'log', size: [25, 12, 12] } }))
  const placements = [{ v: 'place', k: 'a', rel: 'floor', stand: 'end' },
    ...[['b', 'a', 'right'], ['c', 'b', 'right'], ['d', 'a', 'back'], ['e', 'd', 'right'], ['f', 'e', 'right']].map(([k, to, side]) => ({ v: 'place', k, to, side, rel: 'parallel', stand: 'end', gap: 0 }))]
  const pairs = [['a', 'b', 'left'], ['b', 'c', 'left'], ['d', 'e', 'left'], ['e', 'f', 'left'], ['a', 'd', 'front'], ['c', 'f', 'front']]
  const script = { view: 'iso', objects, steps: [{ do: placements }], joints: pairs.map(([a, b, face], i) => ({ id: `j${i}`, a, b, face, otherFace: face, method: 'fasten', depthCm: 18, sites: [{ x: 0.3, lat: 0 }, { x: 0.7, lat: 0 }] })) }
  const geometry = Object.fromEntries(keys.map((k) => [k, { origin: [0, 0], seat: [50, 0], base: [50, 100] }]))
  const sizes = Object.fromEntries(keys.map((k) => [k, { width: 100, height: 100 }]))
  return { script, geometry, sizes }
}

test('two rows of upright logs have the intended envelope and all six joints make contact', () => {
  const { script, geometry, sizes } = uprightLogs(), layout = solveJoints(script, geometry, sizes)
  const parts = Object.values(layout.world)
  const dimensions = ['x', 'y', 'z'].map((ax) => Math.max(...parts.map((p) => p.p[ax] + p.e[ax])) - Math.min(...parts.map((p) => p.p[ax])))
  assert.deepEqual(dimensions, [36, 24, 25])
  assert.deepEqual(layout.diagnostics, [])
  assert.equal(layout.connections.length, 6)
})

test('geometry diagnostics distinguish wrong entry faces from a genuinely misplaced second row', () => {
  const { script, geometry, sizes } = uprightLogs(), layout = solveJoints(script, geometry, sizes)
  const reversed = { ...script.joints[0], face: 'right', otherFace: 'right' }
  const first = checkConnections({ joints: [reversed] }, layout.world).problems[0]
  assert.match(first.message, /use entry face left/)
  assert.equal(first.details.separation, 24)
  assert.equal(first.details.units, 'cm')
  const wrong = structuredClone(layout.world); wrong.d.p.x += 42; wrong.d.p.y = wrong.a.p.y
  const second = checkConnections({ joints: [script.joints[4]] }, wrong).problems[0]
  assert.match(second.message, /independent floor placement does not define a second row/)
  assert.ok(second.details.a.bounds.x); assert.ok(second.details.b.bounds.y)
})

test('explicit edge alignment joins unequal upright logs without stretching or moving neighbours', () => {
  const { script, geometry, sizes } = uprightLogs()
  script.objects = script.objects.slice(0, 4)
  script.objects.forEach((o, i) => { const w = [16, 14, 15, 14][i]; o.cm = 32; o.part.size = [32, w, w] })
  script.steps = [{ do: [{ v: 'place', k: 'a', rel: 'floor', stand: 'end' },
    { v: 'place', k: 'b', rel: 'parallel', to: 'a', side: 'right', stand: 'end' },
    { v: 'place', k: 'c', rel: 'parallel', to: 'a', side: 'front', stand: 'end' },
    { v: 'place', k: 'd', rel: 'parallel', to: 'c', side: 'right', stand: 'end' }] }]
  script.joints = [['a', 'b', 'left'], ['c', 'd', 'left'], ['a', 'c', 'back'], ['b', 'd', 'back']].map(([a, b, face], i) => ({ id: `j${i}`, a, b, face, otherFace: face, method: 'fasten', depthCm: 20, sites: [{ x: 0.3, lat: 0 }, { x: 0.7, lat: 0 }] }))
  const before = solveJoints(script, geometry, sizes)
  assert.equal(before.diagnostics.length, 1)
  assert.match(before.diagnostics[0].message, /align:"back"/)
  script.steps[0].do[3].align = 'back'
  const after = solveJoints(script, geometry, sizes)
  assert.deepEqual(after.diagnostics, []); assert.equal(after.connections.length, 4)
  for (const key of ['a', 'b', 'c']) assert.deepEqual(after.world[key], before.world[key])
  assert.deepEqual(after.world.d.e, before.world.d.e)
  assert.equal(after.world.d.p.y - before.world.d.p.y, 1)
})
