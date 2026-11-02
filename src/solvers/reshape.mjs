// Reshaping: a thing changes shape by hand (wire bent, paper folded, dough rolled, a cable coiled, a cloth knotted). The
// plan gives the thing's drawing before and after (its states' appearances: SVG paths); here both are flattened to
// points in the thing's own drawing space and matched point for point, so the film moves every point from one shape
// to the next (engine.mjs draws it). Computed in Node; the film only interpolates.
//   morph(fromAppearance | null, toAppearance, {width, height}) → {pairs, fadeIn, fadeOut, moved, lineWidth}

const N_OPEN = 48, N_CLOSED = 64

// An SVG path's subpaths as points: M L H V C S Q T A Z, absolute and relative.
export function flatten(d) {
  const tokens = String(d).match(/[MmLlHhVvCcSsQqTtAaZz]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) || []
  const paths = []
  let i = 0, cmd = null, x = 0, y = 0, sx = 0, sy = 0, cx = 0, cy = 0, qx = 0, qy = 0, current = null, last = ''
  const num = () => +tokens[i++]
  const more = () => i < tokens.length && !/^[A-Za-z]$/.test(tokens[i])
  const point = (px, py) => { if (!current) { current = { pts: [[x, y]], closed: false }; paths.push(current) } current.pts.push([px, py]); x = px; y = py }
  const curve = (f, steps = 12) => { for (let k = 1; k <= steps; k++) point(...f(k / steps)) }
  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i])) cmd = tokens[i++]
    else if (!cmd) { i++; continue }
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase(), ox = rel ? x : 0, oy = rel ? y : 0
    if (C === 'Z') { if (current) { current.closed = true; x = sx; y = sy } current = null; last = 'Z'; continue }
    if (!more()) continue // (a command with no numbers: skipped)
    if (C === 'M') {
      x = ox + num(); y = oy + num(); sx = x; sy = y; current = { pts: [[x, y]], closed: false }; paths.push(current)
      cmd = rel ? 'l' : 'L' // (further pairs are lines)
    } else if (C === 'L') point(ox + num(), oy + num())
    else if (C === 'H') point(ox + num(), y)
    else if (C === 'V') point(x, (rel ? y : 0) + num())
    else if (C === 'C' || C === 'S') {
      const x0 = x, y0 = y
      let x1, y1
      if (C === 'C') { x1 = ox + num(); y1 = oy + num() } else { x1 = /[CS]/.test(last) ? 2 * x - cx : x; y1 = /[CS]/.test(last) ? 2 * y - cy : y }
      const x2 = ox + num(), y2 = oy + num(), x3 = ox + num(), y3 = oy + num()
      curve((t) => { const u = 1 - t; return [u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3] })
      cx = x2; cy = y2
    } else if (C === 'Q' || C === 'T') {
      const x0 = x, y0 = y
      let x1, y1
      if (C === 'Q') { x1 = ox + num(); y1 = oy + num() } else { x1 = /[QT]/.test(last) ? 2 * x - qx : x; y1 = /[QT]/.test(last) ? 2 * y - qy : y }
      const x2 = ox + num(), y2 = oy + num()
      curve((t) => { const u = 1 - t; return [u * u * x0 + 2 * u * t * x1 + t * t * x2, u * u * y0 + 2 * u * t * y1 + t * t * y2] })
      qx = x1; qy = y1
    } else if (C === 'A') {
      let rx = Math.abs(num()), ry = Math.abs(num()); const phi = (num() * Math.PI) / 180, large = num(), sweep = num(), x2 = ox + num(), y2 = oy + num()
      const x1 = x, y1 = y
      if (!rx || !ry) { point(x2, y2) } else {
        // endpoint to centre parametrization (SVG implementation notes)
        const c = Math.cos(phi), s = Math.sin(phi), dx = (x1 - x2) / 2, dy = (y1 - y2) / 2
        const xp = c * dx + s * dy, yp = -s * dx + c * dy
        const l = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry)
        if (l > 1) { rx *= Math.sqrt(l); ry *= Math.sqrt(l) }
        const sign = large === sweep ? -1 : 1
        const k = sign * Math.sqrt(Math.max(0, (rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp) / (rx * rx * yp * yp + ry * ry * xp * xp)))
        const cxp = (k * rx * yp) / ry, cyp = (-k * ry * xp) / rx
        const ccx = c * cxp - s * cyp + (x1 + x2) / 2, ccy = s * cxp + c * cyp + (y1 + y2) / 2
        const angle = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
        const a0 = angle(1, 0, (xp - cxp) / rx, (yp - cyp) / ry)
        let da = angle((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry)
        if (!sweep && da > 0) da -= 2 * Math.PI; else if (sweep && da < 0) da += 2 * Math.PI
        curve((t) => { const a = a0 + da * t; return [ccx + c * rx * Math.cos(a) - s * ry * Math.sin(a), ccy + s * rx * Math.cos(a) + c * ry * Math.sin(a)] }, Math.max(4, Math.ceil(Math.abs(da) / 0.3)))
      }
    } else { i++; continue }
    last = C
    if (C !== 'C' && C !== 'S') { cx = x; cy = y }
    if (C !== 'Q' && C !== 'T') { qx = x; qy = y }
  }
  return paths.filter((p) => p.pts.length > 1 && p.pts.every(([a, b]) => Number.isFinite(a) && Number.isFinite(b)))
}

