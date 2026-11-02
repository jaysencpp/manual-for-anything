import sharp from 'sharp'
import { fileURLToPath } from 'node:url'
import { physicalPlan } from './support/physical-plan.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { streamedObjects, preparePhoto, planPhoto, patched, reshapeRepairProgress } from '../src/pipeline/plan.mjs'
import { validatePlan, validateObjects } from '../src/pipeline/validate.mjs'
import { plain } from '../src/pipeline/script.mjs'
import { geometryReview, solveBuild } from '../src/solvers/layout.mjs'
import { withTools } from '../src/solvers/tools.mjs'

const fixture = () => JSON.parse(readFileSync(new URL('../examples/fixtures/wood8/script.json', import.meta.url), 'utf8'))

test('object publication waits for complete JSON and handles quoted brackets and escapes', () => {
  const objects = [{ k: 'box', n: 'a ] box " with a slash \\', b: [1, 2, 3, 4], cm: 5 }]
  const text = '{"objects":' + JSON.stringify(objects)
  assert.equal(streamedObjects(text.slice(0, -1)), null)
  assert.deepEqual(streamedObjects(text), objects)
  assert.deepEqual(streamedObjects(text + ',"ideas":['), objects)
  assert.equal(streamedObjects('{"objects":[broken]}'), null)
})

test('valid current-contract fixtures pass while impossible cuts and unknown references fail', () => {
  const s = fixture(); assert.equal(validatePlan(s).valid, true)
  s.steps[0].do.push({ v: 'use', k: 'not-in-the-photo', with: 'saw' })
  assert.match(validatePlan(s).errors.join(';'), /unknown object/)
  const cut = fixture(), a = cut.steps.flatMap((s) => s.do).find((a) => a.v === 'cut')
  a.into[0].label = '999 cm'; a.into[0].cm = 999
  assert.match(validatePlan(cut).errors.join(';'), /cuts total/)
})

test('creation order, target placement and unsupported verbs are checked', () => {
  const s = fixture()
  s.steps.unshift({ t: 'Bad step', c: 'Use an uncut part', do: [{ v: 'place', k: 'side-a', to: 'base', rel: 'on' }, { v: 'invented', k: 'base' }] })
  const errors = validatePlan(s).errors.join('; ')
  assert.match(errors, /before it is created/); assert.match(errors, /must be placed/); assert.match(errors, /unsupported action/)
})

test('bad boxes, duplicate IDs and malformed plans fail without crashing', () => {
  assert.equal(validatePlan(null).valid, false)
  const s = fixture(); s.objects.push({ ...s.objects[0] }); s.objects[0].b = [0, 0, 101, 100]
  const errors = validateObjects(s.objects, { width: 100, height: 100 }).join('; ')
  assert.match(errors, /duplicate/); assert.match(errors, /outside/)
})

test('kerf is an explicit assumption warning, not a claim of physical certification', () => {
  const s = fixture(), v = validatePlan(s)
  assert.match(v.warnings.join('; '), /3 mm saw kerf/)
  assert.match(v.warnings.join('; '), /model estimates/)
})

test('cut lengths in millimetres and metres normalize to the same centimetre geometry', () => {
  const original = fixture(), mixed = fixture()
  const cut = mixed.steps.flatMap((s) => s.do).find((a) => a.v === 'cut')
  cut.into[0].label = '800 mm'; cut.into[1].label = '0.16 m'; cut.into[2].label = '160 MM'
  assert.deepEqual(plain(mixed), plain(original))
  assert.deepEqual(plain(plain(mixed)), plain(mixed))
})

test('a phone JPEG is normalized with EXIF orientation before dimensions are read', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'meta-photo-test-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const source = join(dir, 'phone.jpg')
  await sharp({ create: { width: 40, height: 20, channels: 3, background: 'gray' } }).withMetadata({ orientation: 6 }).jpeg().toFile(source)
  const photo = await preparePhoto(source, join(dir, 'normalized'))
  assert.equal(photo.width, 20); assert.equal(photo.height, 40)
  assert.equal(readFileSync(photo.path).subarray(1, 4).toString(), 'PNG')
})

