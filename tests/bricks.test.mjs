import test from 'node:test'
import assert from 'node:assert/strict'
import { solveBricks } from '../src/solvers/bricks.mjs'
import { solve } from '../src/solvers/layout.mjs'

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

const pillars = (bridge) => [
  { k: 'left', rel: 'floor', studs: [0, 0] }, { k: 'right', rel: 'floor', studs: [6, 0] }, { k: 'bridge', rel: 'on', to: 'left', studs: bridge },
]
const problems = (objects, actions) => solveBricks({ objects, steps: [{ do: actions.map(a => ({ v: 'place', ...a })) }] },
  Object.fromEntries(objects.map(o => [o.k, {}])), {}).diagnostics.map(d => d.message)
const three = [brick('left'), brick('right'), brick('bridge')]

test('a bridge one stud short of its second pillar is a problem, and one that reaches it is not', () => {
  assert.match(problems(three, pillars([2, 0])).join(), /bridge: overhangs and stops at the edge of right/)
  assert.deepEqual(problems(three, pillars([3, 0])), [])
})

test('the near miss is found in every direction', () => {
  const towards = (bridge) => [{ k: 'left', rel: 'floor', studs: [6, 0] }, { k: 'right', rel: 'floor', studs: [0, 0] }, { k: 'bridge', rel: 'on', to: 'left', studs: bridge }]
  assert.match(problems(three, towards([-2, 0])).join(), /stops at the edge of right/)
  const rows = [brick('near', [2, 4]), brick('far', [2, 4]), brick('span', [2, 4])]
  const inRows = (studs) => [{ k: 'far', rel: 'floor', studs: [0, 0] }, { k: 'near', rel: 'floor', studs: [0, 6] }, { k: 'span', rel: 'on', to: 'far', studs }]
  assert.match(problems(rows, inRows([0, 2])).join(), /span: overhangs and stops at the edge of near/)
  assert.deepEqual(problems(rows, inRows([0, 3])), [])
})

test('ordinary builds are not near misses', () => {
  const objects = [brick('a'), brick('b'), brick('c'), brick('d')]
  assert.deepEqual(problems(objects, [{ k: 'a', rel: 'floor', studs: [0, 0] }, { k: 'b', rel: 'floor', studs: [4, 0] }, { k: 'c', rel: 'on', to: 'a', studs: [0, 0] }, { k: 'd', rel: 'on', to: 'b', studs: [0, 0] }]), [], 'courses butted over a seam')
  assert.deepEqual(problems(objects.slice(0, 2), [{ k: 'a', rel: 'floor', studs: [0, 0] }, { k: 'b', rel: 'on', to: 'a', studs: [2, 0] }]), [], 'an overhang reaching nothing')
  assert.deepEqual(problems(objects.slice(0, 3), [{ k: 'a', rel: 'floor', studs: [0, 0] }, { k: 'b', rel: 'floor', studs: [6, 3] }, { k: 'c', rel: 'on', to: 'a', studs: [2, 0] }]), [], 'the other brick is in another row')
})

test('a near miss stops the layout, so the plan goes to its repair', () => {
  const objects = three, script = { objects, steps: [{ do: pillars([2, 0]).map(a => ({ v: 'place', ...a })) }] }
  assert.throws(() => solve(script, Object.fromEntries(objects.map(o => [o.k, {}])), {}), (error) => error.diagnostics.some(d => d.code === 'brick-near-miss'))
})

