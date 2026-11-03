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
const COLOUR_WORD = /\b(red|orange|yellow|lime|green|blue|purple|pink|brown|black|white|gr[ae]y)\b(?!-)/i
const DESCRIBES_SOMETHING_ELSE = /\b(?:with|behind|beside|near|next to|in front of|under|on|in|at|of|from|and)\b/i
const namedPart = name => String(name || '').split(DESCRIBES_SOMETHING_ELSE)[0]
export const namedColour = name => {
  const word = COLOUR_WORD.exec(namedPart(name))?.[1].toLowerCase().replace('gray', 'grey')
  return word === 'lime' ? 'green' : word ?? null
}

// The shade within that colour: "lime" and "light green" differ from "green", "light blue" and "dark blue" from "blue".
export function namedShade(name) {
  const part = namedPart(name).toLowerCase(), word = namedColour(part)
  if (!word) return null
  if (/\b(?:lime|light green)\b/.test(part)) return 'lime'
  const modifier = /\b(light|pale|sky)\b/.test(part) ? 'light ' : /\b(dark|navy|deep)\b/.test(part) ? 'dark ' : ''
  return modifier + word
}

const hsv = ([r, g, b]) => {
  const high = Math.max(r, g, b), low = Math.min(r, g, b), span = high - low
  const hue = span ? (high === r ? (g - b) / span + 6 : high === g ? (b - r) / span + 2 : (r - g) / span + 4) * 60 % 360 : 0
  return { hue, saturation: high ? span / high : 0, value: high / 255 }
}

// Hue ranges in degrees, generous where neighbours blur: a shiny or shaded thing's average colour is never exact.
const HUES = { red: [335, 25], orange: [10, 50], yellow: [30, 78], green: [65, 175], blue: [165, 265], purple: [255, 315], pink: [305, 350] }
export function looksLike(word, colour) {
  const { hue, saturation, value } = hsv(colour)
  if (word === 'black') return value < 0.3
  if (word === 'white') return saturation < 0.2 && value > 0.7
  if (word === 'grey') return saturation < 0.2 && value >= 0.25
  if (saturation < 0.2 || value < 0.15) return false
  if (word === 'brown') return hue <= 55 && value < 0.75 || hue >= 345 && value < 0.5
  const [from, to] = HUES[word]
  return from <= to ? hue >= from && hue <= to : hue >= from || hue <= to
}

// How far a colour is from the shade a name asks for: hue first, and saturation or brightness when the name says light
// or dark. Lower is closer; only comparisons between candidates mean anything.
const SHADE_HUES = { red: 0, orange: 25, yellow: 50, lime: 80, green: 120, blue: 215, purple: 280, pink: 330, brown: 25 }
export function shadeCost(name, colour) {
  const shade = namedShade(name), word = namedColour(name), { hue, saturation, value } = hsv(colour)
  const missed = looksLike(word, colour) ? 0 : 0.5, base = shade.replace(/^(light|dark) /, '')
  if (!(base in SHADE_HUES)) return missed
  const apart = Math.abs(hue - SHADE_HUES[base]), distance = Math.min(apart, 360 - apart) / 60
  if (shade.startsWith('light ')) return missed + distance + Math.abs(saturation - 0.55) * 0.6
  if (shade.startsWith('dark ')) return missed + distance + Math.abs(value - 0.45) * 0.6
  return missed + distance
}

// Colour only tells objects apart when a class's objects are named by at least two different shades.
export const coloursDistinguish = names => new Set(names.map(namedShade).filter(Boolean)).size >= 2

// Boxes can sit on the wrong thing, so a box match that contradicts the object's name gives way to the nearest free
// instance of that colour. Then closer shades win: "lime" and "green" both pass as green, so each takes the instance
// nearest its own shade. Equal shades stay with their box matches unless their sizes clearly say otherwise: a box several
// times the size of another belongs on the larger of the two instances, even when both boxes are misplaced.
const SHADE_MARGIN = 0.1, CLEARLY_LARGER = 1.5
const area = b => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1])
export function settleColours(names, requests, candidates, scores, colours, assigned) {
  const settled = { ...assigned }, words = names.map(namedColour), moved = new Set()
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
  for (const [, i, j] of pairs) if (!(i in settled) && !held.has(j)) { settled[i] = j; held.add(j); moved.add(i) }
  const usable = j => !held.has(j) && scores[j] >= 0.5 && colours[j] != null
  for (const i of wrong) {
    if (i in settled) continue
    if (i in assigned && !held.has(assigned[i])) { settled[i] = assigned[i]; held.add(assigned[i]); continue }
    // Its match went to another object: the closest instance left, so that the shades below can still sort it out.
    const left = candidates.map((_, j) => j).filter(usable).sort((a, b) => shadeCost(names[i], colours[a]) - shadeCost(names[i], colours[b]))
    if (left.length) { settled[i] = left[0]; held.add(left[0]); moved.add(i) }
  }

  const named = names.flatMap((_, i) => words[i] && i in settled && colours[settled[i]] != null ? [i] : [])
  const cost = (i, j) => shadeCost(names[i], colours[j])
  for (let changed = true, rounds = 0; changed && rounds < 50; rounds++) {
    changed = false
    for (const i of named) candidates.forEach((_, j) => {
      if (!usable(j) || cost(i, settled[i]) - cost(i, j) <= SHADE_MARGIN) return
      held.delete(settled[i]); settled[i] = j; held.add(j); moved.add(i); changed = true
    })
    for (const i of named) for (const k of named) {
      if (i >= k) continue
      const a = settled[i], b = settled[k]
      if (cost(i, a) + cost(k, b) - cost(i, b) - cost(k, a) <= SHADE_MARGIN) continue
      settled[i] = b; settled[k] = a; moved.add(i); moved.add(k); changed = true
    }
  }
  for (const i of named) for (const k of named) {
    if (namedShade(names[i]) !== namedShade(names[k]) || area(requests[i]) < CLEARLY_LARGER * area(requests[k])) continue
    if (area(candidates[settled[k]]) < CLEARLY_LARGER * area(candidates[settled[i]])) continue
    [settled[i], settled[k]] = [settled[k], settled[i]]; moved.add(i); moved.add(k)
  }
  const mismatched = names.flatMap((_, i) => words[i] && !(i in settled && fits(i, settled[i])) ? [i] : [])
  return { assigned: settled, moved: [...moved], mismatched }
}

// Segmentation evidence is not identity or scale confirmation.
export function maskEvidence(requestBox, maskBox, confidence, method) {
  const agreement = overlap(requestBox, maskBox), warnings = []
  if (confidence < 0.5) warnings.push('low mask confidence')
  if (agreement < 0.2) warnings.push('mask and requested box disagree')
  return { maskConfidence: +confidence.toFixed(4), boxIoU: +agreement.toFixed(4), method, identityVerified: false, scaleVerified: false, warnings }
}
