// Folding a flat sheet (paper, card, a napkin, cloth, a tortilla), drawn from numbers the way boards and bricks are.
// The plan never draws a folded sheet: it names each fold by what moves where ("top-left" onto "centre line", the
// "bottom edge" onto the "top edge"), and here the sheet is folded exactly. The fold line is worked out from that; every
// layer on its moving side is split along it and reflected across it, and lands on top of the rest (a valley fold) or
// under it (a mountain fold). Layers, creases and which side faces up all follow, so a dart's nose comes out symmetric
// because the geometry makes it so. Computed in Node; the film (engine.mjs) only turns each flap about its fold line.
//
// A sheet is a set of facets: each the polygon it was in the flat sheet (o, cm), the transform that puts it where it
// lies now (m: x' = a x + c y + e, y' = b x + d y + f; a reflection turns it over), its place in the stack (z) and the
// creases on it (lines, in o's coordinates). The frame is the sheet as seen from above: x across, y down the frame
// (towards the viewer), so "top" is the far edge, as a diagram shows it.
//
// Cut and opened out: a shape cut through the folded layers ("move":"cut", or a "cut" with a "shape", which the plan's
// settling makes one) is taken out of every layer under it; each facet keeps where it lay in the flat sheet, so opening
// the sheet out ("move":"open") shows the cut repeated wherever the folds carried it — a snowflake, a chain of figures.
// Opening undoes every fold, turn and rotation since the sheet was last flat, last first, each facet remembering what
// moved it (hist) and where it was stacked before.
//
//   foldLength(a) → how long a fold act takes, s (an opening: openLength(how many folds it undoes))
//   sheetSize(object) → [w, d] cm: w across the frame, d up and down it
//   runFolds(script) → {sheets: {k: {w, d, initial, folds: {actId: fold}}}, errors}
//   checkFolds(script) → the plan's fold errors (references that do not resolve, a fold that moves nothing)

export const FOLD_LENGTH = { fold: 2.6, unfold: 3.0, over: 1.8, rotate: 1.4, cut: 1.8 }
export const openLength = (n) => 1.2 + 0.75 * Math.max(1, n)
export const foldLength = (a) => FOLD_LENGTH[foldKind(a)] ?? openLength(1)
// (a fold act's kind; "move":"open" — opening the sheet out, kind "spread" (the film's program may not say "open") — is
// not "unfold": that folds once and opens that fold again)
export const foldKind = (a) => a.v === 'cut' || /^\s*cut\b/i.test(String(a.move || '')) ? 'cut' : a.unfold ? 'unfold'
  : /^\s*(open|unfold)\b/i.test(String(a.move || '')) ? 'spread' : /^\s*(turn\s+)?over\b/i.test(String(a.move || '')) ? 'over'
  : /^\s*rotate\b/i.test(String(a.move || '')) ? 'rotate' : 'fold'
// What a fold act does to the sheet for good: folds, turns and rotations are undone by an opening; the rest are not.
export const transforms = (a) => ['fold', 'over', 'rotate'].includes(foldKind(a))

import { sheetParts, hasSheetCuts } from './sheets.mjs'

const EPS = 1e-6
const list = (v) => Array.isArray(v) ? v : []
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]], add = (a, b) => [a[0] + b[0], a[1] + b[1]], mul = (a, k) => [a[0] * k, a[1] * k]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1], cross = (a, b) => a[0] * b[1] - a[1] * b[0]
const len = (a) => Math.hypot(a[0], a[1]), unit = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l] }
const perp = (a) => [-a[1], a[0]]
const apply = (m, [x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
// (A after B)
const compose = (A, B) => [A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
  A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5]]
const ID = [1, 0, 0, 1, 0, 0]
// The reflection across the line through p with unit normal n.
const reflection = (p, n) => { const k = 2 * dot(n, p); return [1 - 2 * n[0] * n[0], -2 * n[0] * n[1], -2 * n[0] * n[1], 1 - 2 * n[1] * n[1], k * n[0], k * n[1]] }
const rotation = (c, a) => { const cs = Math.cos(a), sn = Math.sin(a); return [cs, sn, -sn, cs, c[0] - cs * c[0] + sn * c[1], c[1] - sn * c[0] - cs * c[1]] }
const area = (P) => Math.abs(P.reduce((s, p, i) => s + cross(p, P[(i + 1) % P.length]), 0)) / 2
const current = (f) => f.o.map((p) => apply(f.m, p))
const backUp = (f) => f.m[0] * f.m[3] - f.m[1] * f.m[2] < 0

// A polygon cut by a line: its vertices' signed distances s; the part at s ≤ 0 and the part at s ≥ 0 (each null when
// empty). Facets stay convex (each is the flat sheet cut by straight lines), so one pass does it.
function split(P, s) {
  const neg = [], pos = []
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length], sa = s[i], sb = s[(i + 1) % P.length]
    if (sa <= EPS) neg.push(a)
    if (sa >= -EPS) pos.push(a)
    if ((sa < -EPS && sb > EPS) || (sa > EPS && sb < -EPS)) {
      const u = sa / (sa - sb), x = [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]
      neg.push(x); pos.push(x)
    }
  }
  const ok = (Q) => Q.length >= 3 && area(Q) > 1e-4 ? Q : null
  return [ok(neg), ok(pos)]
}
// A segment cut the same way.
function splitSegment([a, b], sa, sb) {
  if (sa <= EPS && sb <= EPS) return [[a, b], null]
  if (sa >= -EPS && sb >= -EPS) return [null, [a, b]]
  const u = sa / (sa - sb), x = [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]
  return sa < 0 ? [[a, x], [x, b]] : [[x, b], [a, x]]
}

