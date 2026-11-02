import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { plain } from '../src/pipeline/script.mjs'
import { validatePlan } from '../src/pipeline/validate.mjs'
import { withTools } from '../src/solvers/tools.mjs'
import { solveBuild, geometryReview } from '../src/solvers/layout.mjs'

const root = fileURLToPath(new URL('../examples/fixtures/', import.meta.url))

test('every public example has a current contract, complete design and checked geometry', () => {
  for (const name of readdirSync(root)) {
    const read = file => JSON.parse(readFileSync(join(root, name, file), 'utf8'))
    const saved = read('script.json'), script = plain(saved)
    assert.equal(saved.contractVersion, 2, name)
    const validation = validatePlan(script, read('screens/screens.json').photo)
    assert.deepEqual([...validation.errors, ...validation.soft], [], name)
    const screens = read('screens/screens.json')
    const { geometry, sizes } = withTools(script, read('screens/geometry.json'),
      Object.fromEntries(Object.entries(screens).filter(([k]) => k !== 'photo')), {})
    const layout = solveBuild(script, geometry, sizes)
    assert.deepEqual(layout.diagnostics, [], name)
    // A static stock layout does not describe the final envelope after folding or bending.
    // Dedicated fold/strand tests check those dynamic bounds.
    const transformsStock = script.steps.some(s => s.do.some(a => ['fold', 'strand', 'reshape'].includes(a.v)))
    if (!transformsStock) assert.deepEqual(geometryReview(script, layout).errors, [], name)
    assert.equal(layout.connections?.length || 0, script.joints.length, name)
  }
})

test('unversioned and obsolete physical plans are rejected rather than played permissively', () => {
  const saved = JSON.parse(readFileSync(join(root, 'wood8/script.json'), 'utf8'))
  for (const version of [undefined, 1, 3]) {
    const script = { ...saved, contractVersion: version }
    assert.ok(validatePlan(script).errors.some(e => e.includes('version 2')))
    assert.throws(() => plain(script), /version 2/)
  }
})
