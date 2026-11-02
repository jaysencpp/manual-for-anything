// Browser-only renderer. Model output is data: it is never inserted as HTML or executed.
export function renderDrawing(drawing) {
  const started = performance.now()
  const canvas = document.createElement('canvas')
  canvas.width = drawing.width; canvas.height = drawing.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.lineCap = 'round'
  for (const part of drawing.parts) for (const shape of part.shapes) {
    if (shape.hidden) continue
    ctx.lineWidth = shape.weight == null ? 3 : ({ none: 0, detail: 1.25, edge: 2, silhouette: 3 })[shape.weight]
    for (const paint of [shape.fill, shape.stroke]) if (paint !== 'none' && (!CSS.supports('color', paint) || /^(inherit|initial|unset|revert|revert-layer|currentcolor)$/i.test(paint))) throw new Error(`Invalid or context-dependent colour: ${paint}`)
    const path = new Path2D(shape.d)
    if (shape.fill !== 'none') { ctx.fillStyle = shape.fill; ctx.fill(path, shape.fillRule || "nonzero") }
    if (shape.stroke !== 'none' && ctx.lineWidth > 0 && shape.weight !== 'none') { ctx.strokeStyle = shape.stroke; ctx.stroke(path) }
  }
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  let pixels = 0, edgePixels = 0, minX = canvas.width, minY = canvas.height, maxX = -1, maxY = -1
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
    if (data[(y * canvas.width + x) * 4 + 3]) {
      pixels++; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y)
      if (!x || !y || x === canvas.width - 1 || y === canvas.height - 1) edgePixels++
    }
  }
  if (!pixels) throw new Error('Drawing renders no visible pixels')
  const renderSeconds = (performance.now() - started) / 1000
  return { png: canvas.toDataURL('image/png'), renderSeconds, pixels, edgePixels, occupancy: pixels / (canvas.width * canvas.height), bounds: [minX, minY, maxX - minX + 1, maxY - minY + 1],
    note: 'Edge pixels flag possible clipping for human review; they do not prove clipping.' }
}