// A facet cut along the line (p, n), as it lies now: its piece on the negative side and on the positive side (or null),
// each with its part of the creases.
function splitFacet(f, p, n) {
  const s = current(f).map((q) => dot(n, sub(q, p)))
  const [a, b] = split(f.o, s)
  const cutLines = (keep) => f.lines.flatMap((L) => {
    const [x, y] = splitSegment(L, dot(n, sub(apply(f.m, L[0]), p)), dot(n, sub(apply(f.m, L[1]), p)))
    const seg = keep ? y : x
    return seg && len(sub(seg[1], seg[0])) > 1e-3 ? [seg] : []
  })
  return [a && { ...f, o: a, lines: cutLines(false) }, b && { ...f, o: b, lines: cutLines(true) }]
}
// Every facet cut along the line (p, n): the facets on its negative side and on its positive side.
function cutAll(facets, p, n) {
  const neg = [], pos = []
  for (const f of facets) {
    const [a, b] = splitFacet(f, p, n)
    if (a) neg.push(a)
    if (b) pos.push(b)
  }
  return [neg, pos]
}
// A convex polygon C (as the sheet lies now) taken out of a facet: what is left, as convex pieces, and the piece taken.
function subtract(f, C) {
  const kept = [], mid = mul(C.reduce((s, q) => add(s, q), [0, 0]), 1 / C.length)
  let rest = f
  for (let i = 0; i < C.length; i++) {
    const a = C[i], b = C[(i + 1) % C.length]
    let n = unit(perp(sub(b, a)))
    if (dot(n, sub(mid, a)) > 0) n = mul(n, -1)
    const [inner, outer] = splitFacet(rest, a, n)
    if (outer) kept.push(outer)
    if (!inner) return { kept, taken: null }
    rest = inner
  }
  return { kept, taken: rest }
}
// A simple polygon as triangles (ear clipping), or as itself when it is convex already.
function convexParts(P) {
  const signed = P.reduce((s, p, i) => s + cross(p, P[(i + 1) % P.length]), 0) / 2
  const Q = signed < 0 ? [...P].reverse() : [...P]
  const turnsLeft = (a, b, c) => cross(sub(b, a), sub(c, b)) >= -1e-9
  if (Q.every((p, i) => turnsLeft(Q[(i + Q.length - 1) % Q.length], p, Q[(i + 1) % Q.length]))) return [Q]
  const out = [], V = [...Q]
  for (let guard = 0; V.length > 3 && guard < 200; guard++) {
    let clipped = false
    for (let i = 0; i < V.length; i++) {
      const a = V[(i + V.length - 1) % V.length], b = V[i], c = V[(i + 1) % V.length]
      if (cross(sub(b, a), sub(c, b)) <= 1e-9) continue
      const T = [a, b, c]
      if (V.some((q) => !T.includes(q) && inside(T, q, 0))) continue
      out.push(T); V.splice(i, 1); clipped = true; break
    }
    if (!clipped) break
  }
  if (V.length === 3) out.push(V)
  return out
}

// The outline everything makes, as seen from above: the convex hull of every facet's corners (what "the top-left
// corner" or "the left edge" of a folded sheet means is read off it).
function hull(points) {
  // (rounded first: two facets' copies of one corner, 21 and 21.000000000000004 apart, read as a turn back on itself and
  // dropped the corner between them)
  const seen = new Map()
  for (const q of points) { const r = [Math.round(q[0] * 1e6) / 1e6, Math.round(q[1] * 1e6) / 1e6]; seen.set(r.join(), r) }
  const P = [...seen.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]), out = []
  const half = (pts) => { const h = []; for (const p of pts) { while (h.length >= 2 && cross(sub(h[h.length - 1], h[h.length - 2]), sub(p, h[h.length - 2])) <= 1e-9) h.pop(); h.push(p) } h.pop(); return h }
  out.push(...half(P), ...half([...P].reverse()))
  return out
}
const outlineOf = (facets) => hull(facets.flatMap(current))
const boxOf = (pts) => { const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] }
const inside = (H, q, tol) => H.every((p, i) => cross(sub(H[(i + 1) % H.length], p), sub(q, p)) >= -tol * len(sub(H[(i + 1) % H.length], p)))
// Where the line (p, direction d) crosses the outline: its two ends there, or null.
function across(H, p, d) {
  const n = perp(d), s = H.map((q) => dot(n, sub(q, p))), hits = []
  for (let i = 0; i < H.length; i++) {
    const a = H[i], b = H[(i + 1) % H.length], sa = s[i], sb = s[(i + 1) % H.length]
    if (Math.abs(sa) < 1e-9) hits.push(a)
    else if (sa * sb < 0) hits.push(add(a, mul(sub(b, a), sa / (sa - sb))))
  }
  if (hits.length < 2) return null
  const t = hits.map((q) => dot(d, sub(q, p)))
  return [hits[t.indexOf(Math.min(...t))], hits[t.indexOf(Math.max(...t))]]
}

