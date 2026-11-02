// The scene solver, for builds made by putting everyday things in place (a desk set up, a shelf arranged, a gift
// wrapped, a riser stacked): every object a real 3D size in cm, placed physically, and drawn in the brick solver's
// oblique view (bricks.mjs: viewOf). Its output is the joint solver's, so the engine's placing, camera, shadows and draw
// order work as for boards and bricks. Cooking and crochet (pour, stir, heat, work, cut) stay in the side view.
//
// An object is one of these, from its "part" in the script ({"family", "size": [w, d, h] cm}), else from its name and
// its "cm" (its longest side):
//   box      — a laptop, book, binder, phone, box, tray: a block w × d × h, drawn by the engine in its photo colour;
//   sheet    — paper, card, cloth, a towel: a block a few mm thick;
//   rod      — a pen, pencil, stick, cable: lying, a thin block its length long; standing in something, a thin cylinder;
//   cylinder — a cup, mug, jar, tin, bottle, glass: d across, h high; open at the top, so what is put in it shows above;
//   loose    — anything else (headphones, a plant, food): its drawing, standing upright at its real size.
// Placing it, for "place" k:
//   floor (or no `to`) — on the table: "at" left, middle or right puts it in that part of the table, side by side with
//                        what is already there; "back" in a row behind the front one; else to the right of what is there;
//   on `to`            — on its top, at its left, middle or right, or cm from its left edge to this object's left edge;
//                        side front/back aligns its depth; unmeasured things on the same spot sit side by side;
//   in `to`            — inside it: a rod stands upright in it (several fanned across its opening), a sheet slides into a
//                        box (and is hidden in it), anything else sits on its floor; a cylinder is open, so the top of
//                        what is in it shows above its rim (the engine draws its front again over what is in it);
//   lean / next to     — on the table, beside `to`.
// The checks: nothing on the table overlaps (laid side by side with a gap), everything rests on what is under it, and
// what is put in something must fit its opening (noted when it does not). What was changed is in layout.notes.
//
//   isSceneBuild(script) → whether the script is one;  solveScene(script, geometry, sizes) → the joint solver's layout
import { viewOf } from './bricks.mjs'
import { checkConnections, faceLinesFor } from './connections.mjs'

// (measure is not one: a dimension line, it goes with any build)
const PROCESS = new Set(['pour', 'sprinkle', 'stir', 'heat', 'work', 'cut', 'demonstrate', 'reshape', 'fold', 'strand'])

const FAMILIES = new Set(['box', 'sheet', 'rod', 'cylinder', 'loose'])
// One, whatever view the script names: things put in place, no process verbs, and (in the plan, front or iso view,
// which are the joint solver's for boards) most of what is placed an everyday part, not a board — and nothing built
// there: a build whose parts are joined, stood on end or edge, or set on, under, between or across each other is the
// joint solver's, the one that knows every part in numbers (a boot bench of logs on two log legs, screwed down). (Its
// placings, not only its joints: a joint left out after a failed repair must not send the build back here.)
export const isSceneBuild = (script) => {
  const acts = (script.steps || []).flatMap((s) => s.do || [])
  if (!acts.some((a) => a.v === 'place') || acts.some((a) => PROCESS.has(a.v))) return false
  if (!['plan', 'front', 'iso'].includes(script.view)) return true
  if ((script.joints || []).some((j) => ['fasten', 'glue'].includes(j.method))) return false
  if (acts.some((a) => a.v === 'place' && (['edge', 'end'].includes(a.stand) || a.also?.length || ['under', 'between', 'end', 'parallel', 'across', 'wall'].includes(a.rel)))) return false
  const placed = new Set(acts.filter((a) => a.v === 'place').map((a) => a.k)), objects = (script.objects || []).filter((o) => placed.has(o.k))
  return objects.length > 0 && objects.filter((o) => FAMILIES.has(o.part?.family || partOf(o).family) && !(+o.thick > 0)).length >= objects.length * 0.6
}

