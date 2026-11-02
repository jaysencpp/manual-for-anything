// Strands (wire, rope, string, ribbon, cable, twine, pipe cleaners, straws), drawn from numbers the way sheets and boards are.
// The plan never draws a bent wire or a knot: it names each operation (bend it 90° six centimetres from the end, coil the
// last 40 cm, tie an overhand knot in the middle, thread eight beads) and here the strand is worked out exactly. A strand
// is a curve of a fixed length: its heading along its length, in a plane seen from above, so a bend turns the part beyond
// it, a coil is a spiral, a ring is a circle of what is left once the overlap is taken, and none of them can make the
// strand longer or shorter. Crossings are worked out (where the strand passes over itself, a knot's over and unders
// follow the knot). Computed in Node; the film (engine.mjs) only blends one heading profile into the next, so a bend
// swings and a coil winds up without the strand ever stretching.
//
// A strand is its length L and thickness W (cm), a heading h[i] for each short segment (radians, growing clockwise as
// seen from above, the frame x across, y down the frame), the node a, x, y that holds still, and what rides on it:
// beads (by their place along it), a join (the twisted ends of a ring), a look (a twisted cord).
//
//   strandLength(a) → how long an operation takes, s
//   strandSize(object) → {L, W} cm: the strand's length and drawn thickness
//   runStrands(script) → {strands: {k: {L, W, states, ops, box}}, errors}
//   checkStrands(script) → the plan's strand errors (a place that is not on the strand, a bend that would cross it)
//   strandKit() → the film's runtime helpers (the same code the checks run), as a function to embed in a program

export const OPS = ['bend', 'coil', 'ring', 'knot', 'twist', 'thread', 'straighten']
export const STRAND_LENGTH = { bend: 2.4, coil: 3.6, ring: 3.0, knot: 3.2, twist: 3.8, thread: 2.0, straighten: 1.8 }
export const strandOp = (a) => { const o = String(a?.op ?? a?.intent ?? '').toLowerCase().trim(); return OPS.find((x) => o === x || o.startsWith(`${x} `)) || null }
export const strandLength = (a) => {
  const op = strandOp(a) || 'bend'
  return op === 'thread' ? 1.6 + 0.35 * Math.min(12, Math.max(1, +a.n || 1)) : STRAND_LENGTH[op]
}

const TAU = Math.PI * 2
// The film draws a strand at least this thick (a wire of a millimetre would be a hairline), so geometry uses it too.
export const MIN_W = 0.8
const MAX_NODES = 2400
const list = (v) => Array.isArray(v) ? v : []
const r1 = (v) => Math.round(v * 10) / 10
const r2 = (v) => Math.round(v * 100) / 100
const r3 = (v) => Math.round(v * 1000) / 1000

// ---- the film's side: a strand's nodes from a heading profile, and one profile blended into another. This function is
// embedded in the film's program as it stands, so it uses nothing outside itself (and none of the words a program may not).
export function strandKit() {
  // (knots: [[s, h], …] with s rising; the heading at s, linear between the knots)
  const at = (k, s, hint) => {
    let i = hint && hint.i < k.length - 1 && k[hint.i][0] <= s ? hint.i : 0
    while (i < k.length - 2 && k[i + 1][0] <= s) i++
    if (hint) hint.i = i
    const a = k[i], b = k[Math.min(i + 1, k.length - 1)], w = b[0] > a[0] ? Math.min(1, Math.max(0, (s - a[0]) / (b[0] - a[0]))) : 0
    return a[1] + (b[1] - a[1]) * w
  }
  // The nodes of a strand of length L (n segments) whose heading is (1 - u) A + u B, the node at s0 held at (x0, y0).
  const nodes = (L, n, A, B, u, s0, x0, y0) => {
    const ds = L / n, xs = new Array(n + 1), ys = new Array(n + 1), ha = { i: 0 }, hb = { i: 0 }
    const heads = new Array(n)
    for (let i = 0; i < n; i++) { const s = (i + 0.5) * ds; heads[i] = u <= 0 ? at(A, s, ha) : u >= 1 ? at(B, s, hb) : (1 - u) * at(A, s, ha) + u * at(B, s, hb) }
    const m = Math.min(n, Math.max(0, Math.round(s0 / ds)))
    xs[m] = x0; ys[m] = y0
    for (let i = m; i < n; i++) { xs[i + 1] = xs[i] + ds * Math.cos(heads[i]); ys[i + 1] = ys[i] + ds * Math.sin(heads[i]) }
    for (let i = m; i > 0; i--) { xs[i - 1] = xs[i] - ds * Math.cos(heads[i - 1]); ys[i - 1] = ys[i] - ds * Math.sin(heads[i - 1]) }
    return { x: xs, y: ys, h: heads, ds }
  }
  return { at, nodes }
}
const kit = strandKit()

// ---- sizes
// Inventory cm is the strand's material length, not the diameter of its coil. A part-only
// actor can supply size[0]; when both exist, validation requires them to agree.
export function strandSize(o) {
  const s = o?.part?.size
  if (Array.isArray(s) && +s[0] > 0) return { L: +o?.cm > 0 ? +o.cm : +s[0], W: Math.max(MIN_W, +s[1] > 0 ? +s[1] : MIN_W) }
  const L = +o?.cm > 0 ? +o.cm : 30, t = +o?.thick > 0 ? +o.thick : +o?.w > 0 ? +o.w : MIN_W
  return { L, W: Math.max(MIN_W, t) }
}