// The words a plan names a place on the sheet with: where on the sheet as seen from above. Several combine (a corner).
const DIRECTIONS = { top: [0, -1], upper: [0, -1], far: [0, -1], up: [0, -1], bottom: [0, 1], lower: [0, 1], near: [0, 1], down: [0, 1], left: [-1, 0], right: [1, 0] }
const words = (ref) => String(ref ?? '').toLowerCase().replace(/center/g, 'centre').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean)
const directionOf = (w) => { const d = w.filter((x) => DIRECTIONS[x]).reduce((s, x) => add(s, DIRECTIONS[x]), [0, 0]); return len(d) > 0 ? unit(d) : null }
export const isLine = (ref) => words(ref).some((x) => ['edge', 'side', 'line', 'crease', 'fold', 'axis', 'diagonal'].includes(x))

// A place on the sheet as it lies now: a point ({p}) or a line ({line: [a, b]}); throws a message for a plan when it
// does not resolve. Points: a corner (top-left), a side's middle or tip (top), the centre. Lines: an edge (left edge, top-left
// edge for a slanted one), the centre line (vertical; "horizontal centre line" across), a crease named by an earlier fold.
function resolve(state, ref, want) {
  const w = words(ref), H = outlineOf(state.facets), [x0, y0, x1, y1] = boxOf(H), c = [(x0 + x1) / 2, (y0 + y1) / 2], size = Math.max(x1 - x0, y1 - y0)
  const key = (r) => words(r).filter((x) => !['crease', 'line', 'fold', 'the'].includes(x)).join(' ')
  const named = state.named.find((n) => key(n.name) === key(ref))
  if (named) return want === 'point' ? { p: mul(add(named.line[0], named.line[1]), 0.5) } : { line: named.line }
  const d = directionOf(w)
  const lineWanted = want === 'line' || (want !== 'point' && isLine(ref))
  if (lineWanted) {
    // (a crease with no name an earlier fold gave, and no centre or side named, is not guessed at)
    if (w.includes('centre') || w.includes('middle')) {
      const horizontal = w.includes('horizontal') || w.includes('across') || w.includes('crosswise') || w.includes('widthways')
      return { line: horizontal ? [[x0, c[1]], [x1, c[1]]] : [[c[0], y0], [c[0], y1]] }
    }
    if (w.includes('diagonal')) {
      const a = point(H, [-1, -1], size), b = point(H, [1, 1], size), e = point(H, [1, -1], size), f = point(H, [-1, 1], size)
      return { line: d && d[0] * d[1] > 0 ? [e, f] : [a, b] }
    }
    if (!d) throw new Error(`"${ref}" is not a line on the sheet: name an edge ("left edge", "top-left edge"), "centre line", "horizontal centre line" or a crease an earlier fold named`)
    // the outline's edge whose outward side faces that way most (the longest of those that tie)
    let best = null
    for (let i = 0; i < H.length; i++) {
      const a = H[i], b = H[(i + 1) % H.length], n = unit([b[1] - a[1], a[0] - b[0]]), score = dot(n, d)
      if (!best || score > best.score + 1e-6 || (Math.abs(score - best.score) <= 1e-6 && len(sub(b, a)) > len(sub(best.line[1], best.line[0])))) best = { score, line: [a, b] }
    }
    if (best.score < 0.3) throw new Error(`the sheet has no ${w.join(' ')}`)
    return { line: best.line }
  }
  if (!d) {
    if (w.includes('centre') || w.includes('middle')) return { p: c }
    throw new Error(`"${ref}" is not a place on the sheet: name a corner ("top-left"), a side's middle or tip ("top"), the "centre", or an edge or line`)
  }
  return { p: point(H, d, size) }
}
// The outline's point furthest that way; where a whole edge is furthest (a side's middle), its middle.
function point(H, d, size) {
  const best = Math.max(...H.map((q) => dot(q, d))), far = H.filter((q) => dot(q, d) >= best - size * 0.004)
  const along = perp(d), t = far.map((q) => dot(q, along))
  return mul(add(far[t.indexOf(Math.min(...t))], far[t.indexOf(Math.max(...t))]), 0.5)
}

