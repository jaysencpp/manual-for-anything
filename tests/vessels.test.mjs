import test from 'node:test'
import assert from 'node:assert/strict'
import { vesselGeometry, liquidLevel, needsVesselInterior, ingredientPose } from '../src/solvers/vessels.mjs'
import { physicalPlan } from './support/physical-plan.mjs'
import { withTools } from '../src/solvers/tools.mjs'
import { solveBuild } from '../src/solvers/layout.mjs'
import { program, timeline } from '../src/film/engine.mjs'
import { recordingCanvas, offlineEnv } from '../scripts/offline-canvas.mjs'
import { refusedIn } from '../src/pipeline/words.mjs'
import { suppliedObjects } from '../src/pipeline/planning-inputs.mjs'

const glass = () => ({ width: 400, height: 600,
  parts: [{ id: 'glass', parent: null, pivot: [200, 600], shapes: [{ d: 'M80 160L130 570H280L330 160Z', fill: '#d7edf6', stroke: '#1d2b4f' }] }],
  vessel: { seat: [210, 160], rx: 100, ry: 16, interior: [[100, 160], [310, 160], [260, 550], [150, 550]],
    spout: [100, 160], front: [{ d: 'M100 160Q210 192 310 160', fill: 'none', stroke: '#123456' }] } })

test('container geometry validates the actual rim, inner walls and optional pouring lip', () => {
  const art = glass(), original = structuredClone(art)
  const geometry = vesselGeometry(art)
  assert.deepEqual(geometry.seat, [210, 160])
  assert.deepEqual(geometry.interior, art.vessel.interior)
  assert.deepEqual(art, original)
  for (const mutate of [
    v => { v.seat = [210, -1] }, v => { v.rx = Infinity }, v => { v.ry = 0 },
    v => { v.interior[0] = [-1, 160] }, v => { v.interior = [[0, 200], [200, 200], [300, 200]] },
    v => { v.interior = [[100, 20], [310, 20], [310, 80], [100, 80]] },
    v => { v.spout = [401, 160] }, v => { v.front = [{ d: null }] },
  ]) { const bad = glass(); mutate(bad.vessel); assert.equal(vesselGeometry(bad), null) }
  const legacy = glass(); delete legacy.vessel.interior; delete legacy.vessel.front
  assert.ok(vesselGeometry(legacy)); assert.equal(liquidLevel(vesselGeometry(legacy), [], 0), null)
  assert.equal(needsVesselInterior({ steps: [{ do: [{ v: 'pour', k: 'jug', to: 'glass' }] }] }, 'glass'), true)
  assert.equal(needsVesselInterior({ steps: [{ do: [{ v: 'place', k: 'glass' }] }] }, 'glass'), false)
})

test('liquid starts at the inside bottom and rises only during each addition, leaving headroom', () => {
  const v = vesselGeometry(glass()), additions = [{ at: 10.5, fillAt: 10, fillEnd: 11 }, { at: 20.5, fillAt: 20, fillEnd: 21 }]
  const at = t => liquidLevel(v, additions, t)
  assert.equal(at(9).level, 0); assert.equal(at(9).surface, 550)
  assert.ok(at(10.2).surface > at(10.8).surface)
  assert.equal(at(12).surface, at(19).surface)
  assert.ok(at(20.8).surface < at(19).surface)
  assert.ok(at(22).surface > v.seat[1] + v.ry)
  assert.equal(at(22).level, 0.78)
})

test('solid contents require an interior even before liquid is added; rim garnishes and tools do not', () => {
  const script = { objects: [{ k: 'glass', part: { family: 'cylinder' } },
    { k: 'ice', part: { family: 'box' } }, { k: 'spoon', toolKind: 'spoon' }],
    steps: [{ do: [{ v: 'place', k: 'ice', rel: 'in', to: 'glass' }] }] }
  assert.equal(needsVesselInterior(script, 'glass'), true)
  script.steps[0].do[0].rel = 'on'
  assert.equal(needsVesselInterior(script, 'glass'), false)
  script.steps[0].do[0] = { v: 'place', k: 'spoon', rel: 'in', to: 'glass' }
  assert.equal(needsVesselInterior(script, 'glass'), false)
})