// ---- the curve
function blank(L, W) {
  const N = Math.min(MAX_NODES, Math.max(60, Math.ceil(L / 0.2)))
  return { L, W, N, ds: L / N, h: new Float64Array(N), a: { i: 0, x: 0, y: 0 }, beads: [], knots: [], join: null, look: null, over: [], meta: {} }
}
const copy = (S) => ({ ...S, h: Float64Array.from(S.h), a: { ...S.a }, beads: S.beads.map((b) => ({ ...b })), knots: S.knots.map(k => ({ ...k })), over: S.over.map((p) => [...p]), meta: { ...S.meta } })
function trace(S) {
  const { N, ds, h } = S, x = new Float64Array(N + 1), y = new Float64Array(N + 1)
  x[S.a.i] = S.a.x; y[S.a.i] = S.a.y
  for (let i = S.a.i; i < N; i++) { x[i + 1] = x[i] + ds * Math.cos(h[i]); y[i + 1] = y[i] + ds * Math.sin(h[i]) }
  for (let i = S.a.i; i > 0; i--) { x[i - 1] = x[i] - ds * Math.cos(h[i - 1]); y[i - 1] = y[i] - ds * Math.sin(h[i - 1]) }
  return { x, y }
}
// The strand read from its other end (an operation that holds the end still is worked as one that holds the start).
const reversed = (S) => {
  const R = copy(S), N = S.N
  for (let i = 0; i < N; i++) R.h[i] = S.h[N - 1 - i] + Math.PI
  R.a = { i: N - S.a.i, x: S.a.x, y: S.a.y }
  R.beads = S.beads.map((b) => ({ ...b, s: S.L - b.s })).reverse()
  R.join = S.join == null ? null : S.L - S.join
  R.over = S.over.map(([a, b, z]) => [S.L - b, S.L - a, z]).reverse()
  R.knots = S.knots.map(k => ({ ...k, at: S.L - k.at }))
  return R
}
const heldAtStart = (S, hold, fn) => hold === 'end' ? reversed(fn(reversed(S))) : fn(S)
// The strand with its held node (node 0) where it was, whatever the operation did to the rest.
function keepStart(before, after) { const P = trace(before); after.a = { i: 0, x: P.x[0], y: P.y[0] }; return after }
// The held end's heading is kept by the operations (they change the part beyond); it is the frame's.

const arcAt = (S, s) => Math.round(s / S.ds)
const bounds = (P) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (let i = 0; i < P.x.length; i++) { x0 = Math.min(x0, P.x[i]); x1 = Math.max(x1, P.x[i]); y0 = Math.min(y0, P.y[i]); y1 = Math.max(y1, P.y[i]) } return [x0, y0, x1, y1] }

// Where a strand crosses itself: pairs (s of the earlier pass, s of the later), the angle they cross at. Parts less than
// a couple of thicknesses apart along the strand are one bend, not a crossing.
function crossings(S, P = trace(S)) {
  const stride = Math.max(1, Math.round(S.W * 0.3 / S.ds)), idx = []
  for (let i = 0; i < S.N; i += stride) idx.push(i)
  idx.push(S.N)
  const apart = 2.4 * S.W, out = []
  for (let a = 0; a + 1 < idx.length; a++) {
    const i = idx[a], j = idx[a + 1]
    const ax = P.x[i], ay = P.y[i], bx = P.x[j], by = P.y[j]
    for (let c = a + 2; c + 1 < idx.length; c++) {
      const k = idx[c], l = idx[c + 1]
      if ((k - j) * S.ds < apart) continue
      const cx = P.x[k], cy = P.y[k], dx = P.x[l], dy = P.y[l]
      if (Math.max(ax, bx) < Math.min(cx, dx) || Math.max(cx, dx) < Math.min(ax, bx) || Math.max(ay, by) < Math.min(cy, dy) || Math.max(cy, dy) < Math.min(ay, by)) continue
      const r = [bx - ax, by - ay], s = [dx - cx, dy - cy], den = r[0] * s[1] - r[1] * s[0]
      if (Math.abs(den) < 1e-12) continue
      const t = ((cx - ax) * s[1] - (cy - ay) * s[0]) / den, u = ((cx - ax) * r[1] - (cy - ay) * r[0]) / den
      if (t < 0 || t > 1 || u < 0 || u > 1) continue
      const sin = Math.abs(den) / (Math.hypot(...r) * Math.hypot(...s))
      if (sin < 0.12) continue
      out.push({ s1: (i + t * (j - i)) * S.ds, s2: (k + u * (l - k)) * S.ds, sin, x: ax + t * r[0], y: ay + t * r[1] })
    }
  }
  return out
}
// The stretch of the strand drawn again over the other as it passes: about the other's width, along the strand.
const patch = (S, s, sin) => { const e = Math.min(2.6 * S.W, (0.85 * S.W) / Math.max(sin, 0.3)); return [r2(Math.max(0, s - e)), r2(Math.min(S.L, s + e))] }
// What is over what, after an operation: the passes a knot placed keep their order (the strand's s is its material, so
// they stay where they are as the strand moves), every other crossing is the later pass over the earlier, and a patch
// with no crossing left under it goes.
const holds = (p, s) => s >= p[0] - 1e-6 && s <= p[1] + 1e-6
function overAfter(S, P = trace(S)) {
  const cross = crossings(S, P), keep = []
  for (const p of S.over) if (cross.some((c) => holds(p, c.s1) || holds(p, c.s2))) keep.push(p)
  for (const c of cross.sort((a, b) => a.s2 - b.s2)) if (!keep.some((p) => holds(p, c.s1) || holds(p, c.s2))) keep.push([...patch(S, c.s2, c.sin), 1])
  return keep
}