// The fold line for an act, from what it moves and where to: {p, n} (n towards the side that moves), and the arrow's
// ends (a point that moves, from where it is to where it lands).
function foldLine(state, a) {
  const H = outlineOf(state.facets), [x0, y0, x1, y1] = boxOf(H), size = Math.max(x1 - x0, y1 - y0)
  const moving = resolve(state, a.move, isLine(a.move) ? 'line' : 'point')
  const ontoPoint = (A, X) => {
    if (len(sub(A, X)) < size * 0.01) throw new Error(`"${a.move}" is already at "${a.onto}": that fold moves nothing`)
    return { p: mul(add(A, X), 0.5), n: unit(sub(A, X)), from: A, to: X }
  }
  // (an edge turned about a point by so many degrees: the fold passes through "through" at "deg" to that edge, and the
  // edge lands at twice that — a straight edge in thirds is 60° and 60°, a snowflake's wedge)
  if ((a.onto == null || a.onto === '') && a.through && Number.isFinite(+a.deg)) {
    const deg = +a.deg
    if (!moving.line || !(deg > 0 && deg < 180)) throw new Error(`a fold at an angle turns an edge ("move") about "through" by "deg", between 0 and 180`)
    const P = resolve(state, a.through, 'point').p, [e0, e1] = moving.line
    const far = len(sub(e0, P)) >= len(sub(e1, P)) ? e0 : e1, v = unit(sub(far, P)), r = (deg * Math.PI) / 180
    const turn = (s) => [v[0] * Math.cos(s * r) - v[1] * Math.sin(s * r), v[0] * Math.sin(s * r) + v[1] * Math.cos(s * r)]
    const u = [turn(1), turn(-1)].sort((p, q) => Number(inside(H, add(P, mul(q, size * 0.05)), size * 0.002)) - Number(inside(H, add(P, mul(p, size * 0.05)), size * 0.002)))[0]
    let n = perp(u)
    if (dot(n, sub(far, P)) < 0) n = mul(n, -1)
    return { p: P, n, from: far, to: apply(reflection(P, n), far) }
  }
  // (an edge folded in by so many cm, with nothing to fold it onto: a hem, a flap)
  if (a.onto == null || a.onto === '') {
    if (!(+a.cm > 0) || !moving.line) throw new Error(`a fold needs "onto" (where what moves lands), or an edge and "cm" (how far in it folds)`)
    const [e0, e1] = moving.line, mid = mul(add(e0, e1), 0.5), c = [(x0 + x1) / 2, (y0 + y1) / 2]
    let n = unit(perp(sub(e1, e0)))
    if (dot(n, sub(c, mid)) < 0) n = mul(n, -1)
    const cm = +a.cm, to = add(mid, mul(n, 2 * cm))
    return { p: add(mid, mul(n, cm)), n: mul(n, -1), from: mid, to }
  }
  const target = resolve(state, a.onto, isLine(a.onto) ? 'line' : 'point')
  if (moving.p && target.p) return ontoPoint(moving.p, target.p)
  if (moving.p && target.line) {
    // a point onto a line: the fold passes through "through", or where that line meets the outline nearest the point
    const [m0, m1] = target.line, u = unit(sub(m1, m0)), A = moving.p
    let P = a.through ? resolve(state, a.through, 'point').p : null
    if (!P) {
      const ends = across(H, m0, u)
      if (!ends) throw new Error(`"${a.onto}" does not cross the sheet`)
      P = ends.reduce((x, y) => (len(sub(x, A)) <= len(sub(y, A)) ? x : y))
    }
    // where it lands: on the line, as far from P as it was
    const r = len(sub(A, P)), f = dot(sub(P, m0), u), foot = add(m0, mul(u, f)), h = len(sub(P, foot))
    if (h > r + 1e-6) throw new Error(`"${a.move}" cannot reach "${a.onto}" folding through "${a.through || 'that point'}"`)
    const k = Math.sqrt(Math.max(0, r * r - h * h)), options = [add(foot, mul(u, k)), add(foot, mul(u, -k))].filter((X) => len(sub(X, A)) > size * 0.01)
    if (!options.length) throw new Error(`"${a.move}" is already on "${a.onto}": that fold moves nothing`)
    const X = options.sort((p, q) => Number(inside(H, q, size * 0.01)) - Number(inside(H, p, size * 0.01)) || len(sub(p, A)) - len(sub(q, A)))[0]
    return ontoPoint(A, X)
  }
  if (moving.line) {
    // an edge onto a line or an edge: parallel, the fold is halfway between; else it halves the angle where they meet
    const [e0, e1] = moving.line, v = unit(sub(e1, e0)), mid = mul(add(e0, e1), 0.5)
    const [m0, m1] = target.line || [target.p, add(target.p, v)], u = unit(sub(m1, m0))
    if (Math.abs(cross(v, u)) < 0.02) {
      const n0 = perp(u), dist = dot(n0, sub(mid, m0))
      if (Math.abs(dist) < size * 0.01) throw new Error(`"${a.move}" is already on "${a.onto}": that fold moves nothing`)
      return { p: sub(mid, mul(n0, dist / 2)), n: mul(n0, Math.sign(dist)), from: mid, to: sub(mid, mul(n0, dist)) }
    }
    const t = cross(sub(m0, e0), u) / cross(v, u), I = add(e0, mul(v, t))
    const options = [unit(add(v, u)), unit(sub(v, u))].map((b) => {
      let n = perp(b)
      if (dot(n, sub(mid, I)) < 0) n = mul(n, -1)
      const to = apply(reflection(I, n), mid), [, pos] = split(H, H.map((q) => dot(n, sub(q, I))))
      return { p: I, n, from: mid, to, lands: inside(H, to, size * 0.01), moves: pos ? area(pos) : Infinity }
    })
    return options.sort((p, q) => Number(q.lands) - Number(p.lands) || p.moves - q.moves)[0]
  }
  throw new Error(`cannot fold "${a.move}" onto "${a.onto}"`)
}