test('the planner publishes inventory early and returns a validated script through the real HTTP adapter', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'meta-planner-http-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const script = fixture(); for (const o of script.objects) o.b = [1, 1, 10, 10]
  const source = fileURLToPath(new URL('../examples/photos/wood8.png', import.meta.url))
  const prefix = '{"objects":' + JSON.stringify(script.objects)
  const rest = ',' + JSON.stringify(Object.fromEntries(Object.entries(script).filter(([k]) => k !== 'objects'))).slice(1)
  const server = createServer(async (req, res) => {
    let data = ''; for await (const chunk of req) data += chunk
    const request = JSON.parse(data)
    assert.equal(request.response_format.type, 'json_schema')
    assert.ok(request.messages[1].content.some((c) => c.type === 'image_url'))
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: prefix } }] })}\n\n`)
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: rest }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 100 } })}\n\ndata: [DONE]\n\n`)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  let latest = '', publishedEarly = false
  const result = await planPhoto(source, dir, { provider: 'meta', apiKey: 'fake-planner-key', baseURL: `http://127.0.0.1:${server.address().port}/v1/`,
    onText: (text) => { latest = text }, onObjects: (objects) => { publishedEarly = !latest.includes('"steps"'); assert.equal(objects.length, script.objects.length) },
  })
  assert.equal(publishedEarly, true); assert.equal(result.validation.valid, true)
  assert.equal(JSON.parse(readFileSync(join(dir, 'script.json'), 'utf8')).title, script.title)
})

test('a single repair keeps the published inventory fixed and records both attempts', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'meta-plan-repair-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const original = fixture(); for (const o of original.objects) o.b = [1, 1, 10, 10]
  const broken = structuredClone(original); broken.steps[0].do.push({ v: 'measure', k: 'missing-object' })
  let calls = 0
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    // (the repair is a patch of what failed: the objects are given as final)
    if (calls) assert.match(JSON.parse(body).messages[1].content[0].text, /its objects are final and already segmented/)
    const content = JSON.stringify(calls++ ? original : broken)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 100 } })}\n\ndata: [DONE]\n\n`)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  let publications = 0
  const result = await planPhoto(fileURLToPath(new URL('../examples/photos/wood8.png', import.meta.url)), dir, {
    provider: 'meta', apiKey: 'fake-repair-key', baseURL: `http://127.0.0.1:${server.address().port}/v1/`, onObjects: () => publications++,
  })
  assert.equal(calls, 2); assert.equal(publications, 1)
  assert.equal(result.call.firstPassValid, false); assert.equal(result.call.planAttempts, 2)
  assert.equal(result.call.usage.prompt_tokens, 200)
  assert.equal(result.validation.valid, true)
  assert.equal(JSON.parse(readFileSync(join(dir, 'validation-0.json'), 'utf8')).valid, false)
})

test('repairs cannot replace the inventory after segmentation has started', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'meta-plan-freeze-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const original = fixture(); for (const o of original.objects) o.b = [1, 1, 10, 10]
  const broken = structuredClone(original); broken.steps[0].do.push({ v: 'measure', k: 'missing-object' })
  let calls = 0
  const server = createServer((req, res) => {
    req.resume()
    const next = calls++ ? structuredClone(original) : broken
    if (calls > 1) next.objects[0].cm += 10
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(next) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  await assert.rejects(planPhoto(fileURLToPath(new URL('../examples/photos/wood8.png', import.meta.url)), dir, {
    provider: 'meta', apiKey: 'fake-freeze-key', baseURL: `http://127.0.0.1:${server.address().port}/v1/`,
  }), /unknown object missing-object/)
  assert.match(JSON.stringify(JSON.parse(readFileSync(join(dir, 'repair-1.json'))).newErrors), /Repair changed the inventory/)
  assert.equal(JSON.parse(readFileSync(join(dir, 'repair-1.json'))).accepted, false)
  // (the patch, then the whole plan once: both changed the inventory)
  assert.equal(calls, 3)
})

test('the full pipeline exits promptly when planning credentials are missing instead of waiting on inventory', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'meta-pipeline-failure-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../src/pipeline/run.mjs', import.meta.url)),
    fileURLToPath(new URL('../examples/photos/wood8.png', import.meta.url)), dir], {
    env: { ...process.env, MODEL_PROVIDER: 'meta', MODEL_API_KEY: '', META_API_KEY: '' }, encoding: 'utf8', timeout: 5000,
  })
  assert.equal(r.status, 1, r.stderr); assert.equal(r.signal, null)
  assert.match(r.stderr, /Set MODEL_API_KEY/)
})