// ---- places along a strand
const NUM = '(\\d+(?:\\.\\d+)?)'
// "middle", "start", "end", "8 cm", "8 cm from the end", "a third", "40%", a number (cm from the start) → cm from the start.
export function placeOn(L, ref, fallback = null) {
  if (ref == null || ref === '') return fallback
  if (typeof ref === 'number') return Number.isFinite(ref) ? ref : fallback
  const t = String(ref).toLowerCase().replace(/centre|center/g, 'middle').trim()
  let m
  if (/^(the )?(start|beginning|first end|one end|left end|left)$/.test(t)) return 0
  if (/^(the )?(end|last end|other end|far end|right end|right)$/.test(t)) return L
  if (/^(the )?(middle|half|halfway|midpoint)( point)?$/.test(t)) return L / 2
  if ((m = t.match(new RegExp(`^${NUM}\\s*(?:cm|centimet\\w+)?\\s*(?:from|in from|away from)\\s*(?:the\\s*)?(start|beginning|left|first end|end|right|far end|other end)`)))) return /^(end|right|far|other)/.test(m[2]) ? L - +m[1] : +m[1]
  if ((m = t.match(new RegExp(`^(?:the\\s+)?(?:last|final)\\s+${NUM}\\s*(?:cm)?$`)))) return L - +m[1]
  if ((m = t.match(new RegExp(`^(?:the\\s+)?first\\s+${NUM}\\s*(?:cm)?$`)))) return +m[1]
  if ((m = t.match(new RegExp(`^${NUM}\\s*%$`)))) return (L * +m[1]) / 100
  if (/^(a |one |the )?(third|1\/3)( along)?$/.test(t)) return L / 3
  if (/^(two thirds|2\/3)$/.test(t)) return (2 * L) / 3
  if (/^(a |one |the )?(quarter|1\/4)( along)?$/.test(t)) return L / 4
  if (/^(three quarters|3\/4)$/.test(t)) return (3 * L) / 4
  if ((m = t.match(new RegExp(`^${NUM}\\s*(?:cm|centimet\\w+)?$`)))) return +m[1]
  return fallback
}
const PLACE_HELP = 'name a place along the strand: "middle", "start", "end", "6 cm from the end", "a third", "40%" or a number of cm from the start'

// ---- operations. Each takes the strand as it is and what the plan says; each returns the strand after it, with
// meta.mark = where it happens (cm) and meta.angle for a bend. Errors are messages for the plan's repair.

// Bend the part beyond `at` by `deg` (positive to the right as one walks from the start), as a curve of radius r.
function bendAt(S, at, deg, radius) {
  const theta = (deg * Math.PI) / 180, r = radius, arc = r * Math.abs(theta)
  const i0 = arcAt(S, at - arc / 2), i1 = Math.max(i0 + 1, arcAt(S, at + arc / 2))
  if (i0 < 0 || i1 > S.N) throw new Error(`the bend (radius ${r2(r)} cm) does not fit ${r1(at)} cm from the held end: it needs ${r1(arc / 2)} cm either side`)
  const T = copy(S)
  for (let i = i0; i < i1; i++) T.h[i] += (theta * (i - i0 + 0.5)) / (i1 - i0)
  for (let i = i1; i < S.N; i++) T.h[i] += theta
  T.meta.mark = [at]; T.meta.angle = Math.abs(deg)
  return keepStart(S, T)
}

// Coil the strand from `from` to its end into a flat spiral: wound inward, turns touching, `r0` the hole at the middle.
function coilFrom(S, from, side, r0) {
  const pitch = S.W * 1.08, ell = S.L - from
  if (ell < TAU * r0 * 1.2) throw new Error(`${r1(ell)} cm is too short to coil: it is under one turn round a ${r1(r0 * 2)} cm hole`)
  const R = Math.sqrt(r0 * r0 + (ell * pitch) / Math.PI), i0 = arcAt(S, from), T = copy(S), dir = side === 'left' ? -1 : 1
  let phi = 0
  const base = i0 > 0 ? T.h[i0 - 1] : 0
  for (let i = i0; i < S.N; i++) {
    const r = Math.max(S.W * 0.55, R - (pitch * phi) / TAU), dphi = S.ds / r
    T.h[i] = base + dir * (phi + dphi / 2); phi += dphi
  }
  const rEnd = Math.max(S.W * 0.55, R - (pitch * phi) / TAU)
  T.meta.recentre = true; T.meta.mark = [from + ell / 2]; T.meta.turns = r2(phi / TAU); T.meta.diameter = r1(2 * R); T.meta.hole = r1(2 * rEnd)
  return keepStart(S, T)
}

// Bring the ends together into a ring of what is left once `overlap` cm is taken: the last stretch lies over the first.
function ringOf(S, overlap, side) {
  const C = S.L - overlap, R = C / TAU, dir = side === 'left' ? -1 : 1
  if (R < S.W * 1.2) throw new Error(`a ring of ${r1(C)} cm round (${r1(2 * R)} cm across) is smaller than the ${r1(S.W)} cm strand allows: use a longer strand or a smaller overlap`)
  if (overlap < 0 || overlap > S.L * 0.5) throw new Error(`the overlap of a ring is between 0 and half the strand, not ${overlap} cm`)
  const T = copy(S)
  for (let i = 0; i < S.N; i++) {
    const s = (i + 0.5) * S.ds
    T.h[i] = (dir * Math.min(s, C)) / R
  }
  // (the overlapping end leaves the circle in a straight line, over the start)
  const iC = arcAt(S, C)
  for (let i = iC; i < S.N; i++) T.h[i] = dir * (C / R) + dir * (((i - iC + 0.5) * S.ds) / (R * 4))
  T.join = C; T.meta.recentre = true; T.meta.mark = [C]; T.meta.circumference = r1(C); T.meta.diameter = r1(2 * R)
  return keepStart(S, T)
}

