// The joint solver, for assemblies of boards: where each board is, in 3D, from how it meets the others — the way a
// woodworking plan says it — and how it looks from the film's view. Used when the script's "view" is "plan" (from
// above, on a cutting mat: frames, trays, table tops), "front" (looking at it, against a wall: a wall shelf) or "iso"
// (IKEA's three-quarter view: anything that stands up — a box, a planter, a stool, a bookcase); layout.mjs keeps the
// side view (recipes, stacked builds, crochet).
//
// A board is a box: its length (the cm the script gives, or its cut label), its width ("w" cm, else from the photo: the
// length times its straightened cut-out's height over width) and its thickness ("thick" cm, else 2 cm, or its width if
// it is square stock). World axes in cm: x to the right, y away from the viewer (back), z up; the floor is z = 0, the wall y = 0.
// It lies flat (length along x or y, thickness up), stands on its edge (a box's side: width up) or on its end (a leg:
// length up). Relations, for "place" k with `to`:
//   floor    — on the floor; the first lies at the middle, later ones beside the work;
//   on       — on `to`'s upper face; "side" front, back, left, right or middle; "at" start, middle, end (or "cm");
//   parallel — the same way as `to`, beside it across its width, "gap" cm apart, on "side" + or −;
//   end      — at right angles, butted flush against `to`'s end ("at" start or end): an L corner;
//   between  — at right angles, fitted between `to` and the parallel "and", at "at" start, middle or end;
//   across   — at right angles, laid on `to` across it;
//   under    — under `to`, against its lower face, at "at" or "cm" along it: standing on its end (a leg) unless told;
//   wall     — against the wall, its lower face "height" cm above the floor (a shelf; brackets go under it).
// "stand": "edge" or "end" stands a board up; "axis": "x" or "y" says which way its length runs on the floor.
//
//   solveJoints(script, geometry, sizes) → {order, extras, transients, poses, boards, floorY, view}
// boards[key] = {w, h, faces: [{pts, kind}], line: [[x, y], [x, y]], home?, slices?}: its drawing — its bounding box
// (drawing units), its faces (upper, front, side) as polygons in that box, the line along its upper face where tools
// work — and for a board to be cut, its parts' stretches; home: where a cut part lies before it is placed.

import { facePoint, faceFrame, checkConnections } from './connections.mjs'
import { outline, solid, visible, turned } from './shapes.mjs'
const AXES = ['x', 'y', 'z']

// Round wood — a log, a branch, a dowel ("shape": "log" or "round" in its part, else its name; never a toy brick): drawn
// as a cylinder along its length, bark down its sides and its end grain at the end that faces the viewer.
export const isLog = (o) => o?.part?.family !== 'brick' && (['log', 'round'].includes(o?.part?.shape)
  || /\b(logs?|branch(es)?|trunks?|stumps?|firewood|dowels?|poles?|twigs?)\b/i.test(o?.n || ''))

