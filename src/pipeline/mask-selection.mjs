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

// Segmentation evidence is not identity or scale confirmation.
export function maskEvidence(requestBox, maskBox, confidence, method) {
  const agreement = overlap(requestBox, maskBox), warnings = []
  if (confidence < 0.5) warnings.push('low mask confidence')
  if (agreement < 0.2) warnings.push('mask and requested box disagree')
  return { maskConfidence: +confidence.toFixed(4), boxIoU: +agreement.toFixed(4), method, identityVerified: false, scaleVerified: false, warnings }
}