// Two facets meet along an edge of the flat sheet (not merely lie on each other): they are one piece of paper there.
function joined(f, g) {
  for (let i = 0; i < f.o.length; i++) {
    const a = f.o[i], b = f.o[(i + 1) % f.o.length], d = unit(sub(b, a)), L = len(sub(b, a))
    for (let j = 0; j < g.o.length; j++) {
      const c = g.o[j], e = g.o[(j + 1) % g.o.length]
      if (Math.abs(cross(d, sub(c, a))) > 1e-4 || Math.abs(cross(d, sub(e, a))) > 1e-4) continue
      const tc = dot(d, sub(c, a)), te = dot(d, sub(e, a))
      if (Math.min(L, Math.max(tc, te)) - Math.max(0, Math.min(tc, te)) > 1e-3) return true
    }
  }
  return false
}

const rerank = (facets) => { [...facets].sort((a, b) => a.z - b.z).forEach((f, i) => { f.z = i }); return facets }

// (each facet's record of an act that moves the sheet: whether it moved, and where it was stacked before)
const recorded = (f, op, moved) => ({ ...f, hist: [...f.hist, { op, z: f.z, moved }] })

// One act on the sheet: the state after it, and what the film needs to show it.
function applyFold(state, a) {
  const kind = foldKind(a), facets = state.facets, ops = state.ops
  const H = outlineOf(facets), [x0, y0, x1, y1] = boxOf(H), c = [(x0 + x1) / 2, (y0 + y1) / 2]
  if (kind === 'rotate') {
    const deg = Number.isFinite(+a.deg) && +a.deg !== 0 ? +a.deg : 90, R = rotation(c, (deg * Math.PI) / 180)
    const after = facets.map((f) => ({ ...recorded(f, ops.length, true), m: compose(R, f.m) }))
    return { state: { facets: after, named: state.named.map((n) => ({ ...n, line: n.line.map((q) => apply(R, q)) })), ops: [...ops, { kind, F: R, centre: c, deg }] },
      show: { kind, centre: c, deg, still: [], moving: facets, after } }
  }
  if (kind === 'over') {
    // turned over side to side: every layer reflected across the middle, the stack reversed
    const n = [1, 0], F = reflection(c, n), top = Math.max(...facets.map((f) => f.z))
    const after = rerank(facets.map((f) => ({ ...recorded(f, ops.length, true), m: compose(F, f.m), z: top - f.z })))
    return { state: { facets: after, named: state.named.map((x) => ({ ...x, line: x.line.map((q) => apply(F, q)) })), ops: [...ops, { kind, F, axis: { p: c, n } }] },
      show: { kind, axis: { p: c, n }, still: [], moving: facets, after } }
  }
  if (kind === 'cut') {
    // a shape cut through every layer under it: its points are fractions of the folded sheet's box as seen from above
    const shape = list(a.shape).filter((q) => Array.isArray(q) && q.length === 2 && q.every(Number.isFinite))
    if (shape.length < 3 || shape.length > 24) throw new Error(`a cut through the folded sheet needs "shape": 3 to 24 points [u, v], fractions of the folded sheet's box (u from its left, v from its far edge)`)
    if (shape.some(([u, v]) => u < -0.5 || u > 1.5 || v < -0.5 || v > 1.5)) throw new Error(`a cut's points are fractions of the folded sheet's box, from 0 to 1 (a little past its edges to cut a notch)`)
    const C = shape.map(([u, v]) => [x0 + u * (x1 - x0), y0 + v * (y1 - y0)]), parts = convexParts(C)
    if (!parts.length || area(C) < 1e-6) throw new Error(`a cut's shape encloses nothing`)
    let left = facets, taken = []
    for (const P of parts) {
      const next = []
      for (const f of left) { const r = subtract(f, P); next.push(...r.kept); if (r.taken) taken.push(r.taken) }
      left = next
    }
    if (!taken.length) throw new Error(`the cut misses the sheet: its shape is off the folded sheet`)
    if (!left.length) throw new Error(`the cut takes the whole sheet away`)
    return { state: { facets: left, named: state.named, ops }, show: { kind, still: left, moving: taken, after: left, shape: C } }
  }
  if (kind === 'spread') {
    // opened out flat: every fold, turn and rotation since it was last flat undone, last first — each one a turn back
    // about its line for the film — and the edges between pieces a fold had parted drawn as the creases they are
    if (!ops.length) throw new Error(`there is nothing to open out: the sheet is not folded`)
    let now = facets.map((f) => ({ ...f, was: f.m }))
    const subs = []
    for (let j = ops.length - 1; j >= 0; j--) {
      const op = ops[j], back = op.kind === 'rotate' ? rotation(op.centre, (-op.deg * Math.PI) / 180) : op.F
      const undone = now.map((f) => {
        const h = f.hist[f.hist.length - 1]
        return h && h.op === j ? { ...f, hist: f.hist.slice(0, -1), z: h.z, m: h.moved ? compose(back, f.m) : f.m, moved: h.moved } : { ...f, moved: false }
      })
      subs.push({ kind: op.kind, axis: op.axis, mountain: op.mountain, centre: op.centre, deg: op.deg,
        still: undone.filter((f) => !f.moved), moving: undone.filter((f) => f.moved), after: undone })
      now = undone
    }
    const flat = now.map((f) => ({ ...f, m: ID }))
    const after = flat.map((f) => ({ ...f, lines: [...f.lines, ...creasesOf(f, flat)] }))
    for (const f of after) { delete f.was; delete f.moved }
    return { state: { facets: rerank(after), named: [], ops: [] }, show: { kind, still: [], moving: facets, after, subs } }
  }
  const { p, n, from, to } = foldLine(state, a)
  const [still, moved] = cutAll(facets, p, n)
  let moving = moved, staying = still
  if (a.layers === 'top' && moved.length) {
    // only the uppermost layer: the moving pieces that are one piece of paper with the highest of them
    const group = [moved.reduce((x, y) => (y.z > x.z ? y : x))]
    for (let grew = true; grew;) { grew = false; for (const f of moved) if (!group.includes(f) && group.some((g) => joined(f, g))) { group.push(f); grew = true } }
    moving = group; staying = [...still, ...moved.filter((f) => !group.includes(f))]
  }
  if (!moving.length) throw new Error(`folding "${a.move}" onto "${a.onto}" moves nothing: the fold line misses the sheet`)
  if (!staying.length) throw new Error(`folding "${a.move}" onto "${a.onto}" moves the whole sheet: that is turning it over, not a fold`)
  const ends = across(H, p, perp(n)), line = ends ? ends : [sub(p, mul(perp(n), size(H))), add(p, mul(perp(n), size(H)))]
  const mountain = a.crease === 'mountain'
  if (kind === 'unfold') {
    // folded and opened again: nothing moves for good, every facet the line crosses (that the fold moved part of)
    // keeps the crease
    const folded = new Set(moving.map((f) => f.id))
    const after = facets.map((f) => {
      const P = current(f), s = P.map((q) => dot(n, sub(q, p)))
      if (!folded.has(f.id) || Math.min(...s) >= -1e-4 || Math.max(...s) <= 1e-4) return { ...f }
      const seg = across(P, p, perp(n))
      return seg ? { ...f, lines: [...f.lines, seg.map((q) => apply(invert(f.m), q))] } : { ...f }
    })
    return { state: { facets: after, named: [...state.named, ...(a.name ? [{ name: a.name, line }] : [])], ops },
      show: { kind, axis: { p, n }, mountain, still: staying, moving, after, line, from, to } }
  }
  const F = reflection(p, n), zs = moving.map((f) => f.z), top = Math.max(...facets.map((f) => f.z)), bottom = Math.min(...facets.map((f) => f.z))
  const turned = moving.map((f) => ({ ...recorded(f, ops.length, true), m: compose(F, f.m), z: mountain ? bottom - 1 - (f.z - Math.min(...zs)) : top + 1 + (Math.max(...zs) - f.z) }))
  const after = rerank([...staying.map((f) => recorded(f, ops.length, false)), ...turned])
  // (a named crease the fold carries with it moves with it; one that crosses the fold keeps its part that stays)
  const named = state.named.map((x) => {
    const s0 = dot(n, sub(x.line[0], p)), s1 = dot(n, sub(x.line[1], p))
    if (s0 > 1e-4 && s1 > 1e-4) return { ...x, line: x.line.map((q) => apply(F, q)) }
    const [keep] = splitSegment(x.line, s0, s1)
    return keep ? { ...x, line: keep } : x
  })
  return { state: { facets: after, named: [...named, ...(a.name ? [{ name: a.name, line }] : [])], ops: [...ops, { kind, F, axis: { p, n }, mountain }] },
    show: { kind, axis: { p, n }, mountain, still: staying, moving, after, line, from, to } }
}
const size = (H) => { const [x0, y0, x1, y1] = boxOf(H); return Math.max(x1 - x0, y1 - y0) }
const invert = (m) => { const det = m[0] * m[3] - m[1] * m[2], a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det; return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])] }

