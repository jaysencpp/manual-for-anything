// Parts that are not plain boxes: a board's outline (its face seen square on — a shaped bracket, an arch, a taper, a
// notch, rounded corners, angled ends), cut through by planes (a mitre where two parts meet at a corner, a leg cut level
// with the floor), and turned (a leaning board, a splayed leg). joints.mjs keeps every part's box for how parts meet;
// this is what the film draws of it: its faces, in the world, the ones the viewer sees, far to near.
//
//   outline(spec, L, W) → [[u, v], …] anticlockwise, in cm: u along the part's length, v across its width
//   solid(box, { outline, cuts, turn, after }) → faces [{ pts: [{x, y, z}], n: {x, y, z}, edge }]
// box: joints.mjs's {o, e, p}; cuts: planes in the world, each {n, d}, keeping n·q ≤ d; turn: {axis, angle, pivot},
// a turn about a line through the pivot; after: planes applied once turned (a splayed leg's foot cut level with the
// floor). A face's `edge` is the part's length direction across it, for its grain.

const AXES = ['x', 'y', 'z']
const add = (a, b, k = 1) => ({ x: a.x + b.x * k, y: a.y + b.y * k, z: a.z + b.z * k })
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z
const unit = (ax, s = 1) => ({ x: 0, y: 0, z: 0, [ax]: s })
const area2 = (o) => o.reduce((n, q, i) => { const r = o[(i + 1) % o.length]; return n + q[0] * r[1] - r[0] * q[1] }, 0) / 2

// A half-plane clip of a polygon (Sutherland–Hodgman): keeps what f(q) ≤ 0; lerps where it crosses.
function clip2(poly, f) {
  const out = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], fa = f(a), fb = f(b)
    if (fa <= 0) out.push(a)
    if ((fa < 0 && fb > 0) || (fa > 0 && fb < 0)) { const t = fa / (fa - fb); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]) }
  }
  return out
}

// Rounds a polygon's convex corners off with radius r (a quadratic through each, cut back r along both edges).
function rounded(poly, r) {
  if (!(r > 0)) return poly
  const out = [], ccw = area2(poly) > 0
  for (let i = 0; i < poly.length; i++) {
    const p = poly[(i + poly.length - 1) % poly.length], q = poly[i], n = poly[(i + 1) % poly.length]
    const a = [p[0] - q[0], p[1] - q[1]], b = [n[0] - q[0], n[1] - q[1]], la = Math.hypot(...a), lb = Math.hypot(...b)
    const convex = (a[0] * b[1] - a[1] * b[0]) * (ccw ? -1 : 1) > 0
    const k = Math.min(r, la / 2, lb / 2)
    if (!convex || k < 0.05) { out.push(q); continue }
    const s = [q[0] + (a[0] / la) * k, q[1] + (a[1] / la) * k], e = [q[0] + (b[0] / lb) * k, q[1] + (b[1] / lb) * k]
    for (let j = 0; j <= 4; j++) { const t = j / 4, m = 1 - t; out.push([m * m * s[0] + 2 * m * t * q[0] + t * t * e[0], m * m * s[1] + 2 * m * t * q[1] + t * t * e[1]]) }
  }
  return out
}

