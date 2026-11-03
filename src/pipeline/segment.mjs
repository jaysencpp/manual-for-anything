// Cut a plan's objects out of the photo with SAM on the Meta Model API. Visual-class queries find instances and box
// queries find each object's mask; local image processing writes each object's PNG, screens.json, geometry.json and
// perception evidence. A high SAM score does not confirm identity or real-world scale.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { buildObjectPrompt, decodeMaskToRaster, formats } from '@meta-sam/parser'
import sharp from 'sharp'
import { associate, claimLeftovers, coloursDistinguish, looksLike, maskEvidence, namedColour, settleColours } from './mask-selection.mjs'

const PAD = 6, MAX_BOX_OBJECTS = 16, RETRIES = 3, TIMEOUT_MS = 120000, TRANSIENT = new Set([408, 429, 500, 502, 503, 504])

export class Segmenter {
  constructor({ width, height, jpeg }, { env = process.env, signal } = {}) {
    Object.assign(this, { width, height, signal })
    this.model = env.SAM_MODEL || 'sam-3.1'
    this.endpoint = `${(env.META_BASE_URL || 'https://api.meta.ai/v1/').replace(/\/+$/, '')}/responses`
    if (env.NODE_ENV === 'production' && new URL(this.endpoint).protocol !== 'https:') throw new Error('Production SAM API endpoint must use HTTPS')
    this.key = env.MODEL_API_KEY || env.META_API_KEY
    if (!this.key) throw new Error("SAM API needs MODEL_API_KEY (the project's .env.local)")
    // (a JPEG, not a PNG: about a tenth of the upload, which every request repeats; same pixels, same coordinates)
    this.image = `data:image/jpeg;base64,${jpeg.toString('base64')}`
  }

  // A request with bounded transient retries. Redirects are refused: an authenticated request is never forwarded.
  async request(text) {
    const body = JSON.stringify({ model: this.model, stream: false, metadata: { include_confidence: 'true' },
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }, { type: 'input_image', image_url: this.image }] }] })
    for (let attempt = 0; ; attempt++) {
      let wait = 2 ** attempt, transient, failure
      try {
        const signals = [AbortSignal.timeout(TIMEOUT_MS), ...(this.signal ? [this.signal] : [])]
        const response = await fetch(this.endpoint, { method: 'POST', redirect: 'manual', body, signal: AbortSignal.any(signals),
          headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json', Accept: 'application/json' } })
        if (response.ok) return await response.json()
        transient = TRANSIENT.has(response.status)
        // Only log a short, redacted message; never the request or image.
        const message = String((await response.json().catch(() => null))?.error?.message || '')
        failure = `SAM API HTTP ${response.status}${message ? `: ${message.replaceAll(this.key, '***').slice(0, 200)}` : ''}`
        const after = Number(response.headers.get('retry-after'))
        if (Number.isFinite(after)) wait = Math.min(30, Math.max(wait, after))
      } catch (error) {
        if (this.signal?.aborted) throw error
        transient = true
        failure = 'SAM API connection failed or timed out'
      }
      if (!transient || attempt === RETRIES - 1) throw new Error(failure)
      console.error(`${failure}; retry ${attempt + 1}/${RETRIES - 1} in ${wait}s`)
      await delay(wait * 1000, undefined, this.signal ? { signal: this.signal } : {})
    }
  }

  async ask(text) {
    const answer = await this.request(text)
    const output = answer.output_text || (answer.output || []).flatMap(item => item.content || [])
      .filter(part => part.type === 'output_text').map(part => part.text || '').join('')
    const parser = formats.segmentation.image().createParser()
    parser.push(output)
    const { records } = parser.finish({ status: 'completed' }).result
    const masks = new Map(records.filter(r => r.kind === 'mask').map(r => [r.objectId, r]))
    return records.filter(r => r.kind === 'box').map(box => {
      const m = masks.get(box.objectId)
      return { id: box.objectId, box: [box.left, box.top, box.right, box.bottom],
        raster: m ? { data: decodeMaskToRaster(m.mask), width: m.mask.width, height: m.mask.height } : null,
        bounds: m?.bounds ?? null, confidence: box.confidence ?? m?.confidence ?? 1 }
    })
  }

  // A box-local raster placed in the photo, stretched to its bounds if it came back at another size.
  place(raster, bounds) {
    const out = new Uint8Array(this.width * this.height)
    if (!raster || !bounds) return out
    const left = Math.trunc(bounds.left), top = Math.trunc(bounds.top), w = Math.trunc(bounds.right) - left, h = Math.trunc(bounds.bottom) - top
    const x0 = Math.max(0, left), y0 = Math.max(0, top), x1 = Math.min(this.width, left + w), y1 = Math.min(this.height, top + h)
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const sx = Math.floor(((x - left + 0.5) * raster.width) / w), sy = Math.floor(((y - top + 0.5) * raster.height) / h)
      out[y * this.width + x] = raster.data[sy * raster.width + sx] > 0 ? 1 : 0
    }
    return out
  }

  async find(query) {
    const found = await this.ask(query)
    return { boxes: found.map(f => f.box), scores: found.map(f => f.confidence), masks: found.map(f => this.place(f.raster, f.bounds)) }
  }

  async byBoxes(boxes) {
    const objects = boxes.map(([x0, y0, x1, y1], i) => ({ id: i + 1, prompts: [{ box: {
      left: Math.trunc(Math.max(0, x0)), top: Math.trunc(Math.max(0, y0)),
      right: Math.trunc(Math.min(this.width, Math.round(x1))), bottom: Math.trunc(Math.min(this.height, Math.round(y1))) } }] }))
    // The model takes at most MAX_BOX_OBJECTS objects a request; ids stay unique across the batches.
    const batches = []
    for (let i = 0; i < objects.length; i += MAX_BOX_OBJECTS) batches.push(objects.slice(i, i + MAX_BOX_OBJECTS))
    const answers = await limited(batches, 4, batch => this.ask(buildObjectPrompt({ size: { width: this.width, height: this.height }, objects: batch })))
    const found = new Map(answers.flat().map(f => [String(f.id), f]))
    return { masks: boxes.map((_, i) => { const f = found.get(String(i + 1)); return f ? this.place(f.raster, f.bounds) : new Uint8Array(this.width * this.height) }),
      scores: boxes.map((_, i) => found.get(String(i + 1))?.confidence ?? 0) }
  }
}

