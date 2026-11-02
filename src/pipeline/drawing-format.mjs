// Shared data contract for model artwork, production validation and SVG comparisons.
export const LINE_WEIGHTS = Object.freeze({ none: 0, detail: 1.25, edge: 2, silhouette: 3 })
export const lineWidth = shape => shape.weight == null ? 3 : LINE_WEIGHTS[shape.weight]
export const LAYER_RULES = `Give every shape a unique descriptive id within its part (body-outline, handle, seam, label). Give every shape a weight: none, detail, edge or silhouette. Use one strong silhouette contour for each whole object or independently moving part; interior seams use detail or edge. Flat colour/shadow regions use stroke none and weight none. Do not outline every colour patch. Preserve damage and construction details. Preserve every visible hole and gap as transparency through ALL underlying fills. Use compound paths with fillRule evenodd for shapes with holes; an outlined oval over a solid fill is not a hole. Colour patches must not paint over openings. Real edges between physical faces still need edge lines; simplifying shading must not flatten protruding parts.`
const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/
const paint = /^(?:[a-z]+|#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|(?:rgb|rgba|hsl|hsla)\([\d\s.,%+\-/]+\))$/i
const contextPaint = /^(?:inherit|initial|unset|revert|revert-layer|currentcolor)$/i
export function checkPaint(value) {
  if (typeof value !== 'string' || !paint.test(value) || contextPaint.test(value)) throw new Error('Expected a plain CSS colour or none')
}
export function checkPath(path) {
  if (typeof path !== 'string' || path.length > 200000) throw new Error('Missing or oversized SVG path')
  const tokens = path.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g) || []
  if (path.replace(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?|[\s,]/g, '')) throw new Error('Invalid SVG path characters')
  if (!/^[Mm]$/.test(tokens[0] || '')) throw new Error('SVG path must start with moveto')
  const counts = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 }
  let i = 0
  while (i < tokens.length) {
    const command = tokens[i++].toUpperCase(), count = counts[command]
    if (count == null) throw new Error(`Unsupported SVG path command ${command}`)
    const start = i
    while (i < tokens.length && !/^[a-zA-Z]$/.test(tokens[i])) i++
    const args = tokens.slice(start, i).map(Number)
    if (args.some(n => !Number.isFinite(n) || Math.abs(n) > 1e7) || (count ? !args.length || args.length % count : args.length)) throw new Error(`Invalid ${command} arguments`)
    if (command === 'A') for (let j = 0; j < args.length; j += 7) {
      if (args[j] < 0 || args[j + 1] < 0 || ![0, 1].includes(args[j + 3]) || ![0, 1].includes(args[j + 4])) throw new Error('Invalid SVG arc')
    }
  }
}


export function validateDrawing(drawing, { width, height } = {}) {
  if (!Number.isFinite(drawing?.width) || drawing.width <= 0 || drawing.width > 16384 ||
      !Number.isFinite(drawing?.height) || drawing.height <= 0 || drawing.height > 16384) throw new Error('Invalid drawing dimensions')
  if ((width != null && width !== drawing.width) || (height != null && height !== drawing.height)) throw new Error('Drawing dimensions differ from expected canvas')
  if (!Array.isArray(drawing.parts) || !drawing.parts.length || drawing.parts.length > 64) throw new Error('Missing or excessive drawing parts')
  const ids = new Set(); let shapes = 0, visible = 0, bytes = 0
  for (const part of drawing.parts) {
    if (!identifier.test(part.id || '') || ids.has(part.id)) throw new Error('Invalid or duplicate part id')
    if (part.parent != null && !ids.has(part.parent)) throw new Error('Parts must name an earlier parent')
    ids.add(part.id)
    if (!Array.isArray(part.pivot) || part.pivot.length !== 2 || !part.pivot.every(Number.isFinite)) throw new Error('Invalid part pivot')
    if (!Array.isArray(part.shapes)) throw new Error('Missing shapes')
    const layerIds = new Set()
    for (const shape of part.shapes) {
      if (++shapes > 512) throw new Error('Excessive drawing shapes')
      checkPath(shape.d); bytes += shape.d.length
      if (bytes > 400000) throw new Error('Drawing paths exceed the film budget')
      if (shape.id != null && (!identifier.test(shape.id) || layerIds.has(shape.id))) throw new Error('Invalid or duplicate layer id')
      layerIds.add(shape.id)
      for (const value of [shape.fill ?? 'none', shape.stroke ?? 'none']) checkPaint(value)
      if (shape.fillRule != null && !['nonzero', 'evenodd'].includes(shape.fillRule)) throw new Error('Invalid SVG fill rule')
      if (shape.weight != null && !Object.hasOwn(LINE_WEIGHTS, shape.weight)) throw new Error('Unknown line weight')
      if (shape.hidden != null && typeof shape.hidden !== 'boolean') throw new Error('Invalid layer visibility')
      if (!shape.hidden && /[LlHhVvCcSsQqTtAa]/.test(shape.d) &&
          ((shape.fill && shape.fill !== 'none' && shape.fill !== 'transparent') ||
           (shape.stroke && shape.stroke !== 'none' && shape.stroke !== 'transparent' && lineWidth(shape) > 0))) visible++
    }
  }
  if (!visible) throw new Error('Drawing contains no drawable visible shapes')
  return drawing
}

export function namedDrawing(drawing) {
  const copy = structuredClone(drawing)
  for (const part of copy.parts) {
    const used = new Set(part.shapes.map(s => s.id).filter(Boolean))
    part.shapes.forEach((shape, i) => {
      if (shape.id) return
      let id = `layer-${i + 1}`
      while (used.has(id)) id += '-legacy'
      shape.id = id; used.add(id)
    })
  }
  return copy
}

// Edits are data only and never change pivots, parentage, object dimensions or operation geometry.
export function editDrawing(drawing, { partId, shapeId, ...changes }) {
  const copy = namedDrawing(drawing)
  const shape = copy.parts.find(p => p.id === partId)?.shapes.find(s => s.id === shapeId)
  if (!shape) throw new Error('No such drawing layer')
  if (!Object.keys(changes).length || Object.keys(changes).some(k => !['hidden', 'fill', 'stroke', 'weight'].includes(k))) throw new Error('Unsupported layer edit')
  Object.assign(shape, changes)
  return validateDrawing(copy)
}

export function drawingMetrics(drawing) {
  const layers = drawing.parts.flatMap(p => p.shapes)
  return { parts: drawing.parts.length, layers: layers.length, namedLayers: layers.filter(s => s.id).length,
    hiddenLayers: layers.filter(s => s.hidden).length, pathBytes: layers.reduce((n, s) => n + s.d.length, 0),
    commands: layers.reduce((n, s) => n + (s.d.match(/[MmLlHhVvCcSsQqTtAaZz]/g) || []).length, 0),
    weights: Object.fromEntries(Object.keys(LINE_WEIGHTS).map(w => [w, layers.filter(s => s.weight === w).length])),
    note: 'Structure and complexity diagnostics; these do not establish visual correctness.' }
}

export function drawingSVG(drawing) {
  validateDrawing(drawing)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${drawing.width}" height="${drawing.height}" viewBox="0 0 ${drawing.width} ${drawing.height}"><g stroke-linecap="round" stroke-linejoin="round">${drawing.parts.flatMap(p => p.shapes.filter(s => !s.hidden).map(s => `<path d="${s.d}" fill="${s.fill || 'none'}" stroke="${s.stroke || 'none'}" stroke-width="${lineWidth(s)}" fill-rule="${s.fillRule || 'nonzero'}"/>`)).join('')}</g></svg>`
}