// A part's outline from its profile: its own points (cm, clamped to the part), else its rectangle, tapered to `taper`
// of its width at its start (a standing leg's foot), notched along its edges (edge "a" at v = 0, "b" at v = W), its corners rounded, its ends
// cut at an angle (degrees from square; a positive angle leaves the v = W edge shorter). A "mitre" end is the solver's.
export function outline(spec, L, W) {
  const clampQ = ([u, v]) => [Math.min(L, Math.max(0, u)), Math.min(W, Math.max(0, v))]
  let poly
  if (Array.isArray(spec.outline) && spec.outline.length >= 3) poly = spec.outline.map(clampQ)
  else if (spec.taper > 0 && spec.taper < 1) poly = [[0, (W * (1 - spec.taper)) / 2], [L, 0], [L, W], [0, (W * (1 + spec.taper)) / 2]]
  else {
    // the rectangle, walked round with its notches: along edge a (v = 0) from the start, back along edge b (v = W)
    const notches = (Array.isArray(spec.notches) ? spec.notches : []).filter((n) => n.at >= 0 && n.w > 0 && n.d > 0 && n.at + n.w <= L && n.d < W)
    const along = (edge) => notches.filter((n) => (n.edge || 'a') === edge).sort((m, n) => m.at - n.at)
    poly = [[0, 0]]
    for (const n of along('a')) poly.push([n.at, 0], [n.at, n.d], [n.at + n.w, n.d], [n.at + n.w, 0])
    poly.push([L, 0], [L, W])
    for (const n of along('b').reverse()) poly.push([n.at + n.w, W], [n.at + n.w, W - n.d], [n.at, W - n.d], [n.at, W])
    poly.push([0, W])
  }
  if (area2(poly) < 0) poly.reverse()
  poly = rounded(poly, +spec.round || 0)
  const [a0, a1] = Array.isArray(spec.ends) ? spec.ends : []
  const slope = (deg) => Math.tan((Math.max(-60, Math.min(60, deg)) * Math.PI) / 180)
  if (typeof a0 === 'number' && a0) { const t = slope(a0); poly = clip2(poly, ([u, v]) => (t > 0 ? v * t : (W - v) * -t) - u) }
  if (typeof a1 === 'number' && a1) { const t = slope(a1); poly = clip2(poly, ([u, v]) => u - (L - (t > 0 ? v * t : (W - v) * -t))) }
  return poly.length >= 3 && Math.abs(area2(poly)) > 0.01 ? poly : [[0, 0], [L, 0], [L, W], [0, W]]
}

// A point turned about a line through `pivot` (Rodrigues' formula).
export function turned(q, turn) {
  if (!turn) return q
  const { axis: k, angle, pivot } = turn, c = Math.cos(angle), s = Math.sin(angle), v = add(q, pivot, -1)
  const kv = dot(k, v), cr = { x: k.y * v.z - k.z * v.y, y: k.z * v.x - k.x * v.z, z: k.x * v.y - k.y * v.x }
  return add(pivot, { x: v.x * c + cr.x * s + k.x * kv * (1 - c), y: v.y * c + cr.y * s + k.y * kv * (1 - c), z: v.z * c + cr.z * s + k.z * kv * (1 - c) })
}
const turnedDir = (n, turn) => (turn ? add(turned(add(turn.pivot, n), turn), turn.pivot, -1) : n)

// Faces cut by a plane (keeping n·q ≤ d): each face clipped, and the new face along the cut, its points in order round
// their middle (the part is convex where a plane crosses it: an end, a corner, a foot).
function cut(faces, plane) {
  const f = (q) => dot(plane.n, q) - plane.d, out = [], on = []
  for (const face of faces) {
    const kept = []
    for (let i = 0; i < face.pts.length; i++) {
      const a = face.pts[i], b = face.pts[(i + 1) % face.pts.length], fa = f(a), fb = f(b)
      if (fa <= 1e-9) kept.push(a)
      if (Math.abs(fa) <= 1e-9) on.push(a)
      if ((fa < -1e-9 && fb > 1e-9) || (fa > 1e-9 && fb < -1e-9)) { const t = fa / (fa - fb), q = add(a, add(b, a, -1), t); kept.push(q); on.push(q) }
    }
    if (kept.length >= 3) out.push({ ...face, pts: kept })
  }
  // (the cut face: its points without repeats, in order round their middle, seen along the plane's normal)
  const pts = on.filter((q, i) => on.findIndex((r) => Math.abs(r.x - q.x) + Math.abs(r.y - q.y) + Math.abs(r.z - q.z) < 1e-6) === i)
  if (pts.length >= 3) {
    const m = pts.reduce((s, q) => add(s, q, 1 / pts.length), { x: 0, y: 0, z: 0 }), n = plane.n
    const u0 = Math.abs(n.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 }
    const u = add(u0, n, -dot(u0, n)), ul = Math.sqrt(dot(u, u)), uu = { x: u.x / ul, y: u.y / ul, z: u.z / ul }
    const w = { x: n.y * uu.z - n.z * uu.y, y: n.z * uu.x - n.x * uu.z, z: n.x * uu.y - n.y * uu.x }
    const ang = (q) => Math.atan2(dot(add(q, m, -1), w), dot(add(q, m, -1), uu))
    out.push({ pts: pts.sort((a, b) => ang(a) - ang(b)), n: { ...n }, edge: null })
  }
  return out
}

