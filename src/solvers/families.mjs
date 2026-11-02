// Everyday things drawn from numbers, the way boards and bricks are: most things on a kitchen counter or a desk are a
// can or jar (a cylinder), a packet or book (a box), a bag, a ball (yarn, fruit) or a block (cheese, butter). Such a
// thing is drawn as its family — flat colours from its own tracing, an ink outline, and for packaged things a label
// face that carries its name — instead of its tracing, whose holes and photo noise read as a cut-out, and instead of a
// model drawing that lands 20 to 30 s later. Irregular things (headphones, a plant, a tool) keep their tracing and
// model drawing. Each drawing is exactly its tracing's size, so geometry and layout are unchanged.
//
//   familyDrawings(script, traced) → {key: vector}; a packaged thing's vector has `label`: {text, x, y, w, h, color}
//   in drawing units, the face the engine writes its name on.

const INK = '#1d2b4f'
const FAMILIES = [
  ['cylinder', /\b(can|cans|tin|tins|jar|jars|cup|mug|bottle|tub)\b/i],
  ['box', /\b(box|packet|pack|carton|book|binder)\b/i],
  ['bag', /\b(bag|sack|pouch)\b/i],
  ['ball', /\b(ball|yarn|wool|skein|orange|apple|lemon|lime|onion)\b/i],
  ['block', /\b(block|cheese|butter|tofu|soap)\b/i],
]

export function familyOf(o) {
  if (!o || o.toolKind || +o.thick > 0) return null
  const words = `${o.n || ''} ${String(o.k || '').replace(/-/g, ' ')}`
  if (o.part?.family === 'cylinder' && (o.part.shape === 'vessel' || o.contents || /\b(bowl|cup|mug|basin|dish)\b/i.test(words))) return 'vessel'
  if (o.part) return null
  return FAMILIES.find(([, re]) => re.test(words))?.[0] || null
}

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16))
const toHex = (rgb) => '#' + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')
const tint = (c, k) => toHex(hex(c).map((v) => v + (255 - v) * k))
const shade = (c, k) => toHex(hex(c).map((v) => v * (1 - k)))
const light = (c) => { const [r, g, b] = hex(c); return 0.299 * r + 0.587 * g + 0.114 * b > 150 }
const far = (a, b) => hex(a).reduce((s, v, i) => s + Math.abs(v - hex(b)[i]), 0) > 90

// A tracing's colours by the area they cover (each shape's outline, its points taken as a polygon), largest first.
function palette(vector) {
  const area = {}
  for (const part of vector.parts || []) for (const sh of part.shapes || []) {
    if (!/^#[0-9a-f]{6}$/i.test(sh.fill || '')) continue
    const n = (sh.d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number), pts = []
    for (let i = 0; i + 1 < n.length; i += 2) pts.push([n[i], n[i + 1]])
    let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1] }
    area[sh.fill.toLowerCase()] = (area[sh.fill.toLowerCase()] || 0) + Math.abs(a) / 2
  }
  return Object.entries(area).sort((a, b) => b[1] - a[1]).map(([c]) => c)
}

const r = (v) => Math.round(v)
const S = (d, fill) => ({ d, fill, stroke: INK })

function shapes(family, W, H, main, second) {
  const out = []
  let label = null
  if (family === 'cylinder') {
    const ry = Math.min(W * 0.16, H * 0.12), y0 = r(H * 0.24), y1 = r(H * 0.82)
    out.push(S(`M0 ${r(ry)} L0 ${r(H - ry)} A${r(W / 2)} ${r(ry)} 0 0 0 ${r(W)} ${r(H - ry)} L${r(W)} ${r(ry)} Z`, main))
    out.push(S(`M0 ${y0} L0 ${y1} A${r(W / 2)} ${r(ry)} 0 0 0 ${r(W)} ${y1} L${r(W)} ${y0} A${r(W / 2)} ${r(ry)} 0 0 1 0 ${y0} Z`, second))
    out.push(S(`M0 ${r(ry)} A${r(W / 2)} ${r(ry)} 0 0 1 ${r(W)} ${r(ry)} A${r(W / 2)} ${r(ry)} 0 0 1 0 ${r(ry)} Z`, '#d4d8de'))
    label = { x: W * 0.08, y: (y0 + y1) / 2 + ry * 0.5, w: W * 0.84, h: (y1 - y0) * 0.36 }
  } else if (family === 'box' || family === 'block') {
    const d = Math.min(W, H) * 0.16
    out.push(S(`M0 ${r(d)} L${r(W - d)} ${r(d)} L${r(W - d)} ${r(H)} L0 ${r(H)} Z`, main))
    out.push(S(`M0 ${r(d)} L${r(d)} 0 L${r(W)} 0 L${r(W - d)} ${r(d)} Z`, tint(main, 0.35)))
    out.push(S(`M${r(W - d)} ${r(d)} L${r(W)} 0 L${r(W)} ${r(H - d)} L${r(W - d)} ${r(H)} Z`, shade(main, 0.2)))
    if (family === 'box') {
      const fw = W - d, x0 = fw * 0.1, y0 = d + (H - d) * 0.28, w = fw * 0.8, h = (H - d) * 0.44
      out.push(S(`M${r(x0)} ${r(y0)} h${r(w)} v${r(h)} h${r(-w)} Z`, second))
      label = { x: x0 + w * 0.06, y: y0 + h / 2, w: w * 0.88, h: h * 0.5 }
    }
  } else if (family === 'bag') {
    const c = H * 0.12
    out.push(S(`M${r(W * 0.06)} ${r(c)} L${r(W * 0.94)} ${r(c)} Q${r(W * 1.02)} ${r(H * 0.6)} ${r(W * 0.92)} ${r(H)} L${r(W * 0.08)} ${r(H)} Q${r(-W * 0.02)} ${r(H * 0.6)} ${r(W * 0.06)} ${r(c)} Z`, main))
    out.push(S(`M${r(W * 0.06)} ${r(c)} ` + Array.from({ length: 8 }, (_, i) => `L${r(W * (0.06 + 0.11 * (i + 0.5)))} 0 L${r(W * (0.06 + 0.11 * (i + 1)))} ${r(c)}`).join(' ') + ' Z', shade(main, 0.15)))
    const x0 = W * 0.18, y0 = H * 0.4, w = W * 0.64, h = H * 0.32
    out.push(S(`M${r(x0)} ${r(y0)} h${r(w)} v${r(h)} h${r(-w)} Z`, second))
    label = { x: x0 + w * 0.06, y: y0 + h / 2, w: w * 0.88, h: h * 0.5 }
  } else if (family === 'ball') {
    const rx = W / 2, ry = H / 2
    out.push(S(`M0 ${r(ry)} A${r(rx)} ${r(ry)} 0 0 1 ${r(W)} ${r(ry)} A${r(rx)} ${r(ry)} 0 0 1 0 ${r(ry)} Z`, main))
    // (wound strands across it, as a ball of yarn shows them; a fruit's round reads the same way at this size)
    for (const k of [0.3, 0.55, 0.8]) out.push({ d: `M${r(W * 0.12)} ${r(H * k)} Q${r(W * 0.5)} ${r(H * (k - 0.25))} ${r(W * 0.88)} ${r(H * (k - 0.1))}`, fill: 'none', stroke: shade(main, 0.3) })
  }
  return { shapes: out, label }
}