test('state bookkeeping the planner gets wrong is settled before the checks, each repair noted', async () => {
  const { settleStates } = await import('../src/solvers/contracts.mjs')
  const s = fixture(); s.contractVersion = 2; s.joints ??= []; s.goals = [{ k: 'board-a', state: 'never' }]
  for (const o of s.objects) o.measurements ??= { cm: { status: 'estimated', source: 'test' }, w: { status: 'estimated', source: 'test' }, thick: { status: 'estimated', source: 'test' } }
  // (as a paperclip plan had it: a state required but never declared, a demonstration with no result, focus past 1)
  const demo = { v: 'demonstrate', id: 'bend', intent: 'Bend the end up', k: 'board-a', requires: [{ k: 'board-a', state: 'flat' }],
    focus: { k: 'board-a', bounds: [0.5, 0, 0.8, 1] }, demo: { actors: ['board-a'], draw: "(ctx, p, env, scene) => { scene.draw('board-a') }" } }
  s.steps[0].do.unshift(demo)
  const notes = settleStates(s)
  assert.deepEqual(demo.focus.bounds, [0.5, 0, 0.5, 1])
  assert.deepEqual(demo.effects, [{ k: 'board-a', state: 'bend-the-end-up' }])
  assert.equal(s.objects[0].state, 'flat')
  assert.deepEqual(s.objects[0].states.map((x) => x.id), ['flat', 'bend-the-end-up'])
  assert.deepEqual(s.goals, [])
  assert.equal(notes.length, 6, notes.join('; '))
  assert.doesNotMatch(validatePlan(s).errors.join('; '), /state|focus|goal/)
  // a plan with nothing to settle is left as it is
  const clean = fixture(); assert.deepEqual(settleStates(clean), []); assert.deepEqual(clean, fixture())
})

// A model stand-in that answers each request in turn, and keeps what it was asked (its prompt and its schema's name).
async function answering(t, answers) {
  const asked = []
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    const request = JSON.parse(body)
    asked.push({ prompt: request.messages.at(-1).content.find((c) => c.type === 'text').text, schema: request.response_format?.json_schema?.name,
      definition: request.response_format?.json_schema?.schema })
    const content = JSON.stringify(answers[Math.min(asked.length, answers.length) - 1])
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: content.length } })}\n\ndata: [DONE]\n\n`)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  return { asked, options: { provider: 'meta', apiKey: 'local-test-only', baseURL: `http://127.0.0.1:${server.address().port}/v1/` } }
}

test('an inventory-only physical response repairs with every physical field required and no invented root fields', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'meta-incomplete-plan-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const complete = fixture(); for (const o of complete.objects) o.b = [1, 1, 10, 10]
  // The real logs upload failed with objects and invented placeholders but no actual assembly instructions.
  const incomplete = { mode: 'physical', contractVersion: 2, objects: complete.objects, ideas_placeholder: [], unused: '' }
  const { asked, options } = await answering(t, [incomplete, complete])
  const result = await planPhoto(fileURLToPath(new URL('../examples/photos/wood8.png', import.meta.url)), dir, options)
  assert.equal(result.validation.valid, true)
  assert.deepEqual(asked.map((a) => a.schema), ['InstructionPlan', 'InstructionPlan'])
  const initial = asked[0].definition, physical = initial.anyOf.find((s) => s.properties.mode.enum.includes('physical'))
  assert.equal(initial.additionalProperties, false)
  for (const field of ['design', 'ideas', 'pick', 'title', 'steps', 'joints', 'goals', 'tools', 'finale', 'end']) {
    assert.ok(physical.required.includes(field), `${field} required on the first pass`)
    assert.ok(asked[1].definition.required.includes(field), `${field} required on repair`)
  }
  assert.deepEqual(asked[1].definition.properties.mode.enum, ['physical'])
  assert.equal(asked[1].definition.additionalProperties, false)
  assert.match(asked[1].prompt, /inventory has already been sent to segmentation/)
  assert.deepEqual(result.script.objects.map((o) => o.k), complete.objects.map((o) => o.k))
})

