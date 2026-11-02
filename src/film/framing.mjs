import { operationSites } from '../solvers/operations.mjs'

export function workingRegion(a, layout, sizes) {
  const k = a.focus?.k || a.k, posed = a.turn && layout.flip ? layout.flip : layout
  const p = posed.poses[k], b = posed.boards?.[k], s = b ? { width: b.w, height: b.h } :
    sizes[k] && { width: sizes[k].width * 4, height: sizes[k].height * 4 }
  if (!p || !s) return null
  const at = ([x, y]) => {
    x = (x - p.anchor[0]) * p.scale; y = (y - p.anchor[1]) * p.scale
    return [p.x + x * Math.cos(p.angle || 0) - y * Math.sin(p.angle || 0),
      p.y + x * Math.sin(p.angle || 0) + y * Math.cos(p.angle || 0)]
  }
  let points
  if (a.focus) {
    const [x, y, w, h] = a.focus.bounds
    points = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(([u, v]) => at([u * s.width, v * s.height]))
  } else if (a.joint && b?.faceLines?.[a.face]?.basis) {
    const [o, u, v] = b.faceLines[a.face].basis
    points = operationSites(a).map((q) => at([o[0] + (u[0] - o[0]) * q.x + (v[0] - o[0]) * (0.5 + q.lat),
      o[1] + (u[1] - o[1]) * q.x + (v[1] - o[1]) * (0.5 + q.lat)]))
  } else return null
  const tool = a.with && sizes[a.with] && layout.poses[a.with] ? Math.min(300,
    Math.max(100, Math.max(s.width, s.height) * p.scale * 0.4), sizes[a.with].width * 4 * layout.poses[a.with].scale) : 0
  const pad = Math.max(36, Math.max(s.width, s.height) * p.scale * (a.focus?.clearance || 0), tool)
  return { x0: Math.min(...points.map((p) => p[0])) - pad, y0: Math.min(...points.map((p) => p[1])) - pad,
    x1: Math.max(...points.map((p) => p[0])) + pad, y1: Math.max(...points.map((p) => p[1])) + pad }
}