// Keep the photo/tracing frame for the lift-off, but replace its perspective with one coherent side view.
// The opening, contents and tool contact all share the same rim geometry, in drawing coordinates.
export function vesselDrawing(o, W, H, color) {
  const size = o.part?.size || [1, 1, 0.6], depth = Math.max(0.15, Math.min(1.5, size[2] / Math.max(size[0], size[1])))
  const bottom = H * 0.98, height = Math.min(H * 0.94, W * depth), ry = Math.min(W * 0.13, height * 0.25)
  const cy = bottom - height + ry, foot = W * 0.26
  const body = `M0 ${r(cy)} Q${r(W * 0.08)} ${r(bottom - ry)} ${r(W / 2 - foot)} ${r(bottom)} L${r(W / 2 + foot)} ${r(bottom)} Q${r(W * 0.92)} ${r(bottom - ry)} ${r(W)} ${r(cy)} Z`
  const rim = `M0 ${r(cy)} A${r(W / 2)} ${r(ry)} 0 1 1 ${r(W)} ${r(cy)} A${r(W / 2)} ${r(ry)} 0 1 1 0 ${r(cy)} Z`
  return { width: W, height: H, bounds: [0, cy - ry, W, bottom - cy + ry], family: 'vessel', vessel: { seat: [W / 2, cy], rx: W * 0.43, ry: ry * 0.75,
    bounds: [0, cy - ry, W, bottom - cy + ry] },
    parts: [{ id: o.k, parent: null, pivot: [W / 2, bottom], shapes: [S(body, color), S(rim, shade(color, 0.25)),
      ...(o.contents ? [S(`M${r(W * 0.07)} ${r(cy)} A${r(W * 0.43)} ${r(ry * 0.75)} 0 1 1 ${r(W * 0.93)} ${r(cy)} A${r(W * 0.43)} ${r(ry * 0.75)} 0 1 1 ${r(W * 0.07)} ${r(cy)} Z`, o.contents.color)] : [])] }] }
}

export function familyDrawings(script, traced) {
  const out = {}
  for (const o of script.objects || []) {
    const family = familyOf(o), t = traced && traced[o.k]
    if (!family || !t) continue
    const W = t.width, H = t.height
    // (a can lying on its side is not drawn standing: it keeps its tracing)
    if (family === 'cylinder' && W > H * 1.25) continue
    const colours = palette(t), main = colours[0] || '#c8a165'
    if (family === 'vessel') {
      const body = o.contents && colours.length ? [...colours].sort((a, b) => hex(a).reduce((s, v) => s + v, 0) - hex(b).reduce((s, v) => s + v, 0))[0] : main
      out[o.k] = vesselDrawing(o, W, H, body); continue
    }
    const second = colours.slice(1).find((c) => far(c, main)) || (light(main) ? shade(main, 0.25) : tint(main, 0.55))
    const { shapes: s, label } = shapes(family, W, H, main, second)
    out[o.k] = { width: W, height: H, family, parts: [{ id: o.k, parent: null, pivot: t.parts?.[0]?.pivot || [W / 2, H], shapes: s }],
      ...(label ? { label: { ...label, text: String(o.k).replace(/-/g, ' '), color: light(second) ? INK : '#ffffff' } } : {}) }
  }
  return out
}