// An object's family and size in cm, from the script's part or its name.
export function partOf(object, sizes) {
  const n = String(object?.n || '').toLowerCase(), L = +object?.cm > 0 ? +object.cm : 10, p = object?.part || {}
  const given = Array.isArray(p.size) && p.size.length === 3 && p.size.every((v) => +v > 0) ? p.size.map(Number) : null
  const family = ['box', 'sheet', 'rod', 'cylinder', 'loose'].includes(p.family) ? p.family
    // (a container first: a "pen holder cup" is a cup, not a pen)
    : /\b(cup|mug|jar|tin|can|bottle|glass|vase|holder|tumbler|candle)s?\b/.test(n) ? 'cylinder'
    : /\b(pen|pencil|marker|crayon|stick|dowel|cable|straw|chopstick|skewer|brush|ruler)s?\b/.test(n) ? 'rod'
    : /\b(paper|sheet|card|cloth|towel|napkin|envelope|map|poster|page|flyer|notepad|note)s?\b/.test(n) ? 'sheet'
    : /\b(laptop|book|binder|folder|notebook|box|phone|tablet|tray|board|block|case|keyboard|drawer|crate|brick)s?\b/.test(n) ? 'box'
    : 'loose'
  // (a wedge: a block lower at the front than at the back — a lever-arch binder, a doorstop, a ramp; low, its front height)
  if (given) return { family, w: given[0], d: given[1], h: given[2], ...(p.shape === 'wedge' && +p.low > 0 && +p.low < given[2] ? { wedge: +p.low } : {}) }
  if (family === 'box') return { family, w: L, d: L * 0.7, h: Math.max(1, L * 0.1) }
  if (family === 'sheet') return { family, w: L, d: L * 0.71, h: 0.2 }
  if (family === 'rod') { const t = Math.max(0.6, L * 0.06); return { family, w: L, d: t, h: t } }
  if (family === 'cylinder') return { family, w: L * 0.75, d: L * 0.75, h: L }
  // loose: its cut-out's proportions, its longest side L
  const s = sizes?.[object?.k], tall = s ? s.height >= s.width : true, r = s ? Math.min(s.width, s.height) / Math.max(s.width, s.height) : 1
  return { family, w: tall ? L * r : L, d: (tall ? L * r : L) * 0.6, h: tall ? L : L * r }
}

