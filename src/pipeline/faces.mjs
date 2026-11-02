import { fileURLToPath } from 'node:url'
import { LAYER_RULES, LINE_WEIGHTS } from './drawing-format.mjs'
// Face drawings for the parts a scene draws from numbers (scene.mjs: a laptop, binder or book as a block, a sheet of
// paper): one model call each, in place of the drawing call such a part would otherwise get (the engine draws the part
// itself, so it has no use for one). The model draws what the object is recognised by on each face (a laptop's keyboard
// on its upper face, a binder's spine label on its front) as flat SVG shapes in a box the face's shape, 10 units to a
// cm; the engine maps each onto its face (a parallelogram in the oblique view) and fades it in when it arrives.
//   node faces.mjs <run dir> [--resume] — writes faces.json; --resume reuses checked saved responses
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { generate, json } from './model.mjs'
import { cropTo } from './images.mjs'
import { refusedIn } from './words.mjs'
import { isSceneBuild, partOf } from '../solvers/scene.mjs'
import { isLog } from '../solvers/joints.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))

// The faces a part has to draw: its upper face; and its front, when it is at least 1.5 cm high. Box sizes, 10 a cm.
// A log (joints.mjs: isLog, drawn as a cylinder): its cut end and its long side.
export const facesOf = (part) => {
  if (part?.family === 'log') { const [L, D] = part.size; return { end: [Math.round(D * 10), Math.round(D * 10)], side: [Math.round(L * 10), Math.round(D * 10)] } }
  if (!part || !['box', 'sheet'].includes(part.family)) return null
  const [w, d, h] = part.size, f = { upper: [Math.round(w * 10), Math.round(d * 10)] }
  if (part.family === 'box' && h >= 1.5) f.front = [Math.round(w * 10), Math.round(h * 10)]
  return f
}

// Shared by fresh calls and recovery: saved responses must pass the same checks.
export function faceDrawing(answer, part) {
  const out = {}
  for (const [face, [W, H]] of Object.entries(facesOf(part) || {})) {
    const shapes = (answer[face]?.shapes || []).filter((s) => typeof s.d === 'string' && s.d.length < 4000 && !refusedIn(s.d).length).slice(0, 60)
    if (shapes.length) out[face] = { width: W, height: H, shapes: shapes.map((s) => ({ d: s.d, fill: s.fill || 'none', stroke: s.stroke || 'none', ...(s.id ? { id: s.id } : {}), ...(['evenodd', 'nonzero'].includes(s.fillRule) ? { fillRule: s.fillRule } : {}), ...(Object.hasOwn(LINE_WEIGHTS, s.weight) ? { weight: s.weight } : {}) })) }
  }
  return Object.keys(out).length ? out : null
}

// One part's faces, from the model: {upper: {width, height, shapes}, front?: {…}}, or null.
// Its picture: its SAM cut-out if there is one yet, else its box cropped from the photo (so the call can start as soon
// as the script is in, without waiting for SAM).
// (anything else in the options — provider, apiKey, baseURL, retries — goes to the model call: a test's stub)
export async function writeFace(runDir, key, name, part, { effort = 'low', noThinking = false, layered = false, photo = null, box = null, resume = false, onFace, ...call } = {}) {
  const want = facesOf(part); if (!want) return null
  const dir = join(runDir, 'faces', key)
  mkdirSync(dir, { recursive: true })
  if (resume && existsSync(join(dir, 'out.json'))) {
    try {
      const saved = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8'))
      const faces = !saved.is_error && faceDrawing(json(saved.result), part)
      if (faces) return { faces, cost: saved.total_cost_usd, seconds: saved.duration_ms / 1000, provider: saved.provider, model: saved.model, costEstimated: saved.costEstimated, reused: true }
    } catch { /* An incomplete response needs a fresh call. */ }
  }
  const cut = join(runDir, 'screens', `${key}.png`)
  if (existsSync(cut)) copyFileSync(cut, join(dir, `${key}.png`))
  else if (photo && box) await cropTo(photo, box, join(dir, key + '.png'))
  else return null
  const [w, d, h] = part.size
  const seen = { upper: 'its upper face, seen from straight above (its back edge at the top of the box, its front edge at the bottom)', front: 'its front face, seen straight from the front',
    end: 'its sawn end, seen straight on: the end grain as its round cross-section, the circle touching the box\'s edges — growth rings round the pith, any cracks, a thin rim of bark',
    side: 'its long side, seen side-on, its length left to right: its bark (or bare wood where there is none) along it, the way the picture shows it' }
  const lines = Object.entries(want).map(([face, [W, H]]) => `- "${face}": ${seen[face]}, in a ${W} × ${H} box.`)
  const prompt = readFileSync(join(here, '../../prompts/face-prompt.txt'), 'utf8').replace(/\{\{(\w+)\}\}/g, (_, k) => ({ name, key, family: part.family, w, d, h, faces: lines.join('\n'),
    answer: `{${Object.keys(want).map((f) => `"${f}": {"shapes": [{"d": "M…", "fill": "#rrggbb", "stroke": "#rrggbb or none"}]}`).join(', ')}}` }[k])) + (layered ? '\n' + LAYER_RULES : '')
  writeFileSync(join(dir, 'prompt.txt'), prompt)
  // (a failed call — the API overloaded — leaves the part plain, as drawings do; it never stops the run)
  let r
  try { r = await generate(dir, prompt, { ...call, effort, noThinking, images: [`${key}.png`] }) } catch (error) {
    console.warn(`face ${key}: ${error.message.trim()}; keeping any saved face`)
    return null
  }
  try {
    const faces = faceDrawing(json(r.text), part)
    return faces ? { faces, cost: r.cost, seconds: r.seconds, provider: r.provider, model: r.model, costEstimated: r.costEstimated } : null
  } catch { return null }
}