const any = mask => mask.some(Boolean)
const count = mask => mask.reduce((total, v) => total + (v > 0 ? 1 : 0), 0)
async function limited(items, limit, work) {
  const results = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await work(items[i]) }
  }))
  return results
}

// [left, top, right, bottom] of the pixels with alpha above zero, or [0, 0, 1, 1] when there are none.
function alphaBounds(rgba, width, height) {
  let left = width, top = height, right = 0, bottom = 0
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (rgba[(y * width + x) * 4 + 3]) {
    if (x < left) left = x
    if (x >= right) right = x + 1
    if (y < top) top = y
    if (y >= bottom) bottom = y + 1
  }
  return right ? [left, top, right, bottom] : [0, 0, 1, 1]
}

// The principal axis of points: its unit vector and the eigenvalues, largest first (sample covariance).
export function principalAxis(xs, ys) {
  const n = xs.length
  let mx = 0, my = 0
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i] }
  mx /= n; my /= n
  let a = 0, b = 0, d = 0
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; a += dx * dx; b += dx * dy; d += dy * dy }
  a /= n - 1; b /= n - 1; d /= n - 1
  const middle = (a + d) / 2, spread = Math.hypot((a - d) / 2, b), large = middle + spread, small = middle - spread
  let vx = b, vy = large - a
  if (Math.abs(vx) + Math.abs(vy) < 1e-12) [vx, vy] = a >= d ? [1, 0] : [0, 1]
  const length = Math.hypot(vx, vy)
  return { axis: [vx / length, vy / length], large, small, mean: [mx, my] }
}

// The picture turned about a centre into a same-sized canvas; what falls outside stays transparent.
export function rotated(rgba, width, height, turn, [cx, cy]) {
  const out = new Uint8Array(rgba.length), c = Math.cos(turn), s = Math.sin(turn)
  const cubic = t => { t = Math.abs(t); return t < 1 ? 1.5 * t ** 3 - 2.5 * t ** 2 + 1 : t < 2 ? -0.5 * t ** 3 + 2.5 * t ** 2 - 4 * t + 2 : 0 }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const dx = x + 0.5 - cx, dy = y + 0.5 - cy, sx = c * dx - s * dy + cx, sy = s * dx + c * dy + cy
    if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue
    const ix = Math.floor(sx - 0.5), iy = Math.floor(sy - 0.5), fx = sx - 0.5 - ix, fy = sy - 0.5 - iy
    for (let channel = 0; channel < 4; channel++) {
      let value = 0
      for (let j = -1; j <= 2; j++) for (let i = -1; i <= 2; i++) {
        const px = Math.max(0, Math.min(width - 1, ix + i)), py = Math.max(0, Math.min(height - 1, iy + j))
        value += rgba[(py * width + px) * 4 + channel] * cubic(i - fx) * cubic(j - fy)
      }
      out[(y * width + x) * 4 + channel] = Math.max(0, Math.min(255, Math.round(value)))
    }
  }
  return out
}

