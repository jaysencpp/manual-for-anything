// What a film needs that is not in the photo, there the moment the script names it (no model call, no cut-out):
// - tools: kitchen vessels and hand tools, drawn once here, side on, in the drawings' style, each with its working
//   tip and the motion it makes when used (the engine animates that motion and its manual glyph);
// - fasteners (screws, nails, dowels, bolts), drawn the same way;
// - pieces the script makes from yarn (a crocheted coaster), which the engine draws itself as they grow;
// - pieces cut from an object ("cut" into named parts), each a slice of the object's own drawing and cut-out.
// Everything is sized in real units: the script gives each object's real length in cm, which gives the photo's
// cut-out pixels per cm; without them, against the median width of the objects used.
//
//   withTools(script, geometry, sizes, vectors) → the same three, with all of those added under their keys

import { sheetParts, hasSheetCuts } from './sheets.mjs'
import { vesselGeometry } from './vessels.mjs'
import { completeIllustration, illustrationFrame } from '../pipeline/illustration.mjs'

const INK = '#1d2b4f', STEEL = '#c9cfd9', DARK = '#3a4256', WOOD = '#d9a96a', GRIP = '#e8524a'
const ellipse = (cx, cy, rx, ry) => `M${cx - rx} ${cy} a${rx} ${ry} 0 1 0 ${2 * rx} 0 a${rx} ${ry} 0 1 0 ${-2 * rx} 0 Z`
const r = (v) => Math.round(v)
// A polygon from points given as fractions of w and h.
const poly = (w, h, pts) => 'M' + pts.map(([x, y]) => `${r(x * w)} ${r(y * h)}`).join(' L') + ' Z'
const S = (d, fill, stroke = INK) => ({ d, fill, stroke })