test('two individually declared box cubes sit separately below the rim and rise inside the glass', () => {
  const script = physicalPlan({ materials: ['ice-1', 'ice-2'].map(k => ({ k, n: 'ice cube', family: 'box', size: [1.5, 1.5, 1.5] })), objects: [
    { k: 'glass', n: 'glass', cm: 20, b: [0, 0, 100, 150], part: { family: 'cylinder', size: [10, 10, 20] } },
    { k: 'jug', n: 'jug', cm: 20, b: [0, 0, 100, 150] },
  ], steps: [
    { t: 'Glass', c: 'Place the glass', do: [{ v: 'place', k: 'glass', rel: 'floor' }, { v: 'place', k: 'jug', rel: 'floor' }] },
    { t: 'Ice', c: 'Add two ice cubes', do: ['ice-1', 'ice-2'].map(k => ({ v: 'place', k, rel: 'in', to: 'glass' })) },
    { t: 'Pour', c: 'Pour juice', do: [{ v: 'pour', k: 'jug', to: 'glass', color: '#ff9a24' }] },
  ] })
  script.objects.push(...suppliedObjects(script))
  const vectors = { glass: glass(), jug: glass(), ...Object.fromEntries(['ice-1', 'ice-2'].map(k => [k,
    { width: 115, height: 115, parts: [{ id: k, parent: null, pivot: [57.5, 115], shapes: [{ d: 'M0 0H115V115H0Z', fill: '#abcdef' }] }] }])) }
  const raw = Object.fromEntries(['glass', 'jug'].map(k => [k, { origin: [0, 0], seat: [50, 0], base: [50, 150] }]))
  const sizes = { glass: { width: 100, height: 150 }, jug: { width: 100, height: 150 } }
  const fitted = withTools(script, raw, sizes, vectors), layout = solveBuild(script, fitted.geometry, fitted.sizes)
  const draw = new Function(`return (${program({ script, ...fitted, layout, photo: { width: 200, height: 150 }, boxes: {} })})`)()
  const pour = timeline(script).acts.find(a => a.v === 'pour'), previous = []
  const oldPath = globalThis.Path2D; globalThis.Path2D = class { constructor(d) { this.d = d } }
  try {
    for (const fraction of [0, 0.75]) {
      const c = recordingCanvas(); draw(c.ctx, pour.at + pour.len * fraction, offlineEnv())
      const bases = []
      for (const [i, key] of ['ice-1', 'ice-2'].entries()) {
        const marks = c.calls.map((call, i) => call.method === 'mark' && call.args[0] === key ? i : -1).filter(i => i >= 0)
        assert.equal(marks.length, 1, `${key} is visible once`)
        const before = c.calls.slice(0, marks[0]), matrix = before.findLast(call => call.method === 'transform').args
        const center = matrix[0] * 57.5 + matrix[4], base = matrix[3] * 115 + matrix[5]
        const holder = layout.poses.glass, rim = holder.y + (glass().vessel.seat[1] - holder.anchor[1]) * holder.scale
        const bottom = holder.y + (550 - holder.anchor[1]) * holder.scale
        assert.ok(matrix[5] > rim, 'the whole cube is below the rim')
        assert.ok(base < bottom, 'cube rests above the inside bottom')
        assert.ok(before.some(call => call.method === 'clip'), 'contents are clipped to the interior')
        if (fraction) assert.ok(base < previous[i], 'each cube rises with the liquid')
        else previous.push(base)
        bases.push({ center, width: matrix[0] * 115 })
      }
      assert.ok(bases[1].center - bases[0].center > (bases[0].width + bases[1].width) / 2, 'cubes do not overlap')
      assert.equal(c.depth(), 0)
    }
  } finally { globalThis.Path2D = oldPath }
})