test('a plan with a fault in one step is repaired by a patch of that step alone', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'meta-plan-patch-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const original = fixture(); for (const o of original.objects) o.b = [1, 1, 10, 10]
  const broken = structuredClone(original); broken.steps[0].do.push({ v: 'measure', k: 'missing-object' })
  const { asked, options } = await answering(t, [broken, { steps: [{ at: 1, ...original.steps[0] }] }])
  const result = await planPhoto(fileURLToPath(new URL('../examples/photos/wood8.png', import.meta.url)), dir, options)
  assert.equal(result.validation.valid, true); assert.equal(result.call.planAttempts, 2); assert.equal(result.call.patches, 1)
  assert.deepEqual(asked.map((a) => a.schema), ['InstructionPlan', 'InstructionPlanPatch'])
  assert.match(asked[1].prompt, /step 1: k refers to unknown object missing-object/); assert.match(asked[1].prompt, /Leave out everything that passed/)
  assert.deepEqual(result.script.steps.map((s) => s.t), original.steps.map((s) => s.t))
})

test('a patch steps: rewritten and added by number, removed by number; a whole plan given as a patch is taken whole', () => {
  const base = { title: 'T', objects: [], steps: [{ t: 'one' }, { t: 'two' }, { t: 'three' }], joints: [{ id: 'a' }] }
  assert.deepEqual(patched(base, { steps: [{ at: 2, t: 'TWO' }, { at: 4, t: 'four' }], remove: [3], joints: [] }),
    { title: 'T', objects: [], steps: [{ t: 'one' }, { t: 'TWO' }, { t: 'four' }], joints: [] })
  assert.deepEqual(patched(base, { steps: [{ t: 'only' }] }).steps, [{ t: 'only' }])
  const whole = { title: 'New', objects: [], steps: [] }
  assert.equal(patched(base, whole), whole)
  assert.deepEqual(base.steps.length, 3)
  assert.throws(() => patched(base, []), /a patch must be a JSON object/)
  // (states redrawn: a photo object's and a cut part's, nothing else of either)
  const sheet = { k: 'sheet', n: 'paper', b: [1, 2, 3, 4], cm: 29, state: 'flat', states: [{ id: 'flat', label: 'Flat' }] }
  const folded = patched({ ...base, objects: [sheet], steps: [{ t: 'cut', do: [{ v: 'cut', k: 'sheet', into: [{ k: 'sq', label: 'square' }] }] }] },
    { states: [{ k: 'sheet', state: 'flat', states: [{ id: 'flat', label: 'Flat' }, { id: 'half', label: 'Halved' }] }, { k: 'sq', states: [{ id: 'tri', label: 'Triangle' }] }] })
  assert.deepEqual(folded.objects[0], { ...sheet, states: [{ id: 'flat', label: 'Flat' }, { id: 'half', label: 'Halved' }] })
  assert.deepEqual(folded.steps[0].do[0].into[0].states, [{ id: 'tri', label: 'Triangle' }]); assert.equal(sheet.states.length, 1)
})

test('a regressing geometry patch is rolled back and the remaining whole repair uses the intact plan', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'meta-plan-rollback-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const original = fixture(); for (const o of original.objects) o.b = [1, 1, 10, 10]
  const { asked, options } = await answering(t, [original, { remove: [2, 3] }, original])
  let checks = 0, rejections = 0
  const result = await planPhoto(fileURLToPath(new URL('../examples/photos/wood8.png', import.meta.url)), dir, { ...options,
    effort: 'medium', repairEffort: 'low', onRepairRejected: () => rejections++,
    checkPlan: () => checks++ ? [] : ['joint j: Joint surfaces do not touch: a exit plane x=0 cm, b receiving plane x=24 cm'],
  })
  assert.equal(result.validation.valid, true); assert.equal(rejections, 1)
  assert.deepEqual(asked.map((a) => a.schema), ['InstructionPlan', 'InstructionPlanPatch', 'InstructionPlan'])
  assert.doesNotMatch(asked[1].prompt, /Sizes people expect/)
  assert.match(asked[1].prompt, /exit plane x=0 cm/)
  assert.match(asked[2].prompt, /"t":"Cut base and ends"/)
  assert.deepEqual(result.script.steps.map((s) => s.t), original.steps.map((s) => s.t))
  assert.equal(JSON.parse(readFileSync(join(dir, 'repair-1.json'))).accepted, false)
  assert.ok(JSON.parse(readFileSync(join(dir, 'repair-1.json'))).after.errors.some((e) => /unknown object/.test(e)))
  assert.equal(JSON.parse(readFileSync(join(dir, 'request-0.json'))).effort, 'medium')
  assert.equal(JSON.parse(readFileSync(join(dir, 'request-1.json'))).effort, 'low')
  assert.equal(JSON.parse(readFileSync(join(dir, 'selected-attempt.json'))).attempt, 2)
})

