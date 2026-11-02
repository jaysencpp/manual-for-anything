// The layout solver: the script's "place" steps and their relations (floor / on / in / hang / pivot / lean) → where
// each object stands in the finished assembly, a side view fitted to the stage. Things only poured or sprinkled from
// have no place of their own: they are the extras, held over their target when used. Its geometry is the cut-outs'
// (each drawing lies exactly over its cut-out × 4), so it runs as soon as SAM is done, without waiting for the drawings.
//
// An object cut into named parts is on the stage only until it is cut: it is left out of the fit (a transient) and
// stands where the script put it — or, too long for the frame there (a plank), alone in the middle — and its parts are
// placed like any object.
//
//   solve(script, geometry, sizes) → {order, extras, transients, poses: {key: {x, y, scale, angle, anchor}}, floorY}
// geometry[key] = {seat, base} in cut-out pixels (segment.mjs's geometry.json); sizes[key] = {width, height} of the
// cut-out. Poses are in drawing units (× 4): anchor is the object's base, and x, y where it stands on the frame.

import { solveJoints } from './joints.mjs'
import { faceFrame } from './connections.mjs'
import { isBrickBuild, solveBricks } from './bricks.mjs'
import { isSceneBuild, solveScene } from './scene.mjs'
import { hasSheetCuts, hasSheetToolPaths, checkSheetJoins } from './sheets.mjs'
import { finalFoldBounds } from './fold.mjs'
import { finalStrandBounds } from './strand.mjs'

const AT = { left: -0.3, start: -0.3, middle: 0, right: 0.3, end: 0.3 }

// A film in the plan, front or iso view (woodworking: how boards meet) is solved by joints.mjs instead; a build of
// toy bricks by bricks.mjs; one made by putting everyday things in place by scene.mjs.
export function solve(script, geometry, sizes, options = {}) {
  const checked = (layout) => {
    if (options.unchecked) return layout
    const diagnostics = [...(layout.diagnostics || []), ...(layout.geometryEstimated ? [] : layout.notes || []).map((message) => ({ code: 'solver-adjustment', message }))]
    for (const j of script.joints || []) if (!layout.connections?.some((c) => c.id === j.id) && !diagnostics.some((d) => d.joint === j.id))
      diagnostics.push({ code: 'unchecked-connection', joint: j.id, message: `${j.id}: connection has no numeric geometry check` })
    if (diagnostics.length) {
      const error = new Error(`Invalid assembly: ${diagnostics.map((d) => d.message).join('; ')}`)
      error.diagnostics = diagnostics; throw error
    }
    return { ...layout, diagnostics }
  }
  // A build of toy bricks: on a stud grid, drawn from the bricks' numbers (bricks.mjs), whatever view the script asked.
  if (isBrickBuild(script)) return checked(solveBricks(script, geometry, sizes, options))
  if (hasSheetCuts(script) || hasSheetToolPaths(script)) {
    const layout = { ...solveJoints({ ...script, view: 'plan' }, geometry, sizes, options), sheetLayout: true }
    layout.diagnostics.push(...checkSheetJoins(script, layout))
    return checked(layout)
  }
  // A build made by putting everyday things in place (no pouring, stirring, cutting, working or tools): each a real
  // 3D size, placed physically (scene.mjs).
  if (isSceneBuild(script)) return checked(solveScene(script, geometry, sizes, options))
  if (['plan', 'front', 'iso'].includes(script.view)) return checked(solveJoints(script, geometry, sizes, options))
  return checked({ ...solveSide(script, geometry, sizes, options), view: 'side' })
}

// solve, with the fasteners settled first: a plan whose screws are all one wrong length for the parts it joins (15 cm
// screws through 11 cm logs, only 4 cm into the log under them) has them made the one length that holds every joint
// they make, when there is one. The solve may still throw, as solve does.
export function solveBuild(script, geometry, sizes, options = {}) {
  const first = solve(script, geometry, sizes, { ...options, unchecked: true })
  const notes = [...(first.rejoined || []).map((r) => `joint ${r.joint}: joins ${r.to}, which its part rests on, not ${r.from}`), ...settleFasteners(script, first)]
  const layout = solve(script, geometry, sizes, options)
  return notes.length ? { ...layout, settled: notes } : layout
}