// ---- knots: a closed knot diagram (a trefoil, a knot) opened at the tip of a lobe and laid in the strand.
const KNOTS = {
  overhand: { loose: 0.7, names: /^(an? )?(overhand|simple|single|stopper|thumb)( knot)?$/, t: (t) => [Math.sin(t) + 2 * Math.sin(2 * t), Math.cos(t) - 2 * Math.cos(2 * t), -Math.sin(3 * t)] },
  'figure-eight': { loose: 0.7, names: /^(an? )?(figure[- ]?(of[- ])?(8|eight|four)|flemish)( knot)?$/, t: (t) => [(2 + Math.cos(2 * t)) * Math.cos(3 * t), (2 + Math.cos(2 * t)) * Math.sin(3 * t), Math.sin(4 * t)] },
}
export const KNOT_NAMES = Object.keys(KNOTS)
const knotFor = (name) => Object.entries(KNOTS).find(([k, v]) => k === String(name).toLowerCase().trim() || v.names.test(String(name).toLowerCase().trim()))
const templates = new Map()
// The knot's path in the strand's own frame for a strand W thick: its headings along its arc, the arc's length, and the
// z of every point (which pass is over). Opened at the tip of a lobe, scaled so no bend is tighter than the strand can
// make and the two ends it is opened at are clear of each other by a thickness and a quarter.
function knotTemplate(key, W) {
  const id = `${key}:${W}`
  if (templates.has(id)) return templates.get(id)
  const f = KNOTS[key].t, M = 1440
  let tip = 0, far = -1
  for (let i = 0; i < M; i++) { const [x, y] = f((i / M) * TAU); if (Math.hypot(x, y) > far + 1e-9) { far = Math.hypot(x, y); tip = i } }
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1])
  const arcOf = (cut) => { const pts = []; for (let i = cut; i <= M - cut; i++) pts.push(f(((tip + i) / M) * TAU)); return pts }
  const lengths = (P) => { const s = [0]; for (let i = 1; i < P.length; i++) s.push(s[i - 1] + dist(P[i], P[i - 1])); return s }
  // how tight the knot bends: the tenth percentile of the circle through three samples a few apart (one sharp spot is not
  // what sets its size)
  const radius = (P) => {
    const r = []
    for (let i = 6; i < P.length - 6; i += 3) {
      const a = P[i - 6], b = P[i], c = P[i + 6], area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2
      if (area > 1e-9) r.push((dist(a, b) * dist(b, c) * dist(a, c)) / (4 * area))
    }
    return r.sort((x, y) => x - y)[Math.floor(r.length * 0.1)]
  }
  const rmin = radius(arcOf(0)), k = (KNOTS[key].loose * W) / rmin
  // the cut that leaves the ends a thickness and a quarter apart at that scale
  let cut = 4, pts = arcOf(cut)
  while (cut < 200 && dist(pts[0], pts[pts.length - 1]) * k < 1.25 * W) { cut += 2; pts = arcOf(cut) }
  const P = pts.map(([x, y, z]) => [x * k, y * k, z]), S = lengths(P)
  // headings along the arc, unwrapped, from the first one; sampled at 0.1 W
  const K = S[S.length - 1], n = Math.max(24, Math.ceil(K / (W * 0.1))), heads = [], zs = []
  let prev = null, lo = 0
  for (let i = 0; i < n; i++) {
    const u = ((i + 0.5) / n) * K
    while (lo < S.length - 2 && S[lo + 1] < u) lo++
    const w = Math.min(1, Math.max(0, (u - S[lo]) / Math.max(1e-9, S[lo + 1] - S[lo]))), a = P[lo], b = P[lo + 1]
    let ang = Math.atan2(b[1] - a[1], b[0] - a[0])
    if (prev != null) { while (ang - prev > Math.PI) ang -= TAU; while (ang - prev < -Math.PI) ang += TAU }
    heads.push(ang); prev = ang
    zs.push(a[2] + (b[2] - a[2]) * w)
  }
  const out = { K, n, heads: heads.map((v) => v - heads[0]), zs, step: K / n }
  templates.set(id, out)
  return out
}

