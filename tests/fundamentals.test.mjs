import { fileURLToPath } from 'node:url'
import { physicalPlan } from './support/physical-plan.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { planPhoto } from '../src/pipeline/plan.mjs'
import { operationSites, operationFacts, measurementFacts } from '../src/solvers/operations.mjs'
import { validatePlan, designProblems } from '../src/pipeline/validate.mjs'
import { validateContract, settleCaptions } from '../src/solvers/contracts.mjs'
import { plain } from '../src/pipeline/script.mjs'
import { facePoint, checkConnections } from '../src/solvers/connections.mjs'
import { workingRegion } from '../src/film/framing.mjs'
import { checkDemonstration, demonstrationFrame, demoPoint, demoPose } from '../src/film/demonstrations.mjs'
import { auditInstruction } from '../src/pipeline/evaluation.mjs'
import { solve, sizeProblems, builtProblems } from '../src/solvers/layout.mjs'
import { isSceneBuild } from '../src/solvers/scene.mjs'
import { solveJoints, isLog } from '../src/solvers/joints.mjs'
import { writeFaces } from '../src/pipeline/faces.mjs'
import { withTools } from '../src/solvers/tools.mjs'
import { program, timeline, heapSlots, foodColor } from '../src/film/engine.mjs'
import { readRun, filmProgram } from '../src/film/film.mjs'
import { refusedIn } from '../src/pipeline/words.mjs'
import { recordingCanvas, offlineEnv } from '../scripts/offline-canvas.mjs'

const root = fileURLToPath(new URL('../examples/fixtures/', import.meta.url))
const read = (name, file) => JSON.parse(readFileSync(join(root, name, file), 'utf8'))
const solid = (p, e, o = { L: 'x', W: 'y', T: 'z' }) => ({ p, e, o })
const sites = [{ x: 0.1, lat: -0.3 }, { x: 0.9, lat: -0.3 }, { x: 0.1, lat: 0.3 }, { x: 0.9, lat: 0.3 }]

test('repeated work sites preserve exact counts including nonmultiples and more than three rows', () => {
  for (const n of [1, 2, 3, 4, 5, 8, 16, 64]) {
    const s = operationSites({ n, x: [0.1, 0.9] })
    assert.equal(s.length, n)
    assert.ok(s.every((p) => p.x >= 0 && p.x <= 1 && Math.abs(p.lat) <= 0.5))
  }
  assert.throws(() => operationSites({ n: 1e9 }), /count/)
})

test('multi-part counts drive captions, facts and normalized action IDs without multiplying twice', () => {
  const script = physicalPlan({ steps: [{ caption: { template: 'Drive {count} screws', actions: ['drive'] }, claims: ['drive'],
    do: [{ id: 'drive', v: 'use', k: ['a', 'b'], sites, n: 4 }] }] })
  const s = plain(script)
  assert.equal(s.steps[0].c, 'Drive 8 screws')
  assert.equal(operationFacts(s).reduce((n, a) => n + a.count, 0), 8)
  assert.deepEqual(s.steps[0].claims, ['drive:a', 'drive:b'])
  assert.deepEqual(plain(s), s)
})

test('contradictory sites, unsupported intents and missing caption claims are rejected', () => {
  assert.match(validateContract({ steps: [{ do: [{ v: 'use', k: 'a', sites, n: 8 }] }] }).errors.join(), /disagree/)
  assert.match(validateContract({ steps: [{ do: [{ v: 'pour', k: 'pot', intent: 'ladle' }] }] }).errors.join(), /faithful demonstration/)
  assert.match(validateContract({ contractVersion: 2, steps: [{ do: [{ id: 'x', v: 'place', k: 'a', intent: 'place' }], claims: ['missing'] }] }).errors.join(), /missing operation/)
})

test('malformed contract collections and provenance return errors instead of crashing validation', () => {
  for (const s of [{ objects: {} }, { objects: [null], steps: [null] },
    { objects: [{ k: 'a', cm: 80, measurements: { cm: { status: 'confirmed', source: 123 } } }], steps: [{ do: [null] }] },
    { contractVersion: 2, joints: {}, goals: 'finished' }]) assert.equal(validatePlan(s).valid, false)
  const s = read('wood8', 'script.json')
  s.steps.flatMap((s) => s.do).find((a) => a.v === 'cut').into.push(null)
  assert.equal(validatePlan(s).valid, false)
})

test('face sites and receiver checks distinguish a real connection from a nearby decorative screw', () => {
  const world = { a: solid({ x: 0, y: 0, z: 2 }, { x: 80, y: 20, z: 2 }),
    b: solid({ x: 0, y: 0, z: 0 }, { x: 80, y: 20, z: 2 }) }
  const joint = { id: 'j', a: 'a', b: 'b', face: 'upper', otherFace: 'upper', method: 'fasten', sites, depthCm: 3 }
  assert.deepEqual(checkConnections({ joints: [joint] }, world).problems, [])
  assert.deepEqual(facePoint(world.a, 'upper', { x: 0.5, lat: 0 }), { x: 40, y: 10, z: 4 })
  world.b.p.x = 60
  assert.ok(checkConnections({ joints: [joint] }, world).problems.some((p) => p.code === 'missed-target'))
  world.b.p.z = -1
  assert.ok(checkConnections({ joints: [joint] }, world).problems.some((p) => p.code === 'no-contact'))
})

test('fastener depth cannot stop inside the first part or pass through the receiver', () => {
  const world = { a: solid({ x: 0, y: 0, z: 2 }, { x: 80, y: 20, z: 2 }), b: solid({ x: 0, y: 0, z: 0 }, { x: 80, y: 20, z: 2 }) }
  for (const depthCm of [1, 5]) assert.ok(checkConnections({ joints: [{ id: 'j', a: 'a', b: 'b', face: 'upper',
    otherFace: 'upper', method: 'fasten', sites, depthCm }] }, world).problems.some((p) => p.code === 'invalid-depth'))
})