// For each fastener: the lengths each joint it makes needs (through its part, then at least half the receiving
// part's thickness or 5 cm into it, never out of its far side); where the plan's length is outside them and one
// length is inside all, the fastener, its joints' depth, and the labels and captions that give the length (cm or mm)
// become that length, rounded up to a whole cm where it can be. Returns a note for each.
export function settleFasteners(script, layout) {
  const notes = [], W = layout?.world
  if (!W || !Array.isArray(script?.joints) || !Array.isArray(script.tools)) return notes
  const steps = (script.steps || []).filter((s) => Array.isArray(s?.do))
  for (const tool of script.tools.filter((t) => ['screw', 'nail', 'dowel', 'bolt'].includes(t?.use) && t.cm > 0)) {
    const ops = steps.flatMap((s) => s.do).filter((a) => a?.part === tool.k && a.joint)
    const joints = [...new Set(ops.map((a) => a.joint))].map((id) => script.joints.find((j) => j?.id === id)).filter((j) => j?.method === 'fasten')
    const ranges = joints.map((j) => {
      const c = (layout.connections || []).find((x) => x.id === j.id), a = W[j.a], b = W[j.b]
      if (!a || !b) return null
      const axis = c?.axis || faceFrame(a, j.face).axis
      return [a.e[axis] + Math.min(b.e[axis] / 2, 5), a.e[axis] + b.e[axis]]
    })
    if (!joints.length || ranges.some((r) => !r)) continue
    const lo = Math.max(...ranges.map((r) => r[0])), up = Math.min(...ranges.map((r) => r[1]))
    if (lo > up + 0.01 || ranges.every((r) => tool.cm >= r[0] - 0.01 && tool.cm <= r[1] + 0.01)) continue
    const was = tool.cm, now = Math.ceil(lo - 0.01) <= up ? Math.ceil(lo - 0.01) : +lo.toFixed(1)
    const say = (text) => typeof text === 'string' ? text.replace(new RegExp(`(^|[^\\d.])${was}(\\s*cm\\b)`, 'g'), `$1${now}$2`).replace(new RegExp(`(^|[^\\d.])${+(was * 10).toFixed(1)}(\\s*mm\\b)`, 'g'), `$1${+(now * 10).toFixed(1)}$2`) : text
    tool.cm = now
    for (const j of joints) j.depthCm = now
    const making = (a) => a?.part === tool.k || joints.some((j) => j.id === a?.joint)
    for (const s of steps) if (s.do.some(making)) {
      s.c = say(s.c); s.t = say(s.t)
      if (s.caption) s.caption.template = say(s.caption.template)
      for (const a of s.do) if (making(a)) a.label = say(a.label)
    }
    if (script.design) script.design.joins = say(script.design.joins)
    notes.push(`${tool.k}: ${was} cm → ${now} cm, the length every joint they make needs`)
  }
  return notes
}