// The same line as n points evenly spaced along it (a closed one round its whole loop).
export function resample(pts, n, closed) {
  const ring = closed ? [...pts, pts[0]] : pts
  const lengths = [0]
  for (let k = 1; k < ring.length; k++) lengths.push(lengths[k - 1] + Math.hypot(ring[k][0] - ring[k - 1][0], ring[k][1] - ring[k - 1][1]))
  const total = lengths.at(-1)
  if (!(total > 0)) return Array.from({ length: n }, () => [...pts[0]])
  const out = []
  let j = 0
  for (let k = 0; k < n; k++) {
    const want = closed ? (total * k) / n : (total * k) / (n - 1)
    while (j < lengths.length - 2 && lengths[j + 1] < want) j++
    const span = lengths[j + 1] - lengths[j] || 1, u = Math.min(1, Math.max(0, (want - lengths[j]) / span))
    out.push([ring[j][0] + (ring[j + 1][0] - ring[j][0]) * u, ring[j][1] + (ring[j + 1][1] - ring[j][1]) * u])
  }
  return out
}

const cost = (a, b) => a.reduce((s, p, k) => s + Math.hypot(p[0] - b[k][0], p[1] - b[k][1]), 0)
// b reordered to follow a: an open line may run either way; a closed one may also start anywhere round its loop.
function align(a, b, closed) {
  const options = [b, [...b].reverse()]
  if (!closed) return options.reduce((best, o) => (cost(a, o) < cost(a, best) ? o : best))
  let best = b, bestCost = Infinity
  for (const o of options) for (let s = 0; s < o.length; s++) {
    const shifted = [...o.slice(s), ...o.slice(0, s)], c = cost(a, shifted)
    if (c < bestCost) { bestCost = c; best = shifted }
  }
  return best
}

// An appearance's shapes in the thing's own drawing space (stretched to its box, as the film draws a state).
function shapesOf(appearance, size) {
  if (!appearance || !Array.isArray(appearance.shapes)) return []
  const kx = size.width / appearance.width, ky = size.height / appearance.height
  return appearance.shapes.map((s) => ({ fill: s.fill, stroke: s.stroke,
    paths: flatten(s.d).map((p) => ({ closed: p.closed, pts: p.pts.map(([x, y]) => [x * kx, y * ky]) })) }))
}
const round = (pts) => pts.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10])

export function morph(from, to, size) {
  const A = shapesOf(from, size), B = shapesOf(to, size)
  const pairs = [], fadeIn = [], fadeOut = [], moves = []
  let moved = null
  B.forEach((sb, i) => {
    const sa = A[i]
    sb.paths.forEach((pb, j) => {
      const pa = sa?.paths[j]
      const closed = pb.closed, n = closed ? N_CLOSED : N_OPEN
      if (!pa) { fadeIn.push({ pts: round(pb.pts), closed, fill: sb.fill, stroke: sb.stroke }); return }
      const a = resample(pa.pts, n, closed && pa.closed), b = align(a, resample(pb.pts, n, closed && pa.closed), closed && pa.closed)
      for (let k = 0; k < n; k++) {
        const d = Math.hypot(b[k][0] - a[k][0], b[k][1] - a[k][1])
        moves.push(d)
        if (!moved || d > moved.d) moved = { d, from: a[k], to: b[k] }
      }
      pairs.push({ a: round(a), b: round(b), closed: closed && pa.closed, fill: [sa.fill, sb.fill], stroke: [sa.stroke, sb.stroke] })
    })
  })
  A.forEach((sa, i) => sa.paths.forEach((pa, j) => { if (!B[i]?.paths[j]) fadeOut.push({ pts: round(pa.pts), closed: pa.closed, fill: sa.fill, stroke: sa.stroke }) }))
  // (the film strokes a state at 2 units of its drawing, stretched to the thing's box)
  const k = to ? (size.width / to.width + size.height / to.height) / 2 : 1
  // The manual's arrow shows a part that moves while the rest stays (a bent end, a folded flap): only when the biggest
  // move is well clear of the typical one, and a real distance. When everything moves (a redrawn shape), no arrow.
  const median = [...moves].sort((x, y) => x - y)[Math.floor(moves.length / 2)] ?? 0
  const local = moved && moved.d > 0.12 * Math.hypot(size.width, size.height) && moved.d >= 2.5 * median
  return { pairs, fadeIn, fadeOut, lineWidth: 2 * k,
    moved: local ? { from: round([moved.from])[0], to: round([moved.to])[0] } : null }
}