test('loose ingredients fit inside a transformed vessel and only ice rises with its liquid', () => {
  const vessel = vesselGeometry(glass()), holder = { x: 500, y: 700, scale: 0.5, angle: 0.25, anchor: [200, 600] }
  const size = { width: 1000, height: 400 }
  const empty = ingredientPose(vessel, size, holder, 0.5, 550, true)
  const full = ingredientPose(vessel, size, holder, 0.5, 250, true)
  const sinking = ingredientPose(vessel, size, holder, 0.5, 250, false)
  assert.deepEqual(sinking, empty)
  assert.ok(full.y < empty.y)
  assert.ok(full.scale * size.width < vessel.rx * 2 * holder.scale)
  assert.equal(full.angle, holder.angle)
  assert.deepEqual(full.anchor, [500, 400])
  const moved = ingredientPose(vessel, size, { ...holder, x: 600, y: 720 }, 0.5, 250, true)
  assert.equal(moved.x - full.x, 100); assert.equal(moved.y - full.y, 20)
  const script = { objects: [{ k: 'ice', part: { family: 'loose' } }, { k: 'glass', part: { family: 'cylinder' } }],
    steps: [{ do: [{ v: 'place', k: 'ice', rel: 'in', to: 'glass' }] }] }
  assert.equal(needsVesselInterior(script, 'glass'), true)
})

