import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { completeIllustration, illustrationFrame } from '../src/pipeline/illustration.mjs'
import { suppliedDrawingPrompt, requiredDrawingKeys } from '../src/pipeline/artwork.mjs'
import { withTools } from '../src/solvers/tools.mjs'
import { solveBuild } from '../src/solvers/layout.mjs'
import { filmDrawings } from '../src/pipeline/drawings.mjs'
import { program, timeline } from '../src/film/engine.mjs'
import { withUp } from '../src/film/helper.mjs'
import { recordingCanvas, offlineEnv } from '../scripts/offline-canvas.mjs'
import { physicalPlan } from './support/physical-plan.mjs'

const bottle = { k: 'amaro', n: 'Amaro Montenegro bottle', b: [653, 230, 147, 669], cm: 29,
  part: { family: 'cylinder', shape: 'vessel', size: [9, 9, 29] } }
const scriptFor = (extra = {}) => physicalPlan({ title: 'Montenegro Spritz', artworkMode: 'complete', objects: [bottle],
  steps: [{ t: 'Place Amaro', c: 'Place the Amaro bottle', do: [{ v: 'place', k: 'amaro', rel: 'floor' }] }], ...extra })
const sizes = { amaro: { width: 335, height: 152 } }
const geometry = { amaro: { origin: [465, 517], turn: -1.5171, center: [741.9, 595.9], seat: [167.5, 23], base: [167.5, 142], ends: [[3, 148], [334, 9]] } }

test('the clipped sideways Amaro gets an upright complete frame before artwork or layout arrives', () => {
  const script = scriptFor(), original = structuredClone(geometry)
  const fit = withTools(script, geometry, sizes, {})
  assert.deepEqual(fit.sizes.amaro, { width: 104, height: 335 })
  assert.deepEqual(fit.geometry.amaro.base, [52, 335])
  assert.deepEqual(fit.geometry.amaro.seat, [52, 0])
  assert.equal(fit.geometry.amaro.turn, 0)
  assert.equal(fit.geometry.amaro.ends, undefined)
  assert.deepEqual(geometry, original)
  const prompt = suppliedDrawingPrompt(script, bottle, fit.sizes.amaro, { observed: true })
  assert.match(prompt, /COMPLETE object/)
  assert.match(prompt, /original photo/)
  assert.match(prompt, /416×1340 canvas/)
  const layout = solveBuild(script, fit.geometry, fit.sizes)
  assert.deepEqual(layout.poses.amaro.anchor, [208, 1340])
  assert.equal(layout.poses.amaro.angle, 0)
  const noDimensions = { ...bottle, part: undefined }
  assert.ok(illustrationFrame(script, noDimensions, sizes.amaro).height > illustrationFrame(script, noDimensions, sizes.amaro).width)
  const old = scriptFor(); delete old.artworkMode
  assert.deepEqual(withTools(old, geometry, sizes, {}).sizes.amaro, sizes.amaro)
})

test('repairs, LEGO, measured construction and tools retain their photographed/structured frames', () => {
  const s = scriptFor()
  assert.equal(completeIllustration(s, bottle), true)
  assert.equal(completeIllustration(scriptFor({ title: 'Repair a broken bottle' }), bottle), false)
  assert.equal(completeIllustration(scriptFor({ rigs: [{ k: 'amaro' }] }), bottle), false)
  assert.equal(completeIllustration(s, { ...bottle, part: { family: 'brick', studs: [2, 4], plates: 3 } }), false)
  assert.equal(completeIllustration(s, { ...bottle, part: { family: 'sheet' } }), false)
  assert.equal(completeIllustration(s, { ...bottle, toolKind: 'spoon' }), false)
  const recipe = scriptFor({ steps: [{ c: 'Pour juice', do: [{ v: 'pour', k: 'amaro', to: 'glass' }] }] })
  assert.equal(completeIllustration(recipe, { ...bottle, n: 'juice carton', part: { family: 'box', size: [7, 7, 20] } }), true)
  for (const v of ['cut', 'fold', 'measure', 'reshape', 'use', 'work']) {
    const work = scriptFor({ steps: [{ c: 'Work on the object', do: [{ v, k: 'amaro' }] }] })
    assert.equal(completeIllustration(work, bottle), false, v)
  }
})