// What the steps build, against the size the design gives (script.design.size, width × depth × height): its height
// and its two sides (either way round) within 5 cm or a quarter. Only where the solver knows every part in numbers.
export function sizeProblems(script, layout) {
  // A cutting/working layout contains flat intermediate parts, not the finished object's assembled envelope.
  if (layout?.sheetLayout) return []
  const want = script?.design?.size, bounds = layout?.envelope || layout?.world
  const W = bounds && { ...bounds, ...(layout.turnedBox || {}) }
  if (!Array.isArray(want) || want.length !== 3 || !want.every((v) => v > 0) || !W) return []
  if ((script.steps || []).some(s => (s.do || []).some(a => a.v === 'strand'))) {
    const worked = finalStrandBounds(script)
    if (worked.errors.length) return worked.errors.map(error => `finished strand geometry: ${error}`)
    for (const [key, bounds] of Object.entries(worked.bounds)) {
      if ((layout.transients || []).includes(key)) continue
      const part = W[key]
      // A turned or unplaced strand has no supported map into this rigid layout.
      // Its original rod cannot establish the finished assembly's dimensions.
      if (!part?.p || !part.e || !part.o || part.turn || layout.turnedBox?.[key]) return []
      const { L, W: across, T } = part.o
      W[key] = { ...part, p: { ...part.p, [L]: part.p[L] + bounds.min[0], [across]: part.p[across] + part.e[across] / 2 - bounds.max[1] },
        e: { ...part.e, [L]: bounds.size[0], [across]: bounds.size[1], [T]: bounds.size[2] } }
    }
  }
  if ((script.steps || []).some(s => (s.do || []).some(a => a.v === 'fold' || a.v === 'cut' && a.shape))) {
    const folded = finalFoldBounds(script)
    if (folded.errors.length) return folded.errors.map(error => `finished fold geometry: ${error}`)
    for (const [key, bounds] of Object.entries(folded.bounds)) {
      const part = W[key]
      if (!part?.p || !part.e || !part.o || part.turn) continue
      const { L, W: across } = part.o
      // Local sheet x follows the board length; local sheet y goes from its far edge toward the viewer.
      W[key] = { ...part, p: { ...part.p, [L]: part.p[L] + bounds.min[0], [across]: part.p[across] + bounds.stock[1] - bounds.max[1] },
        e: { ...part.e, [L]: bounds.size[0], [across]: bounds.size[1] } }
    }
  }
  const keys = Object.keys(W).filter((k) => !k.startsWith('__') && !(layout.transients || []).includes(k) && W[k]?.p && W[k]?.e)
  if (!keys.length) return []
  const lo = (ax) => Math.min(...keys.map((k) => W[k].p[ax])), hi = (ax) => Math.max(...keys.map((k) => W[k].p[ax] + W[k].e[ax]))
  const built = ['x', 'y', 'z'].map((ax) => +(hi(ax) - lo(ax)).toFixed(1))
  const off = (a, b) => Math.abs(a - b) > Math.max(5, a * 0.25)
  const [bw, bd] = [...built.slice(0, 2)].sort((a, b) => b - a), [ww, wd] = [...want.slice(0, 2)].sort((a, b) => b - a)
  if (!off(want[2], built[2]) && !off(ww, bw) && !off(wd, bd)) return []
  return [`design: the size is ${want.join(' × ')} cm but the steps build ${built.join(' × ')} cm (width × depth × height): make the parts and their placing give the designed size, or correct the design if it was wrong`]
}

// What the steps build, as it would stand and hold: a free-standing thing's base at least a third as wide as it is tall
// (not one fixed to a wall), and each fastener biting into the part it holds by half that part's thickness, or 5 cm.
export function builtProblems(script, layout) {
  if (layout?.sheetLayout) return []
  // (a turned part — leaning, splayed — measured where it really reaches: layout.turnedBox)
  const out = [...sizeProblems(script, layout)], W = layout?.world && { ...layout.world, ...(layout.turnedBox || {}) }
  if (!W) return out
  const keys = Object.keys(W).filter((k) => !k.startsWith('__') && !(layout.transients || []).includes(k) && W[k]?.p && W[k]?.e)
  const walled = (script.steps || []).some((s) => (s.do || []).some((a) => a.v === 'place' && a.rel === 'wall'))
  const floor = keys.filter((k) => W[k].p.z < 0.01)
  if (!walled && floor.length && keys.length > 1) {
    const span = (ax) => Math.max(...floor.map((k) => W[k].p[ax] + W[k].e[ax])) - Math.min(...floor.map((k) => W[k].p[ax]))
    const height = Math.max(...keys.map((k) => W[k].p.z + W[k].e.z)), base = Math.min(span('x'), span('y'))
    if (height > 3 * base + 1) out.push(`it stands ${+height.toFixed(1)} cm tall on a base ${+span('x').toFixed(1)} × ${+span('y').toFixed(1)} cm, and would tip: a base at least a third as wide as the height (${+(height / 3).toFixed(1)} cm), or a lower build`)
  }
  for (const j of script.joints || []) {
    const c = (layout.connections || []).find((x) => x.id === j.id), a = W[j.a], b = W[j.b]
    if (!c || j.method !== 'fasten' || !(j.depthCm > 0) || !a || !b) continue
    const bite = j.depthCm - a.e[c.axis], need = Math.min(b.e[c.axis] / 2, 5)
    if (bite < need - 0.01) out.push(`joint ${j.id}: a ${j.depthCm} cm fastener goes only ${+bite.toFixed(1)} cm into ${j.b} after passing ${+a.e[c.axis].toFixed(1)} cm of ${j.a}; it needs ${+need.toFixed(1)} cm: use ${+(a.e[c.axis] + need).toFixed(1)}–${+(a.e[c.axis] + b.e[c.axis]).toFixed(1)} cm fasteners`)
  }
  return out
}

