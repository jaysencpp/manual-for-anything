import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readRun, filmProgram } from '../src/film/film.mjs'
import assert from 'node:assert/strict'
import { settleWorkTargets, settleOperations } from '../src/solvers/contracts.mjs'
import { validatePlan } from '../src/pipeline/validate.mjs'
import { plain } from '../src/pipeline/script.mjs'
import { isSceneBuild } from '../src/solvers/scene.mjs'
import { solveBuild, geometryReview } from '../src/solvers/layout.mjs'
import { withTools } from '../src/solvers/tools.mjs'
import { program, timeline } from '../src/film/engine.mjs'
import { recordingCanvas, offlineEnv } from '../scripts/offline-canvas.mjs'
import { checkDemonstration, demoPose } from '../src/film/demonstrations.mjs'
import { PHYSICAL_PLAN_SCHEMA, PATCH_SCHEMA } from '../src/pipeline/plan-schema.mjs'

function yarn() {
  return { contractVersion: 2, title: 'Small ball', view: 'side', tools: [], joints: [], goals: [], finale: [],
    objects: [{ k: 'yarn', n: 'Blue yarn', segment: 'yarn', b: [0, 0, 100, 100], cm: 12,
      measurements: { cm: { status: 'estimated', source: 'photo' } } }],
    ideas: [0, 1, 2].map(i => ({ title: `Idea ${i}`, pitch: 'Crochet', kind: 'craft' })), pick: 0,
    makes: [{ k: 'ball', shape: 'ball', cm: 10, rows: 10, colors: ['#a8cce0'] }],
    steps: [.1, .5, 1].map((p, i) => ({ t: 'Work stitches', c: 'Grow the ball', claims: [`work-${i}`],
      do: [{ v: 'work', id: `work-${i}`, intent: 'work', k: 'yarn', to: 'yarn', p }] })) }
}

test('source-targeted work is corrected only for one unambiguous made piece, with an audit trail', () => {
  const script = yarn(), original = structuredClone(script)
  assert.match(validatePlan(script).errors.join(), /work target yarn/)
  assert.equal(settleOperations(script).filter(n => n.includes('work targets')).length, 3)
  assert.equal(validatePlan(script).valid, true, validatePlan(script).errors.join('\n'))
  assert.deepEqual(script.steps.map(s => s.do[0].k), ['ball', 'ball', 'ball'])
  assert.deepEqual(script.steps.map(s => [s.do[0].to, s.do[0].p, s.do[0].id]), original.steps.map(s => [s.do[0].to, s.do[0].p, s.do[0].id]))
  assert.deepEqual(settleWorkTargets(script), [])
  const ambiguous = yarn(); ambiguous.makes.push({ k: 'hat', shape: 'tube' })
  assert.deepEqual(settleWorkTargets(ambiguous), [])
  assert.equal(validatePlan(ambiguous).valid, false)
})

test('made pieces require finite nondecreasing work progress ending at one', () => {
  for (const progress of [[.1, .5, .9], [.6, .2, 1], [.1, NaN, 1]]) {
    const script = yarn(); settleWorkTargets(script)
    script.steps.forEach((s, i) => { s.do[0].p = progress[i] })
    assert.equal(validatePlan(script).valid, false)
  }
  const script = yarn(); settleWorkTargets(script); script.steps = []
  assert.match(validatePlan(script).errors.join(), /visibly create/)
})

test('corrected work creates increasing stitch geometry in the real film program', () => {
  const input = yarn(); settleWorkTargets(input); const script = plain(input)
  const cut = withTools(script, { yarn: { origin: [0, 0], base: [50, 100], seat: [50, 0] } }, { yarn: { width: 100, height: 100 } }, { yarn: { width: 400, height: 400, parts: [] } })
  const layout = solveBuild(script, cut.geometry, cut.sizes), times = timeline(script)
  const draw = new Function(`return (${program({ script, ...cut, layout, boxes: { yarn: [0, 0, 100, 100] }, photo: { width: 100, height: 100 } })})`)()
  const counts = times.acts.filter(a => a.v === 'work').map(a => {
    const c = recordingCanvas(); draw(c.ctx, a.at + a.len * .9, offlineEnv()); assert.equal(c.depth(), 0)
    return c.calls.filter(call => call.method === 'ellipse').length
  })
  assert.ok(counts[0] > 0)
  assert.ok(counts[1] > counts[0] && counts[2] > counts[1], JSON.stringify(counts))
})

