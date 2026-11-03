import test from 'node:test'
import assert from 'node:assert/strict'
import { solveBricks } from '../src/solvers/bricks.mjs'

const brick = (k, studs = [4, 2]) => ({ k, n: `${k} brick`, part: { family: 'brick', studs, plates: 3 } })
const build = (objects, actions) => solveBricks({ objects, steps: [{ do: actions.map(a => ({ v: 'place', ...a })) }] },
  Object.fromEntries(objects.map(o => [o.k, {}])), {}).grid

test('a larger row on the table is nearer the viewer', () => {
  const grid = build([brick('back'), brick('front')], [{ k: 'back', rel: 'floor', studs: [0, 0] }, { k: 'front', rel: 'floor', studs: [0, 3] }])
  assert.ok(grid.front.y + grid.front.d <= grid.back.y, 'y grows away from the viewer')
  assert.equal(grid.back.y - (grid.front.y + grid.front.d), 1, 'one clear row between them')
})

test('studs on a brick count from its back-left stud', () => {
  const grid = build([brick('base', [4, 4]), brick('rear', [2, 1]), brick('near', [2, 1])], [
    { k: 'base', rel: 'floor', studs: [0, 0] },
    { k: 'rear', rel: 'on', to: 'base', studs: [0, 0] },
    { k: 'near', rel: 'on', to: 'base', studs: [2, 3] },
  ])
  assert.equal(grid.rear.y + grid.rear.d, grid.base.y + grid.base.d, 'row 0 lies along the back edge')
  assert.equal(grid.near.y, grid.base.y, 'the last row lies along the front edge')
  assert.equal(grid.near.x, grid.base.x + 2)
  assert.equal(grid.near.z, grid.base.z + grid.base.h)
})

test('a brick with no studs given stays centred and on what it was placed on', () => {
  const grid = build([brick('base', [4, 4]), brick('top', [2, 2])], [{ k: 'base', rel: 'floor', studs: [0, 0] }, { k: 'top', rel: 'on', to: 'base' }])
  assert.equal(grid.top.x, grid.base.x + 1); assert.equal(grid.top.y, grid.base.y + 1)
})
