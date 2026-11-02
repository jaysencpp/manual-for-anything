// Container geometry is expressed in the same coordinates as its vector artwork.
// Old drawings may declare only a rim; only a checked interior enables volume filling.
export function vesselGeometry(drawing) {
  const v = drawing?.vessel, W = drawing?.width, H = drawing?.height
  const point = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) && p[0] >= 0 && p[0] <= W && p[1] >= 0 && p[1] <= H
  if (!v || !point(v.seat) || !Number.isFinite(v.rx) || !Number.isFinite(v.ry) || v.rx <= 0 || v.ry <= 0 ||
    v.seat[0] - v.rx < 0 || v.seat[0] + v.rx > W || v.seat[1] - v.ry < 0 || v.seat[1] + v.ry > H) return null
  const bounds = Array.isArray(v.bounds) && v.bounds.length === 4 && v.bounds.every(Number.isFinite) && v.bounds[2] > 0 && v.bounds[3] > 0
    ? [...v.bounds] : [v.seat[0] - v.rx, v.seat[1] - v.ry, v.rx * 2, H - v.seat[1] + v.ry]
  const result = { seat: [...v.seat], rx: v.rx, ry: v.ry, bounds }
  if (v.spout != null) { if (!point(v.spout)) return null; result.spout = [...v.spout] }
  if (v.interior != null) {
    if (!Array.isArray(v.interior) || v.interior.length < 3 || v.interior.length > 64 || !v.interior.every(point)) return null
    const xs = v.interior.map(p => p[0]), ys = v.interior.map(p => p[1])
    const area = v.interior.reduce((sum, p, i, all) => { const q = all[(i + 1) % all.length]; return sum + p[0] * q[1] - q[0] * p[1] }, 0)
    if (Math.abs(area) < 1 || Math.max(...ys) <= v.seat[1] + v.ry || Math.min(...ys) < v.seat[1] - v.ry ||
      Math.min(...xs) >= v.seat[0] || Math.max(...xs) <= v.seat[0]) return null
    result.interior = v.interior.map(p => [...p])
    if (v.front != null) {
      if (!Array.isArray(v.front) || v.front.length > 30 || !v.front.every(s => typeof s.d === 'string' && s.d.length > 0 && s.d.length < 4000 &&
        (s.fill == null || typeof s.fill === 'string') && (s.stroke == null || typeof s.stroke === 'string'))) return null
      result.front = v.front
    }
  }
  return result
}

export function needsVesselInterior(script, key) {
  const target = (script.objects || []).find(o => o.k === key)
  return (script.steps || []).some(s => (s.do || []).some(a =>
    a.to === key && (['pour', 'sprinkle', 'stir'].includes(a.v) ||
      a.v === 'place' && a.rel === 'in' && (target?.part?.family === 'cylinder' || target?.part?.shape === 'vessel') &&
      (script.objects || []).some(o => o.k === a.k && !o.toolKind))))
}

export function vesselPrompt(required = false) {
  return `CONTAINER GEOMETRY: ${required ? 'This object receives ingredients. You MUST include' : 'For an open container such as a glass, pitcher, bowl or pot, also include'} a top-level "vessel" object in the same drawing coordinates:
{"seat":[openingCenterX,openingCenterY],"rx":openingInnerRadiusX,"ry":openingInnerRadiusY,"interior":[[x,y],...],"spout":[pouringLipX,pouringLipY],"front":[{"d":"SVG path","fill":"none","stroke":"#1d2b4f"}]}.
The seat is the actual opening center, NOT the top edge of the canvas. The radii describe the inside of its visible rim. The interior is a simple closed polygon of 4–32 points following the INSIDE walls from the opening down to the inside bottom; exclude handles, thick walls, feet and the outer silhouette. Keep every point inside the canvas. The renderer clips liquid to this polygon and raises its level from the bottom. Use the left pouring lip for spout, or the left rim if there is no spout. In front put only rim/front outlines and narrow glass highlights to redraw over the liquid; never an opaque body fill. Draw the vessel empty; the renderer adds the contents. Omit vessel for objects that are not containers.`
}

// Schematic fill progress, not a claim about physical capacity or measured volume.
// Each planned addition contributes an equal share; it grows only while flowing.
export function liquidLevel(vessel, additions, time) {
  if (!vessel?.interior) return null
  const bottom = Math.max(...vessel.interior.map(p => p[1]))
  const progress = additions.reduce((sum, a) => {
    const start = a.fillAt ?? a.at, end = a.fillEnd ?? start
    return sum + (time < start ? 0 : end <= start ? 1 : Math.max(0, Math.min(1, (time - start) / (end - start))))
  }, 0)
  const level = 0.78 * progress / Math.max(1, additions.length)
  return { level, bottom, surface: bottom - (bottom - vessel.seat[1]) * level }
}

// Fit a contained object drawing inside its vessel, in the vessel's coordinate system.
// Ice rests on the bottom until liquid lifts it; this is a schematic pile, not a fluid simulation.
// Independently declared contents occupy separate slots instead of hiding one another.
export function ingredientPose(vessel, size, holder, scale, surface, floating = false, index = 0, count = 1) {
  const xs = vessel.interior.map(p => p[0]), ys = vessel.interior.map(p => p[1])
  const left = Math.min(...xs), right = Math.max(...xs), bottom = Math.max(...ys)
  const depth = bottom - vessel.seat[1], margin = depth * 0.04
  const slotWidth = (right - left) * 0.8 / count
  const relative = Math.min(scale / holder.scale, slotWidth * (count > 1 ? 0.9 : 1) / size.width, depth * 0.5 / size.height)
  const height = size.height * relative
  const base = floating && surface != null ? Math.min(bottom - margin, Math.max(vessel.seat[1] + margin + height, surface + height * 0.85)) : bottom - margin
  const x = (left + right) / 2 + (index - (count - 1) / 2) * slotWidth - holder.anchor[0]
  const y = base - holder.anchor[1], angle = holder.angle || 0
  return { x: holder.x + (x * Math.cos(angle) - y * Math.sin(angle)) * holder.scale,
    y: holder.y + (x * Math.sin(angle) + y * Math.cos(angle)) * holder.scale,
    scale: relative * holder.scale, angle, anchor: [size.width / 2, size.height] }
}