test('declared joints cannot silently overwrite contradictory action data', () => {
  const s = physicalPlan({ joints: [{ id: 'j', a: 'a', b: 'b', face: 'upper', otherFace: 'upper', method: 'fasten', depthCm: 3, sites }],
    objects: [{ k: 'a' }, { k: 'b' }], steps: [{ do: [{ v: 'use', intent: 'drill', k: 'a', joint: 'j', n: 8 }] }] })
  assert.match(validateContract(s).errors.join(), /contradicts joint/)
  assert.throws(() => plain(s), /contradicts joint/)
  s.steps[0].do[0].n = 4
  assert.deepEqual(validateContract(s).errors, [])
})

test('state transitions require the actual prior state and reach the stated goal', () => {
  const s = physicalPlan({ objects: [{ k: 'food', state: 'packed', states: [{ id: 'packed', label: 'Packed' }, { id: 'unwrapped', label: 'Unwrapped' }, { id: 'cut', label: 'Cut' }] }],
    goals: [{ k: 'food', state: 'cut' }], steps: [{ do: [{ v: 'cut', k: 'food', requires: [{ k: 'food', state: 'unwrapped' }], effects: [{ k: 'food', state: 'cut' }] }] }] })
  assert.match(validateContract(s).errors.join(), /unmet state/)
  s.objects[0].state = 'unwrapped'
  assert.deepEqual(validateContract(s).errors, [])
  s.goals[0].state = 'packed'
  assert.match(validateContract(s).errors.join(), /unreached goal/)
})

test('gluing inaccessible mating faces after placing parts together is rejected', () => {
  const s = { objects: [{ k: 'a' }, { k: 'b' }], joints: [{ id: 'j', a: 'a', b: 'b', face: 'lower', otherFace: 'upper', method: 'glue', sites }],
    steps: [{ do: [{ v: 'place', k: 'a', to: 'b' }, { v: 'use', k: 'a', intent: 'glue', joint: 'j' }] }] }
  assert.match(validateContract(s).errors.join(), /glue must precede/)
})

test('measurement provenance never upgrades an unconfirmed photo estimate to confirmation', () => {
  assert.equal(measurementFacts({ objects: [{ k: 'a', cm: 80 }] })[0].status, 'estimated')
  assert.match(validateContract({ contractVersion: 2, objects: [{ k: 'a', cm: 80 }] }).errors.join(), /provenance/)
  const s = { contractVersion: 2, joints: [], goals: [], objects: [{ k: 'a', cm: 80, measurements: { cm: { status: 'confirmed', source: 'model says so' } } }] }
  assert.match(validateContract(s).errors.join(), /user-supplied measurement/)
  assert.deepEqual(validateContract(s, { confirmedMeasurements: { a: { cm: 80 } } }).errors, [])
  assert.match(validateContract(s, { confirmedMeasurements: { a: { cm: 90 } } }).errors.join(), /user-supplied measurement/)
})

test('demonstration checks reject undeclared actors, unbounded code and prohibited globals locally', () => {
  const demo = { actors: ['piece'], draw: '(ctx,p,env,scene) => { scene.draw("piece"); }' }
  assert.equal(checkDemonstration(demo), null)
  assert.match(checkDemonstration({ ...demo, draw: '() => { while(true) {} }' }), /timed out/)
  assert.match(checkDemonstration({ ...demo, draw: '() => fetch("x")' }), /refused/)
  assert.match(checkDemonstration({ ...demo, draw: '(ctx,p,env,scene) => scene.draw("unknown")' }), /undeclared/)
  assert.match(checkDemonstration({ ...demo, draw: '(ctx) => ctx.restore()' }), /Unbalanced/)
  assert.match(checkDemonstration({ ...demo, draw: '(ctx) => { ctx.filter="blur(10px)"; }' }), /Unsupported drawing property/)
  assert.match(checkDemonstration({ ...demo, draw: '(ctx) => { for(let i=0;i<600;i++) ctx.fillRect(0,0,1,1); }' }), /budget/)
  assert.match(checkDemonstration({ ...demo, draw: '(ctx,p,env,scene) => { scene.draw("piece"); scene.draw("piece"); }' }), /twice/)
})

test('demonstration coordinates support named fields, numeric indices and destructuring in validation and playback', () => {
  const point = demoPoint(40, 60), [x, y] = point
  assert.equal(point.x, x); assert.equal(point[1], y)
  const draw = '(ctx,p,env,scene) => { const a=scene.point("a",[0,0]); const [x,y]=a; scene.draw("a",{anchor:"center"}); ctx.beginPath(); ctx.moveTo(a[0],a.y); ctx.lineTo(x+10*p,y+10); ctx.stroke(); }'
  assert.equal(checkDemonstration({ actors: ['a'], draw }), null)
  const script = contractExample(); script.joints = []; script.tools = []
  script.steps[1] = { t: 'Show the seam', c: 'Show the operation', claims: ['demo'], do: [{ id: 'demo', v: 'demonstrate', intent: 'show a seam', k: 'a',
    requires: [{ k: 'a', state: 'ready' }], effects: [{ k: 'a', state: 'joined' }], focus: { k: 'a', bounds: [0, 0, 1, 1] }, demo: { actors: ['a'], draw } }] }
  const example = exampleProgram(script), act = example.times.acts.find((a) => a.v === 'demonstrate')
  for (const p of [0, 0.5, 1]) {
    const c = recordingCanvas(); example.draw(c.ctx, act.at + act.len * p - (p === 1 ? 0.01 : 0), example.env)
    assert.equal(c.depth(), 0)
    assert.ok(c.calls.some((call) => call.method === 'lineTo'))
  }
})

test('work-region framing honors local focus and tool clearance without including unrelated source stock', () => {
  const layout = { poses: { piece: { x: 500, y: 400, anchor: [0, 0], scale: 1 }, yarn: { x: -5000, y: 0, anchor: [0, 0], scale: 20 } } }
  const r = workingRegion({ k: 'piece', focus: { k: 'piece', bounds: [0.25, 0.25, 0.5, 0.5] } }, layout, { piece: { width: 50, height: 50 } })
  assert.deepEqual(r, { x0: 514, y0: 414, x1: 686, y1: 586 })
})

