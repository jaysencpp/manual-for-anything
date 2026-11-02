// Flat stock and explicitly laid-out cut parts. All coordinates are centimetres;
// outlines are local to each part, origins are in its immediate source sheet.
const list = (x) => Array.isArray(x) ? x.filter((v) => v != null) : []
const pair = (x) => Array.isArray(x) && x.length === 2 && x.every(Number.isFinite)
const area = (p) => Math.abs(p.reduce((s, q, i) => s + q[0] * p[(i + 1) % p.length][1] - q[1] * p[(i + 1) % p.length][0], 0)) / 2
export const rectangle = ([w, h]) => [[0, 0], [w, 0], [w, h], [0, h]]
export function sheetParts(script) {
  const parts = new Map(list(script?.objects).filter((o) => o.part?.family === 'sheet' && list(o.part.size).length === 3)
    .map((o) => [o.k, { k: o.k, size: o.part.size.slice(0, 2), outline: rectangle(o.part.size), stock: true }]))
  for (const s of list(script?.steps)) for (const a of list(s?.do)) if (a.v === 'cut' && Array.isArray(a.into)) {
    for (const p of a.into) if (p && (p.size || p.origin || p.outline))
      parts.set(p.k, { ...p, from: a.k, outline: p.outline || (pair(p.size) ? rectangle(p.size) : []) })
  }
  return parts
}
export const hasSheetCuts = (script) => list(script?.steps).some((s) => list(s.do).some((a) => a.v === 'cut' && list(a.into).some((p) => p?.size || p?.origin || p?.outline)))
export function hasSheetToolPaths(script) {
  const parts = sheetParts(script)
  return list(script?.steps).some((s) => list(s.do).some((a) => a.path && parts.has(a.k)))
}

export function checkSheets(script) {
  const errors = [], parts = sheetParts(script), occupied = new Map()
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
  const crosses = (a, b, c, d) => cross(a, b, c) * cross(a, b, d) < -1e-9 && cross(c, d, a) * cross(c, d, b) < -1e-9
  const simple = (P) => new Set(P.map((q) => `${q[0]}:${q[1]}`)).size === P.length && P.every((a, i) => P.every((c, j) => j <= i + 1 || i === 0 && j === P.length - 1 || !crosses(a, P[(i + 1) % P.length], c, P[(j + 1) % P.length])))
  const pointIn = (q, p) => {
    let yes = false
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const a = p[j], b = p[i], cross = (q[0] - a[0]) * (b[1] - a[1]) - (q[1] - a[1]) * (b[0] - a[0])
      if (Math.abs(cross) < 1e-6 && q[0] >= Math.min(a[0], b[0]) - 1e-6 && q[0] <= Math.max(a[0], b[0]) + 1e-6 && q[1] >= Math.min(a[1], b[1]) - 1e-6 && q[1] <= Math.max(a[1], b[1]) + 1e-6) return true
      if ((a[1] > q[1]) !== (b[1] > q[1]) && q[0] < (b[0] - a[0]) * (q[1] - a[1]) / (b[1] - a[1]) + a[0]) yes = !yes
    }
    return yes
  }
  const valid = (p) => pair(p.size) && p.size.every((v) => v > 0) && list(p.outline).length >= 3 && p.outline.length <= 48
    && p.outline.every((q) => pair(q) && q[0] >= 0 && q[1] >= 0 && q[0] <= p.size[0] && q[1] <= p.size[1]) && area(p.outline) > 1e-6 && simple(p.outline)
  const contained = (path, polygon) => path.every((q) => pair(q) && pointIn(q, polygon)) && path.slice(1).every((b, i) => {
    const a = path[i]
    return pointIn([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], polygon)
      && polygon.every((c, j) => !crosses(a, b, c, polygon[(j + 1) % polygon.length]))
  })
  for (const p of parts.values()) if (!valid(p)) errors.push(`${p.k}: sheet needs positive size [width,height] and a nonempty outline inside it`)
  for (const s of list(script?.steps)) for (const a of list(s?.do)) {
    if (a.v === 'use' && [...list(script.objects), ...list(script.tools)].some((t) => t.k === a.with && (t.use || t.toolKind) === 'needle') && !a.path)
      errors.push(`${a.id || a.k}: needle work needs intent stitch and an explicit path, or a faithful demonstration`)
    if (a.v === 'use' && a.path && [...list(script.objects), ...list(script.tools)].some((t) => t.k === a.with && (t.use || t.toolKind) === 'needle') && a.intent !== 'stitch') errors.push(`${a.id || a.k}: needle path work must declare intent stitch`)
    if (a.v === 'cut' && Array.isArray(a.into) && a.into.some((p) => p?.size || p?.origin || p?.outline)) {
      const source = parts.get(a.k)
      if (!source || !valid(source)) { errors.push(`${a.id || a.k}: explicit sheet cuts need a sheet source`); continue }
      for (const raw of a.into) {
        const p = parts.get(raw?.k)
        if (!p || !valid(p) || !pair(p.origin) || p.origin.some((v) => v < 0)) { errors.push(`${raw?.k}: every sheet cut output needs size and origin [x,y]`); continue }
        const [x, y] = p.origin, [w, h] = p.size
        if (x + w > source.size[0] + 1e-6 || y + h > source.size[1] + 1e-6 || !contained([...p.outline, p.outline[0]].map((q) => [q[0] + x, q[1] + y]), source.outline))
          errors.push(`${p.k}: cut part lies outside source sheet ${a.k}`)
        // Conservative rectangular reservations: simple, deterministic, and never permit two parts to reuse stock.
        const prior = occupied.get(a.k) || []
        if (prior.some((q) => x < q.x + q.w - 1e-6 && x + w > q.x + 1e-6 && y < q.y + q.h - 1e-6 && y + h > q.y + 1e-6))
          errors.push(`${p.k}: cut layout overlaps another part in ${a.k}; reserve separate bounding boxes`)
        prior.push({ x, y, w, h }); occupied.set(a.k, prior)
      }
    }
    if (a.path != null || a.intent === 'stitch') {
      const p = parts.get(a.k), path = a.path
      if (a.v !== 'use' || !p || !valid(p) || !Array.isArray(path) || path.length < 2 || path.length > 48 || !contained(path, p.outline) || path.every((q) => q[0] === path[0][0] && q[1] === path[0][1]))
        errors.push(`${a.id || a.k}: tool path needs 2–48 distinct points in centimetres inside a known sheet; ${p ? `path must stay inside ${a.k}'s local sheet outline (${p.size?.join(' × ')} cm), not photo pixels or percentages` : 'crochet pieces declared in makes are not flat stock'}. For sewing or folding a shaped or assembled piece, use demonstrate with actors, focus and effects rather than adding a sheet path`)
      if (a.intent === 'stitch') {
        const tool = [...list(script.objects), ...list(script.tools)].find((t) => t.k === a.with)
        if ((tool?.use || tool?.toolKind) !== 'needle') errors.push(`${a.id}: stitching needs a needle`)
        if (a.to && a.to !== a.k) {
          const q = parts.get(a.to), other = a.otherPath
          if (!q || !valid(q) || !Array.isArray(other) || other.length < 2 || other.length > 48 || !contained(other, q.outline)) errors.push(`${a.id}: a joining stitch needs otherPath on its receiving sheet`)
          else if (Array.isArray(path) && path.every(pair)) {
            const length = (P) => P.slice(1).reduce((n, v, i) => n + Math.hypot(v[0] - P[i][0], v[1] - P[i][1]), 0)
            if (Math.abs(length(path) - length(other)) > 0.1) errors.push(`${a.id}: joined paths must have equal lengths; gathering needs a demonstration`)
          }
        }
      }
    }
  }
  // Existing operations cannot transport a stitched path through a fold. Require the explicit demonstration/state
  // contract for turning a joined assembly, rather than painting a seam in the wrong place.
  const marked = new Set(), folded = new Set(), joined = new Set()
  for (const s of list(script?.steps)) for (const a of list(s?.do)) {
    if (a.v === 'fold' && marked.has(a.k)) errors.push(`${a.id}: folding a path-worked sheet needs a demonstration with the resulting state`)
    if (a.v === 'place' && joined.has(a.k)) errors.push(`${a.id}: moving a joined assembly needs a demonstration with the resulting state`)
    if (parts.has(a.k) && (a.tilt > 0 || a.stand && a.stand !== 'flat' || a.turn)) errors.push(`${a.id || a.k}: a non-flat sheet pose needs a demonstration with the resulting state`)
    if (a.v === 'use' && a.path) {
      if (folded.has(a.k) || a.to && folded.has(a.to)) errors.push(`${a.id}: path work on a folded sheet needs a demonstration with the resulting state`)
      marked.add(a.k); if (a.to) marked.add(a.to)
      if (a.intent === 'stitch' && a.to && a.to !== a.k) { joined.add(a.k); joined.add(a.to) }
    }
    if (a.v === 'fold') folded.add(a.k)
  }
  return [...new Set(errors)]
}

