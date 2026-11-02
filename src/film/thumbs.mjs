// Catalogue thumbnails: each finished thing drawn from a compact spec ("look") in a few milliseconds, the same code in
// the browser (served as /thumbs.js) and in Node (tests, on the recording canvas). No imports, no fetches, no images.
//
// A look is a list of solids in centimetres, x to the right, y away from the viewer, z up; each is placed by the
// corner of its bounding box nearest the origin (left, front, bottom):
//   {s:"box",  p:[x,y,z], d:[w,d,h], c:"#rrggbb", m?:mark}            a block, a board, a book, a slab
//   {s:"cyl",  p, d, c, axis?:"z|x|y", open?, f?:"#contents", m?}      a can, a dowel, a pot, a coaster, a roll
//   {s:"cone", p, d, c, t:top/bottom width, axis?, open?, f?, m?}      a bowl (t > 1), a cup, a lampshade, a cone
//   {s:"ball", p, d, c, m?}                                            a yarn ball, a fruit, a bun, a knob
//   {s:"rope", p, d, c, t:thickness, form?}                         a length of rope, cord, wire or ribbon of thickness t cm, running
//                                                                  through its box in a form: "straight" (along the longest side),
//                                                                  "ring" (a loop lying flat: a ring, a hoop toy, a napkin ring), "hoop" (a loop
//                                                                  standing up, in the x–z plane: a hanger, a wreath, a swing's ring), "arch" (a half
//                                                                  loop standing on its ends: a handle, a bow), "knot" (a knot tied in it: a knot ball's loops)
//   {s:"brick",p, d:[studs across, studs deep, plates], c}             a toy brick on its stud grid (0.8 cm a stud)
// Any solid may add r:[about x, about y, about z] in degrees, turned about its box's middle (a roof's pitch, a board
// leaning, a lid ajar).
// m (marks): "grain" (lines along a board), "rings" (rounds on a coaster, end grain), "dots" (beans, seeds,
// sprinkles), "stripes" (rows, wound yarn), "coil" (rope, cord or cable wound round: turns of it on the face, rows
// round the side — a rope mat, a coiled basket; "rings" is a tree slice). open: a vessel whose inside shows; f: what fills it.
// The picture is an orthographic three-quarter view, flat-shaded in three tones with ink outlines, like the films.

export const SHAPES = ['box', 'cyl', 'cone', 'ball', 'brick', 'prism', 'rope']
export const ROPE_FORMS = ['straight', 'ring', 'hoop', 'arch', 'knot']
export const MARKS = ['grain', 'rings', 'dots', 'stripes', 'coil']
export const MAX_SOLIDS = 32
// (a rope's turns: about this thick, so a 4 cm mat is two turns high, a 12 cm basket six)
const ROPE_BANDS = (len) => Math.max(2, Math.min(10, Math.round(len / 2)))
const STUD = 0.8, PLATE = 0.32, INK = '#1d2b4f', NEUTRAL = '#c8b89a'
const AZ = (32 * Math.PI) / 180, EL = (24 * Math.PI) / 180
// screen right, screen up, towards the viewer; the light comes from the upper left, in front
const R = [Math.cos(AZ), Math.sin(AZ), 0]
const U = [-Math.sin(AZ) * Math.sin(EL), Math.cos(AZ) * Math.sin(EL), Math.cos(EL)]
const V = [Math.sin(AZ) * Math.cos(EL), -Math.cos(AZ) * Math.cos(EL), Math.sin(EL)]
const L = norm([-0.45, -0.6, 0.66])

function norm(a) { const n = Math.hypot(...a) || 1; return a.map((x) => x / n) }
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k]
const screen = (q) => [dot(q, R), -dot(q, U)]
const finite = (n) => typeof n === 'number' && Number.isFinite(n)