function knotIn(S, at, name) {
  const found = knotFor(name)
  if (!found) throw new Error(`a knot called "${name}" cannot be drawn: the knots are ${KNOT_NAMES.join(', ')}`)
  const T0 = knotTemplate(found[0], S.W), room = T0.K / 2 + 1.5 * S.W
  if (S.L < 2 * room) throw new Error(`the ${found[0]} knot in a ${r1(S.W)} cm strand takes ${r1(T0.K)} cm, and the strand is only ${r1(S.L)} cm: it needs at least ${r1(T0.K + 3 * S.W)} cm`)
  // (a knot "at the end" is tied as near it as the knot allows, with a short tail left)
  const requested = at
  at = Math.min(S.L - room, Math.max(room, at))
  const i0 = arcAt(S, at - T0.K / 2), i1 = i0 + Math.max(1, arcAt(S, T0.K))
  const T = copy(S), base = i0 > 0 ? S.h[i0 - 1] : 0, zOf = new Float64Array(S.N)
  for (let i = i0; i < i1; i++) {
    const j = Math.min(T0.n - 1, Math.floor(((i - i0 + 0.5) * S.ds) / T0.step))
    T.h[i] = base + T0.heads[j]; zOf[i] = T0.zs[j]
  }
  // (opened at a lobe's tip the knot's far end heads off at an angle to its near end: the strand turns back by it over
  // a few thicknesses, so what follows the knot runs the way what came before it did)
  const end = T0.heads[T0.n - 1], kink = end - TAU * Math.round(end / TAU), back = Math.max(1, arcAt(S, 5 * S.W))
  const shift = base + end - (i1 < S.N ? S.h[i1] : 0)
  for (let i = i1; i < S.N; i++) T.h[i] = S.h[i] + shift - kink * Math.min(1, (i - i1 + 0.5) / back)
  const P = trace(keepStart(S, T)), before = crossings(S), found2 = crossings(T, P).filter((c) => !before.some((b) => Math.hypot(b.s1 - c.s1, b.s2 - c.s2) < 0.5))
  // the knot's own crossings follow its z (the strand either side lies under it); a crossing further out is not a knot's
  const near = (s) => s >= (i0 - 4 * S.W / S.ds) * S.ds && s <= (i1 + back + 4 * S.W / S.ds) * S.ds
  const bad = found2.filter((c) => !near(c.s1) || !near(c.s2))
  if (bad.length) {
    const positions = `Requested centre ${r1(requested)} cm from the start; effective centre ${r1(at)} cm${Math.abs(requested - at) > 1e-6 ? ' (clamped to leave room for the knot and tail)' : ''}. Allowed centre range for this template is ${r1(room)}–${r1(S.L - room)} cm. Moving within the clamped end region gives the same knot position.`
    const material = S.knots.reduce((sum, k) => sum + k.length, T0.K), minimum = material + 3 * S.W
    const budget = S.knots.length ? `knot spacing: ${S.knots.length} existing knot(s) plus this ${found[0]} use ${r1(material)} cm of material in the renderer templates (${r1(T0.K)} cm for this knot). With ${r1(3 * S.W)} cm for the two outer tails, the material budget needs at least ${r1(minimum)} cm before adding any central grip; available strand length is ${r1(S.L)} cm. This is a renderer-template requirement, not a physical knot feasibility measurement; sufficient material alone does not guarantee that these curves fit.` : `This renderer template uses ${r1(T0.K)} cm of material for this knot in a ${r1(S.W)} cm thick strand.`
    throw new Error(`the ${found[0]} knot would lie across the rest of the strand. ${budget} ${positions} Change the design to fewer knots or a supported arrangement with adequate free material. Do not repeat ineffective position edits or change published inventory length/thickness to hide the conflict; keep the design and captions faithful to the revised operations.`)
  }
  const zAt = (s) => { const i = Math.min(S.N - 1, Math.max(0, Math.round(s / S.ds))); return i >= i0 && i < i1 ? zOf[i] : -5 }
  T.over = [...S.over.filter((p) => !(p[1] > i0 * S.ds && p[0] < i1 * S.ds)), ...found2.map((c) => {
    const z1 = zAt(c.s1), z2 = zAt(c.s2), upper = z2 >= z1 ? c.s2 : c.s1
    return [...patch(S, upper, c.sin), Math.max(z1, z2)]
  }).sort((p, q) => p[2] - q[2])]
  T.meta.span = [at - T0.K / 2 - 2 * S.W, at + T0.K / 2 + 2 * S.W]; T.meta.mark = [at]; T.meta.knot = found[0]; T.meta.crossings = found2.length; T.meta.size = r1(T0.K)
  T.knots.push({ at, length: T0.K, name: found[0] })
  return T
}