test('complete recipe illustrations use physical height and the drawn outlet for pouring', () => {
  const script = scriptFor()
  script.objects.push({ k: 'glass', n: 'glass', source: 'additional-supply', cm: 9, part: { family: 'cylinder', size: [9, 9, 14] } })
  script.steps.push({ t: 'Place glass', c: 'Place the glass', do: [{ v: 'place', k: 'glass', rel: 'floor' }] })
  const fit = withTools(script, geometry, sizes, { amaro: { width: 416, height: 1340, outlet: [208, 40], parts: [] } })
  assert.deepEqual(fit.geometry.amaro.seat, [52, 10])
  const layout = solveBuild(script, fit.geometry, fit.sizes)
  const height = k => fit.sizes[k].height * 4 * layout.poses[k].scale
  assert.ok(Math.abs(height('amaro') / height('glass') - 29 / 14) < 0.001)
  const pouring = scriptFor({ steps: [{ c: 'Pour Amaro', do: [{ v: 'pour', k: 'amaro', to: 'glass' }] }] })
  assert.match(suppliedDrawingPrompt(pouring, bottle, fit.sizes.amaro, { observed: true }), /top-level "outlet"/)
})

test('scene containers use complete artwork instead of reverting to generic cylinder geometry', () => {
  const script = scriptFor({ view: 'iso' }), fit = withTools(script, geometry, sizes, {})
  const layout = solveBuild(script, fit.geometry, fit.sizes)
  assert.equal(layout.boards?.amaro, undefined)
  assert.equal(layout.scene.amaro.illustrated, true)
  assert.deepEqual(requiredDrawingKeys(layout, fit.geometry), ['amaro'])
})

test('live and replay keep the complete drawing frame and the intro never samples the sideways cut-out', t => {
  const dir = mkdtempSync(join(tmpdir(), 'complete-illustration-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'screens'))
  const script = scriptFor(), fit = withTools(script, geometry, sizes, {})
  const drawing = { width: 416, height: 1340, parts: [{ id: 'amaro', parent: null, pivot: [208, 1340],
    shapes: [{ d: 'M50 1340V300L160 100H256L366 300V1340Z', fill: '#123d28', stroke: '#1d2b4f' }] }] }
  writeFileSync(join(dir, 'script.json'), JSON.stringify(script))
  writeFileSync(join(dir, 'screens/traced.json'), JSON.stringify({ amaro: { ...drawing, width: 1340, height: 608 } }))
  const art = filmDrawings(dir, { amaro: drawing })
  assert.equal(art.live.vectors.amaro, drawing)
  assert.equal(art.replay.vectors.amaro, drawing)
  assert.deepEqual(art.live.upgrades, {})
  const layout = solveBuild(script, fit.geometry, fit.sizes)
  const source = program({ script, vectors: withUp({ amaro: drawing }), boxes: { amaro: bottle.b },
    geometry: fit.geometry, sizes: fit.sizes, layout, photo: { width: 800, height: 1000 } })
  const previousPath = globalThis.Path2D
  globalThis.Path2D = class { constructor(d) { this.d = d } }
  try {
    const draw = new Function(`return (${source})`)()
    for (const time of [1.1, 1.4, 1.9, 3, 4, timeline(script).starts[0] + 0.3]) {
      const canvas = recordingCanvas(), env = offlineEnv(), sampled = []
      env.drawScreen = (_ctx, key) => sampled.push(key)
      draw(canvas.ctx, time, env)
      assert.equal(canvas.depth(), 0)
      assert.ok(sampled.every(k => k === 'photo'), sampled.join(','))
      assert.ok(canvas.calls.some(c => c.method === 'fill' && c.fill === '#123d28'), `art visible at ${time}`)
    }
  } finally { globalThis.Path2D = previousPath }
})