// ---- the spec, made safe: whatever a model wrote, what is drawn is bounded and well formed ----
const colour = (c) => {
  if (typeof c !== 'string') return null
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim())
  if (!m) return null
  const h = m[1].length === 3 ? [...m[1]].map((x) => x + x).join('') : m[1]
  return `#${h.toLowerCase()}`
}
// A short key's value run into a key of its own, whatever that key's value — Meta writes "o':[[0,1],[1,1],[0.5,0]]},{"
// with null, "o': [[0.5,0],[1,0.45],…],": [0,0], and several in one key, "axis':'z'  ,'o': [[…]]}]  ," — read back from
// that key's text: what follows the name and its colon. Only keys that are not a solid's own are read.
const OWN = new Set(['s', 'p', 'd', 'c', 'axis', 't', 'open', 'f', 'm', 'r', 'o'])
const glued = (raw, names) => {
  for (const k of Object.keys(raw)) {
    if (OWN.has(k)) continue
    const m = new RegExp(`(?:^|[^\\w])(?:${names})['"]?\\s*:\\s*(.+)$`, 's').exec(k)
    if (m) return m[1]
  }
  return null
}
const gluedPoints = (raw) => {
  const text = glued(raw, 'o|outline|polygon|points'), m = text && /\[\s*\[[-\d.,\s\[\]eE+]*\]\s*\]/.exec(text)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch { return null }
}
const gluedWord = (raw, name, allowed) => { const w = (/^[\s'"]*([#\w.]+)/.exec(glued(raw, name) || '') || [])[1]; return w && (!allowed || allowed.includes(w)) ? w : null }
// An outline that crosses itself (a bow tie: its corners in the wrong order) encloses nothing: its points taken round
// their middle instead.
const crosses = (o) => o.some((a, i) => o.some((c, j) => {
  if (Math.abs(i - j) < 2 || (i === 0 && j === o.length - 1) || (j === 0 && i === o.length - 1)) return false
  const b = o[(i + 1) % o.length], e = o[(j + 1) % o.length], side = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
  return side(a, b, c) * side(a, b, e) < 0 && side(c, e, a) * side(c, e, b) < 0
}))
const untangled = (o) => {
  if (!crosses(o)) return o
  const m = [o.reduce((s, q) => s + q[0], 0) / o.length, o.reduce((s, q) => s + q[1], 0) / o.length]
  return [...o].sort((a, b) => Math.atan2(a[1] - m[1], a[0] - m[0]) - Math.atan2(b[1] - m[1], b[0] - m[0]))
}
export function checkLook(look) {
  const problems = [], solids = []
  if (!Array.isArray(look)) return { look: [], problems: ['look is not a list'] }
  for (const [i, raw] of look.entries()) {
    if (solids.length >= MAX_SOLIDS) { problems.push(`more than ${MAX_SOLIDS} solids: the rest left out`); break }
    const s = raw?.s, label = `solid ${i + 1}`
    if (!SHAPES.includes(s)) { problems.push(`${label}: unknown shape ${JSON.stringify(s)}`); continue }
    const p = Array.isArray(raw.p) && raw.p.length === 3 && raw.p.every(finite) && raw.p.every((v) => Math.abs(v) <= 1000) ? raw.p : null
    const d = Array.isArray(raw.d) && raw.d.length === 3 && raw.d.every((v) => finite(v) && v > 0 && v <= 1000) ? raw.d : null
    if (!p || !d) { problems.push(`${label}: p and d must be three numbers (d positive)`); continue }
    if (s === 'brick' && !d.every((v) => Number.isInteger(v) && v <= 48)) { problems.push(`${label}: a brick's d is whole studs and plates`); continue }
    const c = colour(raw.c) || colour(gluedWord(raw, 'c'))
    if (!c) problems.push(`${label}: colour ${JSON.stringify(raw.c)} replaced`)
    const solid = { s, p: [...p], d: [...d], c: c || NEUTRAL }
    const axis = ['x', 'y', 'z'].includes(raw.axis) ? raw.axis : gluedWord(raw, 'axis', ['x', 'y', 'z'])
    if ((s === 'cyl' || s === 'cone') && axis) solid.axis = axis
    if (s === 'rope') {
      const form = ROPE_FORMS.includes(raw.form) ? raw.form : gluedWord(raw, 'form', ROPE_FORMS)
      solid.form = form || 'straight'
      solid.t = finite(raw.t) && raw.t > 0 ? Math.min(raw.t, Math.min(...d)) : Math.max(0.5, Math.min(...d) * 0.5)
    }
    if (s === 'cone') solid.t = finite(raw.t) && raw.t > 0 ? Math.min(8, Math.max(0.05, raw.t)) : 1.4
    if ((s === 'cyl' || s === 'cone') && (raw.open || gluedWord(raw, 'open') === 'true')) {
      solid.open = true
      // Meta sometimes spells the documented fill field f_color. Keep the colour it actually supplied.
      const f = colour(raw.f) || colour(raw.f_color) || colour(gluedWord(raw, 'f'))
      if (f) solid.f = f
    }
    if (s === 'prism') {
      // (its outline: 3 to 24 points, fractions of its box, a simple polygon)
      // (the outline under "o", or a name the model gives it instead: "o/polygon", "outline", "points" — Meta writes these)
      // (or run into the key: gluedPoints)
      const pairs = (v) => Array.isArray(v) && v.some((q) => Array.isArray(q) && q.length === 2) ? v : null
      const given = pairs(raw.o) ?? pairs(Object.entries(raw).find(([k, v]) => pairs(v) && /^(o\W|outline|polygon|points)/i.test(k))?.[1]) ?? gluedPoints(raw)
      const o = untangled(Array.isArray(given) ? given.filter((q) => Array.isArray(q) && q.length === 2 && q.every(finite)).map((q) => q.map((v) => Math.min(1, Math.max(0, v)))) : [])
      if (o.length < 3 || o.length > 24 || Math.abs(area(o)) < 0.01) {
        // No outline to be had: the solid its box fills, rather than nothing (a card with no picture) — seen from above
        // (a coaster, a mat) a disc, else a block.
        problems.push(`${label}: a prism's o is 3 to 24 points [u, v] from 0 to 1 enclosing an area: drawn as a plain ${axis === 'z' ? 'disc' : 'block'}`)
        solid.s = axis === 'z' ? 'cyl' : 'box'
        if (axis === 'z') solid.axis = 'z'
      } else {
        solid.o = o
        // (a flat thing lying down — a paper heart 16 × 14 × 0.3 — is its outline seen from above: on its front face
        // the outline is a sliver 0.3 high, and the card shows a strip)
        const lying = !raw.axis && !gluedWord(raw, 'axis') && d[2] < 0.15 * Math.min(d[0], d[1])
        if (axis === 'z' || lying) solid.axis = 'z'
        if (lying) problems.push(`${label}: a prism ${d[2]} high under ${Math.min(d[0], d[1])} across lies flat: its outline seen from above`)
      }
    }
    const mark = MARKS.includes(raw.m) ? raw.m : gluedWord(raw, 'm', MARKS)
    if (mark) solid.m = mark
    if (Array.isArray(raw.r) && raw.r.length === 3 && raw.r.every(finite) && raw.r.some((v) => v % 360)) solid.r = raw.r.map((v) => v % 360)
    solids.push(solid)
  }
  return { look: solids, problems }
}

// A solid's bounding box in centimetres (a brick's d is in studs and plates).
const extent = (s) => (s.s === 'brick' ? [s.d[0] * STUD, s.d[1] * STUD, s.d[2] * PLATE] : s.d)
// A solid's turn (r) as a pair: P moves a point, N a direction. Unturned solids get the identity.
const IDENT = { P: (q) => q, N: (n) => n }
function turned(s) {
  if (!s.r) return IDENT
  const [ax, ay, az] = s.r.map((v) => (v * Math.PI) / 180), e = extent(s), c = s.p.map((v, i) => v + e[i] / 2)
  const rx = ([x, y, z]) => [x, y * Math.cos(ax) - z * Math.sin(ax), y * Math.sin(ax) + z * Math.cos(ax)]
  const ry = ([x, y, z]) => [x * Math.cos(ay) + z * Math.sin(ay), y, -x * Math.sin(ay) + z * Math.cos(ay)]
  const rz = ([x, y, z]) => [x * Math.cos(az) - y * Math.sin(az), x * Math.sin(az) + y * Math.cos(az), z]
  const N = (n) => rz(ry(rx(n)))
  return { P: (q) => add(c, N(add(q, c, -1))), N }
}
const corners = (s) => { const e = extent(s), X = turned(s); return [0, 1, 2, 3, 4, 5, 6, 7].map((i) => X.P([s.p[0] + (i & 1) * e[0], s.p[1] + ((i >> 1) & 1) * e[1], s.p[2] + ((i >> 2) & 1) * e[2]])) }

// The finished thing's overall size, as a catalogue gives it: width × depth × height in cm.
export function dimensions(look) {
  if (!look.length) return null
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (const s of look) for (const q of corners(s)) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], q[i]); hi[i] = Math.max(hi[i], q[i]) }
  return hi.map((h, i) => h - lo[i])
}
export function dimensionLabel(look) {
  const d = dimensions(look)
  if (!d) return ''
  const n = (v) => (v >= 10 ? Math.round(v) : +v.toFixed(1)).toString()
  return `${n(d[0])} × ${n(d[1])} × ${n(d[2])} cm`
}