// The part's faces in the world: its outline (in its length × width plane) run through its thickness, cut by the
// planes, turned, cut by the planes after.
export function solid(box, { outline: poly = null, cuts = [], turn = null, after = [] } = {}) {
  const { o, e, p } = box, Lv = unit(o.L), Wv = unit(o.W), Tv = unit(o.T)
  const at = ([u, v], t) => add(add(add(p, Lv, u), Wv, v), Tv, t)
  const shape = poly || [[0, 0], [e[o.L], 0], [e[o.L], e[o.W]], [0, e[o.W]]]
  // (the outline anticlockwise seen from +T: its right-handedness depends on the axes it lies along)
  const hand = dot({ x: Lv.y * Wv.z - Lv.z * Wv.y, y: Lv.z * Wv.x - Lv.x * Wv.z, z: Lv.x * Wv.y - Lv.y * Wv.x }, Tv)
  const ring = hand > 0 ? shape : [...shape].reverse()
  let faces = [
    { pts: ring.map((q) => at(q, e[o.T])), n: Tv, edge: Lv },
    { pts: [...ring].reverse().map((q) => at(q, 0)), n: unit(o.T, -1), edge: Lv },
  ]
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length]
    const da = add(at(b, 0), at(a, 0), -1), out = { x: da.y * Tv.z - da.z * Tv.y, y: da.z * Tv.x - da.x * Tv.z, z: da.x * Tv.y - da.y * Tv.x }
    const len = Math.sqrt(dot(out, out)) || 1
    // (a side along the length shows grain along it; an end shows none)
    const alongL = Math.abs(dot(da, Lv)) >= Math.abs(dot(da, Wv))
    faces.push({ pts: [at(a, 0), at(b, 0), at(b, e[o.T]), at(a, e[o.T])], n: { x: out.x / len, y: out.y / len, z: out.z / len }, edge: alongL ? Lv : null })
  }
  for (const plane of cuts) faces = cut(faces, plane)
  if (turn) faces = faces.map((f) => ({ ...f, pts: f.pts.map((q) => turned(q, turn)), n: turnedDir(f.n, turn), edge: f.edge && turnedDir(f.edge, turn) }))
  for (const plane of after) faces = cut(faces, plane)
  return faces
}

// The faces the viewer sees (its view direction, towards the viewer), far to near, each with its kind for the engine's
// shading — upper (lightest), front, side — and, where it has grain, the parallelogram the grain runs in.
export function visible(faces, toward, project) {
  const kindOf = (n) => (Math.abs(n.z) >= Math.max(Math.abs(n.x), Math.abs(n.y)) ? 'upper' : Math.abs(n.y) >= Math.abs(n.x) ? 'front' : 'side')
  const depth = (f) => dot(f.pts.reduce((s, q) => add(s, q, 1 / f.pts.length), { x: 0, y: 0, z: 0 }), toward)
  return faces.filter((f) => dot(f.n, toward) > 1e-6).sort((a, b) => depth(a) - depth(b)).map((f) => {
    const face = { kind: kindOf(f.n), pts: f.pts.map((q) => project(q.x, q.y, q.z)), shaped: true }
    if (f.edge) {
      // (the grain's frame: the face's extent along its length and across it, as a parallelogram on the frame)
      const across = { x: f.n.y * f.edge.z - f.n.z * f.edge.y, y: f.n.z * f.edge.x - f.n.x * f.edge.z, z: f.n.x * f.edge.y - f.n.y * f.edge.x }
      const us = f.pts.map((q) => dot(q, f.edge)), vs = f.pts.map((q) => dot(q, across))
      const u0 = Math.min(...us), u1 = Math.max(...us), v0 = Math.min(...vs), v1 = Math.max(...vs), base = f.pts[0]
      const at = (u, v) => { const q = add(add(base, f.edge, u - dot(base, f.edge)), across, v - dot(base, across)); return project(q.x, q.y, q.z) }
      face.box = [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)]
    }
    return face
  })
}

export { AXES }