test('demonstrations separate whole actors from clipped marks and determine actor draws each frame', () => {
  const clip = (ctx, p, env, scene) => {
    ctx.save(); ctx.translate(12, 18); ctx.strokeStyle = '#123456'
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(20 * p, 10); ctx.stroke(); ctx.restore()
    if (p > .4 && p < .6) scene.draw('bag', { x: 100, y: 200 })
  }
  for (const p of [0, .5, 1]) {
    const c = recordingCanvas(), frame = demonstrationFrame(clip, p, {}, { check: k => assert.equal(k, 'bag') }, c.ctx)
    assert.equal(c.calls.length, 0, 'canvas marks wait until whole actors have been drawn')
    assert.equal(frame.draws.has('bag'), p === .5)
    if (p === .5) assert.deepEqual(demoPose(frame.draws.get('bag'), { width: 300, height: 400 }).anchor, [0, 0])
    c.ctx.mark('whole-bag'); c.ctx.save(); c.ctx.clip(); frame.paint(); c.ctx.restore()
    assert.ok(c.calls.findIndex(x => x.method === 'mark') < c.calls.findIndex(x => x.method === 'clip'))
    assert.ok(c.calls.findIndex(x => x.method === 'clip') < c.calls.findIndex(x => x.method === 'stroke'))
    assert.equal(c.depth(), 0)
  }
  assert.deepEqual(demoPose({ y: 40 }, { width: 300, height: 400 }), { y: 40 })
  assert.deepEqual(demoPose({ x: 100, y: 200, anchor: 'center' }, { width: 300, height: 400 }).anchor, [150, 200])
})

test('deterministic blockers remain visible independently of an attractive film score', () => {
  const script = read('wood8', 'script.json')
  const report = auditInstruction(script, { diagnostics: [{ message: 'Screw misses receiver' }] })
  assert.equal(report.valid, false); assert.ok(report.blockers.includes('Screw misses receiver'))
  assert.equal(report.physicalStrengthChecked, false)
})

function contractExample() {
  const measurement = { status: 'estimated', source: 'test input' }
  return { contractVersion: 2, view: 'iso', title: 'Joined panels', sub: 'Two panels', tag: 'Example', end: 'Finished',
    ideas: [0, 1, 2].map((i) => ({ title: `Idea ${i}`, pitch: 'An example', kind: 'build' })), pick: 0, finale: [], goals: [{ k: 'a', state: 'joined' }],
    design: { purpose: 'Two panels joined flat', standard: 'Panels 80 cm long', size: [80, 20, 4], parts: [{ k: 'a', from: 'a', cm: 80 }, { k: 'b', from: 'b', cm: 80 }], joins: 'Eight 3 cm screws', stands: 'Lies flat' },
    objects: ['a', 'b'].map((k) => ({ k, n: 'panel', segment: 'wooden board', b: [0, 0, 100, 30], cm: 80, w: 20, thick: 2,
      measurements: { cm: measurement, w: measurement, thick: measurement }, state: 'ready', states: [{ id: 'ready', label: 'Ready' }, { id: 'joined', label: 'Joined' }] })),
    tools: [{ k: 'driver', use: 'screwdriver' }, { k: 'screws', use: 'screw', cm: 3 }],
    joints: [{ id: 'j', a: 'a', b: 'b', face: 'upper', otherFace: 'upper', method: 'fasten', depthCm: 3, sites: operationSites({ n: 8, x: [0.1, 0.9] }) }],
    steps: [{ t: 'Position panels', c: 'Stack panels', claims: ['base', 'surface'], do: [
      { id: 'base', intent: 'place', v: 'place', k: 'b', rel: 'floor' },
      { id: 'surface', intent: 'place', v: 'place', k: 'a', to: 'b', rel: 'on' }] },
    { t: 'Join panels', c: 'Derived by compiler', caption: { template: 'Drive {count} screws', actions: ['drive'] }, claims: ['drive'], do: [
      { id: 'drive', intent: 'fasten', v: 'use', k: 'a', joint: 'j', with: 'driver', part: 'screws',
        requires: [{ k: 'a', state: 'ready' }], effects: [{ k: 'a', state: 'joined' }] }] }] }
}

function exampleProgram(input) {
  const script = plain(input), cut = Object.fromEntries(script.objects.map((o) => [o.k, { origin: [0, 0], seat: [50, 2], base: [50, 30], color: '#d9a96a' }]))
  const { geometry, sizes, vectors } = withTools(script, cut, Object.fromEntries(script.objects.map((o) => [o.k, { width: 100, height: 30 }])), {})
  const layout = solve(script, geometry, sizes)
  const source = program({ script, geometry, sizes, vectors, layout, boxes: Object.fromEntries(script.objects.map((o) => [o.k, o.b])), photo: { width: 100, height: 30 } })
  assert.deepEqual(refusedIn(source), [])
  const draw = new Function(`return (${source})`)()
  return { script, layout, draw, times: timeline(script), env: offlineEnv() }
}

test('the real film program leaves exactly eight heads for eight canonical work sites', () => {
  const old = globalThis.Path2D; globalThis.Path2D = class {}
  try {
    const e = exampleProgram(contractExample()), act = e.times.acts.find((a) => a.id === 'drive'), c = recordingCanvas()
    assert.equal(e.script.steps[1].c, 'Drive 8 screws')
    e.draw(c.ctx, act.at + act.len + 0.05, e.env)
    assert.equal(c.calls.filter((c) => c.method === 'ellipse' && c.args[2] === 11 && c.args[3] === 5).length, 8)
    assert.equal(c.depth(), 0)
  } finally { globalThis.Path2D = old }
})