test('an unnumbered partial patch cannot replace the manual and delete its creation steps', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'meta-plan-unnumbered-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const original = fixture(); for (const o of original.objects) o.b = [1, 1, 10, 10]
  const { options } = await answering(t, [original, { steps: [original.steps[4]] }, original])
  let checks = 0
  const result = await planPhoto(fileURLToPath(new URL('../examples/photos/wood8.png', import.meta.url)), dir, { ...options,
    checkPlan: () => checks++ ? [] : ['joint j: Joint surfaces do not touch'],
  })
  const rejected = JSON.parse(readFileSync(join(dir, 'repair-1.json')))
  assert.equal(rejected.accepted, false)
  assert.match(rejected.after.errors.join('; '), /patch step must include/)
  assert.equal(result.validation.valid, true)
  assert.deepEqual(result.script.steps.map((s) => s.t), original.steps.map((s) => s.t))
})

test('the saved backpack patch keeps its progress and the last repair receives only the missing result artwork', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'backpack-repair-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { plan, patch } = JSON.parse(readFileSync(new URL('support/backpack-repair.json', import.meta.url)))
  const fixed = patched(plan, patch)
  // Stand-in artwork verifies the repair contract, not the quality of a generated sewing instruction.
  fixed.objects[0].states.push({ id: 'overlapped', label: 'Overlapped ends', appearance: {
    width: 100, height: 100, shapes: [{ d: 'M30 38 H60 V55 H30 Z', fill: '#222222', stroke: '#ffffff' }],
  } })
  const { asked, options } = await answering(t, [plan, patch, fixed])
  const result = await planPhoto(fileURLToPath(new URL('../examples/photos/wood8.png', import.meta.url)), dir, options)
  assert.equal(result.validation.valid, true)
  const decision = JSON.parse(readFileSync(join(dir, 'repair-1.json')))
  assert.equal(decision.before.errors.length, 19); assert.equal(decision.after.errors.length, 1)
  assert.equal(decision.accepted, true); assert.deepEqual(decision.refinements, decision.newErrors)
  assert.match(asked[2].prompt, /reshaping needs a drawing \(appearance\).*overlapped/)
  assert.match(asked[2].prompt, /You may repair part\/state\/states information and state appearances/)
  assert.doesNotMatch(asked[2].prompt, /objects array EXACTLY unchanged/)
  assert.doesNotMatch(asked[2].prompt, /a demonstration needs drawing code/)
  assert.match(asked[1].prompt, /BOTH the resulting effect/)
  assert.equal(JSON.parse(readFileSync(join(dir, 'selected-attempt.json'))).attempt, 2)
})

test('reshape prerequisite progress is limited to the same unique operation and actor', () => {
  const before = { validation: { errors: ['a: reshaping must declare the shape bag ends in (an effect on bag)'] },
    script: { steps: [{ do: [{ id: 'a', v: 'reshape', k: 'bag' }] }] } }
  const candidate = { script: { steps: [{ do: [{ id: 'a', v: 'reshape', k: 'bag', effects: [{ k: 'bag', state: 'overlap' }] }] }] } }
  const error = 'a: reshaping needs a drawing (appearance) of bag:overlap'
  assert.equal(reshapeRepairProgress(before, candidate, error), true)
  for (const other of ['b: reshaping needs a drawing (appearance) of bag:overlap', 'a: reshaping needs a drawing (appearance) of other:overlap',
    'a: reshaping needs a drawing (appearance) of bag:other', 'joint j: Joint surfaces do not touch', 'Repair changed the inventory already published to segmentation'])
    assert.equal(reshapeRepairProgress(before, candidate, other), false)
  candidate.script.steps[0].do.push(candidate.script.steps[0].do[0])
  assert.equal(reshapeRepairProgress(before, candidate, error), false)
})