for (const family of ['loose', 'box', 'cylinder']) test(`${family} ice stays inside the glass during pouring, above liquid and below front outlines`, () => {
  const script = physicalPlan({ objects: [
    { k: 'glass', n: 'glass', cm: 20, b: [0, 0, 100, 150], part: { family: 'cylinder', size: [10, 10, 20] } },
    { k: 'ice', n: 'ice cubes', cm: 10, b: [0, 0, 200, 100], part: { family, size: [10, 10, 5] } },
    { k: 'jug', n: 'jug', cm: 20, b: [0, 0, 100, 150] },
  ], steps: [
    { t: 'Glass', c: 'Place glass', do: [{ v: 'place', k: 'glass', rel: 'floor' }, { v: 'place', k: 'jug', rel: 'floor' }] },
    { t: 'Ice', c: 'Add ice', do: [{ v: 'place', k: 'ice', rel: 'in', to: 'glass' }] },
    { t: 'Pour', c: 'Pour juice', do: [{ v: 'pour', k: 'jug', to: 'glass', color: '#ff9a24' }] },
    { t: 'Transfer', c: 'Pour the glass into the jug', do: [{ v: 'pour', k: 'glass', to: 'jug', color: '#ff9a24' }] },
    { t: 'Remove', c: 'Remove ice', do: [{ v: 'place', k: 'ice', rel: 'floor' }] },
  ] })
  const vectors = { glass: glass(), jug: glass(), ice: { width: 800, height: 400, parts: [{ id: 'ice', parent: null,
    pivot: [400, 400], shapes: [{ d: 'M0 0H800V400H0Z', fill: '#abcdef' }] }] } }
  const raw = Object.fromEntries(script.objects.map(o => [o.k, { origin: [0, 0], seat: [50, 0], base: [50, 150] }]))
  const sizes = { glass: { width: 100, height: 150 }, jug: { width: 100, height: 150 }, ice: { width: 200, height: 100 } }
  const fitted = withTools(script, raw, sizes, vectors), layout = solveBuild(script, fitted.geometry, fitted.sizes)
  const source = program({ script, ...fitted, layout, photo: { width: 200, height: 150 }, boxes: {} }), times = timeline(script)
  assert.deepEqual(refusedIn(source), [])
  const oldPath = globalThis.Path2D; globalThis.Path2D = class { constructor(d) { this.d = d } }
  try {
    const draw = new Function(`return (${source})`)(), pour = times.acts.find(a => a.v === 'pour'), positions = []
    for (const fraction of [0.42, 0.75]) {
      const c = recordingCanvas(); draw(c.ctx, pour.at + pour.len * fraction, offlineEnv()); assert.equal(c.depth(), 0)
      const mark = c.calls.findIndex(c => c.method === 'mark' && c.args[0] === 'ice')
      assert.ok(mark > 0, 'ice remains visible in the pouring view')
      assert.ok(c.calls.slice(0, mark).some(c => c.method === 'fillRect' && c.fill === '#ff9a24'), 'liquid behind ice')
      const matrix = c.calls.slice(0, mark).findLast(c => c.method === 'transform').args
      positions.push(matrix[5])
      assert.ok(matrix[0] * 800 < glass().vessel.rx * 2 * layout.poses.glass.scale, 'pile fits the glass width')
      assert.ok(c.calls.slice(0, mark).some(c => c.method === 'clip'))
      const iceFill = c.calls.findIndex(c => c.method === 'fill' && c.fill === '#abcdef')
      assert.ok(c.calls.slice(iceFill + 1).some(c => c.method === 'stroke' && c.args[0]?.d === glass().vessel.front[0].d), 'front lines above ice')
    }
    assert.ok(positions[1] < positions[0], 'ice rises with the fill')
    // A filled source lifts, tips, pours and returns with its ice and front outlines attached.
    const transfer = times.acts.find(a => a.v === 'pour' && a.k === 'glass'), localBases = [], holderOrigins = [];
    for (const fraction of [0.02, 0.15, 0.5, 0.93]) {
      const c = recordingCanvas(); draw(c.ctx, transfer.at + transfer.len * fraction, offlineEnv()); assert.equal(c.depth(), 0)
      const marks = c.calls.map((call, i) => call.method === 'mark' && call.args[0] === 'ice' ? i : -1).filter(i => i >= 0)
      assert.equal(marks.length, 1, 'contained ice is drawn once with the moving source')
      const mark = marks[0], iceMatrix = c.calls.slice(0, mark).findLast(call => call.method === 'transform').args
      const iceFill = c.calls.findIndex(call => call.method === 'fill' && call.fill === '#abcdef')
      const front = c.calls.findIndex((call, i) => i > iceFill && call.method === 'stroke' && call.args[0]?.d === glass().vessel.front[0].d)
      assert.ok(front > iceFill, 'moving front outlines cover the ice')
      const holderMatrix = c.calls.slice(0, front).findLast(call => call.method === 'transform').args
      const [a, b, cc, d, x, y] = holderMatrix, det = a * d - b * cc
      const baseX = iceMatrix[0] * 400 + iceMatrix[2] * 400 + iceMatrix[4] - x
      const baseY = iceMatrix[1] * 400 + iceMatrix[3] * 400 + iceMatrix[5] - y
      localBases.push([(d * baseX - cc * baseY) / det, (-b * baseX + a * baseY) / det])
      holderOrigins.push([x, y])
      assert.ok(Math.abs(Math.atan2(iceMatrix[1], iceMatrix[0]) - Math.atan2(b, a)) < 1e-6, 'ice tilts with its holder')
    }
    for (const base of localBases) assert.ok(Math.hypot(base[0] - localBases[0][0], base[1] - localBases[0][1]) < 1e-6, 'ice stays in vessel coordinates')
    assert.ok(Math.hypot(holderOrigins[0][0] - holderOrigins[2][0], holderOrigins[0][1] - holderOrigins[2][1]) > 20, 'source actually moves')
    const c = recordingCanvas(); draw(c.ctx, times.acts.at(-1).at + 1, offlineEnv()); assert.equal(c.depth(), 0)
    const mark = c.calls.findIndex(c => c.method === 'mark' && c.args[0] === 'ice')
    const matrix = c.calls.slice(0, mark).findLast(c => c.method === 'transform').args
    assert.ok(Math.abs(matrix[0] - layout.poses.ice.scale) < 1e-6, 'later placement releases the containment scale')
  } finally { globalThis.Path2D = oldPath }
})