test('custom operation uses the declared actors and commits a persistent resulting appearance', () => {
  const s = contractExample(); s.joints = []; s.view = 'side'
  s.objects[0].states[1].appearance = { width: 100, height: 30, shapes: [{ d: 'M0 0 H100 V30 H0 Z', fill: '#cc00cc', stroke: 'none' }] }
  s.steps[1] = { t: 'Transform', c: 'Demonstrate transformation', claims: ['fold'], do: [{ id: 'fold', v: 'demonstrate', intent: 'fold', k: 'a',
    focus: { k: 'a', bounds: [0, 0, 1, 1] }, demo: { actors: ['a'], draw: '(ctx,p,env,scene) => { scene.draw("a"); ctx.fillRect(1,2,3,4); }', },
    requires: [{ k: 'a', state: 'ready' }], effects: [{ k: 'a', state: 'joined' }] }] }
  const old = globalThis.Path2D; globalThis.Path2D = class {}
  try {
    const e = exampleProgram(s), a = e.times.acts.find((a) => a.id === 'fold'), during = recordingCanvas(), after = recordingCanvas()
    e.env.screens = { a: { width: 100, height: 30 }, b: { width: 100, height: 30 } }
    e.draw(during.ctx, a.at + a.len * 0.5, e.env)
    assert.ok(during.calls.some((c) => c.method === 'fillRect' && c.args.join() === '1,2,3,4'))
    e.draw(after.ctx, a.at + a.len + 0.05, e.env)
    assert.ok(after.calls.some((c) => c.method === 'fill' && c.fill === '#cc00cc'))
    assert.ok(!after.calls.some((c) => c.method === 'fillRect' && c.args.join() === '1,2,3,4'))
    assert.equal(during.depth(), 0); assert.equal(after.depth(), 0)
  } finally { globalThis.Path2D = old }
})

test('a photographed tool retains its appearance while acquiring explicit tool behavior', () => {
  const s = { objects: [{ k: 'photo-driver', cm: 20, toolKind: 'screwdriver', tip: [12, 24] }], steps: [] }
  const cut = { origin: [10, 20], seat: [0, 0], base: [0, 10] }, art = { parts: [] }
  const fitted = withTools(s, { 'photo-driver': cut }, { 'photo-driver': { width: 100, height: 20 } }, { 'photo-driver': art })
  assert.equal(fitted.geometry['photo-driver'].motion, 'turn')
  assert.equal(fitted.geometry['photo-driver'].tool, true)
  assert.deepEqual(fitted.geometry['photo-driver'].tip, [8, 16])
  assert.equal(fitted.vectors['photo-driver'], art)
})

test('an impossible rail fit reports the contradiction without moving its supporting sides', () => {
  const script = { view: 'plan', objects: [
    { k: 'a', cm: 80, w: 4, thick: 2 }, { k: 'b', cm: 80, w: 4, thick: 2 }, { k: 'rail', cm: 30, w: 4, thick: 2 }],
  steps: [{ do: [{ v: 'place', k: 'a', rel: 'floor' }, { v: 'place', k: 'b', rel: 'parallel', to: 'a', gap: 20 },
    { v: 'place', k: 'rail', rel: 'between', to: 'a', and: 'b' }] }] }
  const geometry = Object.fromEntries(script.objects.map((o) => [o.k, { seat: [50, 0], base: [50, 10] }])), sizes = Object.fromEntries(script.objects.map((o) => [o.k, { width: 100, height: 10 }]))
  const layout = solveJoints(script, geometry, sizes), a = layout.world.a, b = layout.world.b
  assert.equal(b.p.y - a.p.y - a.e.y, 20)
  assert.ok(layout.diagnostics.some((p) => p.code === 'inconsistent-fit'))
  assert.throws(() => solve({ ...script, contractVersion: 2 }, geometry, sizes), /Invalid assembly/)
})

test('the shared connection contract also works on generic box parts', () => {
  const script = contractExample()
  for (const o of script.objects) { o.part = { family: 'box', size: [80, 20, 2] }; delete o.w; delete o.thick }
  const example = exampleProgram(script)
  assert.equal(example.layout.connections.length, 1)
  assert.deepEqual(example.layout.diagnostics, [])
})

test('typed cut dimensions and unit labels must agree before normalization', () => {
  const script = read('wood8', 'script.json'), cut = script.steps.flatMap((s) => s.do).find((a) => a.v === 'cut')
  cut.into[0].cm = 999
  assert.match(validatePlan(script).errors.join(), /typed cut length contradicts/)
  cut.into[0].cm = 80; cut.into[0].label = '800 mm'
  assert.ok(!validatePlan(script).errors.some((e) => /typed cut/.test(e)))
  assert.equal(plain(script).steps.flatMap((s) => s.do).find((a) => a.v === 'cut').into[0].label, '80 cm')
})

test('unknown verbs cannot silently fall back to a placement animation', () => {
  assert.throws(() => timeline({ steps: [{ do: [{ v: 'invented', k: 'a' }] }] }), /Unsupported operation/)
})

test('version 2 streams through the planner with a local HTTP stub and no model service', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'instruction-contract-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    const schema = JSON.parse(body).response_format.json_schema.schema
    assert.ok(schema.required.includes('mode'))
    assert.deepEqual(schema.properties.mode.enum, ['physical', 'problem'])
    assert.deepEqual(schema.properties.contractVersion.enum, [2]); assert.ok(schema.properties.joints)
    assert.ok(schema.properties.steps.items.properties.do.items.properties.into.anyOf)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ ...contractExample(), measurementConfirmations: { a: { cm: 999 } } }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const result = await planPhoto(fileURLToPath(new URL('../examples/photos/wood8.png', import.meta.url)), dir, {
    provider: 'meta', apiKey: 'local-test-only', baseURL: `http://127.0.0.1:${server.address().port}/v1/`, maxRepairs: 0,
  })
  assert.equal(result.validation.valid, true)
  assert.equal(result.script.steps[1].c, 'Drive 8 screws')
  assert.equal(result.script.steps[1].do[0].sites.length, 8)
  assert.equal(result.script.measurementConfirmations, undefined)
  assert.equal(auditInstruction(result.script).valid, true)
})

