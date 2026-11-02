import { LAYER_RULES, validateDrawing } from './drawing-format.mjs'
import { facesOf } from './faces.mjs'
import { needsVesselInterior, vesselPrompt, vesselGeometry } from '../solvers/vessels.mjs'

// A single root part uses the drawing's coordinate system. Accept metadata there
// without guessing between parts or replacing an explicit top-level value.
export function checkedArtwork(input, { width, height, observed = false, script, key } = {}) {
  const drawing = structuredClone(input)
  if (drawing?.parts?.length === 1 && drawing.parts[0].parent == null) {
    for (const field of ['vessel', 'outlet']) if (drawing[field] === undefined && drawing.parts[0][field] !== undefined) {
      drawing[field] = drawing.parts[0][field]
      delete drawing.parts[0][field]
    }
  }
  if (!usableDrawing(drawing)) throw Error('The response contained no usable object drawing')
  validateDrawing(drawing)
  if (drawing.width !== width || drawing.height !== height) throw Error('The drawing dimensions do not match its canvas')
  if (observed) {
    drawing.artworkMode = 'complete'
  }
  if (script?.steps.some(s => s.do.some(a => a.k === key && a.v === 'pour')) &&
      (!Array.isArray(drawing.outlet) || drawing.outlet.length !== 2 || !drawing.outlet.every((n, i) => Number.isFinite(n) && n >= 0 && n <= [width, height][i])))
    throw Error('The illustration is missing its pouring outlet: include top-level outlet: [x,y], outside parts[0], inside the canvas')
  const vessel = vesselGeometry(drawing)
  if (drawing.vessel != null && !vessel) throw Error('The drawing contains invalid container geometry at top-level vessel; check seat, radii and interior polygon against the canvas and opening')
  if (script && needsVesselInterior(script, key) && !vessel?.interior)
    throw Error('The container drawing is missing its opening and interior geometry: include top-level vessel with seat, rx, ry and interior, outside parts[0]')
  if (vessel) drawing.vessel = vessel
  return drawing
}

// Share the required artwork list between generation and the playback gate.
export function requiredDrawingKeys(layout, geometry) {
  return [...new Set([...layout.order, ...layout.extras])].filter(key =>
    !geometry[key]?.tool && !geometry[key]?.sliceOf && !layout.boards?.[key] &&
    (layout.scene?.[key]?.illustrated || !facesOf(layout.scene?.[key])))
}

// Additional supplies have descriptions and dimensions, never photographed reference images.
export function suppliedDrawingPrompt(script, object, size, { observed = false, layered = false } = {}) {
  const width = Math.round(size.width * 4), height = Math.round(size.height * 4)
  const steps = (script.steps || []).filter(s => (s.do || []).some(a =>
    [a.k, a.to, a.with, a.part, ...(a.demo?.actors || [])].includes(object.k)))
    .map(s => ({ title: s.t, caption: s.c, actions: s.do }))
  const pouring = steps.some(s => s.actions.some(a => a.k === object.k && a.v === 'pour'))
  const receiving = needsVesselInterior(script, object.k)
  const metadata = `${pouring ? ',"outlet":[pouringLipX,pouringLipY]' : ''}${receiving ? ',"vessel":{"seat":[openingCenterX,openingCenterY],"rx":openingInnerRadiusX,"ry":openingInnerRadiusY,"interior":[[x,y],...],"spout":[pouringLipX,pouringLipY]}' : ''}`
  return `${observed ? 'Draw one complete photographed object' : 'Draw one additional supply'} as clean colored vector line art for an IKEA-style instruction film.
${observed ? `photo.png is the original photo. Identify ONLY the requested object using its name and approximate photo box ${JSON.stringify(object.b)} [x,y,width,height] in original photo pixels. Use the photo for identity, natural colors, distinctive shape and label bands. Draw the COMPLETE object in its normal working pose, including an ordinary neck, opening or base hidden by another object or the photo edge. Simplify unreadable label detail. Do not copy the photo crop, segmentation mask, background, neighboring objects or camera angle. Do not invent extra attachments or mechanisms.` : 'This object is required for the project but is NOT in the photo. No reference images are attached. Illustrate its description; do not try to find a photo cut-out.'}
Object: ${JSON.stringify({ key: object.k, name: object.n, family: object.part?.family, sizeCm: object.part?.size, contents: object.contents })}
Project: ${script.title}. View: ${script.view || 'side'}.
Steps using this object: ${JSON.stringify(steps)}

Draw a recognizable silhouette, useful construction details and natural colors. For example, a pitcher has a handle, open rim and spout; juice has its characteristic color in a recognizable carton or bottle; ice consists of separate translucent pale blue cubes. These are examples, not extra objects to add. Do not substitute a generic rectangle or beige block. Use flat colored fills, lighter and darker faces for depth, outlines in #1d2b4f, round joins, and 3–20 SVG shapes. Leave the background transparent. Show only this single object. Do not add shadows outside its silhouette, tools, hands or scenery. Use simple label bands or fruit motifs for packages, not invented brands. Use a shallow three-quarter view where it helps recognition while keeping the working opening visible for pouring or stirring; use a top view if the project's view is plan. The animation rotates the whole object for pours; draw its initial upright pose, not multiple angles or a pouring pose.

Fit the whole object inside a ${width}×${height} canvas, x right and y down. Keep its base centered at the bottom and its upper opening near the top. Preserve the declared proportions. Return exactly one part, id "${object.k}", parent null, pivot [${width / 2}, ${height}].
${pouring ? 'This object pours ingredients. Draw its ready-to-pour upright pose: a bottle is uncapped, with a visible open mouth; do not add a detached cap. Include a top-level "outlet": [x,y] at the actual pouring lip in drawing coordinates, inside the canvas. The stream starts there. The bottle body may remain opaque; do not paint loose liquid outside it.' : ''}
${vesselPrompt(needsVesselInterior(script, object.k))}
${layered ? LAYER_RULES : ''}
Answer with ONE JSON object and nothing else:
Keep vessel and outlet at the top level beside width, height and parts, never inside a part.
{"width":${width},"height":${height}${metadata},"parts":[{"id":"${object.k}","parent":null,"pivot":[${width / 2},${height}],"shapes":[{"d":"<SVG path data>","fill":"<color or none>","stroke":"<color or none>"}]}]}`
}