// A sheet's size in cm as it lies, w across the frame and d up and down it: its part's size, else its length and width.
export function sheetSize(o) {
  const s = o?.part?.size
  if (Array.isArray(s) && s.length >= 2 && +s[0] > 0 && +s[1] > 0) return [+s[0], +s[1]]
  const L = +o?.cm > 0 ? +o.cm : 21, W = +o?.w > 0 ? +o.w : L * 0.707
  return [Math.min(L, W), Math.max(L, W)]
}

const r2 = (v) => Math.round(v * 100) / 100
const pt = (q) => [r2(q[0]), r2(q[1])]
const same = (m, n) => m.every((v, i) => Math.abs(v - n[i]) < 1e-6)
// Where along f's edge i (0 to 1) another facet's edge of the flat sheet lies, for the facets `which` picks.
function shared(f, i, facets, which) {
  const a = f.o[i], b = f.o[(i + 1) % f.o.length], L = len(sub(b, a)), d = unit(sub(b, a)), out = []
  if (L < 1e-9) return out
  for (const g of facets) {
    if (g === f || !which(g)) continue
    for (let j = 0; j < g.o.length; j++) {
      const c = g.o[j], e = g.o[(j + 1) % g.o.length]
      if (Math.abs(cross(d, sub(c, a))) > 1e-4 || Math.abs(cross(d, sub(e, a))) > 1e-4) continue
      const t0 = Math.max(0, Math.min(dot(d, sub(c, a)), dot(d, sub(e, a))) / L), t1 = Math.min(1, Math.max(dot(d, sub(c, a)), dot(d, sub(e, a))) / L)
      if (t1 - t0 > 1e-6) out.push([t0, t1])
    }
  }
  return out
}
// What is left of [0, 1] once the spans are taken out.
function rest(spans) {
  const out = []
  let at = 0
  for (const [s, e] of [...spans].sort((x, y) => x[0] - y[0])) { if (s > at + 1e-6) out.push([at, s]); at = Math.max(at, e) }
  if (at < 1 - 1e-6) out.push([at, 1])
  return out
}
const along = (f, i, [s, e]) => { const a = f.o[i], b = f.o[(i + 1) % f.o.length]; return [add(a, mul(sub(b, a), s)), add(a, mul(sub(b, a), e))] }
// A facet's edges as the film strokes them: all but where it meets a piece of the same layer lying the same way (the
// seams a cut leaves, splitting a layer into convex pieces: the paper is whole there).
// (an edge stroked whole is given as its index, i from corner i to the next: most are, and a film's program is bounded)
const edgesOf = (f, facets) => f.o.flatMap((_, i) => rest(shared(f, i, facets, (g) => same(g.m, f.m))).map((span) => span[0] < 1e-6 && span[1] > 1 - 1e-6 ? i : along(f, i, span)))
// Opened out: the edges where it meets a piece a fold had laid elsewhere (by what moved them, f.was) are its creases.
const creasesOf = (f, facets) => f.o.flatMap((_, i) => shared(f, i, facets, (g) => !same(g.was, f.was)).map((span) => along(f, i, span)))
  .filter(([p, q]) => len(sub(q, p)) > 1e-3)