test('a joint that misses its part goes back to the planner and still-invalid v2 geometry stops the film', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'instruction-geometry-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const prompts = []
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    prompts.push(JSON.parse(body).messages.at(-1).content.find((c) => c.type === 'text').text)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(contractExample()) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const options = { provider: 'meta', apiKey: 'local-test-only', baseURL: `http://127.0.0.1:${server.address().port}/v1/` }
  const photo = fileURLToPath(new URL('../examples/photos/wood8.png', import.meta.url))
  let checks = 0
  const fixed = await planPhoto(photo, join(dir, 'fixed'), { ...options, checkPlan: async () => checks++ ? [] : ['joint j: Work site 1 misses the receiving part'] })
  assert.equal(fixed.validation.valid, true); assert.equal(fixed.call.planAttempts, 2)
  assert.match(prompts[1], /joint j: Work site 1 misses the receiving part/); assert.match(prompts[1], /"also" the rest/)
  assert.match(prompts[1], /Keep the design and the steps one plan/); assert.match(prompts[0], /Sizes people expect/); assert.doesNotMatch(prompts[0], /\{\{/)
  await assert.rejects(planPhoto(photo, join(dir, 'kept'), { ...options, checkPlan: async () => ['joint j: Work site 1 misses the receiving part'] }), (error) => {
    assert.equal(error.call.planAttempts, 3); assert.equal(error.validation.valid, false)
    return /Work site 1 misses/.test(error.message)
  })
})

test('a v2 geometry patch with remaining errors uses the remaining whole-repair budget', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'instruction-geometry-budget-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const schemas = [], server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    schemas.push(JSON.parse(body).response_format.json_schema.name)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(contractExample()) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  let checks = 0
  const result = await planPhoto(fileURLToPath(new URL('../examples/photos/wood8.png', import.meta.url)), dir, { provider: 'meta', apiKey: 'stub', baseURL: `http://127.0.0.1:${server.address().port}/v1/`,
    background: true, checkPlan: () => ++checks < 3 ? [`joint j: remaining gap ${checks} cm`] : [] })
  assert.equal(result.validation.valid, true)
  assert.deepEqual(schemas, ['InstructionPlan', 'InstructionPlanPatch', 'InstructionPlan'])
  assert.equal(result.call.planAttempts, 3)
})



// A seat on three legs standing apart on the floor: one place, "on" a leg "also" the others.
function stoolExample(legSize = 5) {
  const measurement = { status: 'estimated', source: 'test input' }, legs = ['leg-a', 'leg-b', 'leg-c']
  const part = (k, cm, w, thick) => ({ k, n: k, segment: 'wooden board', b: [0, 0, 100, 30], cm, w, thick, measurements: { cm: measurement, w: measurement, thick: measurement } })
  return { contractVersion: 2, view: 'iso', title: 'Stool', sub: 'Three legs', tag: 'Example', end: 'Finished', finale: [], goals: [],
    ideas: [0, 1, 2].map((i) => ({ title: `Idea ${i}`, pitch: 'An example', kind: 'build' })), pick: 0,
    objects: [part('seat', 30, 28, 3), ...legs.map((k) => part(k, 40, legSize, legSize))],
    tools: [{ k: 'driver', use: 'drill' }, { k: 'screws', use: 'screw', cm: 5 }],
    joints: legs.map((k) => ({ id: `j-${k}`, a: 'seat', b: k, face: 'upper', otherFace: 'upper', method: 'fasten', depthCm: 5, sites: [{ x: 0.5, lat: 0 }] })),
    steps: [{ t: 'Stand the legs', c: 'Stand three legs', claims: legs, do: [...legs.map((k, i) => ({ id: k, intent: 'place', v: 'place', k, rel: 'floor', stand: 'end', at: ['left', 'middle', 'right'][i] })),
      { id: 'seat', intent: 'place', v: 'place', k: 'seat', to: 'leg-a', also: ['leg-b', 'leg-c'], rel: 'on' }] },
    { t: 'Screw the seat', c: 'Derived', caption: { template: 'Drive {count} screws', actions: legs.map((k) => `fix-${k}`) }, claims: legs.map((k) => `fix-${k}`),
      do: legs.map((k) => ({ id: `fix-${k}`, intent: 'fasten', v: 'use', k: 'seat', to: k, joint: `j-${k}`, with: 'driver', part: 'screws', sites: [{ x: 0.5, lat: 0 }] })) }] }
}

test('a part on several supports rests on all of them: free legs gather under it, its screws are aimed at each', () => {
  const script = stoolExample()
  assert.deepEqual(validatePlan(script).errors, [])
  const { layout, script: solved } = exampleProgram(script)
  assert.deepEqual(layout.diagnostics, [])
  const W = layout.world, seat = W.seat
  for (const k of ['leg-a', 'leg-b', 'leg-c']) {
    assert.equal(W[k].p.z, 0); assert.ok(Math.abs(W[k].p.z + W[k].e.z - seat.p.z) < 1e-6, `${k} carries the seat`)
    for (const ax of ['x', 'y']) assert.ok(W[k].p[ax] >= seat.p[ax] - 1e-6 && W[k].p[ax] + W[k].e[ax] <= seat.p[ax] + seat.e[ax] + 1e-6, `${k} under the seat`)
  }
  // a triangle: two at the front, one at the back
  assert.equal(new Set(['leg-a', 'leg-b', 'leg-c'].map((k) => W[k].p.y)).size, 2)
  assert.deepEqual(layout.aimed, ['j-leg-a', 'j-leg-b', 'j-leg-c'])
  assert.deepEqual(solved.steps[1].do[0].sites, solved.joints[0].sites); assert.notDeepEqual(solved.joints[0].sites, [{ x: 0.5, lat: 0 }])
  // legs too big for the seat side by side: said, so the planner can choose a bigger part
  assert.throws(() => exampleProgram(stoolExample(20)), (e) => e.diagnostics.some((d) => d.code === 'crowded-supports' && /too small to rest on 3 parts/.test(d.message)))
})

test('a build of everyday things that stands parts on end or joins them is solved in numbers, even before its joints are declared', () => {
  // logs, not boards: a boot bench routed to the scene solver lay its legs flat and set the seat on one
  const logs = (script) => { for (const o of script.objects) { delete o.thick; delete o.w; o.part = { family: 'loose', size: [o.cm, 12, 12] } } return script }
  assert.equal(isSceneBuild(logs(stoolExample())), false)
  const dropped = logs(stoolExample()); dropped.joints = []
  assert.equal(isSceneBuild(dropped), false)
  // things only put on the table and on each other stay the scene's
  const desk = logs(stoolExample()); desk.joints = []; desk.steps = [{ ...desk.steps[0], do: desk.steps[0].do.map(({ stand, also, ...a }) => a) }]
  assert.equal(isSceneBuild(desk), true)
})