// Each: its real size (cm: length, and height over length), its shapes as a function of its drawing's w and h, its
// seat and base (fractions; where things sit on it, where it stands), its tip (the working end, fractions) and its
// motion when used: saw (strokes along its length), turn (spins, pushing in), tap (swings down and strikes), rub
// (scrubs back and forth), squeeze (closes on it), stroke (draws along the surface), mark (draws a line), press (held
// flat), stir (circles), snip (opens and closes), pour (tips). Tools are drawn lying flat with the tip to the left.
const KINDS = {
  // Kitchen vessels.
  pot: { cm: 24, aspect: 0.72, seat: [0.5, 0.2], base: [0.5, 0.97], tip: [0.06, 0.2], motion: 'pour', shapes: (w, h) => [
    S(`M${r(-0.04 * w)} ${r(0.28 * h)} h${r(0.1 * w)} v${r(0.1 * h)} h${r(-0.1 * w)} Z M${r(0.94 * w)} ${r(0.28 * h)} h${r(0.1 * w)} v${r(0.1 * h)} h${r(-0.1 * w)} Z`, '#59627a'),
    S(poly(w, h, [[0.06, 0.2], [0.94, 0.2], [0.9, 0.95], [0.1, 0.95]]), STEEL),
    S(ellipse(r(0.5 * w), r(0.2 * h), r(0.44 * w), r(0.08 * h)), '#59627a')] },
  pan: { cm: 44, aspect: 0.3, seat: [0.31, 0.42], base: [0.31, 0.97], tip: [0.03, 0.4], motion: 'pour', shapes: (w, h) => [
    S(poly(w, h, [[0.58, 0.48], [1, 0.36], [1, 0.5], [0.58, 0.66]]), DARK),
    S(poly(w, h, [[0.03, 0.4], [0.59, 0.4], [0.55, 0.95], [0.07, 0.95]]), '#59627a'),
    S(ellipse(r(0.31 * w), r(0.4 * h), r(0.28 * w), r(0.09 * h)), DARK)] },
  bowl: { cm: 18, aspect: 0.52, seat: [0.5, 0.22], base: [0.5, 0.96], tip: [0.03, 0.22], motion: 'pour', shapes: (w, h) => [
    S(`M${r(0.03 * w)} ${r(0.22 * h)} Q${r(0.08 * w)} ${r(1.02 * h)} ${r(0.5 * w)} ${r(0.98 * h)} Q${r(0.92 * w)} ${r(1.02 * h)} ${r(0.97 * w)} ${r(0.22 * h)} Z`, '#ffffff'),
    S(ellipse(r(0.5 * w), r(0.22 * h), r(0.47 * w), r(0.1 * h)), '#e6e9ef')] },
  board: { cm: 40, aspect: 0.12, seat: [0.5, 0.3], base: [0.5, 1.0], tip: [0, 0.3], motion: 'press', shapes: (w, h) => [
    S(poly(w, h, [[0, 0.3], [1, 0.3], [1, 1], [0, 1]]), WOOD),
    S(poly(w, h, [[0.04, 0], [1.04, 0], [1, 0.3], [0, 0.3]]), '#e8c48f')] },
  plate: { cm: 26, aspect: 0.18, seat: [0.5, 0.3], base: [0.5, 0.95], tip: [0, 0.3], motion: 'press', shapes: (w, h) => [
    S(poly(w, h, [[0, 0.3], [1, 0.3], [0.82, 0.92], [0.18, 0.92]]), '#ffffff'),
    S(ellipse(r(0.5 * w), r(0.3 * h), r(0.5 * w), r(0.22 * h)), '#f3f4f7')] },
  tray: { cm: 40, aspect: 0.1, seat: [0.5, 0.25], base: [0.5, 1.0], tip: [0, 0.25], motion: 'press', shapes: (w, h) => [
    S(poly(w, h, [[0, 0.25], [1, 0.25], [0.96, 1], [0.04, 1]]), STEEL)] },
  ladle: { cm: 32, aspect: 0.3, seat: [0.13, 0.55], tip: [0.02, 0.55], motion: 'pour', shapes: (w, h) => [
    S(poly(w, h, [[0.22, 0.42], [1, 0.0], [1, 0.12], [0.24, 0.55]]), STEEL),
    S(`M${r(0.0 * w)} ${r(0.45 * h)} Q${r(0.02 * w)} ${r(1.0 * h)} ${r(0.13 * w)} ${r(0.98 * h)} Q${r(0.25 * w)} ${r(1.0 * h)} ${r(0.26 * w)} ${r(0.45 * h)} Z`, STEEL)] },
  knife: { cm: 30, aspect: 0.12, tip: [0.25, 0.95], motion: 'saw', shapes: (w, h) => [
    S(poly(w, h, [[0, 0.7], [0.6, 0.15], [0.6, 0.95], [0.05, 0.95]]), STEEL),
    S(poly(w, h, [[0.6, 0.3], [1, 0.3], [1, 0.8], [0.6, 0.8]]), DARK)] },
  spoon: { cm: 28, aspect: 0.14, tip: [0.1, 0.5], motion: 'stir', shapes: (w, h) => [
    S(poly(w, h, [[0.2, 0.42], [1, 0.4], [1, 0.6], [0.2, 0.58]]), WOOD), S(ellipse(r(0.12 * w), r(0.5 * h), r(0.12 * w), r(0.45 * h)), WOOD)] },
  whisk: { cm: 26, aspect: 0.22, tip: [0.05, 0.5], motion: 'stir', shapes: (w, h) => [
    S(`M${r(0.5 * w)} ${r(0.5 * h)} Q${r(0.02 * w)} ${r(-0.1 * h)} ${r(0.02 * w)} ${r(0.5 * h)} Q${r(0.02 * w)} ${r(1.1 * h)} ${r(0.5 * w)} ${r(0.5 * h)} Z`, 'none'),
    S(`M${r(0.5 * w)} ${r(0.5 * h)} Q${r(0.12 * w)} ${r(0.1 * h)} ${r(0.1 * w)} ${r(0.5 * h)} Q${r(0.12 * w)} ${r(0.9 * h)} ${r(0.5 * w)} ${r(0.5 * h)} Z`, 'none'),
    S(poly(w, h, [[0.5, 0.36], [1, 0.36], [1, 0.64], [0.5, 0.64]]), DARK)] },
  // Hand tools.
  saw: { cm: 55, aspect: 0.3, tip: [0.4, 0.82], motion: 'saw', shapes: (w, h) => [
    S(poly(w, h, [[0, 0.5], [0.72, 0.12], [0.72, 0.82], [0, 0.82]]), STEEL),
    S('M0 ' + r(0.82 * h) + ' ' + Array.from({ length: 18 }, (_, i) => `L${r((i + 0.5) * 0.04 * w)} ${r(0.92 * h)} L${r((i + 1) * 0.04 * w)} ${r(0.82 * h)}`).join(' '), 'none'),
    S(`M${r(0.7 * w)} ${r(0.05 * h)} L${r(w)} ${r(0.05 * h)} L${r(w)} ${r(0.9 * h)} L${r(0.7 * w)} ${r(0.9 * h)} Z M${r(0.78 * w)} ${r(0.3 * h)} L${r(0.92 * w)} ${r(0.3 * h)} L${r(0.92 * w)} ${r(0.62 * h)} L${r(0.78 * w)} ${r(0.62 * h)} Z`, GRIP)] },
  drill: { cm: 26, aspect: 0.85, tip: [0, 0.22], motion: 'turn', shapes: (w, h) => [
    S(poly(w, h, [[0, 0.19], [0.18, 0.19], [0.18, 0.25], [0, 0.25]]), STEEL),
    S(poly(w, h, [[0.16, 0.1], [0.3, 0.1], [0.3, 0.34], [0.16, 0.34]]), DARK),
    S(poly(w, h, [[0.3, 0.02], [1, 0.02], [1, 0.45], [0.3, 0.45]]), GRIP),
    S(poly(w, h, [[0.6, 0.45], [0.85, 0.45], [0.82, 0.86], [0.62, 0.86]]), DARK),
    S(poly(w, h, [[0.52, 0.86], [0.95, 0.86], [0.95, 1], [0.52, 1]]), '#59627a')] },
  screwdriver: { cm: 22, aspect: 0.14, tip: [0, 0.5], motion: 'turn', shapes: (w, h) => [
    S(poly(w, h, [[0, 0.42], [0.55, 0.4], [0.55, 0.6], [0, 0.58]]), STEEL),
    S(poly(w, h, [[0.52, 0.1], [1, 0.15], [1, 0.85], [0.52, 0.9]]), GRIP)] },
  hammer: { cm: 32, aspect: 0.4, tip: [0.09, 1], motion: 'tap', shapes: (w, h) => [
    S(poly(w, h, [[0.12, 0.44], [1, 0.44], [1, 0.6], [0.12, 0.6]]), WOOD),
    S(poly(w, h, [[0, 0], [0.18, 0], [0.18, 1], [0, 1]]), DARK)] },
  tape: { cm: 8, aspect: 0.95, tip: [0, 0.88], motion: 'press', shapes: (w, h) => [
    S(poly(w, h, [[0, 0.84], [0.25, 0.84], [0.25, 0.92], [0, 0.92]]), '#ffcc00'),
    S(`M${r(0.15 * w)} ${r(0.05 * h)} L${r(0.95 * w)} ${r(0.05 * h)} L${r(0.95 * w)} ${r(0.95 * h)} L${r(0.15 * w)} ${r(0.95 * h)} Z`, '#ffcc00'),
    S(ellipse(r(0.55 * w), r(0.48 * h), r(0.2 * w), r(0.2 * h)), DARK)] },
  clamp: { cm: 25, aspect: 0.7, tip: [0.5, 0.5], motion: 'squeeze', shapes: (w, h) => [
    S(poly(w, h, [[0.08, 0], [0.92, 0], [0.92, 0.12], [0.08, 0.12]]), STEEL),
    S(poly(w, h, [[0.8, 0], [0.92, 0], [0.92, 1], [0.8, 1]]), STEEL),
    S(poly(w, h, [[0.08, 0.12], [0.24, 0.12], [0.24, 0.24], [0.08, 0.24]]), DARK),
    S(poly(w, h, [[0.08, 0.76], [0.4, 0.76], [0.4, 0.88], [0.08, 0.88]]), GRIP)] },
  sander: { cm: 14, aspect: 0.45, tip: [0.5, 1], motion: 'rub', shapes: (w, h) => [
    S(poly(w, h, [[0, 0.82], [1, 0.82], [1, 1], [0, 1]]), '#c8a165'),
    S(`M${r(0.05 * w)} ${r(0.82 * h)} Q${r(0.05 * w)} ${r(0.05 * h)} ${r(0.5 * w)} ${r(0.05 * h)} Q${r(0.95 * w)} ${r(0.05 * h)} ${r(0.95 * w)} ${r(0.82 * h)} Z`, GRIP)] },
  brush: { cm: 22, aspect: 0.18, tip: [0, 0.5], motion: 'stroke', shapes: (w, h) => [
    S(poly(w, h, [[0, 0.1], [0.2, 0.1], [0.2, 0.9], [0, 0.9]]), '#5a4632'),
    S(poly(w, h, [[0.2, 0.15], [0.32, 0.2], [0.32, 0.8], [0.2, 0.85]]), STEEL),
    S(poly(w, h, [[0.32, 0.3], [1, 0.35], [1, 0.65], [0.32, 0.7]]), WOOD)] },
  glue: { cm: 16, aspect: 0.35, tip: [0, 0.5], motion: 'stroke', shapes: (w, h) => [
    S(poly(w, h, [[0, 0.44], [0.2, 0.3], [0.2, 0.7], [0, 0.56]]), '#ff8a00'),
    S(poly(w, h, [[0.2, 0.05], [1, 0.05], [1, 0.95], [0.2, 0.95]]), '#ffffff')] },
  pencil: { cm: 17, aspect: 0.07, tip: [0, 0.5], motion: 'mark', shapes: (w, h) => [
    S(poly(w, h, [[0, 0.5], [0.1, 0], [0.1, 1]]), '#e8c48f'),
    S(poly(w, h, [[0.1, 0], [1, 0], [1, 1], [0.1, 1]]), '#ffcc00')] },
  square: { cm: 25, aspect: 0.6, tip: [0, 1], motion: 'press', shapes: (w, h) => [
    S(poly(w, h, [[0, 0.82], [1, 0.82], [1, 1], [0, 1]]), STEEL),
    S(poly(w, h, [[0.82, 0], [1, 0], [1, 0.82], [0.82, 0.82]]), WOOD)] },
  level: { cm: 40, aspect: 0.09, tip: [0, 1], motion: 'press', shapes: (w, h) => [
    S(poly(w, h, [[0, 0], [1, 0], [1, 1], [0, 1]]), '#ffcc00'),
    S(ellipse(r(0.5 * w), r(0.5 * h), r(0.07 * w), r(0.25 * h)), '#9be2a8')] },
  wrench: { cm: 20, aspect: 0.2, tip: [0.06, 0.5], motion: 'turn', shapes: (w, h) => [
    S(`M0 ${r(0.1 * h)} L${r(0.16 * w)} ${r(0.1 * h)} L${r(0.16 * w)} ${r(0.38 * h)} L${r(0.08 * w)} ${r(0.38 * h)} L${r(0.08 * w)} ${r(0.62 * h)} L${r(0.16 * w)} ${r(0.62 * h)} L${r(0.16 * w)} ${r(0.9 * h)} L0 ${r(0.9 * h)} Z`, STEEL),
    S(poly(w, h, [[0.16, 0.3], [1, 0.35], [1, 0.65], [0.16, 0.7]]), STEEL)] },
  scissors: { cm: 18, aspect: 0.45, tip: [0, 0.45], motion: 'snip', shapes: (w, h) => [
    S(poly(w, h, [[0, 0.4], [0.55, 0.3], [0.55, 0.45]]), STEEL), S(poly(w, h, [[0, 0.5], [0.55, 0.45], [0.55, 0.6]]), STEEL),
    S(ellipse(r(0.72 * w), r(0.25 * h), r(0.14 * w), r(0.2 * h)), GRIP), S(ellipse(r(0.72 * w), r(0.75 * h), r(0.14 * w), r(0.2 * h)), GRIP)] },
  needle: { cm: 6, aspect: 0.08, tip: [0, 0.5], motion: 'stroke', shapes: (w, h) => [
    S(poly(w, h, [[0, 0.5], [0.2, 0.2], [1, 0.2], [1, 0.8], [0.2, 0.8]]), STEEL)] },
  // Fasteners: put into a part by a tool (the "n" of them).
  screw: { cm: 4, aspect: 0.3, tip: [0, 0.5], motion: 'turn', fastener: true, shapes: (w, h) => [
    S(poly(w, h, [[0, 0.5], [0.2, 0.3], [0.8, 0.3], [0.8, 0.7], [0.2, 0.7]]), STEEL),
    S(poly(w, h, [[0.8, 0], [1, 0], [1, 1], [0.8, 1]]), STEEL)] },
  nail: { cm: 5, aspect: 0.2, tip: [0, 0.5], motion: 'tap', fastener: true, shapes: (w, h) => [
    S(poly(w, h, [[0, 0.5], [0.1, 0.38], [0.9, 0.38], [0.9, 0.62], [0.1, 0.62]]), STEEL), S(poly(w, h, [[0.9, 0], [1, 0], [1, 1], [0.9, 1]]), STEEL)] },
  dowel: { cm: 4, aspect: 0.2, tip: [0, 0.5], motion: 'tap', fastener: true, shapes: (w, h) => [S(poly(w, h, [[0, 0.1], [1, 0.1], [1, 0.9], [0, 0.9]]), WOOD)] },
  bolt: { cm: 5, aspect: 0.3, tip: [0, 0.5], motion: 'turn', fastener: true, shapes: (w, h) => [
    S(poly(w, h, [[0, 0.32], [0.8, 0.32], [0.8, 0.68], [0, 0.68]]), STEEL), S(poly(w, h, [[0.8, 0], [1, 0], [1, 1], [0.8, 1]]), DARK)] },
}
export const TOOL_KINDS = Object.keys(KINDS)