// Inferred scene dimensions are visual estimates, not a structural proof. Joint/contact diagnostics still throw
// from solveBuild before reaching here; only heuristic envelope/tipping findings become warnings.
export function geometryReview(script, layout) {
  const findings = builtProblems(script, layout)
  return layout.geometryEstimated
    ? { errors: findings.filter((s) => s.startsWith('joint ')), warnings: [...(layout.notes || []), ...findings.filter((s) => !s.startsWith('joint '))] }
    : { errors: findings, warnings: [] }
}

function solveSide(script, geometry, sizes, { floorY = 790, centerX = 910, maxWidth = 1120, maxHeight = 560 } = {}) {
  // Every object at its real size: its longest side the script's cm, at the photo's typical pixels to a cm (the
  // median over its objects). A photo's perspective makes near things look bigger than far ones, so its pixels alone
  // stood headphones taller than the laptop beside them. f: an object's drawing units to world units.
  const cms = Object.fromEntries((script.objects || []).filter((o) => +o.cm > 0).map((o) => [o.k,
    script.artworkMode === 'complete' && (geometry[o.k]?.completeIllustration || geometry[o.k]?.supplied) && o.part?.size
      ? Math.max(o.part.size[0], o.part.size[script.view === 'plan' ? 1 : 2]) : +o.cm]))
  const per = Object.keys(cms).filter((k) => sizes[k]).map((k) => Math.max(sizes[k].width, sizes[k].height) / cms[k]).sort((a, b) => a - b)
  const pxPerCm = per.length ? per[per.length >> 1] : null
  const real = (key) => (pxPerCm && cms[key] && sizes[key] ? cms[key] * pxPerCm / Math.max(sizes[key].width, sizes[key].height) : 1)
  const shape = (key) => {
    const g = geometry[key], s = sizes[key], f = real(key)
    return { w: s.width * 4 * f, h: s.height * 4 * f, seat: g.seat.map((v) => v * 4 * f), base: g.base.map((v) => v * 4 * f), f }
  }
  // World units are drawing units, y up the negative way as on the canvas, the floor at y = 0.
  const world = {}, order = []
  let floorRight = 0
  const slots = {}
  const rotate = ([x, y], a) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)]
  // A point of a placed object (its own coordinates) in the world.
  const at = (key, point) => {
    const p = world[key], s = shape(key), [dx, dy] = rotate([point[0] - s.base[0], point[1] - s.base[1]], p.angle)
    return [p.x + dx, p.y + dy]
  }
  const onFloor = (key) => {
    const s = shape(key)
    world[key] = { x: floorRight + s.w / 2, y: 0, angle: 0 }
    floorRight += s.w * 1.1
    order.push(key)
  }
  // The n-th object put in the same place on the same target moves aside, alternately right and left.
  const nudge = (to, where, w) => {
    const slot = `${to}/${where}`, n = slots[slot] = (slots[slot] ?? -1) + 1
    return n === 0 ? 0 : (n % 2 ? 1 : -1) * Math.ceil(n / 2) * 0.55 * w
  }

  const extras = [], transients = new Set()
  for (const step of script.steps)
    for (const add of step.do) {
      const key = add.k
      if (!geometry[key]) continue
      const to = add.to && geometry[add.to] ? add.to : null
      if (add.v !== 'place') {
        // What is poured, sprinkled, stirred or heated into must stand somewhere; what is cut, too.
        if (to && !world[to]) onFloor(to)
        if (['cut', 'work', 'use', 'measure', 'demonstrate', 'reshape', 'fold', 'strand'].includes(add.v) && !world[key]) onFloor(key)
        // What is held to do the work (a saw, a drill, a tape) or put in by it (the screws) waits in the tray.
        for (const held of [add.with, add.part, ...(add.demo?.actors || []), add.v === 'stir' && geometry[key]?.motion ? key : null])
          if (held && geometry[held] && !world[held] && !extras.includes(held)) extras.push(held)
        if (add.v === 'cut' && Array.isArray(add.into) && add.into.length) transients.add(key)
        if ((add.v === 'pour' || add.v === 'sprinkle') && !world[key] && !extras.includes(key)) extras.push(key)
        // The hook a piece is worked with is held, not placed: it waits in the tray.
        if (add.v === 'work' && geometry[add.with] && !world[add.with] && !extras.includes(add.with)) extras.push(add.with)
        continue
      }
      if (world[key]) continue
      if (to && !world[to]) onFloor(to)
      if (!to || add.rel === 'floor') { onFloor(key); continue }
      const s = shape(key), t = shape(to), offset = (AT[add.at] ?? 0) * t.w + nudge(to, add.at, s.w)
      const [sx, sy] = at(to, [t.seat[0] + offset, t.seat[1]])
      if (add.rel === 'hang') {
        // Its seat (the top of it) at the target's end, the rest hanging below.
        const [hx, hy] = at(to, [t.seat[0] + (AT[add.at] ?? 0.45) * t.w, t.seat[1] + 0.15 * t.h])
        world[key] = { x: hx + (s.base[0] - s.seat[0]), y: hy + (s.base[1] - s.seat[1]), angle: 0 }
      } else if (add.rel === 'lean') {
        const p = world[to]
        // Beside it, its near edge touching, tipped towards it.
        world[key] = { x: p.x + t.w / 2 + s.w * 0.5, y: 0, angle: -0.12 }
      } else {
        world[key] = { x: sx, y: sy + (add.rel === 'in' ? 0.35 * s.h : 0), angle: 0 }
      }
      order.push(key)
    }

  // Fit the whole of it, every object's turned box, to the stage: centred on centerX, its lowest point on the floor.
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (const key of order) {
    if (transients.has(key)) continue
    const s = shape(key)
    for (const corner of [[0, 0], [s.w, 0], [0, s.h], [s.w, s.h]]) {
      const [x, y] = at(key, corner)
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
    }
  }
  if (x0 === Infinity) { x0 = 0; x1 = 1; y0 = -1; y1 = 0 }
  const scale = Math.min(maxWidth / (x1 - x0), maxHeight / (y1 - y0), 3)
  const poses = {}
  for (const key of extras.filter((k) => !world[k])) poses[key] = { x: 0, y: 0, scale: scale * shape(key).f, angle: 0, anchor: shape(key).base.map((v) => v / shape(key).f) }
  for (const key of order) {
    const p = world[key], s = shape(key)
    const x = centerX + (p.x - (x0 + x1) / 2) * scale
    poses[key] = transients.has(key) && (s.w * scale > maxWidth * 0.95 || Math.abs(x - centerX) + s.w * scale / 2 > maxWidth * 0.6)
      ? { x: centerX, y: floorY, scale: Math.min(scale, maxWidth * 0.9 / s.w, maxHeight * 0.5 / s.h) * s.f, angle: 0, anchor: s.base.map((v) => v / s.f) }
      : { x, y: floorY + (p.y - y1) * scale, scale: scale * s.f, angle: p.angle, anchor: s.base.map((v) => v / s.f) }
  }
  return { order, extras: extras.filter((k) => !world[k]), transients: [...transients], poses, floorY }
}