export const drawingFailure = keys => `Could not finish the object drawings: ${keys.join(', ')}. Retry generation to finish the film.`

export function usableDrawing(drawing) {
  return Number.isFinite(drawing?.width) && drawing.width > 0 && Number.isFinite(drawing?.height) && drawing.height > 0 &&
    Array.isArray(drawing.parts) && drawing.parts.some(part => Array.isArray(part.shapes) &&
      part.shapes.some(shape => typeof shape.d === 'string' && shape.d.trim().length > 0))
}

// Small speculative head start, followed by drawings for the selected instructions only.
export function earlyDrawingKeys(objects) {
  return (objects || []).filter((o) => !o.toolKind && o.part?.family !== 'brick' &&
    !/\b(table|countertop|counter|floor|wall|worktop)\b/i.test(o.n || ''))
    .sort((a, b) => area(b.b) - area(a.b)).slice(0, 2).map((o) => o.k)
}
const area = (b) => Array.isArray(b) && b.length === 4 ? Math.max(0, b[2]) * Math.max(0, b[3]) : 0

export function drawingQueue({ concurrency = 4, signal } = {}) {
  let active = 0
  const waiting = []
  const pump = () => {
    while (active < concurrency && waiting.length) {
      const { work, resolve, reject } = waiting.shift()
      if (signal?.aborted) { reject(signal.reason || new Error('Drawing cancelled')); continue }
      active++
      Promise.resolve().then(work).then(resolve, reject).finally(() => { active--; pump() })
    }
  }
  return (work) => new Promise((resolve, reject) => { waiting.push({ work, resolve, reject }); pump() })
}

// Boxes are hints for identification, never masks to subtract: photographed objects can legitimately overlap.
export function drawingReference(key, objects, geometry, size) {
  const target = objects.find((o) => o.k === key), origin = geometry.origin || [0, 0]
  const box = (b) => {
    if (!Array.isArray(b) || b.length !== 4) return null
    const x0 = Math.max(0, (b[0] - origin[0]) * 4), y0 = Math.max(0, (b[1] - origin[1]) * 4)
    const x1 = Math.min(size.width * 4, (b[0] + b[2] - origin[0]) * 4), y1 = Math.min(size.height * 4, (b[1] + b[3] - origin[1]) * 4)
    return x1 > x0 && y1 > y0 ? [x0, y0, x1 - x0, y1 - y0].map(Math.round) : null
  }
  return JSON.stringify({ target: { key, name: target?.n || key, approximateBox: box(target?.b) },
    neighbors: objects.filter((o) => o.k !== key && box(o.b)).map((o) => ({ key: o.k, name: o.n, approximateBox: box(o.b) })) })
}