test('pouring uses the drawn opening and clips a rising volume inside an offset glass, including transformed poses', () => {
  const script = physicalPlan({ objects: ['jug', 'glass'].map(k => ({ k, n: k, cm: 20, b: [0, 0, 100, 150] })),
    steps: [
      ...['jug', 'glass'].map(k => ({ t: `Place ${k}`, c: `Place the ${k}`, do: [{ v: 'place', k, rel: 'floor' }] })),
      { t: 'Pour juice', c: 'Pour juice into the glass', do: [{ v: 'pour', k: 'jug', to: 'glass', color: '#ff9a24' }] },
      { t: 'Add more', c: 'Pour more juice into the glass', do: [{ v: 'pour', k: 'jug', to: 'glass', color: '#ff9a24' }] },
    ] })
  const jug = glass(); jug.parts[0].id = 'jug'; jug.vessel.spout = [90, 160]
  const raw = Object.fromEntries(script.objects.map(o => [o.k, { origin: [0, 0], seat: [50, 0], base: [50, 150] }]))
  const sizes = Object.fromEntries(script.objects.map(o => [o.k, { width: 100, height: 150 }]))
  const fitted = withTools(script, raw, sizes, { glass: glass(), jug }), times = timeline(script)
  assert.deepEqual(fitted.geometry.glass.seat, [52.5, 40])
  const oldPath = globalThis.Path2D; globalThis.Path2D = class { constructor(d) { this.d = d } }
  try {
    for (const angle of [0, 0.25]) {
      const layout = solveBuild(script, fitted.geometry, fitted.sizes)
      layout.poses.glass.angle = angle
      const source = program({ script, ...fitted, layout, photo: { width: 100, height: 150 }, boxes: {} })
      assert.deepEqual(refusedIn(source), [])
      const draw = new Function(`return (${source})`)(), env = offlineEnv(), pour = times.acts[2]
      const frame = fraction => {
        const c = recordingCanvas(); draw(c.ctx, pour.at + pour.len * fraction, env); assert.equal(c.depth(), 0); return c.calls
      }
      const fills = fraction => frame(fraction).filter(c => c.method === 'fillRect' && c.fill === '#ff9a24')
      assert.equal(fills(0.2).length, 0)
      const early = fills(0.42).at(-1), late = fills(0.75).at(-1)
      assert.ok(early && late)
      assert.ok(late.args[1] < early.args[1]); assert.ok(late.args[3] > early.args[3])
      assert.equal(late.args[1] + late.args[3], 550)
      const calls = frame(0.65), fillIndex = calls.findIndex(c => c.method === 'fillRect' && c.fill === '#ff9a24')
      assert.ok(calls.slice(0, fillIndex).some(c => c.method === 'clip'))
      assert.ok(calls.slice(fillIndex).some(c => c.method === 'stroke' && c.args[0]?.d === glass().vessel.front[0].d))
      const stream = calls.filter(c => c.method === 'quadraticCurveTo' && c.fill === '#ff9a24').at(-1)
      const pose = layout.poses.glass, fill = calls[fillIndex], x = 210 - pose.anchor[0], y = fill.args[1] - pose.anchor[1]
      const expected = [pose.x + (x * Math.cos(angle) - y * Math.sin(angle)) * pose.scale,
        pose.y + (x * Math.sin(angle) + y * Math.cos(angle)) * pose.scale]
      assert.ok(stream)
      const streamStart = calls.slice(0, calls.indexOf(stream)).findLast(c => c.method === 'moveTo' && c.fill === '#ff9a24')
      assert.ok(Math.abs(streamStart.args[0] - stream.args[2]) < 1e-6, 'outlet aligns over the receiving opening')
      assert.ok(Math.abs(streamStart.args[1] - stream.args[3] + 70) < 1e-6, 'outlet clears the receiving rim')
      const mouthX = 210 - pose.anchor[0], mouthY = 160 - pose.anchor[1]
      assert.ok(Math.abs(stream.args[2] - (pose.x + (mouthX * Math.cos(angle) - mouthY * Math.sin(angle)) * pose.scale)) < 1e-6)
      assert.ok(Math.abs(stream.args[3] - (pose.y + (mouthX * Math.sin(angle) + mouthY * Math.cos(angle)) * pose.scale)) < 1e-6)
      const end = calls.slice(calls.indexOf(stream) + 1).find(c => c.method === 'lineTo' && c.fill === '#ff9a24')
      assert.ok(end)
      assert.ok(Math.abs(end.args[0] - expected[0]) < 1e-6)
      assert.ok(Math.abs(end.args[1] - expected[1]) < 1e-6)
    }
  } finally { globalThis.Path2D = oldPath }
})