export function solveScene(script, geometry, sizes, options = {}) {
  const { floorY = 790, centerX = 910, maxWidth = 1000, maxHeight = 560 } = options
  const objects = Object.fromEntries((script.objects || []).map((o) => [o.k, o]))
  const GAP = 4
  // Placing o (key k, the script's act a) in or on c, where c already is: what changes about o (a rod stands up, a
  // sheet slid into a box is hidden) and where it sits relative to c's corner (dx, dy, dz). n: what is in or on c already.
  const relate = (o, k, c, a, n, notes) => {
    if (o.rel === 'in') {
      if (o.family === 'rod') {
        // Standing in it: upright, fanned across its opening.
        const L = o.standing ? o.h : o.w, t = o.standing ? o.w : o.d
        Object.assign(o, { standing: true, w: t, d: t, h: L })
        const fan = [0, -0.25, 0.25, -0.12, 0.12, -0.35, 0.35][n % 7]
        o.dx = c.w / 2 - t / 2 + fan * c.w; o.dy = c.d / 2 - t / 2 + (n % 2 ? 0.15 : -0.1) * c.d; o.dz = Math.min(0.5, c.h * 0.1)
        if (L < c.h) notes.push(`${k}: shorter than ${a.to} is deep: it would disappear in it`)
      } else if (o.family === 'sheet' && c.family === 'box') {
        // Slid into it: as big as it is, less a margin, half way up; hidden in it.
        Object.assign(o, { w: Math.min(o.w, c.w - 1), d: Math.min(o.d, c.d - 1), hidden: true })
        o.dx = (c.w - o.w) / 2; o.dy = (c.d - o.d) / 2; o.dz = c.h * 0.4
      } else {
        // On its floor, in the middle.
        if (o.w > c.w || o.d > c.d) notes.push(`${k}: wider than ${a.to}'s opening`)
        o.dx = (c.w - o.w) / 2; o.dy = (c.d - o.d) / 2; o.dz = Math.min(0.5, c.h * 0.1)
      }
      o.inside = a.to
    } else {
      // On its top: at its left, middle or right; a second thing on the same spot beside the first (n: what is on that
      // spot already, not what is in it).
      const measured = Number.isFinite(a.cm)
      const along = measured ? a.cm : a.at === 'left' || a.at === 'start' ? 0 : a.at === 'right' || a.at === 'end' ? c.w - o.w : (c.w - o.w) / 2
      const side = a.side || (['front', 'back'].includes(a.at) ? a.at : null)
      o.dx = along + (!measured && n ? (n % 2 ? 1 : -1) * Math.ceil(n / 2) * (o.w + 1) : 0)
      o.dy = side === 'front' ? 0 : side === 'back' ? c.d - o.d : (c.d - o.d) / 2; o.dz = c.h
      if (measured && (o.dx < 0 || o.dx + o.w > c.w + 0.01))
        notes.push(`${k}: placement at ${a.cm} cm on ${a.to} extends beyond its ${c.w} cm width; cm measures from the target's left edge to the placed object's left edge`)
      o.inside = null; o.hidden = false; o.slope = 0
      // On a wedge: it lies on the slope — its underside rising towards the back as the wedge's upper face does (slope:
      // cm up for each cm back), resting where its front edge meets the slope.
      if (c.wedge != null) { o.slope = (c.h - c.wedge) / c.d; o.dz = c.wedge + o.slope * o.dy }
    }
  }
  // What is on or in something, where that is now (things on the table stay where they are).
  const settle = (P, order) => {
    const done = new Set()
    const place = (k) => {
      const o = P[k]; if (o.rel === 'floor' || done.has(k)) return
      place(o.to); const c = P[o.to]
      o.x = c.x + o.dx; o.y = c.y + o.dy; o.z = c.z + o.dz; done.add(k)
    }
    for (const k of order) place(k)
  }

  // The scene as each thing is first put. P[k]: its family, size (w along x, d along y, h up) and where it is (x, y, z:
  // its corner nearest the viewer, left, low), or, until the table is laid out, where it is relative to what it is on
  // or in.
  const P = {}, order = [], extras = [], notes = [], children = {}, again = []
  const rows = { front: { left: [], middle: [], right: [], next: [] }, back: { left: [], middle: [], right: [], next: [] } }
  for (const step of script.steps || []) for (const a of step.do || []) {
    if (a.v !== 'place') {
      for (const held of [a.with, a.part]) if (held && geometry[held] && !extras.includes(held)) extras.push(held)
      continue
    }
    const k = a.k
    if (!geometry[k] || geometry[k].tool) continue
    // (placed again: a move, made after the first placings are laid out)
    if (P[k]) { again.push(a); continue }
    const part = partOf(objects[k], sizes), to = a.to && P[a.to] ? a.to : null
    const o = { ...part, rel: to ? (a.rel || 'on') : 'floor', to, at: a.at, x: 0, y: 0, z: 0 }
    if (o.rel === 'onto') o.rel = 'on'
    if ((o.rel === 'in' || o.rel === 'on') && to) {
      const slot = `${to}/${o.rel}/${o.rel === 'on' ? `${a.cm != null ? `cm:${a.cm}` : a.at || 'middle'}/${a.side || ''}` : ''}`
      relate(o, k, P[to], a, (children[slot] = children[slot] || []).length, notes); children[slot].push(k)
    } else {
      // On the table: in its row (the front, or behind it for "back") and its zone in the row (beside what it is next
      // to, for lean and next to).
      const near = (o.rel === 'lean' || o.rel === 'next') && to && P[to].rel === 'floor' ? P[to] : null
      const row = near ? near.row : a.at === 'back' || a.side === 'back' ? 'back' : 'front'
      const zone = ['left', 'middle', 'right'].includes(a.at) ? a.at : ['left', 'middle', 'right'].includes(a.side) ? a.side : near ? near.zone : 'next'
      // (gap: how far from its neighbour, cm, when the script says: "10 cm right of the binder")
      Object.assign(o, { rel: 'floor', to: null, zone, row, gap: +a.gap > 0 ? +a.gap : null })
      const list = rows[row][zone]
      if (near && list.includes(to)) list.splice(list.indexOf(to) + 1, 0, k); else list.push(k)
    }
    P[k] = o; order.push(k)
  }
  // The table laid out, row by row: in each, the middle zone centred, the left zone to its left (the first placed
  // nearest the middle), the right zone to its right, the rest after that; a gap between neighbours, so nothing on the
  // table overlaps. The back row stands behind the deepest thing in the front row.
  const rowY = {}
  const lay = (zones, y) => {
    const gap = (k) => P[k].gap ?? GAP
    const middle = zones.middle, mid = middle.reduce((s, k, i) => s + P[k].w + (i ? gap(k) : 0), 0)
    let at = -mid / 2
    for (const [i, k] of middle.entries()) { if (i) at += gap(k); P[k].x = at; at += P[k].w }
    let right = middle.length ? mid / 2 : 0
    for (const [i, k] of [...zones.right, ...zones.next].entries()) { right += i || middle.length ? gap(k) : 0; P[k].x = right; right += P[k].w }
    let left = middle.length ? -mid / 2 : (zones.right.length || zones.next.length ? 0 : GAP)
    for (const k of zones.left) { left -= gap(k) + P[k].w; P[k].x = left }
    for (const k of [...zones.left, ...middle, ...zones.right, ...zones.next]) P[k].y = y
  }
  lay(rows.front, rowY.front = 0)
  const front = Object.values(rows.front).flat()
  lay(rows.back, rowY.back = (front.length ? Math.max(...front.map((k) => P[k].d)) : 0) + GAP)
  settle(P, order)

  // The scene as things end up: a copy of the first, with each thing placed again moved there ("move the folder onto
  // the binder"), carrying what is in or on it; everything else stays where it was. Things whose place differs between
  // the two move, in the film, when they are placed again.
  const final = { P: JSON.parse(JSON.stringify(P)) }, F = final.P
  for (const a of again) {
    const k = a.k, o = F[k], to = a.to && F[a.to] && a.to !== k ? a.to : null
    o.rel = to ? (a.rel === 'onto' ? 'on' : a.rel || 'on') : 'floor'
    if ((o.rel === 'in' || o.rel === 'on') && to) {
      o.to = to; relate(o, k, F[to], a, order.filter((q) => q !== k && F[q].to === to && F[q].rel === o.rel && (o.rel !== 'on' || (F[q].at || 'middle') === (a.at || 'middle'))).length, notes)
    } else {
      // To the table: at the end of its row, clear of what is there.
      const row = a.at === 'back' ? 'back' : 'front', there = order.filter((q) => q !== k && F[q].rel === 'floor' && Math.abs(F[q].y - rowY[row]) < 0.01)
      Object.assign(o, { rel: 'floor', to: null, inside: null, hidden: false, x: there.length ? Math.max(...there.map((q) => F[q].x + F[q].w)) + GAP : 0, y: rowY[row], z: 0 })
    }
    settle(F, order)
  }
  const moved = order.filter((k) => ['x', 'y', 'z'].some((a) => Math.abs(F[k][a] - P[k][a]) > 0.01))
  // (what a moved thing travels with: itself, when it is placed again; else what it is in or on)
  const placedAgain = new Set(again.map((a) => a.k))
  const carrier = (k) => (placedAgain.has(k) || !F[k].to ? k : carrier(F[k].to))

  // The view and the fit: the whole scene, both states, fitted once.
  const unit = 4, { project, flat } = viewOf(options.view || process.env.SCENE_VIEW || 'oblique', unit)
  // (a thing on a slope: every point raised by the slope times how far back it is from its own front edge)
  const lift = (o) => (x, y, z) => [x, y, z + (o.slope || 0) * (y - o.y)]
  const cornersOf = (o) => { const r = [], up = lift(o); for (const x of [o.x, o.x + o.w]) for (const y of [o.y, o.y + o.d]) for (const z of [o.z, o.z + o.h]) r.push(project(...up(x, y, z))); return r }
  const corners = (k) => cornersOf(P[k])
  let fx0 = Infinity, fx1 = -Infinity, fy0 = Infinity, fy1 = -Infinity
  for (const k of order) for (const [x, y] of corners(k)) { fx0 = Math.min(fx0, x); fx1 = Math.max(fx1, x); fy0 = Math.min(fy0, y); fy1 = Math.max(fy1, y) }
  for (const k of moved) for (const [x, y] of cornersOf(F[k])) { fx0 = Math.min(fx0, x); fx1 = Math.max(fx1, x); fy0 = Math.min(fy0, y); fy1 = Math.max(fy1, y) }
  // The table they stand on: its front edge a little in front of the front row (in the fit, so it shows), reaching
  // well past everything to the sides and back; 3 cm thick.
  const ox0 = Math.min(...order.map((k) => P[k].x)) - 12, ox1 = Math.max(...order.map((k) => P[k].x + P[k].w)) + 12
  const oy1 = Math.max(...order.map((k) => P[k].y + P[k].d)) + 30, EDGE = -6, THICK = 3
  if (order.length) for (const [x, y] of [project(ox0, EDGE, -THICK), project(ox1, EDGE, -THICK)]) { fx0 = Math.min(fx0, x); fx1 = Math.max(fx1, x); fy0 = Math.min(fy0, y); fy1 = Math.max(fy1, y) }
  if (fx0 === Infinity) { fx0 = 0; fx1 = 1; fy0 = -1; fy1 = 0 }
  const scale = Math.min(maxWidth / Math.max(1, fx1 - fx0), maxHeight / Math.max(1, fy1 - fy0), 40) / unit
  const toScreen = ([x, y]) => [centerX + (x - (fx0 + fx1) / 2) * scale * unit, floorY + (y - fy1) * scale * unit]
  const poses = {}, boards = {}, inside = {}, F0 = (k) => F[k] || P[k]
  // Supplies keep their numeric placement but use their descriptive illustration,
  // rather than losing handles, labels and color to a generic block or cylinder.
  const illustrated = k => objects[k]?.source === 'additional-supply' || geometry[k]?.completeIllustration
  const perCm = Object.values(objects).filter((o) => +o.cm > 0 && sizes[o.k]).map((o) => Math.max(sizes[o.k].width, sizes[o.k].height) / +o.cm).sort((a, b) => a - b)
  const pxPerCm = perCm.length ? perCm[perCm.length >> 1] : 10
  for (const k of extras.filter((x) => !P[x])) poses[k] = { x: 0, y: 0, scale: scale * unit / (pxPerCm * 4), angle: 0, anchor: geometry[k].base ? geometry[k].base.map((n) => n * 4) : [0, 0] }
  for (const k of order) {
    const o = P[k]
    if (F0(k).inside && P[F0(k).inside]?.family === 'cylinder') inside[k] = F0(k).inside
    if (o.family === 'loose' || illustrated(k)) {
      // Its drawing, upright, its longest side its real length, its base on the middle of where it stands.
      const s = sizes[k], [bx, by] = toScreen(project(o.x + o.w / 2, o.y + o.d / 2, o.z))
      poses[k] = { x: bx, y: by, scale: (scale * unit) * Math.max(o.w, o.h) / (Math.max(s.width, s.height) * 4), angle: 0, anchor: geometry[k].base ? geometry[k].base.map((n) => n * 4) : [s.width * 2, s.height * 4] }
      continue
    }
    // A block or a cylinder, as a brick is drawn (engine: brick()): its faces or its cylinder, no studs.
    const all = corners(k), x0 = Math.min(...all.map((q) => q[0])), y0 = Math.min(...all.map((q) => q[1])), x1 = Math.max(...all.map((q) => q[0])), y1 = Math.max(...all.map((q) => q[1]))
    const at = (x, y, z) => { const [px, py] = project(x, y, z); return [(px - x0) * unit, (py - y0) * unit] }
    const X0 = o.x, X1 = o.x + o.w, Y0 = o.y, Y1 = o.y + o.d, Z0 = o.z, Z1 = o.z + o.h, up = lift(o)
    const q = (pts) => pts.map(([x, y, z]) => at(...up(x, y, z)))
    const round = o.family === 'cylinder' || o.standing
    // (a wedge's upper face falls from its back edge, Z1, to its front edge, ZF; its side is a trapezoid)
    const ZF = o.wedge != null ? Z0 + o.wedge : Z1
    const faces = [
      { kind: 'front', pts: q([[X0, Y0, Z0], [X1, Y0, Z0], [X1, Y0, ZF], [X0, Y0, ZF]]) },
      { kind: 'side', pts: q(o.wedge != null ? [[X1, Y0, Z0], [X1, Y1, Z0], [X1, Y1, Z1], [X1, Y0, ZF]] : [[X1, Y0, Z0], [X1, Y1, Z0], [X1, Y1, Z1], [X1, Y0, Z1]]) },
      { kind: 'upper', pts: q([[X0, Y0, ZF], [X1, Y0, ZF], [X1, Y1, Z1], [X0, Y1, Z1]]) },
    ]
    const brick = { color: geometry[k].color || '#9aa3ad', shape: round ? 'round' : 'box', studs: [], stud: { ...flat(0.2), h: 0 }, columns: [], sideStuds: false, lidless: o.family === 'cylinder',
      round: round ? { c0: at((X0 + X1) / 2, (Y0 + Y1) / 2, Z0), c1: at((X0 + X1) / 2, (Y0 + Y1) / 2, Z1), ...flat(Math.min(o.w, o.d) / 2) } : null }
    const [cx, cy] = toScreen([(x0 + x1) / 2, (y0 + y1) / 2])
    poses[k] = { x: cx, y: cy, scale, angle: 0, anchor: [(x1 - x0) * unit / 2, (y1 - y0) * unit / 2] }
    const worldBox = { p: { x: o.x, y: o.y, z: o.z }, e: { x: o.w, y: o.d, z: o.h }, o: { L: 'x', W: 'y', T: 'z' } }
    boards[k] = { w: (x1 - x0) * unit, h: (y1 - y0) * unit, faces, line: [at(X0, (Y0 + Y1) / 2, Z1), at(X1, (Y0 + Y1) / 2, Z1)],
      faceLines: !round && o.wedge == null && !o.slope ? faceLinesFor(worldBox, at) : {}, brick }
  }
  // Where each moved thing ends up (its pose there: the middle of its box on the frame; a loose thing's base), and
  // what it travels with (by: itself, when it is placed again; else what it is in or on).
  const moves = Object.fromEntries(moved.map((k) => {
    const o = F[k], s = sizes[k]
    if (o.family === 'loose' || illustrated(k)) return [k, { by: carrier(k), pose: { ...poses[k], ...Object.fromEntries(['x', 'y'].map((a, i) => [a, toScreen(project(o.x + o.w / 2, o.y + o.d / 2, o.z))[i]])) } }]
    const all = cornersOf(o), [cx, cy] = toScreen([(Math.min(...all.map((q) => q[0])) + Math.max(...all.map((q) => q[0]))) / 2, (Math.min(...all.map((q) => q[1])) + Math.max(...all.map((q) => q[1]))) / 2])
    return [k, { by: carrier(k), pose: { ...poses[k], x: cx, y: cy } }]
  }))
  // Drawn back to front, as things end up: further away first, then lower first, then left to right. What is hidden in
  // a box is drawn just before the box (which covers it); what is in a cup, just after it (the engine draws the cup's
  // front over it).
  const End = (k) => F[k] || P[k]
  const base = (k) => -(End(k).y + End(k).d / 2) * 1000 + End(k).z * 10 + End(k).x * 0.001
  // (nested: what is in a thing hidden in a box is drawn just after that thing, so still before the box)
  const depth = (k) => End(k).inside ? depth(End(k).inside) + (End(k).hidden ? -0.001 : 0.0001) + order.indexOf(k) * 1e-7 : base(k)
  const tableOf = (pts) => pts.map(([x, y, z]) => toScreen(project(x, y, z)).map((v) => +v.toFixed(1)))
  const table = order.length ? {
    upper: tableOf([[ox0 - 40, EDGE, 0], [ox1 + 40, EDGE, 0], [ox1 + 40, oy1 + 60, 0], [ox0 - 40, oy1 + 60, 0]]),
    front: tableOf([[ox0 - 40, EDGE, 0], [ox1 + 40, EDGE, 0], [ox1 + 40, EDGE, -THICK], [ox0 - 40, EDGE, -THICK]]) } : null
  const world = Object.fromEntries(order.filter((k) => ['box', 'sheet'].includes(F0(k).family) && F0(k).wedge == null && !F0(k).slope && !F0(k).standing).map((k) => {
    const o = F0(k); return [k, { p: { x: o.x, y: o.y, z: o.z }, e: { x: o.w, y: o.d, z: o.h }, o: { L: 'x', W: 'y', T: 'z' } }]
  }))
  const checked = checkConnections(script, world)
  // All placed actors contribute to the final envelope, including cylinders,
  // loose objects and rods. Keep the rectangular solids used for joint checks
  // separate: a bottle's bounding box is not a solid block for fastening.
  const envelope = Object.fromEntries(order.map(k => {
    const o = F0(k), rise = (o.slope || 0) * o.d
    return [k, { p: { x: o.x, y: o.y, z: o.z + Math.min(0, rise) },
      e: { x: o.w, y: o.d, z: o.h + Math.abs(rise) } }]
  }))
  return { order: [...order].sort((a, b) => depth(a) - depth(b)), extras: extras.filter((x) => !P[x]), transients: [], poses, boards, floorY, view: 'iso', table,
    geometryEstimated: order.some((k) => !Array.isArray(objects[k]?.part?.size)),
    scene: Object.fromEntries(order.map((k) => [k, { family: P[k].family, ...(illustrated(k) ? { illustrated: true } : {}), size: [P[k].w, P[k].d, P[k].h].map((v) => +v.toFixed(1)), at: [P[k].x, P[k].y, P[k].z].map((v) => +v.toFixed(1)), ...(P[k].inside ? { in: P[k].inside } : {}) }])),
    inside, moves, notes, world, envelope, connections: checked.connections, diagnostics: checked.problems }
}