test('round wood is drawn as logs: a cylinder with its end grain shown, what rests on one drawn after it, its faces from the model', async (t) => {
  assert.ok(isLog({ n: 'split firewood log' }) && isLog({ n: 'stick', part: { shape: 'round' } }))
  assert.ok(!isLog({ n: 'brown 1×4 log brick', part: { family: 'brick' } }) && !isLog({ n: 'pine board' }))
  const script = stoolExample()
  for (const o of script.objects) { o.n = 'firewood log'; delete o.w; delete o.thick; o.part = { family: 'loose', size: [o.cm, 12, 12] } }
  script.objects[0].part.size = [30, 30, 12]
  script.tools[1].cm = 20; for (const j of script.joints) j.depthCm = 20
  const art = (W, H) => ({ width: W, height: H, shapes: [{ d: `M0 0H${W}V${H}H0Z`, fill: '#7a5a3a', stroke: 'none' }, { d: `M${W / 2} 0V${H}`, fill: 'none', stroke: '#3a2a1a' }] })
  const faces = { seat: { end: art(120, 120), side: art(300, 120), at: 0 } }
  const plainScript = plain(script), cut = Object.fromEntries(plainScript.objects.map((o) => [o.k, { origin: [0, 0], seat: [50, 2], base: [50, 30], color: '#8a6b4a' }]))
  const { geometry, sizes, vectors } = withTools(plainScript, cut, Object.fromEntries(plainScript.objects.map((o) => [o.k, { width: 100, height: 30 }])), {})
  const layout = solve(plainScript, geometry, sizes)
  for (const k of ['seat', 'leg-a']) { const L = layout.boards[k].log; assert.ok(L && L.body.length > 8 && L.ends.length === 2 && L.across.length === 2, k) }
  assert.ok(layout.boards['leg-a'].log.end, 'a standing leg shows its end grain')
  assert.ok(layout.order.indexOf('seat') > Math.max(...['leg-a', 'leg-b', 'leg-c'].map((k) => layout.order.indexOf(k))), layout.order.join(' '))
  const oldPath = globalThis.Path2D; globalThis.Path2D = class { constructor(d) { this.d = d } }
  try {
    const source = program({ script: plainScript, geometry, sizes, vectors, layout, faces, boxes: Object.fromEntries(plainScript.objects.map((o) => [o.k, o.b])), photo: { width: 100, height: 30 } })
    assert.deepEqual(refusedIn(source), [])
    const frame = new Function(`return (${source})`)(), times = timeline(plainScript)
    for (const at of [times.acts.at(-1).at + 0.5, times.finale + 1]) { const c = recordingCanvas(); frame(c.ctx, at, offlineEnv()); assert.equal(c.depth(), 0) }
  } finally { globalThis.Path2D = oldPath }
  // the face call: a log's end and side, through the stub
  const dir = mkdtempSync(join(tmpdir(), 'log-faces-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const prompts = []
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    prompts.push(JSON.parse(body).messages.at(-1).content.find((c) => c.type === 'text').text)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const answer = { end: { shapes: art(120, 120).shapes }, side: { shapes: art(300, 120).shapes } }
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(answer) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close() })
  const done = await writeFaces(dir, script, null, { provider: 'meta', apiKey: 'local-test-only', baseURL: `http://127.0.0.1:${server.address().port}/v1/`, photo: fileURLToPath(new URL('../examples/photos/wood8.png', import.meta.url)) })
  assert.deepEqual(Object.keys(done).sort(), ['leg-a', 'leg-b', 'leg-c', 'seat'])
  assert.deepEqual(Object.keys(done.seat.faces), ['end', 'side']); assert.match(prompts[0], /"end": its sawn end/)
})