test('a backpack repair with an unrelated new failure is still rejected', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'backpack-regression-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { plan, patch } = JSON.parse(readFileSync(new URL('support/backpack-repair.json', import.meta.url)))
  patch.steps[0].do.push({ id: 'unknown', v: 'place', k: 'invented-object', rel: 'floor' })
  const { options } = await answering(t, [plan, patch, plan])
  await assert.rejects(planPhoto(fileURLToPath(new URL('../examples/photos/wood8.png', import.meta.url)), dir, options), /Invalid instruction plan/)
  assert.equal(JSON.parse(readFileSync(join(dir, 'repair-1.json'))).accepted, false)
  assert.equal(JSON.parse(readFileSync(join(dir, 'selected-attempt.json'))).valid, false)
})

test('retaining a partial backpack repair never releases a film without the required artwork', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'backpack-incomplete-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { plan, patch } = JSON.parse(readFileSync(new URL('support/backpack-repair.json', import.meta.url)))
  const { options } = await answering(t, [plan, patch, patched(plan, patch)])
  await assert.rejects(planPhoto(fileURLToPath(new URL('../examples/photos/wood8.png', import.meta.url)), dir, options), /reshaping needs a drawing/)
  assert.equal(JSON.parse(readFileSync(join(dir, 'repair-1.json'))).accepted, true)
  const validation = JSON.parse(readFileSync(join(dir, 'validation.json')))
  assert.equal(validation.valid, false); assert.equal(validation.errors.length, 1)
})

test('explicit operation face corrections update their joint instead of being undone by settling', () => {
  const base = { joints: [{ id: 'j', a: 'a', b: 'b', method: 'fasten', face: 'front', otherFace: 'front' }],
    steps: [{ do: [{ id: 'drill', joint: 'j', face: 'front' }] }, { do: [{ id: 'screw', joint: 'j', face: 'front' }] }] }
  const repair = { steps: [{ at: 1, do: [{ id: 'drill', joint: 'j', face: 'back' }] }, { at: 2, do: [{ id: 'screw', joint: 'j', face: 'back' }] }] }
  const result = patched(base, repair)
  assert.equal(result.joints[0].face, 'back'); assert.equal(result.joints[0].otherFace, 'back')
  assert.equal(base.joints[0].face, 'front')
  repair.steps[1].do[0].face = 'left'
  assert.throws(() => patched(base, repair), /Conflicting entry face edits/)
})

test('a reshape drawn the same before and after is sent back to be drawn as it looks', () => {
  const art = (d) => ({ width: 100, height: 80, shapes: [{ d, fill: '#ffffff', stroke: '#1d2b4f' }] })
  const plan = fixture()
  plan.objects[0].state = 'flat'
  plan.objects[0].states = [{ id: 'flat', label: 'Flat', appearance: art('M0 0 H100 V80 H0 Z') }, { id: 'folded', label: 'Folded', appearance: art('M0 0 H100 V80 H0 Z') },
    { id: 'bent', label: 'Bent', appearance: art('M0 0 L100 80 H0 Z') }]
  const k = plan.objects[0].k, step = (from, to) => ({ t: 'Fold it', c: 'Fold it in half.', do: [{ id: `r-${from}-${to}`, v: 'reshape', k, intent: 'Fold', requires: [{ k, state: from }], effects: [{ k, state: to }] }] })
  const soft = (from, to) => validatePlan({ ...plan, steps: [...plan.steps, step(from, to)] }, { width: 4000, height: 4000 }).soft.filter((m) => m.includes(k))
  assert.match(soft('flat', 'folded').join(), /same outline "flat" and "folded"/)
  assert.match(soft('flat', 'flat').join(), /shows no change/)
  assert.deepEqual(soft('flat', 'bent'), [])
})

test('geometry errors are repaired before returning even when background repair is requested', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'meta-plan-background-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const original = fixture(); for (const o of original.objects) o.b = [1, 1, 10, 10]
  const { asked, options } = await answering(t, [original, { steps: [{ at: 1, ...original.steps[0], t: 'Repaired' }] }])
  let checks = 0
  const result = await planPhoto(fileURLToPath(new URL('../examples/photos/wood8.png', import.meta.url)), dir, { ...options, background: true,
    checkPlan: async () => (checks++ ? [] : ['joint j: Work site 1 misses the receiving part']) })
  assert.equal(asked.length, 2); assert.equal(result.validation.valid, true)
  assert.equal(result.script.steps[0].t, 'Repaired'); assert.equal(result.revision, undefined)
})