// Returns {segment seconds, scores by key, log text}. plan.objects: [{key, name, segment, box: [x, y, w, h]}].
export async function segmentPhoto(photoPath, plan, out, { env = process.env, signal } = {}) {
  const { data: photo, info } = await sharp(photoPath).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width, height } = info, lines = []
  const log = text => { lines.push(text); console.error(text) }
  const segmenter = new Segmenter({ width, height, jpeg: await sharp(photoPath).removeAlpha().jpeg({ quality: 90 }).toBuffer() }, { env, signal })
  log(`SAM via the Meta Model API (${segmenter.model})`)
  const start = performance.now(), objects = plan.objects
  const boxes = objects.map(({ box: [x, y, w, h] }) => [Math.max(0, x - PAD), Math.max(0, y - PAD), Math.min(width, x + w + PAD), Math.min(height, y + h + PAD)])
  const masks = boxes.map(() => new Uint8Array(width * height)), scores = boxes.map(() => 0)
  const cache = new Map(), used = new Map(), semantic = {}, retried = {}, colourWarnings = {}
  const averageColour = mask => {
    let red = 0, green = 0, blue = 0, pixels = 0
    mask.forEach((on, p) => { if (on) { red += photo[p * 3]; green += photo[p * 3 + 1]; blue += photo[p * 3 + 2]; pixels++ } })
    return pixels ? [red / pixels, green / pixels, blue / pixels] : null
  }

  // A spatial label like "front timber board" can retrieve the ground instead of the object. Plans provide a short
  // visual class separately: each class is asked once and its instances associated with the rough boxes. Everything
  // goes at once, so what a class does not match takes its box's mask, already in, rather than waiting for a second round.
  const groups = new Map()
  objects.forEach((o, i) => { if (o.segment) groups.set(o.segment, [...(groups.get(o.segment) || []), i]) })
  const [boxed] = await Promise.all([segmenter.byBoxes(boxes),
    limited([...groups.keys()], 7, async query => { cache.set(query, await segmenter.find(query)) })])
  // A class that matched nothing would leave every object to its box's mask, so a simpler term ("brick" for "building
  // brick") gets one more try.
  const confident = found => found.scores.filter(score => score >= 0.5).length
  await limited([...groups.keys()], 7, async query => {
    const first = cache.get(query), simpler = query.trim().split(/\s+/).at(-1)
    log(`class "${query}": ${first.boxes.length} found, ${confident(first)} confident`)
    if (confident(first) || simpler === query) return
    const again = await segmenter.find(simpler)
    log(`class "${simpler}" instead: ${again.boxes.length} found, ${confident(again)} confident`)
    if (confident(again)) cache.set(query, again)
  })
  for (const [query, indices] of groups) {
    const found = cache.get(query), requests = indices.map(i => boxes[i]), names = indices.map(i => objects[i].name)
    let matches = claimLeftovers(requests, found.boxes, found.scores, associate(requests, found.boxes, found.scores))
    if (coloursDistinguish(names)) {
      const settled = settleColours(names, requests, found.boxes, found.scores, found.masks.map(averageColour), matches)
      matches = settled.assigned
      if (settled.moved.length) log(`matched by colour instead of box: ${JSON.stringify(settled.moved.map(local => objects[indices[local]].key))}`)
    }
    used.set(query, new Set(Object.values(matches)))
    for (const [local, j] of Object.entries(matches)) {
      const i = indices[local]
      masks[i] = found.masks[j]; scores[i] = found.scores[j]; semantic[objects[i].key] = query
    }
  }
  masks.forEach((mask, i) => { if (!any(mask)) { masks[i] = boxed.masks[i]; scores[i] = boxed.scores[i] } })
  if (Object.keys(semantic).length) log(`found by visual class: ${JSON.stringify(semantic)}`)

  // Unmatched visual classes retain the box prompt, with a semantic retry for poor masks.
  const fillOf = i => { const [x0, y0, x1, y1] = boxes[i]; return count(masks[i]) / Math.max(1, (x1 - x0) * (y1 - y0)) }
  const settled = (o, i) => o.key in semantic || (fillOf(i) >= 0.2 && scores[i] >= 0.5) || !o.name
  const queries = [...new Set(objects.filter((o, i) => !settled(o, i)).map(o => o.segment || o.name))].filter(q => !cache.has(q))
  await limited(queries, 8, async query => { cache.set(query, await segmenter.find(query)) })
  objects.forEach((o, i) => {
    if (settled(o, i)) return
    const fill = fillOf(i), query = o.segment || o.name, found = cache.get(query)
    const matches = associate([boxes[i]], found.boxes, found.scores, used.get(query) || [])
    if (!(0 in matches)) return
    const j = matches[0]
    used.set(query, new Set([...(used.get(query) || []), j]))
    masks[i] = found.masks[j]; scores[i] = found.scores[j]
    retried[o.key] = Math.round(fill * 1000) / 1000
  })
  if (Object.keys(retried).length) log(`found again by name (fill of the box's mask): ${JSON.stringify(retried)}`)

  // Anything still without a mask (the API may find nothing, and says so with an empty answer) is cut out as its box,
  // its score 0 so its evidence warns: a cut-out with no pixels would stop everything after.
  const empty = objects.filter((_, i) => !any(masks[i])).map(o => o.key)
  masks.forEach((mask, i) => {
    if (any(mask)) return
    const [x0, y0, x1, y1] = boxes[i].map(Math.trunc), filled = new Uint8Array(width * height)
    for (let y = y0; y < y1; y++) filled.fill(1, y * width + x0, y * width + x1)
    masks[i] = filled; scores[i] = 0
  })
  if (empty.length) log(`no mask found, cut out as the box: ${JSON.stringify(empty)}`)

  // Checked on the final cut-outs, wherever each one came from.
  for (const indices of groups.values()) {
    if (!coloursDistinguish(indices.map(i => objects[i].name))) continue
    for (const i of indices) {
      const word = namedColour(objects[i].name), colour = averageColour(masks[i])
      if (!word || !colour || looksLike(word, colour)) continue
      colourWarnings[objects[i].key] = `named ${word}, but its cut-out does not look ${word}`
      log(`${objects[i].key}: ${colourWarnings[objects[i].key]}`)
    }
  }
  const seconds = +((performance.now() - start) / 1000).toFixed(2)
  log(`${boxes.length} objects segmented in ${seconds}s`)

  const catalog = {}, origins = {}, evidence = {}, scoreByKey = {}
  for (const [i, o] of objects.entries()) {
    const mask = masks[i], score = scores[i]
    const blurred = await sharp(Buffer.from(mask.map(v => (v ? 255 : 0))), { raw: { width, height, channels: 1 } }).blur(0.7).extractChannel(0).raw().toBuffer()
    let cut = new Uint8Array(width * height * 4)
    for (let p = 0; p < width * height; p++) { cut[p * 4] = photo[p * 3]; cut[p * 4 + 1] = photo[p * 3 + 1]; cut[p * 4 + 2] = photo[p * 3 + 2]; cut[p * 4 + 3] = blurred[p] }
    const box = alphaBounds(cut, width, height)
    evidence[o.key] = { ...maskEvidence(boxes[i], box, score, o.key in semantic || o.key in retried ? 'semantic' : 'box'), query: o.segment || o.name }

    // A long thing lying at a slant (a plank, a tool) is turned to lie level — a side view's board, not a diagonal —
    // about its middle; the film turns it back to its slant where it lifts off the photo. turn: the slant, in radians
    // (clockwise, as the canvas turns); center: its middle in the photo; a point p of the photo is, in the cut-out,
    // R(-turn)(p - center) + center - origin.
    const xs = [], ys = []
    let red = 0, green = 0, blue = 0
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const p = y * width + x
      if (mask[p]) { xs.push(x); ys.push(y); red += photo[p * 3]; green += photo[p * 3 + 1]; blue += photo[p * 3 + 2] }
    }
    const center = xs.length ? [xs.reduce((a, v) => a + v, 0) / xs.length, ys.reduce((a, v) => a + v, 0) / ys.length] : [0, 0]
    let turn = 0
    if (xs.length > 2) {
      const { axis, large, small } = principalAxis(xs, ys)
      let slant = Math.atan2(axis[1], axis[0])
      slant = ((slant + Math.PI / 2) % Math.PI + Math.PI) % Math.PI - Math.PI / 2
      if (large > 2.2 ** 2 * Math.max(small, 1e-6) && Math.abs(slant) > (8 * Math.PI) / 180) {
        turn = slant
        cut = rotated(cut, width, height, turn, center)
      }
    }
    const bbox = alphaBounds(cut, width, height), w = bbox[2] - bbox[0], h = bbox[3] - bbox[1]
    const cropped = new Uint8Array(w * h * 4)
    for (let y = 0; y < h; y++) cropped.set(cut.subarray(((y + bbox[1]) * width + bbox[0]) * 4, ((y + bbox[1]) * width + bbox[2]) * 4), y * w * 4)

    // Its seat (where something would sit: a little below the top of its middle column) and its base (the bottom of
    // that column), in the cut-out's pixels, for the layout solver.
    const solid = (x, y) => cropped[(y * w + x) * 4 + 3] > 128
    let first = -1, last = -1
    const halfway = Math.floor(w / 2)
    for (let y = 0; y < h; y++) for (let x = Math.max(0, halfway - 2); x < Math.min(w, halfway + 3); x++) if (solid(x, y)) { if (first < 0) first = y; last = y; break }
    if (first < 0) { first = 0; last = h - 1 }
    const seatY = Math.min(last, Math.trunc(first + 0.12 * h))

    // Its two ends along its length, in the cut-out's pixels: a hook's or a knife's working end is one of them, whichever
    // the script's rough "tip" is nearer. Thinner end first: a hook's head, a knife's point, a pen's nib.
    const sx = [], sy = []
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (solid(x, y)) { sx.push(x); sy.push(y) }
    const axis = sx.length > 2 ? principalAxis(sx, sy).axis : [1, 0]
    let least = Infinity, most = -Infinity, ends = [[0, 0], [0, 0]]
    for (let p = 0; p < sx.length; p++) {
      const along = sx[p] * axis[0] + sy[p] * axis[1]
      if (along < least) { least = along; ends[0] = [sx[p], sy[p]] }
      if (along > most) { most = along; ends[1] = [sx[p], sy[p]] }
    }
    const reach = 0.08 * (most - least)
    let nearLeast = 0, nearMost = 0
    for (let p = 0; p < sx.length; p++) {
      const along = sx[p] * axis[0] + sy[p] * axis[1]
      if (Math.abs(along - least) < reach) nearLeast++
      if (Math.abs(along - most) < reach) nearMost++
    }
    if (nearMost < nearLeast) ends.reverse()

    // Its colour: the mean of its pixels in the photo. Its box: where its mask is in the photo, which the model's box
    // only approximates.
    const hex = v => Math.trunc(v).toString(16).padStart(2, '0')
    const color = xs.length ? `#${hex(red / xs.length)}${hex(green / xs.length)}${hex(blue / xs.length)}` : '#c8aa82'
    origins[o.key] = { origin: [bbox[0], bbox[1]], box: [box[0], box[1], box[2] - box[0], box[3] - box[1]],
      turn: Math.round(turn * 10000) / 10000, center: center.map(v => Math.round(v * 10) / 10),
      seat: [w / 2, seatY], base: [w / 2, last], ends, color }
    await sharp(Buffer.from(cropped), { raw: { width: w, height: h, channels: 4 } }).png().toFile(join(out, `${o.key}.png`))
    catalog[o.key] = { width: w, height: h, regions: [] }
    scoreByKey[o.key] = score
    log(`${o.key.padEnd(12)} ${String(w).padStart(4)}x${String(h).padEnd(4)} score ${score.toFixed(2)}`)
  }
  writeFileSync(join(out, 'screens.json'), JSON.stringify(catalog, null, 1))
  // Where each cut-out's corner was in the photo (to map the script's photo-pixel pivots into it), and its seat and base.
  writeFileSync(join(out, 'geometry.json'), JSON.stringify(origins, null, 1))
  const strideY = Math.max(1, Math.floor(height / 128)), strideX = Math.max(1, Math.floor(width / 128))
  for (let i = 0; i < objects.length; i++) for (let j = i + 1; j < objects.length; j++) {
    let intersection = 0, union = 0
    for (let y = 0; y < height; y += strideY) for (let x = 0; x < width; x += strideX) {
      const a = masks[i][y * width + x], b = masks[j][y * width + x]
      if (a && b) intersection++
      if (a || b) union++
    }
    if (union && intersection / union > 0.85) {
      evidence[objects[i].key].warnings.push(`coarse mask nearly duplicates ${objects[j].key}`)
      evidence[objects[j].key].warnings.push(`coarse mask nearly duplicates ${objects[i].key}`)
    }
  }
  for (const [key, warning] of Object.entries(colourWarnings)) evidence[key].warnings.push(warning)
  writeFileSync(join(out, 'perception.json'), JSON.stringify(evidence, null, 1))
  return { segment: seconds, scores: scoreByKey, colourMismatches: Object.keys(colourWarnings), log: lines.join('\n') }
}