test('untyped plants use scene placement, while structural assemblies keep numeric connection checks', () => {
  const script = { contractVersion: 2, view: 'iso', objects: ['table', 'plant-a', 'plant-b', 'plant-c'].map(k => ({ k, n: k === 'table' ? 'table' : 'potted plant', cm: k === 'table' ? 180 : 25 })), steps: [{ do: [
    { v: 'place', k: 'table', rel: 'floor' }, ...['plant-a', 'plant-b', 'plant-c'].map((k, i) => ({ v: 'place', k, to: 'table', rel: 'on', at: ['left', 'middle', 'right'][i] }))] }] }
  assert.equal(isSceneBuild(script), true)
  const geometry = Object.fromEntries(script.objects.map(o => [o.k, { base: [50, 100], seat: [50, 0] }]))
  const sizes = Object.fromEntries(script.objects.map(o => [o.k, { width: 100, height: 100 }]))
  const layout = solveBuild(script, geometry, sizes)
  assert.ok(layout.scene); assert.equal(layout.geometryEstimated, true)
  assert.deepEqual(geometryReview(script, layout).errors, [])
  const structural = structuredClone(script)
  structural.joints = [{ id: 'bad', a: 'plant-a', b: 'table', method: 'fasten', face: 'upper', otherFace: 'upper', sites: [{ x: .5 }], depthCm: 1 }]
  assert.equal(isSceneBuild(structural), false)
  assert.throws(() => solveBuild(structural, geometry, sizes), /Invalid assembly/)
})

test('estimated envelope differences are warnings; numeric assemblies still fail', () => {
  const script = { design: { size: [100, 100, 100] } }
  const layout = { world: { block: { p: { x: 0, y: 0, z: 0 }, e: { x: 20, y: 20, z: 20 } } } }
  assert.ok(geometryReview(script, layout).errors.length)
  const estimated = geometryReview(script, { ...layout, geometryEstimated: true })
  assert.deepEqual(estimated.errors, []); assert.ok(estimated.warnings.length)
})

test('provider plans and repair patches require the IDs, intent and claims used by local validation', () => {
  for (const schema of [PHYSICAL_PLAN_SCHEMA, PATCH_SCHEMA]) {
    const step = schema.properties.steps.items
    assert.ok(step.required.includes('claims')); assert.equal(step.properties.claims.minItems, 1)
    assert.ok(step.properties.do.items.required.includes('id')); assert.ok(step.properties.do.items.required.includes('intent'))
  }
})

test('demonstration pose validation matches playback including named center anchors', () => {
  assert.deepEqual(demoPose({ anchor: 'center' }, { width: 80, height: 40 }), { anchor: [40, 20] })
  const demo = anchor => ({ actors: ['yarn'], draw: `(ctx,p,env,scene)=>scene.draw('yarn',{anchor:${JSON.stringify(anchor)}})` })
  assert.equal(checkDemonstration(demo('center')), null)
  assert.match(checkDemonstration(demo('nonsense')), /anchor/)
  assert.match(checkDemonstration(demo([0])), /anchor/)
  assert.match(checkDemonstration({ actors: ['yarn'], draw: `(ctx,p,env,scene)=>scene.draw('yarn',{scale:0/0})` }), /finite/)
})


test('reopening a saved source-targeted film repairs its targets and rebuilds the obsolete layout in memory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'work-recovery-')), oldPath = globalThis.Path2D
  globalThis.Path2D = class {}
  try {
    mkdirSync(join(dir, 'screens'))
    const script = yarn(), raw = JSON.stringify(script)
    const files = { 'script.json': script,
      'layout.json': { poses: {}, order: [], extras: [], floorY: 790 },
      'screens/screens.json': { photo: { width: 100, height: 100 }, yarn: { width: 100, height: 100 } },
      'screens/geometry.json': { yarn: { origin: [0, 0], base: [50, 100], seat: [50, 0] } },
      'screens/traced.json': { yarn: { width: 400, height: 400, parts: [] } },
      'screens/boxes.json': { objects: [{ key: 'yarn', box: [0, 0, 100, 100] }] } }
    for (const [name, data] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(data))
    const run = readRun(dir)
    assert.equal(run.needsLayout, true)
    assert.equal(run.script.steps[0].do[0].k, 'ball')
    const result = filmProgram(run), draw = new Function(`return (${result.source})`)()
    const act = run.times.acts.filter(a => a.v === 'work').at(-1), c = recordingCanvas()
    draw(c.ctx, act.at + act.len * .9, offlineEnv())
    assert.ok(c.calls.filter(call => call.method === 'ellipse').length > 100)
    assert.equal(c.depth(), 0)
    assert.equal(readFileSync(join(dir, 'script.json'), 'utf8'), raw)
  } finally { globalThis.Path2D = oldPath; rmSync(dir, { recursive: true, force: true }) }
})