test('a patch that runs on into fields it may not give is stopped there, and what came before is the patch (photo-mvsfpo7r)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'meta-plan-stray-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const original = fixture(); for (const o of original.objects) o.b = [1, 1, 10, 10]
  const broken = structuredClone(original); broken.steps[0].do.push({ v: 'measure', k: 'missing-object' })
  const chunk = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`
  let requests = 0, closedEarly = false
  const server = createServer(async (req, res) => {
    for await (const c of req);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if (requests++ === 0) return res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(broken) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
    // (the step it should give, then made-up fields with no end, as Muse's patch did)
    res.write(chunk(JSON.stringify({ steps: [{ at: 1, ...original.steps[0] }] }).slice(0, -1)))
    res.write(chunk(',"removeDep":[],"removeIds":[],"txt":0,"html":0'))
    for (let i = 0; i < 2000 && !res.destroyed; i++) { res.write(chunk(`,"x${i}":0`)); await new Promise((r) => setTimeout(r, 2)) }
    closedEarly = res.destroyed
    res.end()
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close() })
  const started = performance.now()
  const result = await planPhoto(fileURLToPath(new URL('../examples/photos/wood8.png', import.meta.url)), dir, { provider: 'meta', apiKey: 'local-test-only', baseURL: `http://127.0.0.1:${server.address().port}/v1/` })
  assert.ok(performance.now() - started < 3000, 'stopped long before the made-up fields ran out')
  assert.equal(result.validation.valid, true); assert.equal(requests, 2); assert.equal(result.call.requests[1].strayed, true)
  assert.match(readFileSync(join(dir, 'out-1.partial.txt'), 'utf8'), /removeDep/)
  assert.equal(JSON.parse(readFileSync(join(dir, 'out-1.partial.json'))).aborted, true)
  assert.ok(JSON.parse(readFileSync(join(dir, 'patch-1.json'))).steps.length)
  assert.deepEqual(result.script.steps.map((s) => s.t), original.steps.map((s) => s.t))
})