// A facet as the film draws it: where it lies now, whether its back faces up, its edges to stroke, its creases.
const shown = (f, facets) => ({ p: current(f).map(pt), b: backUp(f) ? 1 : 0, s: edgesOf(f, facets).map((L) => typeof L === 'number' ? L : L.map((q) => pt(apply(f.m, q)))),
  l: f.lines.map((L) => L.map((q) => pt(apply(f.m, q)))) })
const byZ = (facets) => [...facets].sort((a, b) => a.z - b.z).map((f) => shown(f, facets))

// Every sheet's folds, in the order the steps make them. A sheet is an object of the photo, a made piece, or a part cut
// from a sheet: cut across its length, so as wide as what it came from and as long as its cut (21 cm off an A4 sheet
// is a 21 × 21 square).
export function runFolds(script) {
  const explicit = sheetParts(script)
  const objects = new Map([...list(script?.objects), ...list(script?.makes)].filter((o) => o && typeof o.k === 'string').map((o) => [o.k, o]))
  const cuts = new Map(list(script?.steps).flatMap((s) => list(s?.do)).filter((a) => a?.v === 'cut' && typeof a.k === 'string' && !a.shape)
    .flatMap((a) => list(a.into).filter((p) => typeof p?.k === 'string').map((p) => [p.k, { from: a.k, cm: +p.cm }])))
  const sizeOf = (k, seen = new Set()) => {
    if (explicit.get(k)?.from) return explicit.get(k).size
    if (objects.has(k)) return sheetSize(objects.get(k))
    const c = cuts.get(k)
    if (!c || seen.has(k) || !objects.has(c.from) && !cuts.has(c.from)) return null
    const [w, d] = sizeOf(c.from, new Set([...seen, k])) || [], cm = c.cm > 0 ? c.cm : null
    if (!(w > 0) || !cm) return null
    return d >= w ? [w, Math.min(cm, d)] : [Math.min(cm, w), d]
  }
  // (a cut with a shape, through a folded sheet, is one of its folds' acts — the plan's settling makes it "move":"cut")
  const acts = list(script?.steps).flatMap((s, i) => list(s?.do).map((a) => ({ a, step: i }))).filter(({ a }) => a?.v === 'fold' || a?.v === 'cut' && a.shape)
  const sheets = {}, states = {}, errors = []
  const begin = (k, size) => {
    const [w, d] = size, polygon = explicit.get(k)?.outline || [[0, 0], [w, 0], [w, d], [0, d]]
    states[k] = { facets: convexParts(polygon).map((o, id) => ({ id, o, m: ID, z: 0, lines: [], hist: [] })), named: [], ops: [] }
    sheets[k] = { w, d, initial: byZ(states[k].facets), folds: {} }
  }
  if (hasSheetCuts(script) || list(script?.steps).some((s) => list(s.do).some((a) => a.path)))
    for (const [k, p] of explicit) if (Array.isArray(p.size) && p.size.every((x) => x > 0) && p.outline.length >= 3) begin(k, p.size)
  for (const [index, { a, step }] of acts.entries()) {
    const label = `step ${step + 1}${a.id ? ` (${a.id})` : ''}`
    const size = typeof a.k === 'string' ? sizeOf(a.k) : null
    if (!size) { errors.push(`${label}: a fold needs one sheet: an object of the photo, or a part cut from one with its "cm" (the key it was cut into)`); continue }
    if (!states[a.k]) {
      begin(a.k, size)
    }
    if (foldKind(a) === 'fold' || foldKind(a) === 'unfold') {
      if (typeof a.move !== 'string' || !a.move.trim()) { errors.push(`${label}: a fold names what moves in "move" (a corner, a side, an edge)`); continue }
      if (a.crease != null && !['valley', 'mountain'].includes(a.crease)) { errors.push(`${label}: crease is "valley" or "mountain"`); continue }
    }
    try {
      // (each facet a fresh id for the next unfold to find its pieces by)
      const before = states[a.k]
      before.facets.forEach((f, i) => { f.id = i })
      const { state, show } = applyFold(before, a)
      state.facets.forEach((f, i) => { f.id = i })
      states[a.k] = state
      sheets[a.k].folds[a.id || `fold-${index}`] = {
        kind: show.kind, mountain: !!show.mountain, layers: a.layers === 'top' ? 'top' : 'all',
        still: byZ(show.still), moving: byZ(show.moving), after: byZ(show.after),
        axis: show.axis ? { p: pt(show.axis.p), n: show.axis.n.map((v) => Math.round(v * 1e6) / 1e6) } : null,
        centre: show.centre ? pt(show.centre) : null, deg: show.deg ?? null,
        line: show.line ? show.line.map(pt) : null, from: show.from ? pt(show.from) : null, to: show.to ? pt(show.to) : null,
        shape: show.shape ? show.shape.map(pt) : null,
        subs: show.subs ? show.subs.map((x) => ({ kind: x.kind, mountain: !!x.mountain, still: byZ(x.still), moving: byZ(x.moving), after: byZ(x.after),
          axis: x.axis ? { p: pt(x.axis.p), n: x.axis.n.map((v) => Math.round(v * 1e6) / 1e6) } : null, centre: x.centre ? pt(x.centre) : null, deg: x.deg ?? null })) : null,
      }
    } catch (e) {
      errors.push(`${label}: ${e.message}`)
    }
  }
  return { sheets, errors }
}