// Every part with faces to draw, in parallel: {key: faces}. The parts: a solved scene layout's (layout.scene), else —
// straight from the script, before any layout — each object of a scene build with a box or sheet part.
export async function writeFaces(runDir, script, layout, options = {}) {
  const names = Object.fromEntries((script.objects || []).map((o) => [o.k, o.n])), boxes = Object.fromEntries((script.objects || []).map((o) => [o.k, o.b]))
  const scene = layout?.scene || (isSceneBuild(script) ? Object.fromEntries((script.objects || []).map((o) => { const p = partOf(o); return [o.k, { family: p.family, size: [p.w, p.d, p.h] }] })) : {})
  // (and the logs a joint solver's build draws as cylinders: each one the steps work on, its length and thickness)
  const worked = new Set((script.steps || []).flatMap((s) => s.do || []).map((a) => a.k))
  const logs = !isSceneBuild(script) && ['plan', 'front', 'iso'].includes(script.view) ? Object.fromEntries((script.objects || []).filter((o) => isLog(o) && worked.has(o.k)).map((o) => {
    const size = Array.isArray(o.part?.size) && o.part.size.length === 3 && o.part.size.every((v) => +v > 0) ? o.part.size.map(Number).sort((a, b) => b - a) : [+o.cm || 30, (+o.cm || 30) / 3, (+o.cm || 30) / 3]
    return [o.k, { family: 'log', size }]
  })) : {}
  const supplied = new Set((script.objects || []).filter(o => o.source === 'additional-supply').map(o => o.k))
  const parts = Object.entries({ ...scene, ...logs }).filter(([k, p]) => !supplied.has(k) && facesOf(p))
  const done = await Promise.all(parts.map(async ([k, p]) => { const f = await writeFace(runDir, k, names[k] || k, p, { ...options, box: boxes[k] }); options.onFace?.(k, f); return [k, f] }))
  return Object.fromEntries(done.filter(([, f]) => f))
}

if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))) {
  const runDir = resolve(process.argv[2]), read = (p) => JSON.parse(readFileSync(join(runDir, p), 'utf8'))
  const saved = existsSync(join(runDir, 'faces.json')) ? read('faces.json') : {}
  const done = await writeFaces(runDir, read('script.json'), read('layout.json'), { resume: process.argv.includes('--resume') })
  writeFileSync(join(runDir, 'faces.json'), JSON.stringify({ ...saved, ...Object.fromEntries(Object.entries(done).map(([k, f]) => [k, f.faces])) }))
  console.log(Object.entries(done).map(([k, f]) => `${k}: ${Object.keys(f.faces).join(', ')} (${f.seconds}s, $${f.cost.toFixed(3)}${f.reused ? ', saved response' : ''})`).join('\n') || 'no new faces; saved faces kept')
}