test('the design holds the steps to it: parts fit their object, every cut part is designed, the built size is the designed one', () => {
  const objects = new Map([['log', { k: 'log', cm: 30 }]])
  const plan = (parts, into, size = [30, 14, 30]) => ({ view: 'iso', design: { purpose: 'A shelf', standard: 'Shelf 15–30 cm deep', size, parts },
    steps: [{ do: [{ v: 'cut', k: 'log', into }] }] })
  // a split log shelf: 76 cm of parts from a 30 cm log
  const shelf = plan([{ k: 'top', from: 'log', cm: 28 }, { k: 'side', from: 'log', cm: 24, n: 2 }], [{ k: 'top', cm: 28 }, { k: 'side-a', cm: 24 }, { k: 'side-b', cm: 24 }])
  const found = designProblems(shelf, objects)
  assert.ok(found.some((p) => /parts from log need 76.6 cm/.test(p)), found.join('\n'))
  assert.ok(found.some((p) => /cut side-a .* not among the design's parts/.test(p)) && found.some((p) => /side is never made/.test(p)))
  // a sound one: the design's parts are what is cut, and an offcut need not be listed
  assert.deepEqual(designProblems(plan([{ k: 'seat', from: 'log', cm: 20 }], [{ k: 'seat', cm: 20 }, { k: 'offcut', cm: 9.7 }]), objects), [])
  assert.match(designProblems(plan([{ k: 'seat', from: 'log', cm: 20 }], [{ k: 'seat', cm: 18 }]), objects).join(), /seat is 20 cm in the design but cut 18 cm/)
  assert.match(designProblems({ view: 'iso', steps: [] }).join(), /design is missing/)
  assert.match(designProblems(plan([{ k: 'seat', from: 'log', cm: 20 }], [{ k: 'seat', cm: 20 }], null), objects).join(), /design.size is missing/)
  // the cut list of a log (no timber sizes) is held to its length too
  const cut = validatePlan({ ...contractExample(), steps: [{ t: 'Cut', c: 'Cut', claims: ['c'], do: [{ id: 'c', intent: 'cut', v: 'cut', k: 'a', with: 'saw', into: [{ k: 'p', cm: 50, label: '50 cm' }, { k: 'q', cm: 50, label: '50 cm' }] }] }],
    objects: contractExample().objects.map(({ w, thick, ...o }) => o), tools: [{ k: 'saw', use: 'saw' }] })
  assert.ok(cut.soft.some((p) => /cuts total 100 cm \(50 \+ 50\) but a is only 80 cm/.test(p)), cut.soft.join('\n'))
  // the size the steps build, either way round across, against the design
  const layout = { transients: [], world: { a: { p: { x: 0, y: 0, z: 0 }, e: { x: 12, y: 12, z: 35 } }, s: { p: { x: 0, y: 0, z: 35 }, e: { x: 38, y: 15, z: 15 } } } }
  assert.deepEqual(sizeProblems({ design: { size: [15, 38, 50] } }, layout), [])
  assert.match(sizeProblems({ design: { size: [40, 18, 20] } }, layout).join(), /size is 40 × 18 × 20 cm but the steps build 38 × 15 × 50 cm/)
  // as it would stand and hold: a 60 cm thing on a 5 cm base tips; a screw biting 2 cm into a 45 cm leg is too short
  const tall = { transients: [], world: { leg: { p: { x: 0, y: 0, z: 0 }, e: { x: 5, y: 5, z: 60 } }, top: { p: { x: 0, y: 0, z: 60 }, e: { x: 30, y: 30, z: 2 } } } }
  assert.match(builtProblems({ steps: [] }, tall).join(), /stands 62 cm tall on a base 5 × 5 cm/)
  assert.deepEqual(builtProblems({ steps: [{ do: [{ v: 'place', k: 'leg', rel: 'wall' }] }] }, tall), [])
  const stool = { transients: [], connections: [{ id: 'j', axis: 'z' }], world: { leg: { p: { x: 0, y: 0, z: 0 }, e: { x: 30, y: 30, z: 45 } }, top: { p: { x: 0, y: 0, z: 45 }, e: { x: 30, y: 30, z: 2 } } } }
  const fixed = (depthCm) => builtProblems({ steps: [], joints: [{ id: 'j', a: 'top', b: 'leg', method: 'fasten', depthCm }] }, stool)
  assert.match(fixed(4).join(), /a 4 cm fastener goes only 2 cm into leg .* use 7–47 cm fasteners/)
  assert.deepEqual(fixed(7), [])
})

test('a step putting in fasteners without a counted caption gets one: the count from its sites, never a size', () => {
  const script = contractExample(), step = script.steps[1]
  delete step.caption; step.c = 'Drill, then screw each crossing with 16 cm screws'
  assert.ok(validatePlan(script).errors.some((e) => /puts in screws, so its step needs "caption"/.test(e)))
  assert.deepEqual(settleCaptions(script), ['step 2: caption made a count of its screws'])
  assert.deepEqual(step.caption, { template: 'Drill, then screw each crossing with 16 cm screws ({count} screws)', actions: ['drive'] })
  assert.deepEqual(validatePlan(script).errors, [])
  const counted = contractExample(); delete counted.steps[1].caption; counted.steps[1].c = 'Drive 8 screws through the top'
  settleCaptions(counted); assert.equal(counted.steps[1].caption.template, 'Drive {count} screws through the top')
  assert.deepEqual(settleCaptions(contractExample()), [])
})

test('an answer that breaks its JSON and runs on into whitespace is stopped, and its repair is not handed the broken text', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'instruction-runaway-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const prompts = [], chunk = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`
  let closedEarly = false
  const server = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c
    prompts.push(JSON.parse(body).messages.at(-1).content.find((c) => c.type === 'text').text)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if (prompts.length === 1) {
      // (the footstool's break: an escaped quote in a key, then whitespace that would go on for the model's whole limit)
      res.write(chunk('{"contractVersion":2,"tools":[{"k":"screws","use":"screw","cm\\":15}],"'))
      for (let i = 0; i < 2000 && !res.destroyed; i++) { res.write(chunk(' \t'.repeat(30))); await new Promise((r) => setTimeout(r, 2)) }
      closedEarly = res.destroyed || res.writableEnded === false
      return res.end()
    }
    res.end(chunk(JSON.stringify(contractExample())) + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close() })
  const started = performance.now()
  const result = await planPhoto(fileURLToPath(new URL('../examples/photos/wood8.png', import.meta.url)), dir, { provider: 'meta', apiKey: 'local-test-only', baseURL: `http://127.0.0.1:${server.address().port}/v1/` })
  assert.equal(result.validation.valid, true); assert.equal(prompts.length, 2)
  assert.ok(performance.now() - started < 3000, 'stopped long before the whitespace ran out')
  assert.match(result.call.validationHistory[0].errors[0], /ran on into whitespace and was stopped/)
  assert.doesNotMatch(prompts[1], /Previous plan:/); assert.match(prompts[1], /stopped being valid JSON here: .*cm/)
  assert.ok(prompts[1].length < prompts[0].length + 2000, 'the repair carries no whitespace')
})

// Execute generated programs on a recording canvas only; no renderer, models, images or films.
test('all saved domains compile and execute at action phases with balanced canvas state', () => {
  const oldPath = globalThis.Path2D
  globalThis.Path2D = class { constructor(d) { this.d = d } }
  try {
    for (const name of readdirSync(root)) {
      const script = plain(read(name, 'script.json')), screens = read(name, 'screens/screens.json')
      const { geometry, sizes, vectors } = withTools(script, read(name, 'screens/geometry.json'),
        Object.fromEntries(Object.entries(screens).filter(([k]) => k !== 'photo').map(([k, v]) => [k, { width: v.width, height: v.height }])), {})
      const layout = solve(script, geometry, sizes)
      const source = program({ script, geometry, sizes, vectors, layout, boxes: Object.fromEntries(script.objects.map((o) => [o.k, o.b])),
        photo: screens.photo, look: 'drawn' })
      assert.deepEqual(refusedIn(source), [], name)
      const frame = new Function(`return (${source})`)(), times = timeline(script)
      for (const at of [1.2, 4.4, ...times.acts.flatMap((a) => [a.at + a.len * 0.15, a.at + a.len * 0.55, a.at + a.len * 0.95]), times.finale + 3]) {
        const c = recordingCanvas()
        const env = offlineEnv(); env.screens = screens
        frame(c.ctx, at, env); assert.equal(c.depth(), 0, `${name} at ${at}`)
      }
    }
  } finally { globalThis.Path2D = oldPath }
})