// Final visible planar extent in centimetres, including opening, rotation and sheet cuts.
// The fold engine models flat layers; this does not infer a finished 3D thickness.
export function finalFoldBounds(script) {
  const { sheets, errors } = runFolds(script), bounds = {}
  for (const [key, sheet] of Object.entries(sheets)) {
    const last = Object.values(sheet.folds).at(-1)
    if (!last) continue
    const points = last.after.flatMap(f => f.p)
    if (!points.length) { errors.push(`${key}: folded sheet has no remaining material`); continue }
    const min = [0, 1].map(i => Math.min(...points.map(p => p[i])))
    const max = [0, 1].map(i => Math.max(...points.map(p => p[i])))
    bounds[key] = { min, max, size: max.map((v, i) => v - min[i]), stock: [sheet.w, sheet.d] }
  }
  return { bounds, errors }
}

// A film's program is bounded (400 000 characters: a longer one the player refuses, and the film never starts), and a
// sheet's folds and cuts are most of what can grow in it: every corner the film carries costs about 25 characters. A
// plan whose sheets would carry more than this many is sent back for fewer or simpler cuts.
export const MAX_CORNERS = 5000
export const cornersOf = (sheet) => Object.values(sheet.folds).reduce((sum, f) => {
  const n = (facets) => (facets || []).reduce((s, x) => s + x.p.length, 0)
  return sum + n(f.still) + (f.kind === 'spread' ? 0 : n(f.moving)) + (f.kind === 'cut' ? 0 : n(f.after)) + (f.subs || []).reduce((s, x) => s + n(x.still) + n(x.moving), 0)
}, n0(sheet.initial))
const n0 = (facets) => facets.reduce((s, x) => s + x.p.length, 0)
export const checkFolds = (script) => {
  const { sheets, errors } = runFolds(script)
  for (const [k, S] of Object.entries(sheets)) {
    const corners = cornersOf(S)
    if (corners > MAX_CORNERS) errors.push(`${k}: its folds and cuts make too many pieces for the film to carry (${corners} corners, at most ${MAX_CORNERS}): cut fewer or simpler shapes, or cut before the last fold or two`)
  }
  return errors
}