// Check a flat joining operation where the solver actually put its two actors. Equal seam lengths alone do not
// prove contact. A demonstrated gathering or 3D assembly uses the demonstration/state contract instead.
export function checkSheetJoins(script, layout) {
  const problems = []
  const at = (k, q) => {
    const box = layout.world?.[k]
    if (!box?.p || !box.o) return null
    return { ...box.p, [box.o.L]: box.p[box.o.L] + q[0], [box.o.W]: box.p[box.o.W] + q[1] }
  }
  for (const s of list(script?.steps)) for (const a of list(s.do)) if (a.intent === 'stitch' && a.to && a.to !== a.k && Array.isArray(a.path) && Array.isArray(a.otherPath)) {
    let meets = true
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const p = at(a.k, pathPoint(a.path, t)), q = at(a.to, pathPoint(a.otherPath, t))
      if (!p || !q || Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) > 0.2) meets = false
    }
    if (!meets) problems.push({ code: 'sheet-path-contact', message: `${a.id}: stitched paths do not meet in the flat layout; align both parts, or demonstrate the actual joining operation` })
  }
  return problems
}

// Embedded in the film as well as used by tests. Progress follows distance, not vertex count.
export function pathPoint(path, progress) {
  const lengths = path.slice(1).map((p, i) => Math.hypot(p[0] - path[i][0], p[1] - path[i][1]))
  let left = Math.max(0, Math.min(1, progress)) * lengths.reduce((a, b) => a + b, 0)
  for (let i = 0; i < lengths.length; i++) {
    if (left <= lengths[i] || i === lengths.length - 1) {
      const u = lengths[i] ? left / lengths[i] : 0
      return [path[i][0] + (path[i + 1][0] - path[i][0]) * u, path[i][1] + (path[i + 1][1] - path[i][1]) * u]
    }
    left -= lengths[i]
  }
  return path[0]
}