test('serving from a heated pot is done with a ladle, added once; other pours tip', () => {
  const script = physicalPlan({ objects: [{ k: 'beans', n: 'can of beans' }], tools: [{ k: 'pot', use: 'pot' }, { k: 'bowl', use: 'bowl' }, { k: 'colander', use: 'drain' }],
    steps: [{ t: 'Cook', c: '', do: [{ v: 'pour', k: 'beans', to: 'pot' }, { v: 'heat', k: 'pot', to: 'pot' }] },
      { t: 'Serve', c: '', do: [{ v: 'pour', k: 'pot', to: 'bowl' }, { v: 'pour', k: 'pot', to: 'colander' }] }] })
  const once = plain(script), acts = once.steps.flatMap((s) => s.do)
  assert.equal(acts[0].with, undefined)
  assert.equal(acts[2].with, 'ladle')
  assert.equal(acts[3].with, undefined)
  assert.deepEqual(once.tools.at(-1), { k: 'ladle', use: 'ladle' })
  assert.deepEqual(plain(once), once)
  // A ladle the script already has is the one used.
  const own = plain({ ...script, tools: [...script.tools, { k: 'soup-ladle', use: 'ladle' }] })
  assert.equal(own.steps[1].do[0].with, 'soup-ladle')
  assert.equal(own.tools.length, 4)
})

test('a heat takes its level from its caption', () => {
  const heat = (c, extra = {}) => plain(physicalPlan({ objects: [], tools: [{ k: 'pot', use: 'pot' }], steps: [{ t: 'Cook', c, do: [{ v: 'heat', k: 'pot', to: 'pot', ...extra }] }] })).steps[0].do[0].level
  assert.equal(heat('Place the pot on medium heat.'), 'medium')
  assert.equal(heat('Bring to a boil.'), 'high')
  assert.equal(heat('Simmer 20 minutes.'), 'low')
  assert.equal(heat('Simmer 20 minutes.', { level: 'medium' }), 'medium')
  assert.equal(heat('Warm it through.'), undefined)
})

test('a box over the photo edge is trimmed, not refused: one planning request, and the trimmed list is published', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'instruction-fit-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const photo = fileURLToPath(new URL('../examples/photos/wood8.png', import.meta.url))
  let requests = 0
  const server = createServer(async (req, res) => {
    requests++
    for await (const chunk of req) void chunk
    const plan = contractExample(); plan.objects[0].b = [500, 10, 200, 30]
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(plan) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  let published = null
  const result = await planPhoto(photo, dir, { provider: 'meta', apiKey: 'local-test-only', baseURL: `http://127.0.0.1:${server.address().port}/v1/`,
    onObjects: (objects) => { published = objects } })
  const width = result.photo.width
  assert.equal(requests, 1)
  assert.equal(result.validation.valid, true)
  assert.deepEqual(result.script.objects[0].b, [500, 10, width - 500, 30])
  assert.deepEqual(published[0].b, [500, 10, width - 500, 30])
})


test('a placed, chopped ingredient added to a pot goes by the handful and rests within its board', () => {
  const place = (k, rel, to) => ({ v: 'place', k, rel, to })
  const times = timeline({ steps: [
    { do: [place('board', 'floor', null)] },
    { do: [place('onion', 'on', 'board'), { v: 'cut', k: 'onion', into: 'bits', with: 'knife' }] },
    { do: [place('carrot', 'on', 'board'), { v: 'cut', k: 'carrot', into: 'slices', with: 'knife' }] },
    { do: [place('onion', 'in', 'pot'), place('whole-pear', 'in', 'pot')] },
  ] })
  const added = times.acts.filter((a) => a.step === 3)
  assert.equal(added[0].v, 'pour'); assert.equal(added[0].handful, true)
  assert.equal(added[1].v, 'place', 'something never cut is still placed whole')
  const poses = { board: { x: 500, y: 700, scale: 0.5, anchor: [400, 100] }, onion: { x: 480, y: 660, scale: 1, anchor: [50, 90] }, carrot: { x: 1300, y: 660, scale: 1, anchor: [50, 90] } }
  const slots = heapSlots(times.acts, poses, { board: { width: 200 }, onion: { width: 100 }, carrot: { width: 100 } })
  const left = 500 - 400 * 0.5, right = left + 200 * 4 * 0.5
  for (const key of ['onion', 'carrot']) {
    assert.ok(slots[key].x - slots[key].width / 2 >= left && slots[key].x + slots[key].width / 2 <= right, `${key} on the board`)
    assert.ok(slots[key].scale * 100 * 4 <= slots[key].width, `${key} fits its slot`)
  }
  assert.ok(slots.onion.x < slots.carrot.x, 'in the order they were cut')
  assert.equal(heapSlots([place('x', 'on', 'board')], poses, {}).x, undefined, 'nothing cut, nothing moved')
})

test('pieces take their food colour when the plan gives none', () => {
  assert.equal(foodColor('yellow bag of carrots'), '#e8873a'); assert.equal(foodColor('Bag of Celery Stalks'), '#8fbf5a'); assert.equal(foodColor('plank'), undefined)
})

test('a chopped thing rests on its support instead of floating at the middle of its drawing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chopped-'))
  try {
    cpSync(new URL('../examples/fixtures/groceries', import.meta.url), dir, { recursive: true })
    const run = readRun(dir), cut = run.times.acts.find((a) => a.v === 'cut' && a.k === 'pepperjack')
    const { source } = filmProgram(run, { name: 'replay', vectors: run.vectors, drawingAt: () => 0, faces: run.faces || {}, faceAt: () => 0, finaleAt: Infinity, panelAt: Infinity })
    const { ctx, calls } = recordingCanvas()
    globalThis.Path2D ??= class { moveTo() {} lineTo() {} closePath() {} quadraticCurveTo() {} bezierCurveTo() {} arc() {} ellipse() {} rect() {} addPath() {} }
    new Function(`return (${source})`)()(ctx, cut.at + 0.5, { ...offlineEnv(), screens: run.screens })
    const color = (cut.color || run.script.steps.flatMap((s) => s.do).find((a) => a.k === 'pepperjack' && a.color)?.color || '').toLowerCase()
    const blocks = calls.filter((c) => c.method === 'fillRect' && String(c.fill).toLowerCase() === color)
    assert.ok(blocks.length, 'the uncut block is drawn')
    const onBoard = run.layout.poses.pepperjack.y
    for (const b of blocks) assert.ok(Math.abs(b.args[1] + b.args[3] - onBoard) < 1, `block bottom ${b.args[1] + b.args[3]} on ${onBoard}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