test('tall pouring sources align their drawn outlet from the tray and stage, with legacy fallbacks', () => {
  const oldPath = globalThis.Path2D; globalThis.Path2D = class { constructor(d) { this.d = d } }
  try {
    for (const placed of [false, true]) for (const metadata of ['outlet', 'spout', 'legacy']) {
      const script = physicalPlan({ objects: ['jug', 'glass'].map(k => ({ k, n: k, cm: 20, b: [0, 0, 100, 150] })),
        steps: [
          ...(placed ? [{ t: 'Place jug', c: 'Place jug', do: [{ v: 'place', k: 'jug', rel: 'floor' }] }] : []),
          { t: 'Place glass', c: 'Place glass', do: [{ v: 'place', k: 'glass', rel: 'floor' }] },
          { t: 'Pour', c: 'Pour juice', do: [{ v: 'pour', k: 'jug', to: 'glass', color: '#ff9a24' }] },
        ] })
      const jug = { width: 400, height: 1600, parts: [{ id: 'jug', parent: null, pivot: [200, 1600],
        shapes: [{ d: 'M40 80H360V1600H40Z', fill: '#00aa99' }] }] }
      if (metadata === 'outlet') { jug.outlet = [310, 100]; jug.vessel = { ...glass().vessel, spout: [100, 160] } }
      if (metadata === 'spout') jug.vessel = glass().vessel
      const raw = { jug: { origin: [0, 0], seat: [50, 0], base: [50, 400] }, glass: { origin: [0, 0], seat: [50, 0], base: [50, 150] } }
      const fitted = withTools(script, raw, { jug: { width: 100, height: 400 }, glass: { width: 100, height: 150 } }, { jug, glass: glass() })
      const layout = solveBuild(script, fitted.geometry, fitted.sizes); layout.poses.glass.angle = 0.25
      const draw = new Function(`return (${program({ script, ...fitted, layout, photo: { width: 100, height: 150 }, boxes: {} })})`)()
      const pour = timeline(script).acts.at(-1)
      for (const fraction of [0.36, 0.55, 0.79, 0.99]) {
        const c = recordingCanvas(); draw(c.ctx, pour.at + pour.len * fraction, offlineEnv()); assert.equal(c.depth(), 0)
        if (fraction > 0.8) continue
        const stream = c.calls.findLast(c => c.method === 'quadraticCurveTo' && c.fill === '#ff9a24')
        const start = c.calls.slice(0, c.calls.indexOf(stream)).findLast(c => c.method === 'moveTo' && c.fill === '#ff9a24')
        assert.ok(Math.abs(start.args[0] - stream.args[2]) < 1e-6, `${placed}/${metadata}/${fraction}: horizontal alignment`)
        assert.ok(Math.abs(start.args[1] - stream.args[3] + 70) < 1e-6, 'clearance above rim')
        const mark = c.calls.findIndex(c => c.method === 'mark' && c.args[0] === 'jug')
        const matrix = c.calls.slice(0, mark).findLast(c => c.method === 'transform').args
        const lip = jug.outlet || jug.vessel?.spout || [200, 0]
        assert.ok(Math.abs(matrix[0] * lip[0] + matrix[2] * lip[1] + matrix[4] - start.args[0]) < 1e-6, 'stream begins at the drawn lip')
        assert.ok(Math.abs(matrix[1] * lip[0] + matrix[3] * lip[1] + matrix[5] - start.args[1]) < 1e-6)
      }
    }
  } finally { globalThis.Path2D = oldPath }
})

