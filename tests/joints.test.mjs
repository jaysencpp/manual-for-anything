import test from 'node:test'
import assert from 'node:assert/strict'
import { solveJoints } from '../src/solvers/joints.mjs'

function solve(orientation) {
  const script = { view: 'plan', objects: [{ k: 'surface', cm: 80, w: 20, thick: 2 }, { k: 'support', cm: 40, w: 4, thick: 2 }],
    steps: [{ do: [{ v: 'place', k: 'surface', rel: 'floor' }, { v: 'place', k: 'support', rel: 'under', to: 'surface', ...orientation }] }] }
  const geometry = Object.fromEntries(script.objects.map((o) => [o.k, { origin: [0, 0], seat: [40, 0], base: [40, 20] }]))
  const sizes = Object.fromEntries(script.objects.map((o) => [o.k, { width: 80, height: 20 }]))
  return solveJoints(script, geometry, sizes).boards.support
}

test('an explicit horizontal axis keeps an underside support flat and at its real length', () => {
  const b = solve({ axis: 'y' })
  assert.equal(b.w, 16); assert.equal(b.h, 160)
})

test('an explicit flat support lies along x while a default leg remains upright', () => {
  const flat = solve({ stand: 'flat' }), leg = solve({})
  assert.equal(flat.w, 160); assert.equal(flat.h, 16)
  assert.equal(leg.w, 8); assert.equal(leg.h, 16)
})
