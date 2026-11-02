import test from 'node:test'
import assert from 'node:assert/strict'
import { solveScene } from '../src/solvers/scene.mjs'

test('moving a part beside another a second time leaves it supported by the table', () => {
  const keys = ['battery', 'fuse', 'resistor', 'led']
  const objects = keys.map((k) => ({ k, cm: 3, part: { family: 'box', size: [3, 2, 1] } }))
  const geometry = Object.fromEntries(keys.map((k) => [k, { base: [10, 20], seat: [10, 0] }]))
  const sizes = Object.fromEntries(keys.map((k) => [k, { width: 20, height: 20 }]))
  for (const rel of ['next', 'lean', 'floor']) {
    const script = { objects, steps: [
      ...keys.map((k, i) => ({ do: [{ v: 'place', k, rel: i ? 'next' : 'floor', to: keys[i - 1], at: 'right' }] })),
      { do: [{ v: 'place', k: 'led', rel, to: 'battery', at: 'middle' }] },
    ] }
    const layout = solveScene(script, geometry, sizes)
    assert.equal(layout.world.led.p.z, 0)
    assert.ok(Number.isFinite(layout.world.led.p.x))
    assert.ok(Object.values(layout.poses.led).filter((v) => typeof v === 'number').every(Number.isFinite))
  }
})

// Regression for the bottle-display run: the joint solids contained only the
// 3 cm base although four upright bottles were correctly positioned above it.
import { solveBuild, geometryReview, sizeProblems } from '../src/solvers/layout.mjs'
import { withTools } from '../src/solvers/tools.mjs'
import { physicalPlan } from './support/physical-plan.mjs'
import { settlePlanningInputs } from '../src/pipeline/planning-inputs.mjs'
import { validateContract } from '../src/solvers/contracts.mjs'
import { validatePlan } from '../src/pipeline/validate.mjs'
import { PHYSICAL_PLAN_SCHEMA } from '../src/pipeline/plan-schema.mjs'
import { readFileSync } from 'node:fs'

function bottleDisplay(strip = 90) {
  const bottles = [[10, 23], [9, 27], [8, 30], [9, 29]].map(([width, height], i) => ({ k: `bottle-${i}`, n: `Bottle ${i}`,
    cm: height, b: [i * 100, 0, 80, 300], part: { family: 'cylinder', shape: 'vessel', size: [width, width, height] } }))
  const script = physicalPlan({ view: 'front', artworkMode: 'complete', objects: bottles,
    materials: [{ k: 'base', n: 'Display base', family: 'box', size: [90, 18, 3] },
      { k: 'led', n: 'LED strip', family: 'rod', size: [strip, 1, 0.3] }],
    tools: [{ k: 'level', use: 'level' }],
    design: { purpose: 'Bottle display', size: [90, 18, 33], stands: 'A level base', joins: 'Bottles rest on the base',
      parts: [{ k: 'base', from: 'base', cm: 90, n: 1 }, { k: 'led', from: 'led', cm: strip, n: 1 },
        ...bottles.map(o => ({ k: o.k, from: o.k, cm: o.cm, n: 1 }))] },
    steps: [{ t: 'Base', c: 'Place base', do: [{ v: 'place', k: 'base', rel: 'floor', at: 'middle' }] },
      ...bottles.map((o, i) => ({ t: 'Bottle', c: `Place bottle ${12 + 22 * i} cm along the base`,
        do: [{ v: 'place', k: o.k, to: 'base', rel: 'on', cm: 12 + 22 * i, label: `${12 + 22 * i} cm` }] })),
      { t: 'LED', c: 'Place LED strip along the front edge', do: [{ v: 'place', k: 'led', to: 'base', rel: 'on', side: 'front' }] },
      { t: 'Check', c: 'Check level', do: [{ v: 'use', k: 'base', with: 'level', intent: 'fit' }] }],
  })
  settlePlanningInputs(script)
  const geometry = Object.fromEntries(bottles.map(o => [o.k, { origin: [0, 0], seat: [40, 0], base: [40, 300] }]))
  const sizes = Object.fromEntries(bottles.map(o => [o.k, { width: 80, height: 300 }]))
  const fit = withTools(script, geometry, sizes, {})
  return { script, fit, layout: solveBuild(script, fit.geometry, fit.sizes) }
}

test('the full display envelope includes cylinders and rods while joint checks retain rectangular solids', () => {
  const { script, layout } = bottleDisplay()
  assert.deepEqual(geometryReview(script, layout), { errors: [], warnings: [] })
  assert.deepEqual(sizeProblems(script, layout), [])
  assert.equal(layout.world['bottle-2'], undefined)
  assert.equal(layout.envelope['bottle-2'].p.z + layout.envelope['bottle-2'].e.z, 33)
  for (let i = 0; i < 4; i++) {
    assert.equal(layout.envelope[`bottle-${i}`].p.x - layout.envelope.base.p.x, 12 + 22 * i)
    assert.equal(layout.envelope[`bottle-${i}`].p.z, 3)
  }
  assert.equal(layout.envelope.led.p.y, layout.envelope.base.p.y)
  assert.equal(layout.envelope.led.p.x, layout.envelope.base.p.x)
  assert.deepEqual(validateContract(script).errors, [])
  assert.equal(validatePlan(script).valid, true)
})

test('an overlong strip retains its length and produces the real envelope mismatch', () => {
  const { script, layout } = bottleDisplay(120)
  assert.equal(layout.envelope.led.e.x, 120)
  assert.match(sizeProblems(script, layout).join(';'), /steps build 120 × 18 × 33 cm/)
})

test('measured placements validate against the support, and work positions still validate against the worked part', () => {
  const { script } = bottleDisplay()
  const placement = script.steps[3].do[0]
  assert.ok(placement.cm > script.objects.find(o => o.k === placement.k).cm)
  assert.deepEqual(validateContract(script).errors, [])
  placement.cm = 91
  assert.match(validateContract(script).errors.join(';'), /measured placement lies outside target base/)
  placement.cm = [12, 34]
  assert.match(validateContract(script).errors.join(';'), /needs one cm offset/)
  placement.cm = 56
  placement.to = null
  assert.match(validateContract(script).errors.join(';'), /needs one cm offset.*target/)
  placement.to = 'base'
  const work = script.steps.at(-1).do[0]; work.k = 'bottle-2'; work.cm = 34
  assert.match(validateContract(script).errors.join(';'), /measured work position lies outside the part/)
})

test('measured positions cannot silently overhang the support or be shifted to fit', () => {
  const { script, fit } = bottleDisplay()
  script.steps[4].do[0].cm = 85 // the start fits, but the 9 cm wide bottle does not
  assert.throws(() => solveBuild(script, fit.geometry, fit.sizes), /placement at 85 cm on base extends beyond its 90 cm width/)
})

test('the planner schema and prompt document measured offsets and explicit strip length', () => {
  const action = PHYSICAL_PLAN_SCHEMA.properties.steps.items.properties.do.items
  assert.match(action.properties.cm.description, /along target to/)
  assert.deepEqual(action.anyOf.find(branch => branch.properties.v.enum[0] === 'place').properties.cm, { type: 'number', minimum: 0 })
  const prompt = readFileSync(new URL('../prompts/script-prompt.txt', import.meta.url), 'utf8')
  assert.match(prompt, /NOT its center/)
  assert.match(prompt, /retains its declared full length/)
})