// Yarn weights (the Craft Yarn Council's names): single-crochet stitches per 10 cm, and how thick a strand of it is
// drawn on the frame, in pixels.
const WEIGHTS = {
  lace: { gauge: 32, strand: 2 }, fingering: { gauge: 28, strand: 2.5 }, sport: { gauge: 24, strand: 3 },
  dk: { gauge: 21, strand: 3.5 }, worsted: { gauge: 16, strand: 4.5 }, aran: { gauge: 14, strand: 5.5 },
  bulky: { gauge: 11, strand: 7 }, 'super-bulky': { gauge: 8, strand: 9 }, jumbo: { gauge: 5, strand: 12 },
}

export function withTools(script, geometry, sizes, vectors) {
  const acts = (script.steps || []).flatMap((s) => s.do || [])
  const used = new Set(acts.flatMap((a) => [a.k, a.to, a.with]).filter((k) => sizes[k]))
  const widths = [...used].map((k) => sizes[k].width).sort((a, b) => a - b)
  const unit = widths.length ? widths[widths.length >> 1] : 80
  // Cut-out pixels per cm: from the objects whose real length the script gave, the median; else the unit over 10 cm.
  const perCm = (script.objects || []).filter((o) => +o.cm > 0 && sizes[o.k]).map((o) => Math.max(sizes[o.k].width, sizes[o.k].height) / +o.cm).sort((a, b) => a - b)
  const pxPerCm = perCm.length ? perCm[perCm.length >> 1] : unit / 10
  const g = { ...geometry }, s = { ...sizes }, v = { ...vectors }
  for (const o of script.objects || []) if (sizes[o.k] && g[o.k] && completeIllustration(script, o)) {
    const { width, height } = illustrationFrame(script, o, sizes[o.k])
    s[o.k] = { width, height }
    g[o.k] = { ...g[o.k], origin: [o.b[0], o.b[1]], turn: 0, ends: undefined,
      seat: [width / 2, 0], base: [width / 2, height], completeIllustration: true, photoBox: o.b }
  }
  // Supplies never enter photo segmentation. Keep generated artwork when it arrives;
  // simple stock geometry also supports layout and offline planning before artwork exists.
  for (const o of script.objects || []) if (o.source === 'additional-supply') {
    const [L, W, H] = o.part.size, width = Math.max(1, L * pxPerCm)
    const height = Math.max(1, (['sheet', 'rod'].includes(o.part.family) || script.view === 'plan' ? W : H) * pxPerCm)
    s[o.k] = { width, height }
    g[o.k] = { origin: [0, 0], seat: [width / 2, 0], base: [width / 2, height], supplied: true }
    v[o.k] ||= { width: Math.round(width * 4), height: Math.round(height * 4), parts: [{ id: o.k, parent: null,
      pivot: [width * 2, height * 4], shapes: [S(poly(width * 4, height * 4, [[0, 0], [1, 0], [1, 1], [0, 1]]), '#f2ead8')] }] }
  }
  for (const [k, drawing] of Object.entries(v)) {
    if (g[k]?.completeIllustration && Array.isArray(drawing.outlet) && drawing.outlet.length === 2 &&
      drawing.outlet.every((n, i) => Number.isFinite(n) && n >= 0 && n <= [drawing.width, drawing.height][i]))
      g[k] = { ...g[k], seat: drawing.outlet.map(x => x / 4) }
    const vessel = vesselGeometry(drawing)
    if (vessel && g[k]) g[k] = { ...g[k], seat: vessel.seat.map(x => x / 4), vessel }
  }
  const sheets = sheetParts(script), sheetWork = hasSheetCuts(script) || acts.some((a) => a.path)
  if (sheetWork) for (const [k, p] of sheets) if (p.stock && g[k]) g[k] = { ...g[k], sheet: p }
  // A photographed tool keeps its own tracing and dimensions, but gets explicit behavior rather than being
  // mistaken for another board. Tip coordinates are mapped through SAM's straightening into the cut-out.
  for (const o of script.objects || []) if (o.toolKind && KINDS[o.toolKind] && g[o.k] && s[o.k]) {
    const q = g[o.k], kind = KINDS[o.toolKind], size = s[o.k]
    let tip = q.ends?.[0] || [kind.tip[0] * size.width, kind.tip[1] * size.height]
    if (o.tip) {
      const c = q.center || [0, 0], turn = q.turn || 0, x = o.tip[0] - c[0], y = o.tip[1] - c[1]
      tip = [c[0] + x * Math.cos(turn) + y * Math.sin(turn) - q.origin[0],
        c[1] - x * Math.sin(turn) + y * Math.cos(turn) - q.origin[1]]
    }
    g[o.k] = { ...q, tool: true, use: o.toolKind, motion: kind.motion, fastener: !!kind.fastener, tip: tip.map((v) => v * 4) }
  }
  // In the plan and front views a board is as long as it really is: a photo taken at an angle makes the same batten
  // look shorter at the back. (Its cut parts, sliced after this, share that length out.)
  if (script.view === 'plan' || script.view === 'front')
    for (const o of script.objects || []) {
      const k = o.k
      if (!(+o.cm > 0) || !s[k] || s[k].width < 2.5 * s[k].height || g[k]?.tool) continue
      const width = Math.round(+o.cm * pxPerCm)
      if (v[k]) v[k] = { ...v[k], width: width * 4 }
      g[k] = { ...g[k], seat: [width / 2, g[k].seat[1]], base: [width / 2, g[k].base[1]] }
      s[k] = { ...s[k], width }
    }

  // A tool's kind: its "use", else its key, else a known name in either ("cutting-board" → board).
  const kindOf = (tool) => KINDS[tool.use] || KINDS[tool.k]
    || KINDS[TOOL_KINDS.find((name) => new RegExp(`\\b${name}`).test(`${tool.k} ${tool.use}`)) || '']
  for (const tool of script.tools || []) {
    const kind = kindOf(tool)
    if (!kind || sizes[tool.k]) continue
    // In cut-out pixels, as the photo's objects are; the drawing is four times that.
    const cm = +tool.cm > 0 ? +tool.cm : kind.cm
    const width = Math.max(4, Math.round(cm * pxPerCm)), height = Math.max(3, Math.round(cm * kind.aspect * pxPerCm)), w = width * 4, h = height * 4
    s[tool.k] = { width, height }
    const seat = kind.seat || [0.5, 0], base = kind.base || [0.5, 1]
    g[tool.k] = { origin: [0, 0], seat: [seat[0] * width, seat[1] * height], base: [base[0] * width, base[1] * height], tool: true,
      use: TOOL_KINDS.find((name) => KINDS[name] === kind), motion: kind.motion, fastener: !!kind.fastener, tip: [kind.tip[0] * w, kind.tip[1] * h] }
    v[tool.k] = { width: w, height: h, parts: [{ id: tool.k, parent: null, pivot: [w / 2, h], shapes: kind.shapes(w, h) }] }
  }

  for (const piece of script.makes || []) {
    if (sizes[piece.k]) continue
    const shape = ['flat', 'round', 'ball', 'tube', 'square', 'hexagon', 'flower'].includes(piece.shape) ? piece.shape : 'flat'
    // (a motif — round, square, hexagon, flower — may be one of several worked and joined into one piece: a pouch of
    // granny squares, a cushion of hexagons; laid out "cols" across, the rest in rows)
    const motif = ['round', 'square', 'hexagon', 'flower'].includes(shape)
    const motifs = motif ? Math.min(36, Math.max(1, Math.round(+piece.motifs || 1))) : 1
    const cols = Math.min(motifs, Math.max(1, Math.round(+piece.cols || Math.ceil(Math.sqrt(motifs)))))
    // Its size: its real width, else `size` times the width of the yarn it is worked from (or of the unit).
    const from = acts.find((a) => a.v === 'work' && a.k === piece.k && sizes[a.to])
    const width = +piece.cm > 0 && perCm.length ? Math.round(+piece.cm * pxPerCm)
      : Math.round(Math.min(4, Math.max(0.4, +piece.size || 1.5)) * (from ? sizes[from.to].width : unit))
    const aspect = motif ? Math.ceil(motifs / cols) / cols : shape === 'ball' ? 1 : Math.min(4, Math.max(0.25, +piece.aspect || 0.7))
    const height = Math.round(width * aspect)
    s[piece.k] = { width, height }
    // Its stitches as its pattern counts them: a round piece's first round (each round after adds as many), a flat
    // piece's row; else as many as its yarn's weight fits across its width (single crochet, per 10 cm).
    const weight = WEIGHTS[piece.weight] ? piece.weight : 'worsted', rows = Math.min(30, Math.max(3, Math.round(+piece.rows || 10)))
    const across = Math.round((+piece.cm || 20) / 10 * WEIGHTS[weight].gauge)
    g[piece.k] = { origin: [0, 0], seat: [width / 2, 0], base: [width / 2, height], tool: true,
      piece: { shape, rows, weight, strand: WEIGHTS[weight].strand, motifs, cols, petals: Math.min(12, Math.max(3, Math.round(+piece.petals || +piece.start || 6))),
        start: Math.min(16, Math.max(3, Math.round(+piece.start || 6))),
        stitches: Math.min(80, Math.max(3, Math.round(+piece.stitches || across))),
        colors: (piece.colors || []).filter((c) => /^#[0-9a-f]{6}$/i.test(c)).slice(0, 4) } }
    v[piece.k] = { width: width * 4, height: height * 4, parts: [{ id: piece.k, parent: null, pivot: [width * 2, height * 4], shapes: [] }] }
  }

  // Cut into named parts: each a slice of its object along its length, in order — as long as its label says when the
  // object's own length is known (what is left over is the offcut), else its share of the labels, else an equal share.
  // A slice keeps its object's cut-out and drawing, clipped to its stretch.
  for (const a of acts) {
    if (a.v !== 'cut' || !Array.isArray(a.into) || !s[a.k]) continue
    if (a.into.some((p) => p.size)) {
      for (const p of a.into) {
        const part = sheets.get(p.k)
        if (!part?.size) continue
        const [width, height] = part.size.map((x) => x * pxPerCm)
        s[p.k] = { width, height }
        g[p.k] = { ...g[a.k], sheet: part, sliceOf: a.k, slice: [0, width], label: p.label,
          seat: [width / 2, 0], base: [width / 2, height], tool: false, ends: undefined }
        const d = part.outline.map(([x, y], i) => `${i ? 'L' : 'M'}${x * pxPerCm * 4} ${y * pxPerCm * 4}`).join(' ') + ' Z'
        v[p.k] = { width: width * 4, height: height * 4, parts: [{ id: p.k, parent: null, pivot: [width * 2, height * 4],
          shapes: [{ d, fill: g[a.k].color || '#d0b8a0', stroke: INK }] }] }
      }
      continue
    }
    const whole = s[a.k], parts = a.into.filter((p) => p && p.k && !s[p.k])
    const cms = parts.map((p) => parseFloat(p.cm ?? p.label) || 0), sum = cms.reduce((x, y) => x + y, 0)
    let x0 = 0
    parts.forEach((p, i) => {
      const whole_cm = +(script.objects || []).find((o) => o.k === a.k)?.cm || 0
      const share = cms.every((c) => c > 0) ? (whole_cm >= sum ? cms[i] / whole_cm : cms[i] / sum) : 1 / parts.length
      const width = Math.max(2, Math.round(whole.width * share)), height = whole.height
      s[p.k] = { width, height }
      const src = g[a.k]
      g[p.k] = { ...src, seat: [width / 2, src.seat[1]], base: [width / 2, src.base[1]], ends: undefined, tool: false,
        sliceOf: a.k, slice: [x0, x0 + width], label: p.label || (p.cm ? `${p.cm} cm` : '') }
      const whole4 = v[a.k] || { height: whole.height * 4, parts: [{ id: a.k, parent: null, pivot: [whole.width * 2, whole.height * 4], shapes: [] }], cutOut: true }
      v[p.k] = { ...whole4, width: width * 4, slice: [x0 * 4, (x0 + width) * 4], sliceOf: a.k }
      const sourceCm = +(script.objects || []).find(o => o.k === a.k)?.cm || 0
      x0 += width + (sourceCm > 0 ? (+a.kerfCm || 0) * whole.width / sourceCm : 0)
    })
  }
  return { geometry: g, sizes: s, vectors: v }
}