// ---- colour ----
function rgb(c) { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255] }
function mix(c, to, k) { const a = rgb(c), b = to === 'white' ? [255, 255, 255] : [20, 26, 44]; return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * k)).join(',')})` }
// Three tones by how a face meets the light (and a fourth for faces turned away): the films' flat shading.
function tone(c, n) {
  const t = dot(n, L)
  return t > 0.62 ? mix(c, 'white', 0.22) : t > 0.1 ? c : t > -0.3 ? mix(c, 'ink', 0.12) : mix(c, 'ink', 0.24)
}
const toneIndex = (n) => { const t = dot(n, L); return t > 0.62 ? 0 : t > 0.1 ? 1 : t > -0.3 ? 2 : 3 }

function hull(points) {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (p.length < 3) return p
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower = [], upper = []
  for (const q of p) { while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), q) <= 0) lower.pop(); lower.push(q) }
  for (const q of p.reverse()) { while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), q) <= 0) upper.pop(); upper.push(q) }
  return lower.slice(0, -1).concat(upper.slice(0, -1))
}

// ---- each solid as a list of drawing operations in screen units (before fitting) ----
// op: {poly:[[x,y]…], fill?, stroke?, width?, alpha?, closed?, clip?:poly (clip to it), dots?:[[x,y,r]…]}
const SIDES = 28
// A small deterministic scatter (the same picture every time).
function scatter(n, seed) { const out = []; let a = seed * 9301 + 49297; for (let i = 0; i < n; i++) { a = (a * 9301 + 49297) % 233280; const u = a / 233280; a = (a * 9301 + 49297) % 233280; out.push([u, a / 233280]) } return out }

function boxOps(p, e, c, mark, seed, X = IDENT) {
  const ops = [], [w, d, h] = e
  const at = (x, y, z) => X.P([p[0] + x * w, p[1] + y * d, p[2] + z * h])
  // the six faces as [normal, corners (unit box), its two in-plane axes]
  const faces = [
    [[0, 0, 1], [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]], [[0, 0, -1], [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]]],
    [[0, -1, 0], [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]], [[0, 1, 0], [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]]],
    [[1, 0, 0], [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]]], [[-1, 0, 0], [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]]],
  ]
  for (const [n, corners] of faces) {
    const seen = X.N(n)
    if (dot(seen, V) <= 0) continue
    const poly = corners.map((q) => screen(at(...q)))
    ops.push({ poly, fill: tone(c, seen), stroke: INK, width: 1 })
    // marks on the face, in its own plane
    const ax = n[0] ? [1, 2] : n[1] ? [0, 2] : [0, 1], fixed = n.findIndex((v) => v), fv = n[fixed] > 0 ? 1 : 0
    const point = (u, v) => { const q = [0, 0, 0]; q[fixed] = fv; q[ax[0]] = u; q[ax[1]] = v; return screen(at(...q)) }
    const len = [w, d, h]
    if (mark === 'grain' || mark === 'stripes' || mark === 'coil') {
      // grain runs along the face's longer side (stripes across its shorter one: rows)
      const along = len[ax[0]] >= len[ax[1]] ? 0 : 1, lines = mark === 'grain' ? 3 : Math.max(3, Math.min(9, Math.round(len[ax[1 - along]] / 1.2)))
      for (let i = 1; i <= lines; i++) {
        const f = i / (lines + 1), pts = []
        for (let k = 0; k <= 6; k++) {
          const g = k / 6, wobble = mark === 'grain' ? 0.035 * Math.sin(g * 5 + i * 2.1 + seed) : 0
          pts.push(along === 0 ? point(g, f + wobble) : point(f + wobble, g))
        }
        ops.push({ poly: pts, stroke: mix(c, 'ink', 0.35), width: 0.7, closed: false, alpha: 0.7 })
      }
    } else if (mark === 'dots' && n[2] === 1) {
      ops.push({ dots: scatter(Math.min(40, Math.max(6, Math.round((w * d) / 6))), seed).map(([u, v]) => [...point(0.08 + u * 0.84, 0.08 + v * 0.84), 0.9]), fill: mix(c, 'ink', 0.45) })
    } else if (mark === 'rings' && n[2] === 1) {
      for (const f of [0.66, 0.33]) ops.push({ poly: corners.map((q) => point(0.5 + (q[ax[0]] - 0.5) * f, 0.5 + (q[ax[1]] - 0.5) * f)), stroke: mix(c, 'ink', 0.35), width: 0.7, alpha: 0.7 })
    }
  }
  return ops
}

const area = (o) => o.reduce((n, q, i) => { const r = o[(i + 1) % o.length]; return n + q[0] * r[1] - r[0] * q[1] }, 0) / 2
// A prism: an outline (fractions of its box) run straight through it — drawn on its front face (u across x, v up z),
// running back along y; with axis "z", drawn on its upper face (u along x, v along y), running up. A wedge, a gable, an
// A-frame's side, a shaped bracket, an arch, a hexagon. Its faces that face the viewer, far to near, in tone; grain
// and stripes on its outline faces.
function prismOps(solid, e, seed, X = IDENT) {
  const [w, d, h] = e, flat = solid.axis === 'z', ccw = area(solid.o) > 0 ? solid.o : [...solid.o].reverse()
  // a point of the outline at depth f (0 front/lower, 1 back/upper)
  const at = ([u, v], f) => X.P(flat ? [solid.p[0] + u * w, solid.p[1] + v * d, solid.p[2] + f * h] : [solid.p[0] + u * w, solid.p[1] + f * d, solid.p[2] + v * h])
  const outward = flat ? [0, 0, 1] : [0, -1, 0]
  const faces = [{ n: outward, q: ccw.map((q) => at(q, flat ? 1 : 0)), cap: true }, { n: outward.map((v) => -v), q: [...ccw].reverse().map((q) => at(q, flat ? 0 : 1)), cap: true }]
  for (let i = 0; i < ccw.length; i++) {
    const a = ccw[i], b = ccw[(i + 1) % ccw.length], du = (b[0] - a[0]) * w, dv = (b[1] - a[1]) * (flat ? d : h)
    // (the outline runs anticlockwise as drawn: its outward side is to the right of each edge)
    const n2 = [dv, -du], len = Math.hypot(...n2) || 1, n = flat ? [n2[0] / len, n2[1] / len, 0] : [n2[0] / len, 0, n2[1] / len]
    faces.push({ n, q: flat ? [at(a, 0), at(b, 0), at(b, 1), at(a, 1)] : [at(a, 0), at(b, 0), at(b, 1), at(a, 1)] })
  }
  const ops = []
  for (const f of faces.map((f) => ({ ...f, seen: X.N(f.n) })).filter((f) => dot(f.seen, V) > 1e-6)
    .sort((a, b) => dot(a.q.reduce((m, q) => add(m, q, 1 / a.q.length), [0, 0, 0]), V) - dot(b.q.reduce((m, q) => add(m, q, 1 / b.q.length), [0, 0, 0]), V))) {
    const poly = f.q.map(screen)
    ops.push({ poly, fill: tone(solid.c, f.seen), stroke: INK, width: 1 })
    if (f.cap && (solid.m === 'grain' || solid.m === 'stripes' || solid.m === 'coil')) {
      const lines = solid.m === 'grain' ? 3 : 6
      for (let i = 1; i <= lines; i++) {
        const v = i / (lines + 1), pts = []
        for (let k = 0; k <= 6; k++) pts.push(screen(at([k / 6, v + (solid.m === 'grain' ? 0.03 * Math.sin(k + i * 2.1 + seed) : 0)], dot(f.n, outward) > 0 ? (flat ? 1 : 0) : (flat ? 0 : 1))))
        ops.push({ poly: pts, stroke: mix(solid.c, 'ink', 0.35), width: 0.7, closed: false, alpha: 0.7, clip: poly })
      }
    }
  }
  return ops
}

// Cylinders and cones (frustums) along an axis: the side in tone bands, the cap that faces the viewer, the outline.
function roundOps(solid, e, seed, X = IDENT) {
  const { p, c } = solid, axis = solid.axis || 'z', ai = { x: 0, y: 1, z: 2 }[axis]
  const others = [0, 1, 2].filter((i) => i !== ai)
  const unit = (i) => [0, 1, 2].map((j) => (j === i ? 1 : 0))
  const a = X.N(unit(ai)), e1 = X.N(unit(others[0])), e2 = X.N(unit(others[1]))
  const centre = X.P([0, 1, 2].map((i) => p[i] + (i === ai ? 0 : e[i] / 2)))
  const len = e[ai], ra = e[others[0]] / 2, rb = e[others[1]] / 2
  const t = solid.s === 'cone' ? solid.t : 1, k0 = t > 1 ? 1 / t : 1, k1 = t > 1 ? 1 : t
  const ring = (z, k) => Array.from({ length: SIDES }, (_, i) => {
    const g = (2 * Math.PI * i) / SIDES
    return add(add(add(centre, a, z), e1, ra * k * Math.cos(g)), e2, rb * k * Math.sin(g))
  })
  const r0 = ring(0, k0), r1 = ring(len, k1), s0 = r0.map(screen), s1 = r1.map(screen)
  const ops = []
  // side: each strip's outward normal (a cone's tilts with its slope), merged into runs of one tone
  const slope = ((k0 - k1) * Math.max(ra, rb)) / len
  const strips = Array.from({ length: SIDES }, (_, i) => {
    const g = (2 * Math.PI * (i + 0.5)) / SIDES
    const n = norm(add(add(add([0, 0, 0], e1, Math.cos(g) / (ra || 1)), e2, Math.sin(g) / (rb || 1)), a, slope / Math.max(ra, rb)))
    return { i, n, seen: dot(n, V) > 0 }
  })
  let run = null
  const flush = () => {
    if (!run) return
    const j = (run.end + 1) % SIDES, idx = []
    for (let i = run.start; ; i = (i + 1) % SIDES) { idx.push(i); if (i === run.end) break }
    idx.push(j)
    ops.push({ poly: [...idx.map((i) => s0[i]), ...idx.reverse().map((i) => s1[i])], fill: tone(c, run.n), stroke: tone(c, run.n), width: 0.6 })
    run = null
  }
  // start just after a hidden strip so a visible run is never split at index 0
  const first = Math.max(0, strips.findIndex((s) => !s.seen))
  for (let q = 0; q < SIDES; q++) {
    const s = strips[(first + q) % SIDES]
    if (!s.seen) { flush(); continue }
    const ti = toneIndex(s.n)
    if (run && run.ti === ti) run.end = s.i
    else { flush(); run = { start: s.i, end: s.i, ti, n: s.n } }
  }
  flush()
  // the cap facing the viewer
  const topSeen = dot(a, V) > 0, cap = topSeen ? s1 : s0, capRing = topSeen ? r1 : r0, capN = topSeen ? a : a.map((v) => -v)
  ops.push({ poly: cap, fill: tone(c, capN), stroke: INK, width: 1 })
  let markArea = solid.open ? null : { colour: c, k: topSeen ? k1 : k0, z: topSeen ? len : 0 }
  if (solid.open) {
    // a vessel: a rim, the inside in shadow, and what it holds a little below the rim
    const kr = (topSeen ? k1 : k0) * (1 - Math.min(0.12, 0.6 / Math.max(0.5, Math.min(ra, rb)))), inside = ring(topSeen ? len : 0, kr).map(screen)
    ops.push({ poly: inside, fill: mix(c, 'ink', 0.42), stroke: INK, width: 0.6 })
    if (solid.f) {
      const z = topSeen ? len * 0.88 : len * 0.12, k = (k0 + (k1 - k0) * (topSeen ? 0.88 : 0.12)) * (kr / (topSeen ? k1 : k0))
      ops.push({ poly: ring(z, k).map(screen), fill: tone(solid.f, capN), clip: inside })
      markArea = { colour: solid.f, k, z, clip: inside }
    }
  }
  if (solid.m && markArea) {
    const m = solid.m, inner = (f) => ring(markArea.z, markArea.k * f).map(screen)
    if (m === 'coil') {
      // turns of rope on the face: a ring for each, the ridge between turns dark and the crown of each turn light
      const turns = Math.max(3, Math.min(10, Math.round(Math.min(ra, rb) * markArea.k / (len / ROPE_BANDS(len)))))
      for (let t = 0; t < turns; t++) {
        const f = 0.94 - (0.86 * t) / turns
        ops.push({ poly: inner(f), stroke: mix(markArea.colour, 'ink', 0.55), width: 1.1, alpha: 0.9 })
        ops.push({ poly: inner(f - 0.43 / turns), stroke: mix(markArea.colour, 'white', 0.42), width: 2.4, alpha: 0.6 })
      }
    } else if (m === 'rings') for (const f of [0.68, 0.36]) ops.push({ poly: inner(f), stroke: mix(markArea.colour, 'ink', 0.35), width: 0.7, alpha: 0.75 })
    else if (m === 'dots') {
      const n = Math.min(40, Math.max(6, Math.round((Math.PI * ra * rb * markArea.k * markArea.k) / 5)))
      ops.push({ dots: scatter(n, seed).map(([u, v]) => {
        const r = Math.sqrt(u) * 0.82, g = v * 2 * Math.PI
        return [...screen(add(add(add(centre, a, markArea.z), e1, ra * markArea.k * r * Math.cos(g)), e2, rb * markArea.k * r * Math.sin(g))), 0.9]
      }), fill: mix(markArea.colour, 'ink', 0.45), clip: markArea.clip })
    }
  }
  if (solid.m === 'coil') {
    // each turn of rope round the side a rounded tube: a dark seam between turns, a light crown along the middle of each, and
    // the slanting ticks of its twist
    const bands = ROPE_BANDS(len)
    const order = Array.from({ length: SIDES }, (_, q) => (first + q) % SIDES)
    const runs = (f) => {
      const r = ring(len * f, k0 + (k1 - k0) * f), seen = r.map((q, i) => (strips[i].seen ? screen(q) : null)), out = []
      let pts = []
      for (const i of order) { if (seen[i]) pts.push(seen[i]); else { if (pts.length > 1) out.push(pts); pts = [] } }
      if (pts.length > 1) out.push(pts)
      return out
    }
    for (let b = 0; b < bands; b++) {
      for (const pts of runs((b + 0.5) / bands)) {
        ops.push({ poly: pts, stroke: mix(c, 'white', 0.42), width: 2.2, closed: false, alpha: 0.6 })
        const ticks = []
        for (let i = 2; i + 3 < pts.length; i += 2) ticks.push([[pts[i][0] - 0.12, pts[i][1] + 0.3], [pts[i][0] + 0.2, pts[i][1] - 0.3]])
        for (const t of ticks) ops.push({ poly: t, stroke: mix(c, 'ink', 0.4), width: 0.6, closed: false, alpha: 0.75 })
      }
      if (b) for (const pts of runs(b / bands)) ops.push({ poly: pts, stroke: mix(c, 'ink', 0.55), width: 1.1, closed: false, alpha: 0.9 })
    }
  } else if (solid.m === 'stripes' || solid.m === 'grain') {
    // bands round the side (rows of stitches, a wound strand, a can's label edges)
    const bands = solid.m === 'grain' ? 2 : Math.max(2, Math.min(10, Math.round(len / 1.2)))
    for (let b = 1; b <= bands; b++) {
      const f = b / (bands + 1), r = ring(len * f, k0 + (k1 - k0) * f)
      const seen = r.map((q, i) => (strips[i].seen ? screen(q) : null))
      let pts = []
      const order = Array.from({ length: SIDES }, (_, q) => (first + q) % SIDES)
      for (const i of order) { if (seen[i]) pts.push(seen[i]); else if (pts.length) { ops.push({ poly: pts, stroke: mix(c, 'ink', 0.35), width: 0.7, closed: false, alpha: 0.7 }); pts = [] } }
      if (pts.length > 1) ops.push({ poly: pts, stroke: mix(c, 'ink', 0.35), width: 0.7, closed: false, alpha: 0.7 })
    }
  }
  ops.push({ poly: hull([...s0, ...s1]), stroke: INK, width: 1.2 })
  return ops
}

// A ball (an ellipsoid in its box): base, a shadowed crescent, a highlight, wound lines for "stripes".
function ballOps(solid, e, seed, X = IDENT) {
  const { p, c } = solid, centre = p.map((v, i) => v + e[i] / 2), r = e.map((v) => v / 2)
  const pts = []
  for (let i = 0; i < 24; i++) for (let j = 0; j <= 12; j++) {
    const th = (Math.PI * j) / 12, ph = (2 * Math.PI * i) / 24
    pts.push(screen(X.P([centre[0] + r[0] * Math.sin(th) * Math.cos(ph), centre[1] + r[1] * Math.sin(th) * Math.sin(ph), centre[2] + r[2] * Math.cos(th)])))
  }
  const outline = hull(pts), mid = screen(centre)
  const scale = (poly, k, dx = 0, dy = 0) => poly.map(([x, y]) => [mid[0] + (x - mid[0]) * k + dx, mid[1] + (y - mid[1]) * k + dy])
  const size = Math.max(...r)
  const ops = [
    { poly: outline, fill: mix(c, 'ink', 0.2) },
    { poly: scale(outline, 0.86, -size * 0.1, -size * 0.1), fill: c, clip: outline },
    { poly: scale(outline, 0.2, -size * 0.36, -size * 0.36), fill: mix(c, 'white', 0.22), clip: outline },
  ]
  if (solid.m === 'stripes' || solid.m === 'grain' || solid.m === 'rings' || solid.m === 'coil') {
    // wound strands: great circles at a spread of tilts, clipped to the ball
    for (let k = 0; k < 6; k++) {
      const tilt = (k * Math.PI) / 6 + seed, ring = []
      for (let i = 0; i <= 24; i++) {
        const g = (2 * Math.PI * i) / 24, q = [Math.cos(g), Math.sin(g) * Math.cos(tilt), Math.sin(g) * Math.sin(tilt)]
        // only the half facing the viewer
        if (dot(X.N(q), V) < 0) { if (ring.length > 1) ops.push({ poly: ring.splice(0), stroke: mix(c, 'ink', 0.4), width: 0.7, closed: false, alpha: 0.7, clip: outline }); ring.length = 0; continue }
        ring.push(screen(X.P(centre.map((v, j) => v + q[j] * r[j]))))
      }
      if (ring.length > 1) ops.push({ poly: ring, stroke: mix(c, 'ink', 0.4), width: 0.7, closed: false, alpha: 0.7, clip: outline })
    }
  } else if (solid.m === 'dots') {
    ops.push({ dots: scatter(14, seed).map(([u, v]) => { const g = v * 2 * Math.PI, k = Math.sqrt(u) * 0.75; return [mid[0] + Math.cos(g) * k * size, mid[1] + Math.sin(g) * k * size * 0.9, 0.8] }), fill: mix(c, 'ink', 0.45), clip: outline })
  }
  ops.push({ poly: outline, stroke: INK, width: 1.2 })
  return ops
}

// A toy brick: its block, then its studs from the back row forward.
function brickOps(solid, seed, X) {
  const e = extent(solid), ops = boxOps(solid.p, e, solid.c, null, seed, X)
  const studs = []
  for (let i = 0; i < solid.d[0]; i++) for (let j = solid.d[1] - 1; j >= 0; j--) studs.push([i, j])
  studs.sort((a, b) => dot([b[0], b[1], 0], V) - dot([a[0], a[1], 0], V)).reverse()
  for (const [i, j] of studs) {
    const p = [solid.p[0] + (i + 0.2) * STUD, solid.p[1] + (j + 0.2) * STUD, solid.p[2] + e[2]]
    ops.push(...roundOps({ s: 'cyl', p, c: solid.c }, [STUD * 0.6, STUD * 0.6, 0.17], seed, X).map((op) => (op.width ? { ...op, width: op.width * 0.6 } : op)))
  }
  return ops
}

// A length of rope: its path through the box in 3D, drawn as a tube — an ink edge, the colour, a light crown — far to near.
function ropePath(solid, e) {
  const t = solid.t, [w, d, h] = e, c = [w / 2, d / 2, h / 2], n = 48
  const rw = Math.max(0, w / 2 - t / 2), rd = Math.max(0, d / 2 - t / 2), rh = Math.max(0, h / 2 - t / 2), pts = []
  const ang = (i) => (i / n) * Math.PI * 2
  if (solid.form === 'ring') for (let i = 0; i < n; i++) pts.push([c[0] + rw * Math.cos(ang(i)), c[1] + rd * Math.sin(ang(i)), t / 2])
  else if (solid.form === 'hoop') for (let i = 0; i < n; i++) pts.push([c[0] + rw * Math.cos(ang(i)), c[1], c[2] + rh * Math.sin(ang(i))])
  else if (solid.form === 'arch') for (let i = 0; i <= n / 2; i++) pts.push([c[0] - rw * Math.cos(ang(i)), c[1], t / 2 + (h - t) * Math.sin(ang(i))])
  else if (solid.form === 'knot') for (let i = 0; i < n * 2; i++) { const a = (i / (n * 2)) * Math.PI * 2; pts.push([c[0] + (rw * (Math.sin(a) + 2 * Math.sin(2 * a))) / 3, c[1] + (rd * (Math.cos(a) - 2 * Math.cos(2 * a))) / 3, c[2] - (rh * Math.sin(3 * a)) / 1.4]) }
  else { const axis = w >= d && w >= h ? 0 : d >= h ? 1 : 2; for (let i = 0; i <= 16; i++) { const q = [c[0], c[1], c[2]]; q[axis] = t / 2 + ((e[axis] - t) * i) / 16; pts.push(q) } }
  const closed = solid.form === 'ring' || solid.form === 'hoop' || solid.form === 'knot'
  return { pts, closed }
}
function ropeOps(solid, e, X) {
  const { pts, closed } = ropePath(solid, e), q = pts.map((v) => add(solid.p, X.P(v))), at = (i) => q[((i % q.length) + q.length) % q.length]
  // runs of the path nearer or farther than its depth's bands, so the near part crosses over the far part and a run is one
  // unbroken tube (a stroke for each short piece would show a seam at every joint)
  const n = closed ? q.length : q.length - 1, depth = (i) => dot(add(at(i), at(i + 1), 1), V) / 2, ds = Array.from({ length: n }, (_, i) => depth(i))
  const lo = Math.min(...ds), hi = Math.max(...ds), band = (i) => solid.form === 'knot' ? Math.min(3, Math.floor(((ds[i] - lo) / Math.max(1e-6, hi - lo)) * 4)) : 0
  const runs = []
  for (let i = 0; i < n; i++) {
    const last = runs[runs.length - 1]
    if (last && last.band === band(i) && last.end === i) { last.pts.push(screen(at(i + 1))); last.end = i + 1 } else runs.push({ band: band(i), end: i + 1, pts: [screen(at(i)), screen(at(i + 1))], depth: ds[i] })
  }
  runs.sort((x, y) => x.band - y.band || x.depth - y.depth)
  return runs.map((r) => ({ poly: r.pts, closed: false, tube: { w: solid.t, c: solid.c } }))
}

function solidOps(solid, seed) {
  const e = extent(solid), X = turned(solid)
  if (solid.s === 'rope') return ropeOps(solid, e, X)
  if (solid.s === 'box') return boxOps(solid.p, e, solid.c, solid.m, seed, X)
  if (solid.s === 'brick') return brickOps(solid, seed, X)
  if (solid.s === 'ball') return ballOps(solid, e, seed, X)
  if (solid.s === 'prism') return prismOps(solid, e, seed, X)
  return roundOps(solid, e, seed, X)
}

// Far to near. Two solids whose boxes are apart along an axis go in that axis's order (lower before higher; left
// before right; back before front: the viewer is above, to the right, in front); the rest by their middles' depth.
// A plain sort by depth draws a brick's leg over the plate resting on it.
function paintOrder(solids, contained = []) {
  const boxes = solids.map((s) => {
    const q = corners(s), lo = [0, 1, 2].map((i) => Math.min(...q.map((c) => c[i]))), hi = [0, 1, 2].map((i) => Math.max(...q.map((c) => c[i])))
    return { lo, hi, depth: dot(lo.map((v, i) => (v + hi[i]) / 2), V) }
  })
  const eps = 1e-6, n = solids.length
  // before(a, b): a must be drawn before b
  const before = (a, b) => {
    if (contained[b]?.parent === a) return true
    if (contained[a]?.parent === b) return false
    const A = boxes[a], B = boxes[b]
    if (A.hi[2] <= B.lo[2] + eps) return true
    if (B.hi[2] <= A.lo[2] + eps) return false
    if (A.hi[0] <= B.lo[0] + eps) return true
    if (B.hi[0] <= A.lo[0] + eps) return false
    if (A.lo[1] >= B.hi[1] - eps) return true
    if (B.lo[1] >= A.hi[1] - eps) return false
    return null
  }
  const after = Array.from({ length: n }, () => []), waiting = new Array(n).fill(0)
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
    const r = before(a, b)
    if (r === true) { after[a].push(b); waiting[b]++ } else if (r === false) { after[b].push(a); waiting[a]++ }
  }
  const out = [], done = new Array(n).fill(false)
  while (out.length < n) {
    // the farthest solid with nothing left to wait for (or, in a cycle, the farthest left)
    let pick = -1
    for (let i = 0; i < n; i++) if (!done[i] && !waiting[i] && (pick < 0 || boxes[i].depth < boxes[pick].depth)) pick = i
    if (pick < 0) for (let i = 0; i < n; i++) if (!done[i] && (pick < 0 || boxes[i].depth < boxes[pick].depth)) pick = i
    done[pick] = true; out.push(pick)
    for (const j of after[pick]) waiting[j]--
  }
  return out
}

// Contents below an upright vessel's rim must be occluded by its front wall.
// This is geometric containment, not a guess based on a liquid's colour or the project's domain.
// Solids above the rim, tilted vessels and independent dishes keep ordinary depth ordering.
export function containedContents(solids) {
  const upright = (s) => (!s.axis || s.axis === 'z') && (!s.r || s.r.every((a) => Math.abs(a) < 1e-6))
  return solids.map((child, index) => {
    if (!['cyl', 'box', 'ball'].includes(child.s) || child.open || !upright(child)) return null
    const candidates = []
    for (const [parent, vessel] of solids.entries()) {
      if (parent === index || !vessel.open || !['cyl', 'cone'].includes(vessel.s) || !upright(vessel)) continue
      const [w, d, h] = vessel.d, z = child.p[2] - vessel.p[2]
      if (z < 0 || z + child.d[2] > h + 1e-6 || child.d[2] > h * 0.5) continue
      const t = vessel.s === 'cone' ? vessel.t || 1.4 : 1, k0 = t > 1 ? 1 / t : 1, k1 = t > 1 ? 1 : t
      const inner = 1 - Math.min(0.12, 0.6 / Math.max(0.5, Math.min(w, d) / 2))
      const radius = (k0 + (k1 - k0) * (z + child.d[2]) / h) * inner
      const cx = vessel.p[0] + w / 2, cy = vessel.p[1] + d / 2
      const dx = (child.p[0] + child.d[0] / 2 - cx) / (w * radius / 2), dy = (child.p[1] + child.d[1] / 2 - cy) / (d * radius / 2)
      if (child.s === 'cyl') {
        if (child.d[2] > h * 0.25 || Math.hypot(dx, dy) + Math.max(child.d[0] / (w * radius), child.d[1] / (d * radius)) > 1 + 1e-6) continue
      } else {
        // Small items centred in the opening can meet the curved wall; clipping hides that overlap.
        // A block spanning the bowl is a lid or an independent part, not its contents.
        if (Math.hypot(dx, dy) >= 1 || child.d[0] > w * radius * 0.6 || child.d[1] > d * radius * 0.6) continue
      }
      const clip = Array.from({ length: SIDES }, (_, i) => {
        const a = i * Math.PI * 2 / SIDES
        return screen([cx + Math.cos(a) * w * k1 * inner / 2, cy + Math.sin(a) * d * k1 * inner / 2, vessel.p[2] + h])
      })
      candidates.push({ parent, clip, volume: w * d * h })
    }
    candidates.sort((a, b) => a.volume - b.volume)
    return candidates[0] || null
  })
}

// ---- the thumbnail ----
// Draws the look into the rectangle [x, y, width, height] of ctx. Returns {ms, solids} (how long it took, what was drawn).
export function drawThumb(ctx, look, { x = 0, y = 0, width, height, pad = 0.1, background = null, shadow = true } = {}) {
  const started = (globalThis.performance || Date).now()
  const solids = checkLook(look).look
  if (background) { ctx.fillStyle = background; ctx.fillRect(x, y, width, height) }
  if (!solids.length) return { ms: 0, solids: 0 }
  const contained = containedContents(solids)
  const groups = paintOrder(solids, contained).map((i) => solidOps(solids[i], i + 1).map((op) => contained[i] ? { ...op, vesselClip: contained[i].clip } : op))
  // the shadow on the surface it stands on: every solid's footprint at the lowest level
  const all = solids.flatMap(corners), floor = Math.min(...all.map((q) => q[2]))
  const foot = hull(all.map((q) => screen([q[0], q[1], floor])))
  // fit everything into the rectangle
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const ops of [...groups, [{ poly: foot }]]) for (const op of ops) for (const q of op.poly || op.dots || []) { x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]) }
  const room = Math.min(width, height) * pad
  const k = Math.min((width - 2 * room) / Math.max(1e-6, x1 - x0), (height - 2 * room) / Math.max(1e-6, y1 - y0))
  const ox = x + width / 2 - ((x0 + x1) / 2) * k, oy = y + height / 2 - ((y0 + y1) / 2) * k
  const T = ([px, py]) => [ox + px * k, oy + py * k]
  const path = (poly, closed = true) => { ctx.beginPath(); poly.forEach((q, i) => { const [px, py] = T(q); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py) }); if (closed) ctx.closePath() }
  // line widths grow a little with the picture, never below a hairline
  const lw = Math.max(0.6, Math.min(width, height) / 160)
  ctx.save()
  ctx.lineJoin = 'round'; ctx.lineCap = 'round'
  if (shadow) { ctx.globalAlpha = 0.09; ctx.fillStyle = INK; path(foot); ctx.fill(); ctx.globalAlpha = 1 }
  for (const ops of groups) for (const op of ops) {
    if (op.clip || op.vesselClip) {
      ctx.save()
      for (const clip of [op.vesselClip, op.clip].filter(Boolean)) { path(clip); ctx.clip() }
    }
    ctx.globalAlpha = op.alpha ?? 1
    if (op.tube) {
      // (a segment of rope: ink edge, then its colour, then a light crown; widths in centimetres of the thing)
      path(op.poly, false)
      ctx.lineCap = 'round'; ctx.strokeStyle = INK; ctx.lineWidth = op.tube.w * k + 1.6 * lw; ctx.stroke()
      ctx.strokeStyle = op.tube.c; ctx.lineWidth = op.tube.w * k; ctx.stroke()
      ctx.strokeStyle = mix(op.tube.c, 'white', 0.42); ctx.globalAlpha = 0.55; ctx.lineWidth = Math.max(0.6, op.tube.w * k * 0.28); ctx.stroke()
    } else if (op.dots) {
      ctx.fillStyle = op.fill
      ctx.beginPath()
      for (const [px, py, r] of op.dots) { const [sx, sy] = T([px, py]); const rr = Math.max(0.8, r * lw); ctx.moveTo(sx + rr, sy); ctx.arc(sx, sy, rr, 0, Math.PI * 2) }
      ctx.fill()
    } else {
      path(op.poly, op.closed !== false)
      if (op.fill) { ctx.fillStyle = op.fill; ctx.fill() }
      if (op.stroke) { ctx.strokeStyle = op.stroke; ctx.lineWidth = (op.width || 1) * lw; ctx.stroke() }
    }
    ctx.globalAlpha = 1
    if (op.clip || op.vesselClip) ctx.restore()
  }
  ctx.restore()
  return { ms: (globalThis.performance || Date).now() - started, solids: solids.length }
}
