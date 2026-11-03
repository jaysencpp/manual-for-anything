// Associate semantic segmentation candidates with requested boxes, without assigning one mask twice.
export function overlap(a, b) {
  const width = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
  const height = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
  const intersection = width * height
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]), areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1])
  return intersection / Math.max(1, areaA + areaB - intersection)
}

// Request index → candidate index. Geometry leads; confidence breaks close ties; a request still unmatched takes the
// nearest free confident candidate near its box.
export function associate(requests, candidates, scores, excluded = []) {
  const skip = new Set(excluded), pairs = []
  requests.forEach((request, i) => candidates.forEach((candidate, j) => {
    const iou = overlap(request, candidate)
    if (!skip.has(j) && scores[j] >= 0.5 && iou >= 0.05) pairs.push([iou + 0.05 * scores[j], i, j])
  }))
  const assigned = {}, used = new Set(skip)
  const take = (i, j) => { if (!(i in assigned) && !used.has(j)) { assigned[i] = j; used.add(j) } }
  pairs.sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2]).forEach(([, i, j]) => take(i, j))
  // A request the overlap left unmatched takes the nearest confident instance of its class still free, when that lies
  // near its box (its middle within 1.5 of the box's diagonals): a model's box can be off by a box or so, and SAM's own
  // find of "black computer keyboard" is then a better answer than a mask of the wrong patch. Farther stays unrelated.
  const middle = b => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2], near = []
  requests.forEach((request, i) => {
    if (i in assigned) return
    const reach = 1.5 * Math.hypot(request[2] - request[0], request[3] - request[1]), [rx, ry] = middle(request)
    candidates.forEach((candidate, j) => {
      if (used.has(j) || scores[j] < 0.5) return
      const [cx, cy] = middle(candidate), distance = Math.hypot(rx - cx, ry - cy)
      if (distance <= reach) near.push([distance, i, j])
    })
  })
  near.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]).forEach(([, i, j]) => take(i, j))
  return assigned
}

// The colour a name gives its object ("light green plastic brick": green), or null. "Blue-handled scissors" and "dark
// bottle with white cap" name only a part's colour, so they give none.
const COLOUR_WORD = /\b(red|orange|yellow|green|blue|purple|pink|brown|black|white|gr[ae]y)\b(?!-)/i
const DESCRIBES_SOMETHING_ELSE = /\b(?:with|behind|beside|near|next to|in front of|under|on|in|of|from|and)\b/i
export const namedColour = name => COLOUR_WORD.exec(String(name || '').split(DESCRIBES_SOMETHING_ELSE)[0])?.[1].toLowerCase().replace('gray', 'grey') ?? null

// Hue ranges in degrees, generous where neighbours blur: a shiny or shaded thing's average colour is never exact.
const HUES = { red: [335, 25], orange: [10, 50], yellow: [35, 78], green: [65, 175], blue: [165, 265], purple: [255, 315], pink: [305, 350] }
export function looksLike(word, [r, g, b]) {
  const high = Math.max(r, g, b), low = Math.min(r, g, b), value = high / 255, saturation = high ? (high - low) / high : 0
  if (word === 'black') return value < 0.3
  if (word === 'white') return saturation < 0.2 && value > 0.7
  if (word === 'grey') return saturation < 0.2 && value >= 0.25
  if (saturation < 0.2 || value < 0.15) return false
  const span = high - low
  const hue = (high === r ? (g - b) / span + 6 : high === g ? (b - r) / span + 2 : (r - g) / span + 4) * 60 % 360
  if (word === 'brown') return hue <= 55 && value < 0.75 || hue >= 345 && value < 0.5
  const [from, to] = HUES[word]
  return from <= to ? hue >= from && hue <= to : hue >= from || hue <= to
}

// Colour only tells objects apart when a class's objects are named by at least two different colours.
export const coloursDistinguish = names => new Set(names.map(namedColour).filter(Boolean)).size >= 2

// Boxes can sit on the wrong thing, so a box match that contradicts the object's name gives way to the nearest free
// instance of that colour. An object with no such instance keeps its match and is reported, since we have no better one.
export function settleColours(names, requests, candidates, scores, colours, assigned) {
  const settled = { ...assigned }, words = names.map(namedColour), moved = [], mismatched = []
  const fits = (i, j) => colours[j] != null && looksLike(words[i], colours[j])
  const wrong = names.flatMap((_, i) => words[i] && !(i in assigned && fits(i, assigned[i])) ? [i] : [])
  for (const i of wrong) delete settled[i]
  const held = new Set(Object.values(settled)), middle = b => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2], pairs = []
  for (const i of wrong) candidates.forEach((candidate, j) => {
    if (held.has(j) || scores[j] < 0.5 || !fits(i, j)) return
    const [rx, ry] = middle(requests[i]), [cx, cy] = middle(candidate)
    pairs.push([Math.hypot(rx - cx, ry - cy), i, j])
  })
  pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
  for (const [, i, j] of pairs) if (!(i in settled) && !held.has(j)) { settled[i] = j; held.add(j); moved.push(i) }
  for (const i of wrong) {
    if (i in settled) continue
    mismatched.push(i)
    if (i in assigned && !held.has(assigned[i])) { settled[i] = assigned[i]; held.add(assigned[i]) }
  }
  return { assigned: settled, moved, mismatched }
}

// Segmentation evidence is not identity or scale confirmation.
export function maskEvidence(requestBox, maskBox, confidence, method) {
  const agreement = overlap(requestBox, maskBox), warnings = []
  if (confidence < 0.5) warnings.push('low mask confidence')
  if (agreement < 0.2) warnings.push('mask and requested box disagree')
  return { maskConfidence: +confidence.toFixed(4), boxIoU: +agreement.toFixed(4), method, identityVerified: false, scaleVerified: false, warnings }
}