test('finale stage overrides and legacy direct draws carry every garnish with the vessel once', () => {
  const script = physicalPlan({ objects: [
    { k: 'glass', n: 'glass', cm: 20, b: [0, 0, 100, 150], part: { family: 'cylinder', size: [10, 10, 20] } },
    ...['ice', 'peel'].map(k => ({ k, n: k, cm: 5, b: [0, 0, 100, 50], part: { family: 'loose', size: [5, 2, 1] } })),
  ], steps: [
    { t: 'Glass', c: 'Place glass', do: [{ v: 'place', k: 'glass', rel: 'floor' }] },
    ...['ice', 'peel'].map(k => ({ t: k, c: `Add ${k}`, do: [{ v: 'place', k, rel: 'in', to: 'glass' }] })),
  ] })
  const vectors = { glass: glass(), ...Object.fromEntries(['ice', 'peel'].map(k => [k, { width: 200, height: 100,
    parts: [{ id: k, parent: null, pivot: [100, 100], shapes: [{ d: 'M0 0H200V100H0Z', fill: k === 'peel' ? '#ff9900' : '#abcdef' }] }] }])) }
  const raw = Object.fromEntries(script.objects.map(o => [o.k, { origin: [0, 0], seat: [50, 0], base: [50, 150] }]))
  const sizes = Object.fromEntries(script.objects.map(o => [o.k, { width: 100, height: 150 }]))
  const fitted = withTools(script, raw, sizes, vectors), layout = solveBuild(script, fitted.geometry, fitted.sizes), times = timeline(script)
  const oldPath = globalThis.Path2D; globalThis.Path2D = class { constructor(d) { this.d = d } }
  try {
    for (const direct of [false, true]) {
      const finale = direct
        ? `(ctx, u, env, objects, stage) => {
            stage.draw(ctx, { glass: { alpha: 0 }, ice: { alpha: 0 } });
            objects.draw(ctx, 'glass', { x: 800, y: 600, scale: 0.7, angle: u, anchor: [200, 300] });
            objects.draw(ctx, 'ice', { x: 20, y: 20, scale: 1, angle: 0 });
          }`
        : `(ctx, u, env, objects, stage) => {
            stage.draw(ctx, { glass: { x: 800, y: 600, scale: 0.7, angle: u, anchor: [200, 300] } });
          }`
      const source = program({ script, ...fitted, layout, photo: { width: 200, height: 150 }, boxes: {}, finale })
      assert.deepEqual(refusedIn(source), [])
      const draw = new Function(`return (${source})`)(), bases = []
      for (const angle of [0.2, 1.5, 3]) {
        const c = recordingCanvas(); draw(c.ctx, times.finale + angle, offlineEnv()); assert.equal(c.depth(), 0)
        for (const key of ['ice', 'peel']) {
          const marks = c.calls.map((call, i) => call.method === 'mark' && call.args[0] === key ? i : -1).filter(i => i >= 0)
          assert.equal(marks.length, 1, `${key} is drawn once, including with legacy explicit ice drawing`)
          const matrix = c.calls.slice(0, marks[0]).findLast(call => call.method === 'transform').args
          assert.ok(Math.abs(Math.atan2(matrix[1], matrix[0]) - angle) < 1e-6, `${key} turns with the glass`)
          if (key === 'peel') {
            const x = matrix[0] * 100 + matrix[2] * 100 + matrix[4] - 800
            const y = matrix[1] * 100 + matrix[3] * 100 + matrix[5] - 600
            bases.push([x * Math.cos(angle) + y * Math.sin(angle), -x * Math.sin(angle) + y * Math.cos(angle)])
          }
        }
      }
      for (const base of bases) assert.ok(Math.hypot(base[0] - bases[0][0], base[1] - bases[0][1]) < 1e-6, 'peel keeps its position inside the rotating glass')
    }
  } finally { globalThis.Path2D = oldPath }
})