// ---- beads on the strand
const COLORS = { red: '#d64545', blue: '#3b6fd6', green: '#3f9c5a', yellow: '#f0c33c', orange: '#ee8a2f', purple: '#8d5bc7', pink: '#ec7fb0', white: '#f6f4ee', black: '#2b2b30', brown: '#8a5a38', grey: '#9aa0a8', gray: '#9aa0a8', silver: '#c5cad2', gold: '#d9aa3a', teal: '#2f9a9a', turquoise: '#3ab5b0', clear: '#dcecf5' }
export const colorOf = (word) => {
  const t = String(word || '').toLowerCase().trim()
  if (/^#[0-9a-f]{6}$/.test(t)) return t
  const hit = Object.keys(COLORS).find((c) => new RegExp(`\\b${c}\\b`).test(t))
  return hit ? COLORS[hit] : null
}
function threadOn(S, a) {
  const n = Math.round(+a.n), d = +a.cm > 0 ? +a.cm : Math.max(S.W * 1.8, 1), gap = +a.gap > 0 ? +a.gap : 0
  if (!(n >= 1)) throw new Error('threading beads needs "n", how many')
  if (d < S.W * 1.1) throw new Error(`beads ${r1(d)} cm across cannot slide on a ${r1(S.W)} cm strand: "cm" is the bead's diameter, larger than the strand`)
  const block = n * d + (n - 1) * gap, centre = placeOn(S.L, a.at, S.L / 2)
  const s0 = centre - block / 2
  if (s0 < -1e-6 || s0 + block > S.L + 1e-6) throw new Error(`${n} beads of ${r1(d)} cm take ${r1(block)} cm along the strand, which does not fit round ${r1(centre)} cm of its ${r1(S.L)} cm`)
  const cols = String(a.color || '').split(/,|\band\b|\bthen\b/).map(colorOf).filter(Boolean), pal = cols.length ? cols : [colorOf('red')]
  const T = copy(S)
  for (let j = 0; j < n; j++) T.beads.push({ s: r2(s0 + d / 2 + j * (d + gap)), r: r2(d / 2), c: pal[j % pal.length] })
  if (T.beads.length > 400) throw new Error('too many beads for the film to carry')
  T.meta.mark = [centre]; T.meta.fresh = n; T.meta.bead = r2(d)
  return T
}

// ---- a cord: a strand folded in half and twisted; the folded halves become one cord of the shorter length that twisting leaves
function twistPair(S, a) {
  const P = trace(S), sf = S.meta.fold
  if (sf == null) throw new Error('twist needs a strand folded in half first: bend it 180° in the middle, then twist it')
  const ell = Math.min(sf, S.L - sf), tol = Math.max(1.5, S.L * 0.06)
  if (Math.abs(sf - S.L / 2) > tol) throw new Error(`twist works on a strand folded in half: it is folded ${r1(sf)} cm along its ${r1(S.L)} cm, not in the middle`)
  // the halves must still lie side by side along their length
  let worst = 0
  for (let d = 1.5 * S.W; d <= ell - 0.5; d += Math.max(0.3, S.W / 2)) {
    const p = Math.round((sf - d) / S.ds), q = Math.round((sf + d) / S.ds)
    worst = Math.max(worst, Math.hypot(P.x[p] - P.x[q], P.y[p] - P.y[q]))
  }
  if (worst > S.W * 2.2) throw new Error('twist works on a strand folded in half with its halves lying side by side: it was bent again after folding')
  const n = +a.n > 0 ? +a.n : Math.max(2, Math.round(ell / (3.2 * S.W))), maxTurns = ell / (Math.PI * S.W)
  if (n >= maxTurns) throw new Error(`${n} turns are too many for a ${r1(ell)} cm doubled strand ${r1(S.W)} cm thick: at most ${Math.floor(maxTurns - 0.001)}`)
  const c = Math.sqrt(ell * ell - (Math.PI * S.W * n) ** 2)
  // the fold's tip is where the cord starts; it runs the way the halves go
  const f = Math.round(sf / S.ds), dir = Math.atan2(P.y[f + Math.round(ell / 2 / S.ds)] - P.y[f], P.x[f + Math.round(ell / 2 / S.ds)] - P.x[f])
  const mid = [(P.x[Math.max(0, f - Math.round(S.W / S.ds))] + P.x[Math.min(S.N, f + Math.round(S.W / S.ds))]) / 2, (P.y[Math.max(0, f - Math.round(S.W / S.ds))] + P.y[Math.min(S.N, f + Math.round(S.W / S.ds))]) / 2]
  const tip = [P.x[f], P.y[f]]
  const C = blank(c, S.W * 2 * 0.92)
  for (let i = 0; i < C.N; i++) C.h[i] = dir
  C.a = { i: 0, x: tip[0] + Math.cos(dir) * 0, y: tip[1] + Math.sin(dir) * 0 }
  C.look = { twist: { n, w: r2(S.W), c: r2(c), ell: r2(ell) } }
  C.meta = { mark: [0], turns: n, length: r1(c), take: r1(ell - c), from: { sf: r2(sf), ell: r2(ell), tip: [r2(tip[0]), r2(tip[1])], mid: [r2(mid[0]), r2(mid[1])], dir: r3(dir) } }
  return C
}

// ---- applying an act to a state
function apply(S, a) {
  const op = strandOp(a)
  if (!op) throw new Error(`a strand operation is one of ${OPS.join(', ')}, as "op"`)
  const side = String(a.side || '').toLowerCase()
  const need = (v, what) => { if (v == null) throw new Error(`${op}: ${what}`); return v }
  const finish = (T) => { if (op !== 'knot') T.over = overAfter(T); return T }
  if (op === 'bend') {
    const at = need(placeOn(S.L, a.at), `"at" ${PLACE_HELP}`)
    if (!(at > 0 && at < S.L)) throw new Error(`bend: ${r1(at)} cm is not along the strand's ${r1(S.L)} cm: ${PLACE_HELP}`)
    let deg = +a.deg
    if (!Number.isFinite(deg) || deg === 0) throw new Error('bend needs "deg", the angle it is bent through (positive to the right walking from the start, negative to the left)')
    if (side === 'left') deg = -Math.abs(deg); else if (side === 'right') deg = Math.abs(deg)
    if (Math.abs(deg) > 180.01) throw new Error('bend: at most 180° at a time (two bends make more)')
    const radius = +a.radius > 0 ? +a.radius : Math.max(S.W * 0.6, 0.35)
    if (radius < S.W * 0.5) throw new Error(`bend: radius ${r2(radius)} cm is under half the ${r1(S.W)} cm strand's thickness`)
    // the shorter side moves
    const hold = String(a.hold || '').toLowerCase() === 'start' ? 'start' : String(a.hold || '').toLowerCase() === 'end' ? 'end' : at >= S.L - at ? 'start' : 'end'
    const T = heldAtStart(S, hold, (X) => bendAt(X, hold === 'end' ? S.L - at : at, hold === 'end' ? -deg : deg, radius))
    // (read from the other end the strand turns the other way: -deg, then back again)
    const P = trace(T)
    if (crossings(T, P).length > crossings(S).length) throw new Error(`bend: ${Math.abs(deg)}° ${r1(at)} cm along would make the strand cross itself: bend it less, or tie a knot`)
    if (Math.abs(Math.abs(deg) - 180) < 6) T.meta.fold = at
    else T.meta.fold = null
    T.meta.hold = hold; T.meta.dist = r1(hold === 'start' ? S.L - at : at)
    return finish(T)
  }
  if (op === 'coil') {
    const length = +a.cm > 0 ? +a.cm : S.L
    if (length > S.L + 1e-6) throw new Error(`coil: ${r1(length)} cm is more than the strand's ${r1(S.L)} cm`)
    const hold = String(a.hold || '').toLowerCase() === 'end' ? 'end' : 'start'
    const r0 = +a.radius > 0 ? +a.radius : Math.max(S.W * 0.9, 0.7)
    const T = heldAtStart(S, hold, (X) => coilFrom(X, X.L - length, side, r0))
    if (+a.n > 0 && Math.abs(T.meta.turns - +a.n) > Math.max(0.6, +a.n * 0.15)) throw new Error(`coil: ${r1(length)} cm of a ${r1(S.W)} cm strand makes ${T.meta.turns} turns round a ${r1(r0 * 2)} cm hole, not ${a.n}: change "n" or the length wound`)
    T.meta.fold = null; T.meta.hold = hold; T.meta.wound = r1(length)
    return finish(T)
  }
  if (op === 'ring') {
    const overlap = +a.cm >= 0 && a.cm != null && a.cm !== '' ? +a.cm : Math.min(3, S.L * 0.1)
    const T = ringOf(S, overlap, side)
    T.meta.fold = null; T.meta.hold = 'start'; T.meta.overlap = r1(overlap)
    return finish(T)
  }
  if (op === 'knot') {
    const at = need(placeOn(S.L, a.at, S.L / 2), `"at" ${PLACE_HELP}`)
    const T = knotIn(S, at, need(a.name ?? a.knot, '"name" is the knot: ' + KNOT_NAMES.join(', ')))
    T.meta.fold = null; T.meta.hold = 'start'
    return finish(T)
  }
  if (op === 'thread') { const T = threadOn(S, a); T.meta.fold = S.meta.fold; T.meta.hold = 'start'; return finish(T) }
  if (op === 'twist') {
    if (S.beads.length) throw new Error('twist: thread the beads after twisting, not before')
    return twistPair(S, a)
  }
  if (op === 'straighten') {
    const T = copy(S)
    T.h.fill(S.h[0]); T.join = null; T.over = []; T.knots = []
    T.meta = { mark: [S.L / 2], hold: 'start', fold: null }
    return keepStart(S, T)
  }
  throw new Error(`unknown strand operation ${op}`)
}

// ---- the film's data: a state as a heading profile (piecewise linear, few knots), what rides on it
function profile(S) {
  const knots = [], tol = 0.0015, ds = S.ds
  // greedy: extend a linear piece while every heading stays within tol of it
  let i = 0
  const heads = Array.from(S.h)
  knots.push([0, heads[0]])
  while (i < heads.length - 1) {
    let j = i + 1
    const s0 = (i + 0.5) * ds
    let slope = 0
    for (; j < heads.length; j++) {
      slope = (heads[j] - heads[i]) / ((j - i) * ds)
      let ok = true
      for (let m = i + 1; m < j; m++) if (Math.abs(heads[i] + slope * (m - i) * ds - heads[m]) > tol) { ok = false; break }
      if (!ok) { j--; break }
    }
    j = Math.min(j, heads.length - 1)
    if (j <= i) j = i + 1
    knots.push([r3((j + 0.5) * ds), r3(heads[j])])
    i = j
    void s0
  }
  knots[0] = [0, r3(heads[0])]
  if (knots[knots.length - 1][0] < S.L) knots.push([r3(S.L), knots[knots.length - 1][1]])
  return knots
}
// The strand's nodes as the film makes them from a state's profile (the same code), for the checks and the bounds.
export function nodesOf(L, N, knots, anchor, from = knots, u = 1) { return kit.nodes(L, N, from, knots, u, anchor.s, anchor.x, anchor.y) }

const exportState = (S) => ({ k: profile(S), over: S.over.filter((p) => p[1] - p[0] > 0.05), beads: S.beads, join: S.join == null ? null : r2(S.join), look: S.look, meta: S.meta })

// ---- every strand's states, in the order the steps make them
export function runStrands(script) {
  const objects = new Map([...list(script?.objects), ...list(script?.makes)].filter((o) => o && typeof o.k === 'string').map((o) => [o.k, o]))
  const cuts = new Map(list(script?.steps).flatMap((s) => list(s?.do)).filter((a) => a?.v === 'cut' && typeof a.k === 'string' && !a.shape)
    .flatMap((a) => list(a.into).filter((p) => typeof p?.k === 'string').map((p) => [p.k, { from: a.k, cm: +p.cm }])))
  const acts = list(script?.steps).flatMap((s, i) => list(s?.do).map((a) => ({ a, step: i }))).filter(({ a }) => a?.v === 'strand')
  const strands = {}, errors = [], current = {}, checked = new Set()
  // Check the stock as well as any cut strand worked later. Changing captions or the
  // design alone must not leave a second material length in the animation geometry.
  const checkLength = (k) => {
    if (checked.has(k)) return
    checked.add(k)
    const o = objects.get(k), c = cuts.get(k), size = o?.part?.size
    if (o && +o.cm > 0 && +size?.[0] > 0 && Math.abs(o.cm - size[0]) > 1e-6)
      errors.push(`${k}: strand length mismatch: inventory cm is ${o.cm} cm but part.size[0] is ${size[0]} cm. Keep inventory cm unchanged and set part.size[0] to the same material length; update the design and instructions to use it. Coil diameter is a finished dimension, not material length.`)
    if (c) checkLength(c.from)
    const length = o ? strandSize(o).L : c?.cm
    for (const p of list(script?.design?.parts)) if (p?.k === k && +p.cm > 0 && length > 0 && Math.abs(p.cm - length) > 1e-6)
      errors.push(`${k}: strand length mismatch: design.parts gives ${p.cm} cm but the actor has ${length} cm. Use the actor's material length, or declare and show a cut with a distinct output key.`)
  }
  acts.forEach(({ a }) => checkLength(a.k))
  if (errors.length) return { strands, errors, final: current }
  const sizeOf = (k, seen = new Set()) => {
    if (objects.has(k)) return strandSize(objects.get(k))
    const c = cuts.get(k)
    if (!c || seen.has(k)) return null
    const parent = sizeOf(c.from, new Set([...seen, k]))
    return parent && c.cm > 0 ? { L: Math.min(c.cm, parent.L), W: parent.W } : null
  }
  for (const [index, { a, step }] of acts.entries()) {
    const label = `step ${step + 1}${a.id ? ` (${a.id})` : ''}`
    const size = typeof a.k === 'string' ? sizeOf(a.k) : null
    if (!size) { errors.push(`${label}: a strand operation needs one strand: an object of the photo, or a piece cut from one with its "cm" (the key it was cut into)`); continue }
    if (!current[a.k]) {
      const S0 = blank(size.L, size.W)
      current[a.k] = S0
      strands[a.k] = { L: r2(size.L), W: r2(size.W), N: S0.N, states: [exportState(S0)], anchors: [{ s: 0, x: 0, y: 0 }], ops: {}, boxes: [] }
    }
    try {
      const before = current[a.k], T = apply(before, a), id = a.id || `strand-${index}`
      const P0 = trace(before), box0 = bounds(P0)
      // A coil or a ring winds up where the strand lay: its middle is the strand's middle, and the film moves the held end
      // there as it winds (hold0 where that end was, hold where it ends up).
      const hold0 = { s: T.a.i * T.ds, x: P0.x[T.a.i], y: P0.y[T.a.i] }
      if (T.meta.recentre) {
        const box1 = bounds(trace(T))
        T.a.x += (box0[0] + box0[2]) / 2 - (box1[0] + box1[2]) / 2; T.a.y += (box0[1] + box0[3]) / 2 - (box1[1] + box1[3]) / 2
      }
      // (the held node: s of the node, its place — the film blends one profile into the next about it)
      const hold = { s: T.a.i * T.ds, x: T.a.x, y: T.a.y }
      // the twist builds a new, shorter cord: no blending between the two
      const cord = !!T.look?.twist && T.L !== before.L
      const P = trace(T), out = strands[a.k]
      // bounds of the strand through the operation (sampled): the film frames the step on them
      const box = [], sample = (S, Q) => box.push(bounds(Q))
      sample(before, P0); sample(T, P)
      if (!cord) for (const u of [0.25, 0.5, 0.75]) {
        const n = kit.nodes(T.L, T.N, profile(before), profile(T), u, hold.s, hold0.x + (hold.x - hold0.x) * u, hold0.y + (hold.y - hold0.y) * u)
        box.push(bounds(n))
      }
      // (a knot's own stretch of it, for the close-up: the knot and a couple of thicknesses either side)
      const own = strandOp(a) === "knot" && T.meta.span ? bounds({ x: P.x.slice(Math.max(0, arcAt(T, T.meta.span[0])), arcAt(T, T.meta.span[1]) + 1), y: P.y.slice(Math.max(0, arcAt(T, T.meta.span[0])), arcAt(T, T.meta.span[1]) + 1) }) : null
      out.states.push(exportState(T)); out.anchors.push(hold)
      const st = exportState(T)
      out.ops[id] = { state: out.states.length - 1, cord, hold: { s: r2(hold.s), x: r2(hold.x), y: r2(hold.y) }, hold0: { s: r2(hold0.s), x: r2(hold0.x), y: r2(hold0.y) }, op: strandOp(a), step,
        mark: T.meta.mark, angle: T.meta.angle ?? null, turns: T.meta.turns ?? null, diameter: T.meta.diameter ?? null, size: T.meta.size ?? null, hole: T.meta.hole ?? null,
        take: T.meta.take ?? null, length: T.meta.length ?? null, fresh: T.meta.fresh ?? null, bead: T.meta.bead ?? null, dist: T.meta.dist ?? null, wound: T.meta.wound ?? null, overlap: T.meta.overlap ?? null, circumference: T.meta.circumference ?? null, knot: T.meta.knot ?? null, closeup: own, hold_side: T.meta.hold ?? null, bounds: box }
      void st
      current[a.k] = T
    } catch (e) {
      errors.push(`${label}: ${e.message}`)
    }
  }
  return { strands, errors, final: current }
}

export const MAX_KNOTS = 4000
// Finished planar envelope in material coordinates, including tube thickness and beads.
// The rigid layout retains the original straight stock; size checks need the worked curve.
export function finalStrandBounds(script) {
  const { final, errors } = runStrands(script), boxes = {}
  if (errors.length) return { bounds: boxes, errors }
  for (const [k, S] of Object.entries(final)) {
    const nd = trace(S), box = bounds(nd), r = S.W / 2
    const min = [box[0] - r, box[1] - r], max = [box[2] + r, box[3] + r]
    let height = S.W
    for (const bead of S.beads) {
      const i = Math.min(S.N, Math.max(0, arcAt(S, bead.s)))
      min[0] = Math.min(min[0], nd.x[i] - bead.r); max[0] = Math.max(max[0], nd.x[i] + bead.r)
      min[1] = Math.min(min[1], nd.y[i] - bead.r); max[1] = Math.max(max[1], nd.y[i] + bead.r)
      height = Math.max(height, bead.r * 2)
    }
    boxes[k] = { min, max, size: [max[0] - min[0], max[1] - min[1], height] }
  }
  return { bounds: boxes, errors }
}

export const checkStrands = (script) => {
  const { strands, errors } = runStrands(script)
  for (const [k, S] of Object.entries(strands)) {
    const knots = S.states.reduce((n, s) => n + s.k.length + s.beads.length, 0)
    if (knots > MAX_KNOTS) errors.push(`${k}: its bends, coils and beads make too much for the film to carry (${knots} points, at most ${MAX_KNOTS}): fewer beads or fewer operations`)
  }
  return errors
}

// (for the tests and the plots that check them)
export const internals = { knotTemplate, trace, crossings, blank, apply, copy }