test('a cup caption moving a pouch is repaired through a bounded step patch without relabeling the photo', async (t) => {
  const { stubModel } = await import('./support/stub-model.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'caption-repair-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const inventory = [
    { k: 'mat', n: 'cork mat', b: [0, 0, 80, 80], cm: 12 },
    { k: 'pouch', n: 'teal fabric pouch', b: [100, 0, 80, 80], cm: 10 },
  ]
  const script = physicalPlan({ title: 'Coffee', view: 'side', objects: inventory, tools: [],
    ideas: [0, 1, 2].map(i => ({ title: `Idea ${i}`, pitch: 'Coffee' })), pick: 0,
    steps: [{ t: 'Prepare mat', c: 'Place the mat', do: [{ v: 'place', k: 'mat', rel: 'floor' }] },
      { t: 'Serve', c: 'Rest the finished cup on the cork mat', do: [{ v: 'place', k: 'pouch', to: 'mat', rel: 'on' }] }], finale: [] })
  const seen = [], stub = await stubModel({ seen, answers: { InstructionPlan: script,
    InstructionPlanPatch: { tools: [{ k: 'cup', use: 'bowl' }], steps: [{ at: 2, t: 'Serve', c: 'Rest the finished cup on the cork mat',
      claims: ['serve'], do: [{ v: 'place', id: 'serve', intent: 'place', k: 'cup', to: 'mat', rel: 'on' }] }] } } }); t.after(stub.close)
  const result = await planPhoto(fileURLToPath(new URL('../examples/photos/wood8.png', import.meta.url)), dir, { provider: 'meta', apiKey: 'local-test', baseURL: stub.url, maxRepairs: 1 })
  assert.equal(result.validation.valid, true, result.validation.errors.join('\n'))
  assert.deepEqual(result.script.objects, inventory)
  assert.equal(result.script.steps[1].do[0].k, 'cup')
  assert.equal(seen.filter(r => r.name === 'InstructionPlanPatch').length, 1)
  assert.match(seen.find(r => r.name === 'InstructionPlanPatch').prompt, /caption names a cup but placement moves pouch/)
})

test('conflicting strand geometry requests a whole repair and preserves the inventory length', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'meta-strand-length-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const complete = JSON.parse(readFileSync(new URL('../examples/fixtures/wire-bracelet/script.json', import.meta.url), 'utf8'))
  complete.goals = []
  complete.steps = [{ t: 'Lay wire', c: 'Lay the wire flat.', claims: ['lay'], do: [{ id: 'lay', v: 'place', intent: 'place', k: 'copper-wire', rel: 'floor' }] },
    { t: 'Coil wire', c: 'Coil all 45 cm.', claims: ['coil'], do: [{ id: 'coil', v: 'strand', intent: 'coil', op: 'coil', k: 'copper-wire', label: '45 cm' }] }]
  complete.objects[0].b = [1, 1, 10, 10]
  const broken = structuredClone(complete)
  broken.objects[0].part.size[0] = 300
  const { asked, options } = await answering(t, [broken, complete])
  const result = await planPhoto(fileURLToPath(new URL('../examples/photos/wood8.png', import.meta.url)), dir, { ...options, maxRepairs: 1 })
  assert.equal(result.validation.valid, true)
  assert.deepEqual(asked.map(a => a.schema), ['InstructionPlan', 'InstructionPlan'])
  assert.match(asked[1].prompt, /strand length mismatch/)
  assert.match(asked[1].prompt, /Keep every object's key, name, segment class, photo box, dimensions/)
  assert.equal(result.script.objects[0].cm, 45)
  assert.equal(result.script.objects[0].part.size[0], 45)
})

test('the saved 35 cm rope coil passes geometry on the first attempt without repair churn', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'meta-rope-envelope-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const plan = JSON.parse(readFileSync(new URL('support/rope-coil-plan.json', import.meta.url), 'utf8'))
  plan.objects[0].b = [1, 1, 10, 10]
  const { asked, options } = await answering(t, [plan])
  let checks = 0
  const result = await planPhoto(fileURLToPath(new URL('../examples/photos/wood8.png', import.meta.url)), dir, { ...options, checkPlan: script => {
    checks++
    const fitted = withTools(script, { 'rope-1': { origin: [0, 0], seat: [100, 0], base: [100, 200] } }, { 'rope-1': { width: 200, height: 200 } }, {})
    return geometryReview(script, solveBuild(script, fitted.geometry, fitted.sizes))
  } })
  assert.equal(result.validation.valid, true)
  assert.equal(checks, 1)
  assert.equal(asked.length, 1, 'the original plan needs no repair calls')
  assert.equal(result.script.objects[0].cm, 35)
  assert.deepEqual(result.script.design.size, [11, 11, 2])
})

test('a knot-spacing repair receives material and clamp facts and can simplify the design', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'meta-knot-spacing-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const plan = JSON.parse(readFileSync(new URL('support/two-knot-rope-plan.json', import.meta.url), 'utf8'))
  plan.objects[0].b = [1, 1, 10, 10]
  const patch = { remove: [5, 6], design: { ...plan.design, size: [36, 9, 2],
    purpose: 'A rope with one stopper knot', standard: 'One knotted end and a free rope tail',
    joins: 'One overhand stopper knot; the second knot is omitted to leave free rope.' } }
  const { asked, options } = await answering(t, [plan, patch])
  const result = await planPhoto(fileURLToPath(new URL('../examples/photos/wood8.png', import.meta.url)), dir, { ...options, maxRepairs: 1,
    checkPlan: script => {
      const fitted = withTools(script, { rope: { origin: [0, 0], seat: [100, 0], base: [100, 200] } }, { rope: { width: 200, height: 200 } }, {})
      return geometryReview(script, solveBuild(script, fitted.geometry, fitted.sizes))
    } })
  assert.equal(result.validation.valid, true, result.validation.errors.join('; '))
  assert.deepEqual(asked.map(a => a.schema), ['InstructionPlan', 'InstructionPlanPatch'])
  assert.match(asked[1].prompt, /knot spacing:.*at least 67.4 cm/)
  assert.match(asked[1].prompt, /effective centre 18.3 cm \(clamped/)
  assert.match(asked[1].prompt, /Do not repeat ineffective position edits or change published inventory/)
  assert.deepEqual(result.script.objects, plan.objects, 'the repair cannot invent a longer or thinner rope')
  assert.equal(result.script.steps.flatMap(s => s.do).filter(a => a.op === 'knot').length, 1)
})