export function solveJoints(script, geometry, sizes, { floorY = 790, centerX = 910, centerY = 500, maxWidth = 1100, maxHeight = 540 } = {}) {
  const view = ['plan', 'front', 'iso'].includes(script.view) ? script.view : 'iso'
  const objects = Object.fromEntries((script.objects || []).map((o) => [o.k, o]))
  // In these views every photo object the script cuts or places is a board — however its photo's angle shows it.
  const isBoard = (k) => { const of = geometry[k]?.sliceOf || k; return !!(geometry[of] && !geometry[of].tool && !geometry[of].piece && sizes[of]) }
  // A board's dimensions in cm: length, width, thickness.
  const dims = (k) => {
    if (geometry[k].sheet) { const [L, W] = geometry[k].sheet.size; return { L, W, T: 0.05 } }
    const of = geometry[k].sliceOf || k, s = sizes[of], o = objects[of] || {}
    // (a part's own size in cm, when the plan gives one — a log [38, 14, 12] — sets its width and thickness)
    const size = Array.isArray(o.part?.size) && o.part.size.length === 3 && o.part.size.every((v) => +v > 0) ? o.part.size.map(Number).sort((a, b) => b - a) : null
    const whole = +o.cm > 0 ? +o.cm : s.width / 4
    const L = geometry[k].sliceOf ? (parseFloat(geometry[k].label) || whole * sizes[k].width / s.width) : whole
    // Its width and thickness as the script gives them (a merchant's sizes); else its width from the photo — which
    // a steep angle distorts, so never more than a third of its length — and 2 cm thick, or square if narrow.
    // A given size's other two sides are what is left once the side its cm names is taken out: an A4 sheet
    // [21, 29.7, 0.1] with cm 21 is 29.7 wide, not the 21 that the sorted size has second.
    const rest = size && size.filter((_, j) => j !== (+o.cm > 0 ? size.reduce((best, v, i) => Math.abs(v - whole) < Math.abs(size[best] - whole) ? i : best, 0) : 0))
    const W = +o.w > 0 ? +o.w : rest ? rest[0] : Math.max(1, Math.min(whole / 3, whole * s.height / s.width)), T = +o.thick > 0 ? +o.thick : rest ? rest[1] : W <= 6 ? W : 2
    return { L, W, T }
  }
  // Its extent along x, y, z for an orientation: which axis its length, width and thickness run along.
  const extent = (d, o) => { const e = {}; e[o.L] = d.L; e[o.W] = d.W; e[o.T] = d.T; return e }
  const lying = (axis = 'x') => ({ L: axis, W: axis === 'x' ? 'y' : 'x', T: 'z' })
  // (a part shorter than it is wide and thick — a slice across a log, a round — lies on its cut face unless told)
  const round = (k) => { const d = k && geometry[k] ? dims(k) : null; return !!d && d.L < Math.min(d.W, d.T) }
  const orient = (a, base, k) => {
    const axis = a.axis === 'y' || a.axis === 'x' ? a.axis : base?.L === 'y' ? 'y' : 'x', other = axis === 'x' ? 'y' : 'x'
    if (a.stand === 'edge') return { L: axis, W: 'z', T: other }
    if (a.stand === 'end' || !a.stand && round(k)) return { L: 'z', W: axis, T: other }
    return lying(axis)
  }
  const B = {}, order = [], extras = [], transients = new Set(), diagnostics = [], gaps = []
  // Parts the plan shapes ("profiles", shapes.mjs): an outline, a taper, notches, rounded corners, angled ends; a
  // "mitre" end is cut where the part meets another at a corner (below), never from the plan's own directions.
  const profiles = Object.fromEntries((Array.isArray(script.profiles) ? script.profiles : []).filter((q) => q && typeof q.k === 'string').map((q) => [q.k, q]))
  const mitred = (k) => Array.isArray(profiles[k]?.ends) && profiles[k].ends.includes('mitre')
  const dirOf = (ax, s) => ({ x: 0, y: 0, z: 0, [ax]: s })
  // Turns a part `th` radians about the edge of its foot on the `toward` side along `ax`, so its top goes that way (a
  // board leaning on another, an A-frame's side); what then dips below the floor is cut level with it.
  const leanOver = (k, th, ax, toward) => {
    const { p, e } = B[k], w = ax === 'x' ? 'y' : 'x', pivot = { x: 0, y: 0, z: p.z }
    pivot[ax] = toward > 0 ? p[ax] + e[ax] : p[ax]; pivot[w] = p[w] + e[w] / 2
    const axis = dirOf(w, 1), probe = { ...pivot, z: p.z + e.z }
    let turn = { axis, angle: th, pivot }
    if ((turned(probe, turn)[ax] - probe[ax]) * toward < 0) turn = { axis, angle: -th, pivot }
    B[k] = { ...B[k], turn, after: [{ n: { x: 0, y: 0, z: -1 }, d: -p.z }], lean: { ax, toward, th } }
  }
  // What a part laid on others rests on, whether the solver chose where (centred: no "at" or "cm" given), and the first
  // part of the row it was laid beside ("parallel"): a layer laid from a centred first part is centred as a whole.
  const rests = {}, centred = {}, rowOf = {}
  const box = (k, o, at) => { B[k] = { o, e: extent(dims(k), o), p: at }; order.push(k) }
  const hi = (k, ax) => B[k].p[ax] + B[k].e[ax]
  const mid = (k, ax) => B[k].p[ax] + B[k].e[ax] / 2
  // Where along a length (from its start p, of length len) something of length l goes: at start, middle, end or cm.
  const along = (a, p, len, l) => a.cm != null && !Number.isNaN(+a.cm) ? p + +a.cm
    : a.at === 'end' || a.at === 'right' ? p + len - l : a.at === 'middle' || a.at === 'center' ? p + (len - l) / 2 : p
  const extentAll = (keys) => {
    const r = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, z1: 0 }
    for (const k of keys) { r.x0 = Math.min(r.x0, B[k].p.x); r.x1 = Math.max(r.x1, hi(k, 'x')); r.y0 = Math.min(r.y0, B[k].p.y); r.y1 = Math.max(r.y1, hi(k, 'y')); r.z1 = Math.max(r.z1, hi(k, 'z')) }
    return r
  }
  const onFloor = (k, a = {}) => {
    const o = orient(a, null, k), e = extent(dims(k), o), work = order.filter((x) => !transients.has(x))
    // Beside the work, to its right; with no work yet, at the origin. Never on top of a board already on the floor
    // there (two boards laid out to be marked): it moves across, beside them, 5 cm apart.
    const p = work.length ? { x: extentAll(work).x1 + 6, y: extentAll(work).y0, z: 0 } : { x: 0, y: 0, z: 0 }
    const hits = (q) => order.some((x) => q.x < hi(x, 'x') && q.x + e.x > B[x].p.x && q.y < hi(x, 'y') && q.y + e.y > B[x].p.y && B[x].p.z < e.z)
    while (hits(p)) p.y = Math.max(...order.filter((x) => B[x].p.z < e.z).map((x) => hi(x, 'y'))) + 5
    box(k, o, p)
  }

  // k on the upper faces of several supports. Supports standing free on the floor on their ends (where "floor" put them
  // is the solver's own choice, beside the work) are gathered under it — one row (two legs at its ends), else a front and a back row (three legs a triangle, four its corners);
  // when they cannot all fit under it, that is reported (a seat too small for its legs), and with "spread" on the place
  // (run.mjs: a plan that still does not fit after its repair) they stay where they stood, it centred over them.
  const restOn = (k, sups, a) => {
    // (supports lying side by side — logs in a layer, two blocks — are bridged: k lies across them, unless told its axis)
    const lyingSame = sups.every((x) => B[x].o.L !== 'z' && B[x].o.L === B[sups[0]].o.L)
    const axis = a.axis === 'y' || a.axis === 'x' ? a.axis : lyingSame ? (B[sups[0]].o.L === 'x' ? 'y' : 'x') : 'x'
    const o = orient({ ...a, axis }, lying(axis), k), e = extent(dims(k), o), r = extentAll(sups)
    const p = { x: (r.x0 + r.x1 - e.x) / 2, y: (r.y0 + r.y1 - e.y) / 2, z: 0 }
    // (only supports standing free on their ends — legs — are gathered; lying ones were placed where they are)
    if (sups.every((x) => B[x].p.z < 0.01 && B[x].o.L === 'z')) {
      const spots = gather(sups, e)
      if (spots && !a.spread) sups.forEach((x, i) => { B[x] = { ...B[x], p: { ...B[x].p, x: p.x + spots[i].x, y: p.y + spots[i].y } } })
      else if (!a.spread) {
        const fmt = (v) => +v.toFixed(1), part = B[sups[0]].e
        diagnostics.push({ code: 'crowded-supports', part: k, message: `${k} (${fmt(e.x)} × ${fmt(e.y)} cm) is too small to rest on ${sups.length} parts of ${fmt(part.x)} × ${fmt(part.y)} cm side by side under it: use a larger part on top, or fewer supports` })
      }
    }
    p.z = Math.max(...sups.map((x) => hi(x, 'z')))
    box(k, o, p); rests[k] = sups; centred[k] = true
  }
  // The parts lying side by side with t, the way it lies and at its height (a layer of logs, boards edge to edge),
  // touching or a few cm apart across `ax`.
  const row = (t, ax) => {
    const L = B[t].o.L, members = [t]
    if (L === 'z') return members
    for (let grew = true; grew;) {
      grew = false
      for (const x of order) if (!members.includes(x) && !transients.has(x) && B[x].o.L === L && Math.abs(B[x].p.z - B[t].p.z) < 0.01
          && B[x].p[L] < hi(t, L) && hi(x, L) > B[t].p[L]
          && members.some((m) => B[x].p[ax] <= hi(m, ax) + 5 && hi(x, ax) >= B[m].p[ax] - 5)) { members.push(x); grew = true }
    }
    return members
  }
  // Several parts side by side on the same supports (a seat of logs on legs): laid as one, lying the same way, across
  // their widths in the order the plan places them, the legs gathered under the whole of it as under one part.
  const restOnLayer = (acts, sups) => {
    const lyingSame = sups.every((x) => B[x].o.L !== 'z' && B[x].o.L === B[sups[0]].o.L)
    const a0 = acts[0], axis = a0.axis === 'y' || a0.axis === 'x' ? a0.axis : lyingSame ? (B[sups[0]].o.L === 'x' ? 'y' : 'x') : 'x', across = axis === 'x' ? 'y' : 'x'
    const parts = acts.map((a) => { const o = orient({ ...a, axis }, lying(axis), a.k); return { k: a.k, o, e: extent(dims(a.k), o) } })
    const e = { [axis]: Math.max(...parts.map((q) => q.e[axis])), [across]: parts.reduce((n, q) => n + q.e[across], 0), z: Math.max(...parts.map((q) => q.e.z)) }
    const r = extentAll(sups), p = { x: (r.x0 + r.x1 - e.x) / 2, y: (r.y0 + r.y1 - e.y) / 2 }
    if (sups.every((x) => B[x].p.z < 0.01 && B[x].o.L === 'z')) {
      // (legs joined each to one part of the layer go under that part: one under each part alternating ends — three
      // legs a triangle, not a line — two under one part at its ends; else gathered as under one part)
      const of = Object.fromEntries(sups.map((x) => [x, parts.findIndex((q) => (script.joints || []).some((j) => j.a === q.k && j.b === x || j.b === q.k && j.a === x))]))
      let spots = null
      if (sups.every((x) => of[x] >= 0)) {
        const offset = (i) => parts.slice(0, i).reduce((n, q) => n + q.e[across], 0)
        spots = sups.map((x) => {
          const i = of[x], mine = sups.filter((y) => of[y] === i), j = mine.indexOf(x), q = parts[i], leg = B[x].e
          const end = mine.length === 1 ? i % 2 : mine.length === 2 ? j : null
          const along = end == null ? (e[axis] - leg[axis]) * (j + 0.5) / mine.length : end ? e[axis] - leg[axis] : 0
          return leg[across] <= q.e[across] + 0.01 && mine.reduce((n, y) => n + B[y].e[axis], 0) <= e[axis] + 0.01
            ? { [axis]: along, [across]: offset(i) + (q.e[across] - leg[across]) / 2 } : null
        })
        if (spots.some((t) => !t)) spots = null
      }
      spots ??= gather(sups, e)
      if (spots && !acts.some((a) => a.spread)) sups.forEach((x, i) => { B[x] = { ...B[x], p: { ...B[x].p, x: p.x + spots[i].x, y: p.y + spots[i].y } } })
      else if (!acts.some((a) => a.spread)) {
        const fmt = (v) => +v.toFixed(1), part = B[sups[0]].e
        diagnostics.push({ code: 'crowded-supports', part: a0.k, message: `${parts.map((q) => q.k).join(', ')} together (${fmt(e.x)} × ${fmt(e.y)} cm) are too small to rest on ${sups.length} parts of ${fmt(part.x)} × ${fmt(part.y)} cm side by side under them: use larger parts on top, or fewer supports` })
      }
    }
    const z = Math.max(...sups.map((x) => hi(x, 'z')))
    let at = p[across]
    for (const q of parts) {
      box(q.k, q.o, { [axis]: p[axis] + (e[axis] - q.e[axis]) / 2, [across]: at, z }); rests[q.k] = sups; centred[q.k] = true
      at += q.e[across]
    }
  }
  // Where each support goes under a part of extent e (offsets from its corner), or null when they do not fit.
  const gather = (sups, e) => {
    for (const [u, v] of [['x', 'y'], ['y', 'x']]) {
      const rows = sups.length <= 2 ? [sups] : [sups.slice(0, Math.ceil(sups.length / 2)), sups.slice(Math.ceil(sups.length / 2))]
      const deep = rows.map((row) => Math.max(...row.map((x) => B[x].e[v])))
      if (rows.some((row) => row.reduce((n, x) => n + B[x].e[u], 0) > e[u] + 0.01) || deep.reduce((n, d) => n + d, 0) > e[v] + 0.01) continue
      const spots = {}
      rows.forEach((row, ri) => row.forEach((x, i) => {
        const w = B[x].e[u], at = row.length === 1 ? (e[u] - w) / 2 : (e[u] - w) * i / (row.length - 1)
        const across = rows.length === 1 ? (e[v] - B[x].e[v]) / 2 : ri === 0 ? 0 : e[v] - B[x].e[v]
        spots[x] = { [u]: at, [v]: across }
      }))
      return sups.map((x) => spots[x])
    }
    return null
  }

  // Parts already glued, their faces together, travel with a part placed again (a flower glued to its stem, the stem
  // then stood in a vase): as one piece, the way the part itself moved. Not what it is being placed on: glue goes on
  // before the parts close, so a part placed on its own partner is closing that joint, not moving it.
  const made = new Set()
  const gluedTo = (k, a) => {
    const staying = new Set([a.to, a.and, ...(Array.isArray(a.also) ? a.also : [])]), group = [k]
    const meet = (j) => {
      const A = B[j.a], R = B[j.b], f = faceFrame(A, j.face), g = faceFrame(R, j.otherFace)
      const plane = (b, q) => b.p[q.axis] + (q.sign > 0 ? b.e[q.axis] : 0)
      return f.axis === g.axis && f.sign === -g.sign && Math.abs(plane(A, f) - plane(R, g)) <= 0.01
        && [f.along, f.across].every((ax) => Math.min(A.p[ax] + A.e[ax], R.p[ax] + R.e[ax]) - Math.max(A.p[ax], R.p[ax]) > 0.01)
    }
    for (const m of group) for (const j of script.joints || []) {
      const other = j.a === m ? j.b : j.b === m ? j.a : null
      if (other && j.method === 'glue' && made.has(j.id) && B[j.a] && B[j.b] && !B[other].turn && !transients.has(other)
        && !staying.has(other) && !group.includes(other) && meet(j)) group.push(other)
    }
    return group.slice(1)
  }
  // Things put in one container with no position of their own (stems in a vase) stand side by side across it, not all
  // at its middle: each is placed for good by its last place.
  const lastPlace = new Map((script.steps || []).flatMap((s) => s.do || []).filter((a) => a?.v === 'place').map((a) => [a.k, a]))
  const sharing = (a) => a.rel !== 'in' || a.at != null || a.cm != null || a.side != null || lastPlace.get(a.k) !== a ? []
    : [...lastPlace.values()].filter((b) => b.rel === 'in' && b.to === a.to && b.at == null && b.cm == null && b.side == null && geometry[b.k] && isBoard(b.k))
  let moving = null
  const carry = () => {
    if (!moving) return
    const { k, was, parts } = moving, now = B[k]; moving = null
    if (now.turn) return
    const to = { [was.o.L]: now.o.L, [was.o.W]: now.o.W, [was.o.T]: now.o.T }
    for (const x of parts) {
      const q = B[x], p = {}, e = {}
      for (const ax of ['x', 'y', 'z']) { p[to[ax]] = now.p[to[ax]] + q.p[ax] - was.p[ax]; e[to[ax]] = q.e[ax] }
      B[x] = { ...q, o: { L: to[q.o.L], W: to[q.o.W], T: to[q.o.T] }, e, p }
      order.splice(order.indexOf(x), 1); order.push(x)
    }
  }
  const laid = []
  for (const step of script.steps || [])
    for (const a of step.do || []) {
      const k = a.k
      carry()
      if (typeof a.joint === 'string') made.add(a.joint)
      if (!geometry[k] || laid.includes(a)) continue
      if (a.v !== 'place') {
        for (const held of [a.with, a.part, ...(a.demo?.actors || []), a.v === 'stir' && geometry[k]?.motion ? k : null])
          if (held && geometry[held] && !B[held] && !extras.includes(held)) extras.push(held)
        if (a.v === 'cut' && Array.isArray(a.into) && a.into.length) transients.add(k)
        if (['cut', 'use', 'measure', 'work', 'demonstrate', 'reshape', 'fold', 'strand'].includes(a.v) && !B[k] && isBoard(k)) onFloor(k)
        if ((a.v === 'pour' || a.v === 'sprinkle') && !B[k] && !extras.includes(k)) extras.push(k)
        continue
      }
      if (!isBoard(k)) continue
      // A place moves it to where it goes, whatever happened to it before (laid on the bench to be marked or glued,
      // then mounted): the last place is where it ends up.
      if (B[k]) {
        const parts = B[k].turn ? [] : gluedTo(k, a)
        if (parts.length) moving = { k, was: B[k], parts }
        delete B[k]; order.splice(order.indexOf(k), 1)
      }
      const to = a.to && B[a.to] ? a.to : a.to && geometry[a.to] && isBoard(a.to) ? (onFloor(a.to), a.to) : null
      if (a.rel === 'wall') {
        // Against the wall, lying level along x, its lower face at the height given.
        const o = orient({ ...a, axis: 'x' }), e = extent(dims(k), o)
        box(k, o, { x: 0, y: 0, z: (+a.height > 0 ? +a.height : 100) }); continue
      }
      if (!to || a.rel === 'floor') {
        onFloor(k, a)
        // (stood up and tilted through its thickness: "tilt" degrees, its top towards "side" — back or right, unless left
        // or front; an A-frame's first side)
        if (+a.tilt > 0) { const ax = B[k].o.T === 'z' ? (B[k].o.W === 'z' ? B[k].o.L : B[k].o.W) : B[k].o.T; leanOver(k, (Math.min(45, +a.tilt) * Math.PI) / 180, ax, a.side === 'left' || a.side === 'front' ? -1 : 1) }
        continue
      }
      // On several supports at once ("also": a seat on three legs, a plank across two blocks, a layer of logs across the
      // layer under it): on all their upper faces.
      const also = (Array.isArray(a.also) ? a.also : []).filter((x) => x !== k && x !== to && geometry[x] && isBoard(x))
      if (also.length && ['on', 'across'].includes(a.rel || 'on')) {
        for (const x of also) if (!B[x]) onFloor(x)
        // (parts laid in one step on the same supports are one layer over them — logs side by side as a seat on three
        // legs: the legs gather under the whole layer, not under each log)
        const sups = [to, ...also], same = (b) => b !== a && b?.v === 'place' && typeof b.k === 'string' && geometry[b.k] && isBoard(b.k) && !B[b.k]
          && ['on', 'across'].includes(b.rel || 'on') && new Set([b.to, ...(Array.isArray(b.also) ? b.also : [])]).size === sups.length && sups.every((x) => x === b.to || b.also?.includes(x))
        const layer = [a, ...(step.do || []).filter(same)]
        if (layer.length > 1) { restOnLayer(layer, sups); laid.push(...layer.slice(1)); continue }
        restOn(k, sups, a); continue
      }
      const T = B[to], L = T.o.L, Wax = L === 'x' ? 'y' : L === 'y' ? 'x' : (T.o.W === 'z' ? T.o.T : T.o.W)
      const sign = a.side === '-' || a.side === 'front' || a.side === 'left' ? -1 : 1
      switch (a.rel) {
        case 'parallel': {
          // An upright part has two horizontal neighbour directions. Explicit faces select the world axis;
          // +/- retain the existing across-width convention used by older plans.
          const across = L === 'z' && ['front', 'back', 'left', 'right'].includes(a.side) ? (['front', 'back'].includes(a.side) ? 'y' : 'x') : Wax
          const o = { ...T.o }, e = extent(dims(k), o), p = { ...T.p }
          if (a.align && L !== 'z') diagnostics.push({ code: 'invalid-alignment', part: k, message: `${k}: align currently requires upright parallel parts` })
          p[across] = sign > 0 ? hi(to, across) + (+a.gap || 0) : T.p[across] - (+a.gap || 0) - e[across]
          if (L === 'z' && a.align) {
            const u = across === 'x' ? 'y' : 'x'
            const low = u === 'x' ? 'left' : 'front', high = u === 'x' ? 'right' : 'back'
            if (a.align === low) p[u] = T.p[u]
            else if (a.align === high) p[u] = hi(to, u) - e[u]
            else if (a.align === 'middle') p[u] = T.p[u] + (T.e[u] - e[u]) / 2
            else diagnostics.push({ code: 'invalid-alignment', part: k, message: `${k}: upright parallel placement on ${across} can align ${low}, ${high} or middle, not ${a.align}` })
          }
          p[L] = along(a, T.p[L], T.e[L], e[L]); box(k, o, p)
          if (+a.gap > 0) gaps.push({ k, to, ax: across, L, gap: +a.gap })
          // (a layer laid from a first part the solver centred on what it rests on is centred there as a whole, as long
          // as nothing else was laid since: three logs across the three under them, not the last one hanging off)
          const first = rowOf[to] || to; rowOf[k] = first
          const layer = order.slice(order.indexOf(first))
          if (centred[first] && rests[first] && layer.every((x) => (rowOf[x] || x) === first)) {
            const lo = Math.min(...rests[first].map((x) => B[x].p[across])), up = Math.max(...rests[first].map((x) => hi(x, across)))
            const shift = (lo + up) / 2 - (Math.min(...layer.map((x) => B[x].p[across])) + Math.max(...layer.map((x) => hi(x, across)))) / 2
            for (const x of layer) B[x] = { ...B[x], p: { ...B[x].p, [across]: B[x].p[across] + shift } }
          }
          break
        }
        case 'end': case 'between': case 'across': {
          // At right angles in the floor plane, standing as `to` stands (a rail between two sides on their edges).
          const across = L === 'z' ? 'x' : Wax
          const o = a.rel === 'across' ? lying(across) : T.o.W === 'z' ? { L: across, W: 'z', T: L } : T.o.L === 'z' ? { L: across, W: T.o.W === 'x' ? 'y' : 'x', T: 'z' } : lying(across)
          const e = extent(dims(k), o), p = { x: 0, y: 0, z: a.rel === 'across' ? hi(to, 'z') : T.p.z }
          if (a.rel === 'across') {
            // (across the whole row `to` lies in, at the height of its highest part: a log laid across a layer of three
            // spans all three, not hanging off the first)
            const under = row(to, across), lo = Math.min(...under.map((x) => B[x].p[across])), up = Math.max(...under.map((x) => hi(x, across)))
            p[L] = along({ ...a, at: a.at || 'middle' }, T.p[L], T.e[L], e[L]); p[across] = (lo + up - e[across]) / 2
            p.z = Math.max(...under.map((x) => hi(x, 'z'))); rests[k] = under; centred[k] = a.at == null && a.cm == null
          }
          else if (a.rel === 'end') {
            p[L] = a.at === 'end' || a.at === 'right' ? hi(to, L) - e[L] : T.p[L]
            // (two mitred parts share the corner, each running to its outer edge; the mitre below divides it)
            p[across] = mitred(k) && mitred(to) ? (sign > 0 ? T.p[across] : hi(to, across) - e[across]) : sign > 0 ? hi(to, across) : T.p[across] - e[across]
          }
          else {
            const other = a.and && B[a.and] ? a.and : null
            p[L] = along(a, T.p[L], T.e[L], e[L])
            if (other) {
              // An impossible fit is reported, never repaired by moving an already positioned part.
              const first = T.p[across] <= B[other].p[across] ? to : other, second = first === to ? other : to
              const room = B[second].p[across] - hi(first, across)
              if (Math.abs(room - e[across]) > 0.01) diagnostics.push({ code: 'inconsistent-fit', part: k,
                message: `${k}: ${e[across]} cm part does not fit ${room} cm gap` })
              p[across] = hi(first, across) + (B[second].p[across] - hi(first, across) - e[across]) / 2
            } else p[across] = hi(to, across)
          }
          box(k, o, p); break
        }
        case 'lean': {
          // Leaning on `to` ("side" front, back, left or right of it; front unless told), its foot on the floor, turned
          // "tilt" degrees (15 unless told) towards it: its top on `to`'s face, or over its upper edge when `to` is
          // lower. On a part that leans already, it is that part's mirror, their tops meeting: an A-frame.
          const th = (Math.min(45, Math.max(3, +a.tilt || 15)) * Math.PI) / 180
          if (T.lean) {
            const { ax, toward } = T.lean, o = { ...T.o }, e = extent(dims(k), o)
            const tip = turned({ x: T.p.x + T.e.x / 2, y: T.p.y + T.e.y / 2, z: T.p.z + T.e.z, [ax]: toward > 0 ? T.p[ax] + T.e[ax] : T.p[ax] }, T.turn)
            const p = { ...T.p }; p[ax] = 2 * tip[ax] - T.p[ax] - e[ax]
            box(k, o, p); leanOver(k, T.lean.th, ax, -toward); break
          }
          const side = ['back', 'left', 'right'].includes(a.side) ? a.side : 'front', ax = side === 'front' || side === 'back' ? 'y' : 'x', w = ax === 'y' ? 'x' : 'y'
          const o = a.stand === 'edge' ? { L: w, W: 'z', T: ax } : { L: 'z', W: w, T: ax }, e = extent(dims(k), o)
          const near = side === 'front' || side === 'left' ? -1 : 1, h = Math.min(hi(to, 'z'), e.z * Math.cos(th)), d = h * Math.tan(th)
          const p = { x: 0, y: 0, z: 0 }
          p[w] = along({ ...a, at: a.at || 'middle' }, T.p[w], T.e[w], e[w])
          p[ax] = near < 0 ? T.p[ax] - d - e[ax] : hi(to, ax) + d
          box(k, o, p); leanOver(k, th, ax, -near); break
        }
        case 'under': {
          // Upright, its width running back under `to` (a bracket seen edge-on from the front, a leg).
          const o = a.stand || a.axis ? orient(a, T.o) : { L: 'z', W: Wax, T: L === 'z' ? 'x' : L }, e = extent(dims(k), o), p = { ...T.p }
          // ("side" front or back — left or right — sets it at that edge across: legs at a table's corners)
          p.z = T.p.z - e.z; p[L] = along(a, T.p[L], T.e[L], e[L])
          p[Wax] = a.side === 'front' || a.side === 'left' ? T.p[Wax] : a.side === 'back' || a.side === 'right' ? hi(to, Wax) - e[Wax] : T.p[Wax] + (T.e[Wax] - e[Wax]) / 2
          box(k, o, p); break
        }
        default: {
          // on (and in, hang, pivot, lean): on its upper face.
          const o = a.stand || a.axis ? orient(a, T.o) : { ...T.o, T: 'z', ...(T.o.T !== 'z' ? lying(L === 'z' ? 'x' : L) : {}) }
          const e = extent(dims(k), o), p = { x: 0, y: 0, z: hi(to, 'z') }
          p[L === 'z' ? 'x' : L] = along({ ...a, at: a.at || 'middle' }, T.p[L === 'z' ? 'x' : L], T.e[L === 'z' ? 'x' : L], e[L === 'z' ? 'x' : L])
          const ax = L === 'z' ? 'y' : Wax
          p[ax] = a.side === 'front' || a.side === 'left' ? T.p[ax] : a.side === 'back' || a.side === 'right' ? hi(to, ax) - e[ax] : T.p[ax] + (T.e[ax] - e[ax]) / 2
          const together = sharing(a)
          if (together.length > 1) {
            const narrow = e.x <= e.y ? 'x' : 'y'
            const slot = T.p[narrow] + T.e[narrow] * (together.indexOf(a) + 0.5) / together.length - e[narrow] / 2
            if (e[narrow] <= T.e[narrow]) p[narrow] = Math.min(Math.max(slot, T.p[narrow]), hi(to, narrow) - e[narrow])
          }
          box(k, o, p)
        }
      }
    }
  carry()

  // Two parts in the same space, most of the smaller inside the other: the film would show them as one.
  const overlapCheck = order.filter((k) => !transients.has(k) && !B[k].turn)
  const volume = (k) => B[k].e.x * B[k].e.y * B[k].e.z
  for (const [i, u] of overlapCheck.entries()) for (const v of overlapCheck.slice(i + 1)) {
    const shared = ['x', 'y', 'z'].reduce((n, ax) => n * Math.max(0, Math.min(hi(u, ax), hi(v, ax)) - Math.max(B[u].p[ax], B[v].p[ax])), 1)
    if (shared > 0.5 * Math.min(volume(u), volume(v))) diagnostics.push({ code: 'parts-overlap', part: v, message: `${u} and ${v} land in the same place: give each its own position (at, cm or side), or a container wide enough for them` })
  }

  // Supports put under a build that rests on the floor (feet or legs under a base lying there) would stand in the
  // floor: the build, everything joined to them by placings, is lifted onto them. `raise` lets the engine show what was
  // placed before the first support resting on the floor, and lift it as that support goes in: nothing floats over
  // the floor waiting for its feet, and no foot sinks through it.
  let raise = null
  const sunk = order.filter((k) => !transients.has(k) && B[k].p.z < -0.01)
  if (sunk.length && view !== 'plan') {
    const by = -Math.min(...sunk.map((k) => B[k].p.z)), root = {}
    const find = (k) => (root[k] == null || root[k] === k ? (root[k] = k) : (root[k] = find(root[k])))
    const places = (script.steps || []).flatMap((st) => st.do || []).filter((a) => a.v === 'place' && B[a.k])
    for (const a of places) for (const o of [a.to, a.and, ...(Array.isArray(a.also) ? a.also : [])]) if (o && B[o]) root[find(a.k)] = find(o)
    const joined = order.filter((k) => !transients.has(k) && find(k) === find(sunk[0]))
    for (const k of joined) B[k] = { ...B[k], p: { ...B[k].p, z: B[k].p.z + by } }
    const first = places.find((a) => sunk.includes(a.k)).k
    raise = { at: first, by, keys: joined.filter((k) => !sunk.includes(k) && places.findIndex((a) => a.k === k) < places.findIndex((a) => a.k === first)) }
  }

  // Splayed legs ("splay": degrees, on the place of the part they carry, or of a leg itself): each leg turned out from
  // the middle of what it carries, about its upper end, and — drawn longer by what the slant needs — cut level with the
  // floor and with the underside it meets, as a splayed leg is cut. Its box stays upright, for how the parts meet.
  for (const a of (script.steps || []).flatMap((st) => st.do || []).filter((a) => a.v === 'place' && +a.splay > 0 && B[a.k])) {
    const th = (Math.min(30, +a.splay) * Math.PI) / 180
    const carried = rests[a.k] ? a.k : (script.steps || []).flatMap((st) => st.do || []).find((b) => b.v === 'place' && B[b.k] && (b.to === a.k || (Array.isArray(b.also) && b.also.includes(a.k))))?.k
    const legs = rests[a.k] ? rests[a.k] : [a.k]
    if (!carried) continue
    const c = { x: B[carried].p.x + B[carried].e.x / 2, y: B[carried].p.y + B[carried].e.y / 2 }
    for (const leg of legs.filter((x) => B[x] && B[x].o.L === 'z' && !B[x].turn)) {
      const { p, e } = B[leg], m = { x: p.x + e.x / 2, y: p.y + e.y / 2 }, dx = m.x - c.x, dy = m.y - c.y, len = Math.hypot(dx, dy)
      if (len < 0.1) continue
      const out = { x: dx / len, y: dy / len }, pivot = { x: m.x, y: m.y, z: p.z + e.z }, axis = { x: -out.y, y: out.x, z: 0 }
      let turn = { axis, angle: th, pivot }
      const foot = turned({ ...m, z: p.z }, turn)
      if ((foot.x - m.x) * out.x + (foot.y - m.y) * out.y < 0) turn = { axis, angle: -th, pivot }
      const ext = e.z * (1 / Math.cos(th) - 1) + e[B[leg].o.W] * Math.tan(th) + 1
      B[leg] = { ...B[leg], turn, drawBox: { o: B[leg].o, e: { ...e, z: e.z + ext }, p: { ...p, z: p.z - ext } },
        after: [{ n: { x: 0, y: 0, z: -1 }, d: -p.z }, { n: { x: 0, y: 0, z: 1 }, d: p.z + e.z }] }
    }
  }
  // Mitred corners: two parts both with a "mitre" end, square to each other, sharing a square at their ends (a frame's
  // sides, a box's sides on their edges): each cut along that square's diagonal, from its outer corner to its inner
  // one, keeping the half towards its own length.
  const mitres = order.filter((k) => !transients.has(k) && mitred(k))
  for (let i = 0; i < mitres.length; i++) for (let j = i + 1; j < mitres.length; j++) {
    const a = mitres[i], b = mitres[j], La = B[a].o.L, Lb = B[b].o.L
    if (La === Lb) continue
    const lo = {}, up = {}
    for (const ax of ['x', 'y', 'z']) { lo[ax] = Math.max(B[a].p[ax], B[b].p[ax]); up[ax] = Math.min(hi(a, ax), hi(b, ax)) }
    if (['x', 'y', 'z'].some((ax) => up[ax] - lo[ax] <= 0.01)) continue
    const short = (k, L) => up[L] - lo[L] < B[k].e[L] * 0.75
    const endOf = (k, L) => (Math.abs(lo[L] - B[k].p[L]) < 0.01 && short(k, L) ? -1 : Math.abs(up[L] - hi(k, L)) < 0.01 && short(k, L) ? 1 : 0)
    const ea = endOf(a, La), eb = endOf(b, Lb)
    if (!ea || !eb) continue
    const c = { x: (lo.x + up.x) / 2, y: (lo.y + up.y) / 2, z: (lo.z + up.z) / 2 }, hA = (up[La] - lo[La]) / 2, hB = (up[Lb] - lo[Lb]) / 2
    // (towards each one's own length from the square: -ea along La, -eb along Lb; the diagonal from outer to inner)
    const D = [-ea * hA, -eb * hB]
    let N = [D[1], -D[0]]
    if (N[0] * -ea < 0) N = [-N[0], -N[1]]
    const n = { x: 0, y: 0, z: 0, [La]: N[0], [Lb]: N[1] }, nc = n.x * c.x + n.y * c.y + n.z * c.z
    B[a] = { ...B[a], cuts: [...(B[a].cuts || []), { n: { x: -n.x, y: -n.y, z: -n.z }, d: -nc }] }
    B[b] = { ...B[b], cuts: [...(B[b].cuts || []), { n, d: nc }] }
  }

  // The view: plan looks down (x right, y up the frame), front looks at it (x right, z up), iso is IKEA's 30 degrees.
  const C = Math.cos(Math.PI / 6), S = Math.sin(Math.PI / 6)
  // Iso: x runs right and down the frame, y (away) right and up, z up — the viewer at the front right, above.
  const project = view === 'plan' ? (x, y, z) => [x, -y] : view === 'front' ? (x, y, z) => [x, -z] : (x, y, z) => [(x + y) * C, (x - y) * S - z]
  // A part the plan shapes, or the solver cuts or turns, as its faces in the world (shapes.mjs); null for a plain board.
  // (a log is drawn as a log: shaped by nothing but its turn)
  const logKey = (k) => { const of = geometry[k]?.sliceOf || k; return isLog(objects[of]) }
  const TOWARD = view === 'plan' ? { x: 0, y: 0, z: 1 } : view === 'front' ? { x: 0, y: -1, z: 0 } : { x: 1, y: -1, z: 1 }
  const shaped = {}
  const shapeOf = (k) => {
    if (k in shaped) return shaped[k]
    const b = B[k], prof = logKey(k) ? null : profiles[k]
    if (!prof && !b.cuts?.length && !b.turn) return (shaped[k] = null)
    const box = b.drawBox || b
    return (shaped[k] = solid(box, { outline: prof ? outline(prof, box.e[box.o.L], box.e[box.o.W]) : null, cuts: logKey(k) ? [] : b.cuts || [], turn: b.turn, after: logKey(k) ? [] : b.after || [] }))
  }
  const at3 = (k, x, y, z) => { const q = B[k].turn ? turned({ x, y, z }, B[k].turn) : { x, y, z }; return project(q.x, q.y, q.z) }
  const corners = (k) => {
    const sh = shapeOf(k)
    if (sh) return sh.flatMap((f) => f.pts.map((q) => project(q.x, q.y, q.z)))
    const { p, e } = B[k]; const r = []; for (const dx of [0, e.x]) for (const dy of [0, e.y]) for (const dz of [0, e.z]) r.push(project(p.x + dx, p.y + dy, p.z + dz)); return r
  }
  // Its visible faces, as 3D quads: plan the upper face, front the front face (y = p.y), iso the upper, front and right.
  const faces = (k) => {
    const sh = shapeOf(k)
    if (sh) return visible(sh, TOWARD, project)
    const { p, e } = B[k], q = (pts) => pts.map(([x, y, z]) => project(x, y, z))
    const X = [p.x, p.x + e.x], Y = [p.y, p.y + e.y], Z = [p.z, p.z + e.z]
    const upper = { kind: 'upper', pts: q([[X[0], Y[0], Z[1]], [X[1], Y[0], Z[1]], [X[1], Y[1], Z[1]], [X[0], Y[1], Z[1]]]) }
    const front = { kind: 'front', pts: q([[X[0], Y[0], Z[0]], [X[1], Y[0], Z[0]], [X[1], Y[0], Z[1]], [X[0], Y[0], Z[1]]]) }
    const right = { kind: 'side', pts: q([[X[1], Y[0], Z[0]], [X[1], Y[1], Z[0]], [X[1], Y[1], Z[1]], [X[1], Y[0], Z[1]]]) }
    // The viewer sits at the front right, above: the faces at y = p.y (front) and x = p.x + e.x (right) face it.
    return view === 'plan' ? [upper] : view === 'front' ? [front] : [front, right, upper]
  }
  // The line along its upper face, down its middle, start to end: where tools work and marks go.
  const line = (k) => {
    const { p, e, o } = B[k], m = { x: p.x + e.x / 2, y: p.y + e.y / 2, z: p.z + e.z }
    const a = { ...m }, b = { ...m }
    if (o.L === 'z') { a.z = p.z + e.z; b.z = p.z; } else { a[o.L] = p[o.L]; b[o.L] = p[o.L] + e[o.L] }
    if (view === 'front') { a.y = b.y = p.y }
    return [at3(k, a.x, a.y, a.z), at3(k, b.x, b.y, b.z)]
  }
  // Every face a tool may work on — upper, lower, front, back, left, right, and start and end (the end grain at each end
  // of its length): the line down its middle along the board's length (a point, on an end-grain face) and which way it
  // faces on the frame, a unit vector (a face square to the viewer counts as facing up the frame).
  const NORMALS = { upper: [0, 0, 1], lower: [0, 0, -1], front: [0, -1, 0], back: [0, 1, 0], left: [-1, 0, 0], right: [1, 0, 0] }
  const faceLines = (k) => {
    const { p, e, o } = B[k], li = AXES.indexOf(o.L), out = {}
    const named = { ...NORMALS, start: AXES.map((_, i) => (i === li ? -1 : 0)), end: AXES.map((_, i) => (i === li ? 1 : 0)) }
    for (const [name, n] of Object.entries(named)) {
      const q = { x: p.x + e.x / 2, y: p.y + e.y / 2, z: p.z + e.z / 2 }
      AXES.forEach((ax, i) => { if (n[i]) q[ax] = n[i] > 0 ? p[ax] + e[ax] : p[ax] })
      const a = { ...q }, b = { ...q }
      if (n[li] === 0) { a[o.L] = p[o.L]; b[o.L] = p[o.L] + e[o.L] }
      const c0 = at3(k, q.x, q.y, q.z), c1 = at3(k, q.x + n[0], q.y + n[1], q.z + n[2])
      let nx = c1[0] - c0[0], ny = c1[1] - c0[1]; const len = Math.hypot(nx, ny)
      if (len < 0.2) { nx = 0; ny = -1 } else { nx /= len; ny /= len }
      const pts = [{ x: 0, lat: -0.5 }, { x: 1, lat: -0.5 }, { x: 0, lat: 0.5 }].map((s) => {
        const v = facePoint(B[k], name, s); return at3(k, v.x, v.y, v.z)
      })
      out[name] = { line: [at3(k, a.x, a.y, a.z), at3(k, b.x, b.y, b.z)], n: [nx, ny], basis: pts }
    }
    return out
  }

  // Fit the work to the stage; a board to be cut stands alone in the middle, as large as fits. Drawing units are
  // cm × unit, so the scale the engine applies is screen pixels per drawing unit.
  const unit = 4
  const fitOf = (keys) => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
    for (const k of keys) for (const [x, y] of corners(k)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
    // The front view takes in the floor only when something stands on it: a wall shelf is framed on itself.
    if (view === 'front' && keys.some((k) => B[k] && B[k].p.z <= 0.01)) y1 = Math.max(y1, 0)
    return x0 === Infinity ? null : { x0, x1, y0, y1 }
  }
  const standing = (keys) => view === 'front' && keys.some((k) => B[k] && B[k].p.z <= 0.01)
  const work = order.filter((k) => !transients.has(k)), f = fitOf(work.length ? work : order) || { x0: 0, x1: 1, y0: -1, y1: 0 }
  // (up to 30 screen pixels a cm: a small frame fills the stage too)
  const scale = Math.min(maxWidth / Math.max(1, f.x1 - f.x0), maxHeight / Math.max(1, f.y1 - f.y0), 30) / unit
  const grounded = standing(work.length ? work : order)
  const toScreen = (fit, s) => ([x, y]) => [centerX + (x - (fit.x0 + fit.x1) / 2) * s * unit,
    view === 'front' && grounded ? floorY + (y - fit.y1) * s * unit : centerY + (y - (fit.y0 + fit.y1) / 2) * s * unit]
  const poses = {}, boards = {}
  // Tools and fasteners are drawings in cut-out pixels × 4; at the boards' scale of screen pixels per cm.
  const perCm = Object.values(objects).filter((o) => +o.cm > 0 && sizes[o.k]).map((o) => Math.max(sizes[o.k].width, sizes[o.k].height) / +o.cm).sort((a, b) => a - b)
  const pxPerCm = perCm.length ? perCm[perCm.length >> 1] : 10
  for (const k of extras.filter((x) => !B[x])) poses[k] = { x: 0, y: 0, scale: scale * unit / (pxPerCm * 4), angle: 0, anchor: geometry[k].base ? geometry[k].base.map((n) => n * 4) : [0, 0] }
  // A log's drawing (isLog), in the board's box: its body — the outline of the cylinder through the ellipses in its
  // two end faces — and the end that faces the viewer, as its centre and half axes (an ellipse c + u cos θ + v sin θ).
  const VISIBLE = { plan: ['+z'], front: ['-y'], iso: ['+x', '-y', '+z'] }[view]
  const logOf = (k, local) => {
    const { p, e, o } = B[k].drawBox || B[k], [a, b] = AXES.filter((ax) => ax !== o.L)
    const end = (at) => {
      const q = (da, db) => { const r = { ...p }; r[o.L] = at; r[a] += da; r[b] += db; return local(at3(k, r.x, r.y, r.z)) }
      const Q = [q(0, 0), q(e[a], 0), q(e[a], e[b]), q(0, e[b])]
      return { c: [(Q[0][0] + Q[2][0]) / 2, (Q[0][1] + Q[2][1]) / 2], u: [(Q[1][0] - Q[0][0]) / 2, (Q[1][1] - Q[0][1]) / 2], v: [(Q[3][0] - Q[0][0]) / 2, (Q[3][1] - Q[0][1]) / 2] }
    }
    const ends = [end(p[o.L]), end(p[o.L] + e[o.L])]
    const pts = ends.flatMap(({ c, u, v }) => Array.from({ length: 32 }, (_, i) => { const th = i * Math.PI / 16; return [c[0] + u[0] * Math.cos(th) + v[0] * Math.sin(th), c[1] + u[1] * Math.cos(th) + v[1] * Math.sin(th)] }))
    // (the outline: the convex hull of both ends' ellipses)
    pts.sort((m, n) => m[0] - n[0] || m[1] - n[1])
    const cross = (O, A, P) => (A[0] - O[0]) * (P[1] - O[1]) - (A[1] - O[1]) * (P[0] - O[0])
    const half = (list) => { const h = []; for (const P of list) { while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], P) <= 0) h.pop(); h.push(P) } h.pop(); return h }
    const body = [...half(pts), ...half([...pts].reverse())].map(([x, y]) => [+x.toFixed(1), +y.toFixed(1)])
    const shown = VISIBLE.includes(`+${o.L}`) ? ends[1] : VISIBLE.includes(`-${o.L}`) ? ends[0] : null
    const round = (q) => q && { c: q.c.map((n) => +n.toFixed(1)), u: q.u.map((n) => +n.toFixed(1)), v: q.v.map((n) => +n.toFixed(1)) }
    // (across: half its width on the frame, square to its length — where bark streaks run; a log seen end-on, any way)
    const dx = ends[1].c[0] - ends[0].c[0], dy = ends[1].c[1] - ends[0].c[1], dl = Math.hypot(dx, dy), dir = dl > 0.5 ? [dx / dl, dy / dl] : [1, 0]
    const hw = Math.hypot(dir[0] * ends[0].u[1] - dir[1] * ends[0].u[0], dir[0] * ends[0].v[1] - dir[1] * ends[0].v[0])
    return { body, end: round(shown), ends: ends.map((q) => q.c.map((n) => +n.toFixed(1))), across: [+(-dir[1] * hw).toFixed(1), +(dir[0] * hw).toFixed(1)] }
  }
  // A board's drawing: its faces and line in its own bounding box, in drawing units; its pose places that box's middle.
  // (like: the part it is drawn as — a cut part's stretch, while it waits where it was cut, is drawn as that part)
  const drawing = (k, fit, s, like = k) => {
    const all = corners(k), x0 = Math.min(...all.map((c) => c[0])), y0 = Math.min(...all.map((c) => c[1]))
    const x1 = Math.max(...all.map((c) => c[0])), y1 = Math.max(...all.map((c) => c[1]))
    const local = ([x, y]) => [(x - x0) * unit, (y - y0) * unit]
    const [cx, cy] = toScreen(fit, s)([(x0 + x1) / 2, (y0 + y1) / 2])
    return { pose: { x: cx, y: cy, scale: s, angle: 0, anchor: [(x1 - x0) * unit / 2, (y1 - y0) * unit / 2] },
      board: { w: (x1 - x0) * unit, h: (y1 - y0) * unit, faces: faces(k).map((fc) => ({ kind: fc.kind, pts: fc.pts.map(local), ...(fc.shaped ? { shaped: true } : {}), ...(fc.box ? { box: fc.box.map(local) } : {}) })), line: line(k).map(local),
        faceLines: Object.fromEntries(Object.entries(faceLines(k)).map(([name, f]) => [name, { line: f.line.map(local), n: f.n, basis: f.basis.map(local) }])),
        ...(logKey(like) ? { log: logOf(k, local) } : {}) } }
  }
  // The boards to be cut are framed together, as they lie side by side on the bench, as large as fits: each one framed
  // alone stood every one of them in the same middle of the stage, one over the other.
  const cutKeys = order.filter((k) => transients.has(k)), together = fitOf(cutKeys)
  const cutScale = together && Math.min(maxWidth * 0.85 / Math.max(1, together.x1 - together.x0), maxHeight * (cutKeys.length > 1 ? 0.62 : 0.5) / Math.max(1, together.y1 - together.y0), 30) / unit
  for (const k of order) {
    if (transients.has(k)) {
      const d = drawing(k, together, cutScale), s = cutScale
      // Its parts: stretches of its length (fractions), from the cut's labels.
      const cut = (script.steps || []).flatMap((st) => st.do || []).find((a) => a.v === 'cut' && a.k === k && Array.isArray(a.into))
      let at = 0
      const whole = dims(k).L
      d.board.slices = (cut?.into || []).filter((p) => geometry[p.k] && !p.size).map((p) => {
        const len = parseFloat(geometry[p.k].label) || whole / cut.into.length, s0 = at / whole
        at += len; return { k: p.k, f0: s0, f1: Math.min(1, at / whole) }
      })
      poses[k] = cutKeys.length > 1 ? { ...d.pose, y: view === 'front' ? d.pose.y - 20 : d.pose.y }
        : { ...d.pose, x: centerX, y: view === 'front' ? floorY - d.board.h * s / 2 - 20 : centerY }
      boards[k] = d.board
      continue
    }
    const d = drawing(k, f, scale)
    poses[k] = d.pose; boards[k] = d.board
  }
  // A cut part waits where it was cut: its stretch of the cut board, lying as the board lay, the parts drawn apart.
  // It keeps that drawing there (homeBoard) — its placed one may lie another way — and, never placed, has only that.
  for (const k of transients) {
    const b = boards[k], P = poses[k]; if (!b) continue
    for (const [j, sl] of (b.slices || []).entries()) {
      const e = { ...B[k].e }; e[B[k].o.L] = B[k].e[B[k].o.L] * (sl.f1 - sl.f0)
      B.__home = { o: B[k].o, e, p: { ...B[k].p } }
      const hb = drawing('__home', fitOf([k]), P.scale, sl.k).board; delete B.__home
      const [lx0, ly0] = b.line[0], [lx1, ly1] = b.line[1], fm = (sl.f0 + sl.f1) / 2, n = b.slices.length
      const len = Math.hypot(lx1 - lx0, ly1 - ly0) || 1, gap = (j - (n - 1) / 2) * 50
      boards[sl.k] = boards[sl.k] || { w: hb.w, h: hb.h, faces: hb.faces, line: hb.line, faceLines: hb.faceLines }
      boards[sl.k].homeBoard = { w: hb.w, h: hb.h, faces: hb.faces, line: hb.line, faceLines: hb.faceLines }
      boards[sl.k].home = { x: P.x + (lx0 + (lx1 - lx0) * fm - b.w / 2) * P.scale + (lx1 - lx0) / len * gap,
        y: P.y + (ly0 + (ly1 - ly0) * fm - b.h / 2) * P.scale + (ly1 - ly0) / len * gap, scale: P.scale, angle: 0, anchor: [hb.w / 2, hb.h / 2] }
      // How far it moved apart from its neighbours (on the frame): where it was in the board is home less this.
      boards[sl.k].homeGap = [(lx1 - lx0) / len * gap, (ly1 - ly0) / len * gap]
    }
  }
  // Drawn back to front: in the plan the lowest first, in the front view the furthest back, in iso the furthest away.
  const depth = (k) => { const { p, e } = B[k]; return view === 'plan' ? p.z + e.z : view === 'front' ? -(p.y + e.y) : p.x + e.x / 2 - (p.y + e.y / 2) + (p.z + e.z) * 0.5 }
  // (a log is round, so what rests on one — a seat log on its legs — would show the leg's end grain through it, drawn
  // by depth alone: it goes after what it rests on)
  const resting = (list) => {
    const out = [...list], on = (u, l) => logKey(u) && logKey(l) && Math.abs(B[u].p.z - hi(l, 'z')) < 0.01
      && ['x', 'y'].every((ax) => B[u].p[ax] < hi(l, ax) && hi(u, ax) > B[l].p[ax])
    for (let pass = 0, moved = true; moved && pass < out.length; pass++) {
      moved = false
      for (const u of [...out]) for (const l of out) if (u !== l && on(u, l) && out.indexOf(u) < out.indexOf(l)) { out.splice(out.indexOf(u), 1); out.splice(out.indexOf(l) + 1, 0, u); moved = true }
    }
    return out
  }
  const drawOrder = resting([...order].sort((a, b) => depth(a) - depth(b)))
  // Where the floor is on the frame: the floor line, or — a wall-mounted assembly framed on itself — wherever the floor
  // falls below it (it may be off the frame).
  const floorAt = view === 'front' && !grounded ? toScreen(f, scale)([0, 0])[1] : floorY
  // The work turned over (a step on its underside, script.mjs): half a turn about the length of the floor (x), so
  // what faced down faces up — each board where it then lies, its faces and lines as seen so, at the same scale, and
  // the middle of the work on the frame (what it turns about).
  let flip = null
  if (work.length) {
    const r = extentAll(work), saved = {}
    for (const k of work) { saved[k] = B[k]; const { o, e, p } = B[k]; B[k] = { o, e, p: { x: p.x, y: r.y0 + r.y1 - (p.y + e.y), z: r.z1 - (p.z + e.z) } } }
    const ff = fitOf(work)
    flip = { poses: {}, boards: {}, order: resting([...work].sort((a, b) => depth(a) - depth(b))), cy: toScreen(f, scale)([(f.x0 + f.x1) / 2, (f.y0 + f.y1) / 2])[1] }
    for (const k of work) { const d = drawing(k, ff, scale); flip.poses[k] = d.pose; flip.boards[k] = d.board }
    Object.assign(B, saved)
  }
  // Each gap a part was set from another at ("parallel", "gap" cm): a dimension across it, from the one's facing edge to
  // the other's, in the middle of where they run side by side, on their upper faces; drawn along its own direction
  // (along), unlike a brick's, which lies level under the row.
  // (not between boards laid out only to be marked and cut: their gap is the bench's, not the build's)
  const gapDims = gaps.filter((g) => B[g.k] && B[g.to] && !transients.has(g.k) && !transients.has(g.to)).map((g) => {
    const a = B[g.to], b = B[g.k], near = a.p[g.ax] < b.p[g.ax]
    const lo = Math.max(a.p[g.L], b.p[g.L]), hiL = Math.min(hi(g.to, g.L), hi(g.k, g.L)), mid = (lo + hiL) / 2
    const z = Math.max(hi(g.to, 'z'), hi(g.k, 'z')), at = (w) => ({ x: 0, y: 0, z, [g.L]: mid, [g.ax]: w })
    const P = (q) => toScreen(f, scale)(project(q.x, q.y, q.z))
    return { k: g.k, label: `${g.gap} cm`, along: true,
      from: P(at(near ? hi(g.to, g.ax) : a.p[g.ax])), to: P(at(near ? b.p[g.ax] : hi(g.k, g.ax))) }
  }).filter((d) => Math.hypot(d.to[0] - d.from[0], d.to[1] - d.from[1]) > 12)
  // A joint whose parts meet but where a work site misses the receiving part (the plan guessed where a leg would stand
  // before the solver gathered it, or spread a crossing's two screws wider than the log under it): its sites go over
  // where the two really overlap, spread along it, in the joint and in the operations that make it alike. The parts
  // stay where the plan put them; only the screws are aimed.
  // A joint whose faces do not meet, where its part rests against another there instead (a top log on the thickest of
  // the logs under it, clear of the thinner one it was screwed to): it joins the part it meets, the one it touches over
  // most, in the joint and in the operations that make it — unless the two are already joined.
  const SIDES = { z: ['lower', 'upper'], y: ['front', 'back'], x: ['left', 'right'] }, rejoined = []
  for (const j of script.joints || []) {
    const a = B[j.a], b = B[j.b]
    if (!a || !b || !['fasten', 'glue'].includes(j.method)) continue
    const f = faceFrame(a, j.face), ax = f.axis, sign = j.method === 'fasten' ? -f.sign : f.sign
    const plane = a.p[ax] + (sign > 0 ? a.e[ax] : 0), facing = (x) => B[x].p[ax] + (sign > 0 ? 0 : B[x].e[ax])
    const area = (x) => [f.along, f.across].reduce((n, u) => n * Math.max(0, Math.min(hi(j.a, u), hi(x, u)) - Math.max(a.p[u], B[x].p[u])), 1)
    if (Math.abs(facing(j.b) - plane) <= 0.01) continue
    const joined = (x) => (script.joints || []).some((o) => o !== j && (o.a === j.a && o.b === x || o.b === j.a && o.a === x))
    const meets = Object.keys(B).filter((x) => x !== j.a && !transients.has(x) && Math.abs(facing(x) - plane) <= 0.01 && area(x) > 0.01 && !joined(x))
      .sort((p, q) => area(q) - area(p))
    if (!meets.length) continue
    rejoined.push({ joint: j.id, from: j.b, to: meets[0] })
    j.b = meets[0]; j.otherFace = SIDES[ax][sign > 0 ? 0 : 1]
    for (const s of script.steps || []) for (const op of s.do || []) if (op.joint === j.id && op.to != null) op.to = j.b
  }
  const aimed = []
  for (const j of script.joints || []) {
    const a = B[j.a], b = B[j.b]
    if (!a || !b || !Array.isArray(j.sites) || !j.sites.length || !['fasten', 'glue'].includes(j.method)) continue
    const f = faceFrame(a, j.face), lands = (site) => { const q = facePoint(a, j.face, site); return [f.along, f.across].every((ax) => q[ax] >= b.p[ax] - 0.01 && q[ax] <= b.p[ax] + b.e[ax] + 0.01) }
    if (j.sites.every(lands)) continue
    const lo = (ax) => Math.max(a.p[ax], b.p[ax]), up = (ax) => Math.min(a.p[ax] + a.e[ax], b.p[ax] + b.e[ax])
    if (up(f.along) <= lo(f.along) || up(f.across) <= lo(f.across)) continue
    const n = j.sites.length, span = (up(f.along) - lo(f.along)) * 0.6, mid = (lo(f.along) + up(f.along)) / 2
    const sites = j.sites.map((_, i) => ({ x: +((mid + span * ((i + 0.5) / n - 0.5) - a.p[f.along]) / a.e[f.along]).toFixed(3),
      lat: +(((lo(f.across) + up(f.across)) / 2 - a.p[f.across]) / a.e[f.across] - 0.5).toFixed(3) }))
    if (!sites.every(lands)) continue
    j.sites = sites; aimed.push(j.id)
    for (const s of script.steps || []) for (const op of s.do || []) if (op.joint === j.id && Array.isArray(op.sites)) op.sites = sites.map((q) => ({ ...q }))
  }
  // (a turned part's true extent in the world — a leaning side, a splayed leg — for the checks of the build's size and
  // footing: its own box stays upright)
  const turnedBox = {}
  for (const k of order.filter((x) => B[x].turn && !transients.has(x))) {
    const pts = shapeOf(k).flatMap((f) => f.pts), lo = {}, e = {}
    for (const ax of AXES) { lo[ax] = Math.min(...pts.map((q) => q[ax])); e[ax] = Math.max(...pts.map((q) => q[ax])) - lo[ax] }
    turnedBox[k] = { p: lo, e }
  }
  const checked = checkConnections(script, B)
  diagnostics.push(...checked.problems)
  if (raise) raise.dy = raise.by * scale * unit
  return { order: drawOrder, extras: extras.filter((x) => !B[x]), transients: [...transients], poses, boards, floorY: floorAt, view, flip, raise,
    world: B, connections: checked.connections, diagnostics, dims: gapDims, ...(Object.keys(turnedBox).length ? { turnedBox } : {}), ...(aimed.length ? { aimed } : {}), ...(rejoined.length ? { rejoined } : {}) }
}
