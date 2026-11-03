// The independently benchmarkable photo → script stage, shared with run.mjs.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { normalizePhoto, jpegBeside } from './images.mjs'
import { generate, json } from './model.mjs'
import { plain } from './script.mjs'
import { validateObjects, validatePlan, groupedInventoryProblems, placeholderNames } from './validate.mjs'
import { settleOperations, settleStates, settleCaptions } from '../solvers/contracts.mjs'
import { PLAN_SCHEMA, PHYSICAL_PLAN_SCHEMA, INVENTORY_PLAN_SCHEMA, PROBLEM_PLAN_SCHEMA, PATCH_SCHEMA, PERCEPTION_SCHEMA, frozenPlanningSchema } from './plan-schema.mjs'
import { checkLook, dimensionLabel } from '../film/thumbs.mjs'
import { validateProblem, problemScript } from './problem.mjs'
import { guidancePrompt } from './guidance.mjs'
import { materialPlanningPrompt, hydrateInventory } from './planning-inputs.mjs'

// How much whitespace an answer may end in before it counts as run away (valid JSON never has this much in a row).
const RUNAWAY = 400

// A reshape's result declaration and appearance are checked in sequence. Adding the missing
// effect exposes the missing artwork; that is progress on the same requirement, not a new fault.
// Keep this narrow: fewer errors alone must never excuse broken inventory, geometry or references.
export function reshapeRepairProgress(before, candidate, error) {
  const match = /^(.+): reshaping needs a drawing \(appearance\) of (.+):([^:]+)$/.exec(error)
  if (!match) return false
  const [, id, key, state] = match
  if (!before.validation.errors.includes(`${id}: reshaping must declare the shape ${key} ends in (an effect on ${key})`)) return false
  const actions = (r) => list(r.script?.steps).flatMap((s) => list(s.do)).filter((a) => a.id === id)
  const old = actions(before), next = actions(candidate)
  return old.length === 1 && next.length === 1 && old[0].v === 'reshape' && next[0].v === 'reshape'
    && old[0].k === key && next[0].k === key && !list(old[0].effects).some((e) => e.k === key)
    && list(next[0].effects).some((e) => e.k === key && e.state === state)
}

// What materials allow, what the film can show and the sizes people expect: one text, the planner's and the catalogue's.
export const MATERIALS = readFileSync(new URL('../../prompts/materials.txt', import.meta.url), 'utf8').trim()
// Which prompt a plan was written with (runstats.mjs groups runs by it): the prompt, its materials and the schema.
export const PROMPT_VERSION = createHash('sha256').update(readFileSync(new URL('../../prompts/script-prompt.txt', import.meta.url))).update(MATERIALS)
  .update(JSON.stringify([PLAN_SCHEMA, PHYSICAL_PLAN_SCHEMA, INVENTORY_PLAN_SCHEMA, PROBLEM_PLAN_SCHEMA, PATCH_SCHEMA, PERCEPTION_SCHEMA])).digest('hex').slice(0, 10)

export async function preparePhoto(source, dir) {
  mkdirSync(dir, { recursive: true })
  const path = resolve(dir, 'photo.png')
  if (resolve(source) !== path) await normalizePhoto(resolve(source), path)
  else await jpegBeside(path)
  const bytes = readFileSync(path)
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Photo normalization did not produce PNG')
  return { path, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

// Return a complete objects array as soon as it arrives, respecting nested arrays and quoted brackets.
export function streamedObjects(text) {
  const match = /"objects"\s*:\s*\[/.exec(text)
  if (!match) return null
  const start = match.index + match[0].length - 1
  let depth = 0, quoted = false, escaped = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue }
    if (c === '"') quoted = true
    else if (c === '[') depth++
    else if (c === ']' && --depth === 0) { try { return JSON.parse(text.slice(start, i + 1)) } catch { return null } }
  }
  return null
}

// A box that runs over the photo's edge is trimmed to it, here and in the finished plan alike, rather than refused:
// refusing it cost a whole second planning request (~6.5 s) and held the object list back from SAM and the film.
// One wholly outside, or trimmed to nothing, is left as it is for the checks to refuse.
export const fitBoxes = (objects, photo) => Array.isArray(objects) ? objects.map((o) => {
  const b = o?.b
  if (!Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite)) return o
  const x0 = Math.max(0, b[0]), y0 = Math.max(0, b[1]), x1 = Math.min(photo.width, b[0] + b[2]), y1 = Math.min(photo.height, b[1] + b[3])
  return x1 - x0 >= 2 && y1 - y0 >= 2 && (x0 !== b[0] || y0 !== b[1] || x1 !== b[0] + b[2] || y1 !== b[1] + b[3]) ? { ...o, b: [x0, y0, x1 - x0, y1 - y0] } : o
}) : objects

const hasBox = (o) => Array.isArray(o?.b) && o.b.length === 4 && o.b.every(Number.isFinite) && o.b[2] > 0 && o.b[3] > 0
const outsidePhoto = ([x, y, w, h], photo) => x >= photo.width || y >= photo.height || x + w <= 0 || y + h <= 0

// Trimming suits a box that slightly overshoots. Several boxes far past the edge mean the whole answer is in another
// form: trimming and omitting them would keep boxes that sit on the wrong things, so segmentation would hand objects
// the wrong cut-outs. Returns those boxes, or [] for a stray one.
export function offScaleBoxes(objects, photo) {
  const boxed = (Array.isArray(objects) ? objects : []).filter(hasBox)
  const marginX = 0.1 * photo.width, marginY = 0.1 * photo.height
  const far = boxed.filter(({ b, b: [x, y, w, h] }) => outsidePhoto(b, photo)
    || x < -marginX || y < -marginY || x + w > photo.width + marginX || y + h > photo.height + marginY)
  return far.length >= 2 && far.length > boxed.length / 4 ? far : []
}

// The model's off-photo answers take two forms, each seen in saved runs:
// - edges: the third number is the box's right edge, not its width, so it nearly always exceeds the first. When bottoms
//   overshoot too, the fourth number is the bottom edge wherever it can be. Such an answer can also be in a frame wider
//   than the photo (1000 across an 800-wide one), so each axis is then divided by how far it still overshoots.
// - scale: the whole answer is drawn larger than the photo in both directions (about twice, on a 474 × 316 photo), so one
//   factor, the larger overshoot, restores it. An axis's overshoot alone would understate it when nothing sits at that edge.
// Returns { objects, form } with the boxes corrected, or null when neither leaves every box on the photo.
export function correctBoxes(objects, photo) {
  const boxed = objects.filter(hasBox)
  if (!boxed.length || boxed.some(({ b }) => b[0] < 0 || b[1] < 0)) return null
  const overshoot = (list, [at, size], limit) => Math.max(1, ...list.map(({ b }) => (b[at] + b[size]) / limit))
  const divided = (b, x, y) => [b[0] / x, b[1] / y, b[2] / x, b[3] / y].map((v) => Math.round(v))
  const edged = boxed.filter(({ b }) => b[2] > b[0]).length >= 0.9 * boxed.length
  let corrected, form
  if (edged) {
    const bottoms = boxed.some(({ b }) => b[1] + b[3] > 1.1 * photo.height), read = new Map(boxed.map((o) => {
      const [x, y, third, fourth] = o.b
      return [o, [x, y, third > x ? third - x : third, bottoms && fourth > y ? fourth - y : fourth]]
    }))
    const sized = [...read.values()].map((b) => ({ b }))
    const scaleX = overshoot(sized, [0, 2], photo.width), scaleY = overshoot(sized, [1, 3], photo.height)
    corrected = (o) => divided(read.get(o), scaleX, scaleY); form = 'edges'
  } else {
    const scale = Math.max(overshoot(boxed, [0, 2], photo.width), overshoot(boxed, [1, 3], photo.height))
    corrected = (o) => divided(o.b, scale, scale); form = 'scale'
  }
  const all = objects.map((o) => hasBox(o) ? { ...o, b: corrected(o) } : o)
  const fits = all.filter(hasBox).length === boxed.length && !all.filter(hasBox).some(({ b }) => outsidePhoto(b, photo)) && !offScaleBoxes(all, photo).length
  return fits ? { objects: all, form } : null
}

// A project picked from the catalogue (catalogue.mjs) is planned on the catalogue's inventory: what segmentation was
// given. The plan may add what the project needs to an object (its part, states), never change what identifies it.
const IDENTITY = ['k', 'n', 'segment', 'b', 'cm', 'w', 'thick', 'tip', 'measurements']
export function onInventory(inventory, planned) {
  const byKey = Object.fromEntries((Array.isArray(planned) ? planned : []).filter((o) => o?.k).map((o) => [o.k, o]))
  return inventory.map((o) => {
    const kept = Object.fromEntries(IDENTITY.filter((f) => f in o).map((f) => [f, o[f]]))
    const merged = { ...o, ...byKey[o.k], ...kept }
    for (const f of IDENTITY) if (!(f in o)) delete merged[f]
    return merged
  })
}
function ideaPrompt(idea, inventory) {
  const { look, ...project } = idea
  // (the card's drawing is what the person picked: its sizes are the build's, so the plan cuts the parts to them —
  // a boot bench card drew 15 cm legs; planned without it, the legs stayed whole 35 cm logs)
  const solids = checkLook(look).look
  const sketch = solids.length ? `\nThe card they picked shows it ${dimensionLabel(solids)} overall (width × depth × height), drawn as these solids in cm (p: corner position, z up; d: size): ${JSON.stringify(solids.map(({ s, p, d }) => ({ s, p, d })))}. Build it to these proportions: cut parts to the sizes the sketch needs, and keep within what the objects allow.` : ''
  return `\n\nThe person chose this project from a catalogue of ideas for this photo: ${JSON.stringify(project)}${sketch}
Plan exactly this project. "ideas" lists it first, with this title, kind and pitch, then two other good options; "pick" is 0.
The things in the photo are already identified and segmented. "objects" is exactly this list, in this order, with these k, n, segment, b, cm, w, thick, tip and measurements unchanged; you may add part, toolKind, state and states where the project needs them, and nothing else: ${JSON.stringify(inventory)}`
}

export function perceptionPrompt(photo, guidance) {
  return `Classify this photo (${photo.width} × ${photo.height} pixels) before planning. Return mode problem for a predominantly written question, equation or exercise; incidental product labels do not count. Otherwise return physical.
For problem return objects:[]; do not solve it yet. For physical identify the visible objects with stable lowercase keys, literal segment class, name, b:[x,y,width,height] in photo pixels, cm and measurement provenance. Every physical instance MUST have its own unique k across the entire objects array, even when several objects share the same class. For example, three bottles use bottle-1, bottle-2 and bottle-3; never reuse bottle for multiple instances. k is an internal key that no viewer sees. n is what the viewer reads in every caption, so it describes what can be seen, such as "yellow 2×4 brick" or "Crown Royal whisky bottle": give the colour whenever it tells similar things apart, and never repeat the key or number the objects in n. Identify EACH independently usable physical instance, even when touching or overlapping: ten visible logs are ten objects, not one pile of logs; likewise boards, bricks, sheets, tools or skeins. Use a tight individual photo box for each visible piece. Do not invent hidden instances or duplicate a pile box to manufacture a count. If you can distinguish only some pieces, identify only those pieces. A container and continuous contents (water, powder, rice) remain one object, but a rack containing separate logs does not turn those logs into a single object. The segment is a literal physical class such as "split log" or "metal log holder", never SAM categories such as freeform-stack, freeform-pile, container or thin-structure.
Dimensions from a single photo are estimated, never confirmed. Omit contents, part, state and states: this stage identifies objects, not container contents, mechanical families or recipe states. A skein is yarn itself, not a container holding yarn. The later planner chooses appropriate material geometry and can describe contents for actual vessels using hex colours. Do not propose a project or steps.
${guidancePrompt(guidance ? { messages: guidance.messages } : null)}`
}

export async function writePlan(dir, photo, options = {}) {
  const started = performance.now()
  const confirmedMeasurements = options.confirmedMeasurements || {}
  let prompt = readFileSync(new URL('../../prompts/script-prompt.txt', import.meta.url), 'utf8')
    .replace(/\{\{(\w+)\}\}/g, (_, key) => ({ photo: 'photo.jpg', width: photo.width, height: photo.height, materials: MATERIALS }[key]))
    + (Object.keys(confirmedMeasurements).length ? `\nUser-supplied confirmed dimensions in cm by object key: ${JSON.stringify(confirmedMeasurements)}` : '')
    + (options.idea && options.inventory ? ideaPrompt(options.idea, options.inventory) : '')
    + guidancePrompt(options.guidance)
  writeFileSync(join(dir, 'prompt.txt'), prompt)
  let published = false, publishedObjects = null, problemMode = false
  const fit = (objects) => fitBoxes(objects, photo)
  // (what segmentation was given: what finds and sizes each thing. The settling adds states and a part's size to the objects
  // after that — a plan with a demonstration, a strand — which is not a change of the inventory)
  const identity = (objects) => JSON.stringify((Array.isArray(objects) ? objects : []).map((o) => ({ k: o?.k, n: o?.n, segment: o?.segment, b: o?.b, cm: o?.cm, w: o?.w, thick: o?.thick, tip: o?.tip })))
  const publish = (objects) => {
    objects = fit(objects)
    if (objects?.some((o) => ['cm', 'w', 'thick'].some((f) => o?.measurements?.[f]?.status === 'confirmed' && confirmedMeasurements[o.k]?.[f] !== o[f]))) return
    if (!published && objects && !validateObjects(objects, photo).length) {
      published = true; publishedObjects = JSON.stringify(objects); options.onObjects?.(objects)
    }
  }
  let perception = null, routedMode = options.inventory ? 'physical' : null
  const perceptionRequests = []
  let initialInventory = options.inventory
  if (options.perception && !initialInventory) {
    let text = perceptionPrompt(photo, options.guidance)
    for (let perceptionAttempt = 0; perceptionAttempt < 2; perceptionAttempt++) {
      const schema = { name: 'PhotoPerception', schema: PERCEPTION_SCHEMA }
      writeFileSync(join(dir, perceptionAttempt ? 'perception-repair-request.json' : 'perception-request.json'), JSON.stringify({ prompt: text, ...schema, effort: options.perceptionEffort || 'minimal', images: ['photo.jpg'] }, null, 1))
      perception = await generate(dir, text, { ...options, effort: options.perceptionEffort || 'minimal', maxTokens: 8000,
        out: perceptionAttempt ? 'perception-repair.json' : 'perception.json', images: ['photo.jpg'], responseFormat: { type: 'json_schema', json_schema: schema }, onText: options.onPerceptionText })
      perceptionRequests.push(perception)
      let read
      try {
        read = json(perception.text)
        if (!['physical', 'problem'].includes(read?.mode) || !Array.isArray(read.objects)) throw new Error('mode and objects are required')
      } catch (error) {
        writeFileSync(join(dir, 'perception-validation.json'), JSON.stringify({ valid: false, errors: [error.message] }, null, 1))
        writeFileSync(join(dir, `perception-validation-${perceptionAttempt}.json`), JSON.stringify({ valid: false, errors: [error.message] }, null, 1))
        if (perceptionAttempt === 0) {
          options.onPerceptionRepair?.()
          text += `\nThe previous response was invalid: ${error.message}. Return one complete JSON object matching the supplied schema, with mode and objects. Reinspect the original photo.`
          continue
        }
        throw new Error(`Invalid photo perception: ${error.message}`)
      }
      // Perception has not published keys yet, so a stray off-photo detection can be omitted without
      // breaking plan references. Keep malformed boxes for validation; trim partial overlaps as usual.
      // Boxes in another form are corrected rather than asked for again: asked again, the model squeezed them onto the
      // photo without moving them to the right things. Only what cannot be corrected takes the second reading.
      const omittedObjects = []
      let offScale = read.mode === 'physical' ? offScaleBoxes(read.objects, photo) : [], correction = null
      if (offScale.length) {
        correction = correctBoxes(read.objects, photo)
        if (correction) {
          read.objects = correction.objects; offScale = []
          options.onBoxesCorrected?.(correction.form)
        }
      }
      if (read.mode === 'physical') {
        read.objects = fit(read.objects.filter((o) => {
          const outside = hasBox(o) && outsidePhoto(o.b, photo)
          if (outside) omittedObjects.push({ k: o.k, b: o.b, reason: 'box is entirely outside the photo' })
          return !outside
        }))
      }
      const errors = read.mode === 'physical' ? validateObjects(read.objects, photo) : read.objects.length ? ['a written problem cannot publish physical objects'] : []
      if (offScale.length) errors.push(`${offScale.length} boxes run far past this ${photo.width} × ${photo.height} photo, such as ${offScale.slice(0, 3).map((o) => `${o.k} [${o.b.join(',')}]`).join(', ')}. Give every b as [x,y,width,height] in this photo's own pixels, with x+width at most ${photo.width} and y+height at most ${photo.height}, and include every object again`)
      const grouped = read.mode === 'physical' ? groupedInventoryProblems(read.objects) : []
      errors.push(...grouped)
      const unnamed = read.mode === 'physical' ? placeholderNames(read.objects) : []
      if (unnamed.length) errors.push(`${unnamed.map((o) => o.k).join(', ')}: n is a placeholder. n is what the viewer reads in the captions, so describe what can be seen in the photo, such as colour, material or label, and never repeat the key or number the objects`)
      if (read.objects.some((o) => ['contents', 'part', 'state', 'states'].some((field) => o?.[field] != null))) errors.push('perception must omit contents, part, state and states; identify the physical objects here and defer geometry and state metadata to planning')
      if (read.objects.some((o) => ['cm', 'w', 'thick'].some((f) => o?.measurements?.[f]?.status === 'confirmed' && confirmedMeasurements[o.k]?.[f] !== o[f]))) errors.push('perception cannot manufacture confirmed measurements')
      const checked = JSON.stringify({ valid: !errors.length, errors, omittedObjects, ...(correction ? { correctedBoxes: correction.form } : {}) }, null, 1)
      writeFileSync(join(dir, 'perception-validation.json'), checked)
      writeFileSync(join(dir, `perception-validation-${perceptionAttempt}.json`), checked)
      if (errors.length && perceptionAttempt === 0) {
        options.onPerceptionRepair?.()
        text += `\nThe previous inventory failed validation. Reinspect the ORIGINAL PHOTO and return corrected objects before segmentation. Identify individual visible instances of discrete stock. Omit contents and all fields absent from the supplied schema. Problems: ${errors.join('; ')}\nPrevious inventory: ${JSON.stringify(read.objects)}`
        continue
      }
      if (errors.length) throw new Error(`Invalid photo perception: ${errors.join('; ')}`)
      routedMode = read.mode; problemMode = routedMode === 'problem'
      options.onMode?.(routedMode)
      if (routedMode === 'physical') initialInventory = read.objects
      break
    }
  }
  const inventory = initialInventory ? fit(initialInventory) : null
  if (inventory) {
    const problems = validateObjects(inventory, photo)
    if (problems.length) throw new Error(`The catalogue's inventory does not pass: ${problems.join('; ')}`)
    // (segmentation can start at once: the objects are known before the plan is asked for)
    published = true; publishedObjects = JSON.stringify(inventory); options.onObjects?.(inventory)
    if (!options.idea) prompt += `\nPerception selected physical mode. Plan a complete physical manual with every required field. Keep this inventory's keys, names, segment classes, boxes, dimensions and measurement provenance unchanged: ${JSON.stringify(inventory)}. You may add part/state/tool information. Do not switch to problem mode.`
    prompt += materialPlanningPrompt(inventory)
    prompt += '\nFROZEN INVENTORY OUTPUT CONTRACT: The inventory above is read-only input. Omit objects from your response. Return objectUpdates:[] or sparse annotations [{k,part,toolKind,contents,state,states}], using only the annotation fields needed for each existing key. Never repeat names, boxes, sizes, tips, segments or measurement provenance. We reconstruct objects from the frozen input. Additional stock belongs in materials. This output contract supersedes earlier instructions to return an objects array.'
  }
  if (routedMode === 'problem') prompt += '\nPerception selected problem mode. Return the complete problem payload only; do not switch to physical mode.'
  writeFileSync(join(dir, 'prompt.txt'), prompt)
  const requests = [], history = [], maxRepairs = options.maxRepairs ?? 1
  if (!Number.isInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 2) throw new Error('maxRepairs must be 0, 1 or 2')
  let call, n = 0
  // One request: the first plan, a repair of the whole plan, or a patch (`base`: the plan it patches) of only what
  // failed. Its answer parsed, settled and checked: { script, validation, softOnly, geometry, response, attempt }.
  const ask = async (text, base = null) => {
    const attempt = n++
    options.onPlanAttempt?.({ attempt, patch: !!base })
    // An answer that breaks its JSON (a stray \" in a key: a footstool's plan wrote "cm\":15 twice) can only go on with
    // whitespace, and did — 830 kB of it, 37 s — until the model's limit: once its tail is nothing but whitespace it is
    // stopped, and goes to the repair as broken.
    const stop = new AbortController(), began = performance.now()
    let partial = '', runaway = false, strayed = false
    // (a patch may give only its eight fields, or a whole plan's; the first two given ran on inventing others — "removeDep", "txt",
    // "html", … — for 58 kB and 73 s until the JSON broke. It is stopped at the first field it may not give, or once
    // longer than the plan it patches, and kept up to its last whole value)
    // (a whole plan given as a patch is taken whole, so the plan's own fields are allowed, and its length with room)
    const fields = base ? topFields() : null, limit = base ? JSON.stringify(base).length * 1.5 + 2000 : Infinity
    const schema = base ? { name: 'InstructionPlanPatch', schema: inventory ? frozenPlanningSchema(inventory, true) : PATCH_SCHEMA } : {
      name: 'InstructionPlan', schema: problemMode ? PROBLEM_PLAN_SCHEMA : inventory ? frozenPlanningSchema(inventory) : publishedObjects || routedMode === 'physical' ? PHYSICAL_PLAN_SCHEMA : PLAN_SCHEMA,
    }
    const effort = attempt ? options.repairEffort || options.effort || 'low' : options.effort || 'low'
    writeFileSync(join(dir, `request-${attempt}.json`), JSON.stringify({ prompt: text, ...schema, schemaHash: createHash('sha256').update(JSON.stringify(schema.schema)).digest('hex'), effort, images: ['photo.jpg'] }, null, 1))
    const asked = generate(dir, text, { ...options, effort, maxTokens: options.maxTokens ?? 32000, out: `out-${attempt}.json`, signal: options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal,
      responseFormat: { type: 'json_schema', json_schema: schema },
      images: ['photo.jpg'], onText: (text) => {
        partial = text
        if (!runaway && text.length > RUNAWAY && /^\s+$/.test(text.slice(-RUNAWAY))) { runaway = true; stop.abort(); return }
        if (base) {
          if (!strayed && (text.length > limit || fields(text).some((k) => !PATCH_FIELDS.has(k) && !(k in PLAN_SCHEMA.properties)))) { strayed = runaway = true; stop.abort() }
          return
        }
        options.onText?.(text)
        if (/"mode"\s*:\s*"problem"/.test(text)) problemMode = true
        if (!published && !problemMode) publish(streamedObjects(text))
      } })
    const response = await asked.catch((error) => {
      writeFileSync(join(dir, `out-${attempt}.partial.txt`), partial)
      if (!runaway) throw error
      const file = join(dir, `out-${attempt}.partial.json`)
      const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
      return { text: partial.trimEnd(), seconds: (performance.now() - began) / 1000, firstTokenSeconds: saved.firstTokenSeconds ?? null,
        cost: saved.cost ?? null, usage: saved.usage ?? null, runaway: true, stopReason: strayed ? 'unexpected fields or size limit' : 'trailing whitespace' }
    })
    requests.push({ ...response, ...(base ? { patch: true } : {}), ...(strayed ? { strayed: true } : {}) })
    let script = null, validation
    try {
      // (an answer cut off part way is mended up to its last whole value: kept only when it then passes the checks,
      // else the repair is told where it broke, as for any broken answer)
      let cutOff = null
      if (base) {
        const patch = json(response.text, { truncated: true })
        writeFileSync(join(dir, `patch-${attempt}.json`), JSON.stringify(patch, null, 1))
        if (!Array.isArray(patch.objects) && typeof patch.title !== 'string' && Array.isArray(patch.steps) && patch.steps.some((s) => !Number.isInteger(s?.at) || s.at < 1))
          throw new Error('Each patch step must include its positive integer at number; an unnumbered array cannot replace the manual')
        script = patched(base, patch)
        const faceEdits = list(script.joints).filter((j) => list(base.joints).some((old) => old.id === j.id && old.face !== j.face))
        if (faceEdits.length) writeFileSync(join(dir, `joint-face-edits-${attempt}.json`), JSON.stringify(faceEdits, null, 1))
      }
      else try { script = json(response.text) } catch (error) { cutOff = error; script = json(response.text, { truncated: true }) }
      if (problemMode && script?.mode !== 'problem') throw new Error('problem mode cannot change to a physical project during repair')
      if (script?.mode === 'problem') {
        if (inventory) throw new Error('a selected physical project cannot change to problem mode')
        validation = validateProblem(script.problem)
        if (published) { validation.valid = false; validation.errors.push('problem mode must be chosen before publishing physical objects') }
        if (validation.valid) script = problemScript(script.problem)
      } else {
        if (script?.mode != null && script.mode !== 'physical') throw new Error('unknown photo mode')
        if (script && Array.isArray(script.objects)) script.objects = fit(script.objects)
        if (script && inventory) {
          script = hydrateInventory(script, inventory)
          // what identifies each thing is the catalogue's; anything not in its inventory is left out (a step that uses
          // it then fails the checks)
          script.objects = onInventory(inventory, script.objects)
          if (options.idea) {
            const { look, ...chosen } = options.idea, chosenIdea = { title: chosen.title, kind: chosen.kind, pitch: chosen.pitch }
            script.ideas = [chosenIdea, ...(Array.isArray(script.ideas) ? script.ideas : []).filter((i) => i?.title && i.title !== chosen.title)].slice(0, 3)
            script.pick = 0
          }
        }
        const settled = [...settleOperations(script), ...settleStates(script), ...settleCaptions(script)]
        validation = validatePlan(script, photo, { confirmedMeasurements })
        if (cutOff && !validation.valid) throw cutOff
        if (cutOff) settled.unshift('the answer was cut off and mended into JSON')
        if (settled.length) validation.warnings.push(...settled.map((n) => `settled: ${n}`))
        // SAM may already be running: a repair must not change any published object, box, or dimension.
        if (publishedObjects && !inventory && identity(script.objects.filter(o => o.source !== 'additional-supply')) !== identity(JSON.parse(publishedObjects))) {
          validation.errors.push('Repair changed the inventory already published to segmentation'); validation.valid = false
        }
      }
    } catch (error) {
      // (where it broke, for the repair: the few characters before it)
      const at = +(/position (\d+)/.exec(error.message)?.[1] ?? response.text.length)
      script = null
      validation = { valid: false, broken: response.text.slice(Math.max(0, at - 80), at + 20), errors: [`Invalid plan ${base ? 'patch ' : ''}JSON${response.runaway ? ' (the answer ran on into whitespace and was stopped)' : ''}: ${error.message}`], warnings: [] }
    }
    // What the repair is asked to fix but a film is still made with: the design against the steps (validate.mjs:
    // soft), and how the parts meet, checked in numbers (layout.mjs) once the rest passes — only once the cut-outs can be
    // waited on (the objects published).
    let softOnly = false, geometry = false
    if (validation.valid) {
      const problems = [...(validation.soft || [])]
      if (script.mode !== 'problem' && published && options.checkPlan) {
        const review = await options.checkPlan(script), found = Array.isArray(review) ? review : review.errors || []
        geometry = found.length > 0; problems.push(...found)
        if (!Array.isArray(review)) validation.warnings.push(...(review.warnings || []))
      }
      if (problems.length) { validation.errors.push(...problems); validation.valid = false; softOnly = true }
    }
    if (script) writeFileSync(join(dir, `candidate-${attempt}.json`), JSON.stringify(script, null, 1))
    history.push(validation)
    writeFileSync(join(dir, `validation-${attempt}.json`), JSON.stringify(validation, null, 1))
    writeFileSync(join(dir, 'validation.json'), JSON.stringify(validation, null, 1))
    const allRequests = [...perceptionRequests, ...requests]
    const sum = (get) => allRequests.every((r) => Number.isFinite(get(r))) ? allRequests.reduce((n, r) => n + get(r), 0) : null
    call = { ...response, seconds: (performance.now() - started) / 1000, firstTokenSeconds: allRequests[0].firstTokenSeconds,
      cost: sum((r) => r.cost), output: sum((r) => r.output), thinking: sum((r) => r.thinking),
      knownCost: allRequests.reduce((sum, r) => sum + (Number.isFinite(r.cost) ? r.cost : 0), 0), costIncomplete: allRequests.some((r) => !Number.isFinite(r.cost)),
      usage: { prompt_tokens: sum((r) => r.usage?.prompt_tokens), completion_tokens: sum((r) => r.usage?.completion_tokens) },
      planAttempts: requests.length, patches: requests.filter((r) => r.patch).length, firstPassValid: history[0].valid, promptVersion: PROMPT_VERSION,
      effort: options.noThinking ? 'minimal' : options.effort || 'low', validationHistory: history,
      perception: perception ? { ...perception, text: undefined, attempts: perceptionRequests.length } : null,
      requests: requests.map(({ text, ...metadata }) => metadata) }
    writeFileSync(join(dir, 'planning.json'), JSON.stringify({ ...call, text: undefined }, null, 1))
    return { script, validation, softOnly, geometry, response, attempt }
  }

  const hints = (r) => `${r.softOnly ? '\nKeep the design and the steps one plan: each physical copy has its own key, immediate source and creation operation. Account for rigid stock by length and sheet stock by explicit two-dimensional cutting positions and outlines. When parts cannot fit, change the design, not only the numbers.' : ''}${r.geometry ? '\nHow the parts meet failed: place each part where its joint needs it (a part resting on several others is "on" one with "also" the rest), use parts big enough for what goes under them, or join fewer parts.' : ''}`
  const failed = (r) => `failed these deterministic checks:\n${r.validation.errors.map((e) => `- ${e}`).join('\n')}${r.validation.errors.some((e) => /: reshaping (must declare the shape|needs a drawing)/.test(e)) ? '\nFor every reshape, supply BOTH the resulting effect and its declared state with a complete appearance (width, height, shapes). A label-only state cannot animate the result. In a patch, provide the actor in states with all its states; in a whole plan, put these on the actor or in top-level states. Preserve the starting state and existing valid appearances.' : ''}`
  // The whole plan again: for a broken answer, or problems that are not in its steps, joints, tools or design.
  const wholePrompt = (r) => r.script?.mode === 'problem' ? `${prompt}\n\nThe problem response ${failed(r)}. Correct the transcription/solution as problem JSON; do not switch to a physical project. Previous response: ${JSON.stringify(r.script)}` : `${prompt}\n\nYour previous plan ${failed(r)}
Correct the whole JSON plan. Keep the chosen idea and every valid instruction. ${publishedObjects ? `The inventory has already been sent to segmentation: ${publishedObjects}. Keep every object's key, name, segment class, photo box, dimensions, tip and measurement provenance unchanged. You may repair part/state/states information and state appearances; preserve existing valid states and appearances from the previous plan below.` : 'Correct photo boxes to fit the stated image dimensions.'}
Declare every referenced tool and cut part; place supports before placing objects on them. Do not fix an error by inventing materials.${hints(r)}
${r.validation.broken != null ? `Your previous answer stopped being valid JSON here: ${JSON.stringify(r.validation.broken)}. Write the whole plan again from the start as valid JSON; inside a key or value never escape a quote that ends it.` : `Previous plan: ${JSON.stringify(r.script).slice(0, 60000)}`}`
  // Only what failed: a few hundred tokens instead of the whole plan's thousands (a whole repair took ~10 s).
  const patchPrompt = (r) => `${r.geometry ? 'Repair the measured assembly geometry in the following plan. Units are cm. Return only a bounded JSON patch in the supplied schema. Preserve every existing cut/creation operation and all unaffected steps. Do not renumber, rename or delete parts merely to remove a diagnostic. An entry face is the outer face where a fastener enters, not the contacting face. Keep inventory and measurement provenance unchanged.' : prompt}\n\nYour plan, as checked (its objects are final and already segmented): ${JSON.stringify(r.script)}
It ${failed(r)}
Answer with only what you change, as JSON: "steps", the steps you rewrite, each whole with "at", its number from 1 (one past the last adds a step); "remove", the numbers of steps to drop; "states", things whose states you redraw, each {"k", "state" (the state it starts in), "states" (all of them, each with its appearance)} — the one change a photo object allows; and only if they change, the whole "design", "tools", "joints", "makes", "goals" or "profiles". Leave out everything that passed. For upright parallel parts of unequal widths, use explicit align:"front|back|left|right|middle" on the placement to align the remaining horizontal edge. Never change dimensions to close a gap. To change screw entry faces, update the joints array together with the operations, or consistently change the existing joint operations' faces.
Declare every referenced tool and cut part; place supports before placing objects on them. Do not fix an error by inventing materials.${hints(r)}`
  const missingDesignParts = (script) => {
    const created = new Set([...list(script?.objects), ...list(script?.tools), ...list(script?.makes),
      ...list(script?.steps).flatMap((s) => list(s.do).flatMap((a) => list(a.into)))].map((o) => o?.k))
    return list(script?.design?.parts).some((p) => !created.has(p.k))
  }
  const patchable = (r) => publishedObjects && r.script && !missingDesignParts(r.script) && r.validation.broken == null && r.validation.errors.every((e) => !GLOBAL.test(e)
    && !list(r.script.objects).some((o) => typeof o?.k === 'string' && (e.startsWith(`${o.k}:`) || e.startsWith(`${o.k}.`))))
  // Repairs until the plan passes: first a patch, when every problem lies in what a patch gives; then — only for
  // problems that would stop the film, not for soft ones a film is made with — the whole plan, up to maxRepairs times
  // (the patch not counted). What it ends with, passing or not.
  const repaired = async (r) => {
    let patches = 0, wholes = 0
    const select = (before, candidate) => {
      const newErrors = (candidate.validation.errors || []).filter((e) => !before.validation.errors.includes(e))
      const refinements = newErrors.filter((e) => reshapeRepairProgress(before, candidate, e))
      const accepted = candidate.validation.valid || candidate.validation.broken == null &&
        (candidate.softOnly || !before.softOnly && newErrors.length === refinements.length)
      writeFileSync(join(dir, `repair-${candidate.attempt ?? n - 1}.json`), JSON.stringify({ baseAttempt: before.attempt,
        candidateAttempt: candidate.attempt ?? n - 1, accepted, reason: accepted ? refinements.length ? 'candidate advances an existing reshape result requirement; remaining failures still require repair' : 'candidate passes or introduces no new structural failures' : 'candidate introduces structural failures or broken JSON; previous plan retained',
        before: before.validation, after: candidate.validation, newErrors, refinements }, null, 1))
      if (!accepted) options.onRepairRejected?.({ attempt: candidate.attempt, errors: newErrors })
      return accepted ? candidate : before
    }
    while (!r.validation.valid && maxRepairs > 0) {
      if (!patches && patchable(r)) {
        patches++
        // (a patch request that fails — the API, the network — leaves the plan as it was, for the whole repair)
        const p = await ask(patchPrompt(r), r.script).catch((error) => { if (options.signal?.aborted) throw error; return { validation: { broken: error.message } } })
        // (a patch that does not parse leaves the plan as it was, for the whole repair)
        const previous = r
        r = select(r, p)
        if (r.softOnly && r !== previous && !r.geometry) break
        continue
      }
      if (wholes >= maxRepairs) break
      wholes++; r = select(r, await ask(wholePrompt(r)))
    }
    return r
  }
  const done = (r) => {
    writeFileSync(join(dir, 'validation.json'), JSON.stringify(r.validation, null, 1))
    writeFileSync(join(dir, 'selected-attempt.json'), JSON.stringify({ attempt: r.attempt, valid: r.validation.valid, geometry: r.geometry }, null, 1))
    // Confirmation evidence belongs to the caller, never to the generated response.
    const { measurementConfirmations: ignored, ...generated } = r.script
    const script = generated.mode === 'problem' ? problemScript(generated.problem) : plain(Object.keys(confirmedMeasurements).length ? { ...generated, measurementConfirmations: confirmedMeasurements } : generated)
    if (script.mode !== 'problem') publish(script.objects)
    writeFileSync(join(dir, `out-${r.attempt}.plan.json`), JSON.stringify(r.script))
    writeFileSync(join(dir, 'script.json'), JSON.stringify(script, null, 1))
    return { script, call, validation: r.validation, photo }
  }
  // Non-geometric soft findings can be returned for review; unresolved numeric geometry always stops the plan.
  const settle = (r) => {
    if (r.validation.valid || r.softOnly && !r.geometry) return done(r)
    writeFileSync(join(dir, 'validation.json'), JSON.stringify(r.validation, null, 1))
    writeFileSync(join(dir, 'selected-attempt.json'), JSON.stringify({ attempt: r.attempt, valid: false, geometry: r.geometry }, null, 1))
    const error = new Error(`Invalid instruction plan after ${requests.length} attempt(s): ${r.validation.errors.join('; ')}`)
    error.validation = r.validation; error.call = call
    throw error
  }
  const first = await ask(prompt)
  // With `background`, a plan whose only faults are soft is not held back for its repair: it is returned at once, and
  // its repair goes on (`revision`: the repaired plan when it passes, else null), for the caller to take if it comes in
  // time. The film starts from the plan as it is.
  if (options.background && first.softOnly && !first.geometry && maxRepairs > 0) {
    const kept = done(first)
    const revision = repaired(first).then((r) => (r.validation.valid ? done(r) : null)).catch(() => null)
    return { ...kept, revision }
  }
  return settle(await repaired(first))
}

// The fields a patch may give (PATCH_SCHEMA).
const PATCH_FIELDS = new Set(['steps', 'remove', 'design', 'tools', 'joints', 'makes', 'goals', 'profiles', 'states', 'supplies', 'confirmations', 'materials', 'assembly', 'objectUpdates', 'cuts'])
// The keys of a JSON object's top level as its text streams in: a reader that keeps its place between calls (each call
// is given the whole text so far) and returns every key begun at the top level.
function topFields() {
  let at = 0, depth = 0, quoted = false, escaped = false, key = null, expectKey = false
  const keys = []
  return (text) => {
    for (; at < text.length; at++) {
      const c = text[at]
      if (quoted) {
        if (escaped) escaped = false
        else if (c === '\\') escaped = true
        else if (c === '"') { quoted = false; if (key != null) { keys.push(key); key = null } }
        else if (key != null) key += c
        continue
      }
      if (c === '"') { quoted = true; if (depth === 1 && expectKey) { key = ''; expectKey = false } }
      else if (c === '{' || c === '[') { depth++; if (depth === 1) expectKey = c === '{' }
      else if (c === '}' || c === ']') depth--
      else if (c === ',' && depth === 1) expectKey = true
    }
    return keys
  }
}

// Operations, keys and checks that a patch cannot reach: the plan's own fields, its answer's form, its objects.
const GLOBAL = /^(plan must|title |view |ideas |pick |steps must|objects must|operation contract|unsupported operation contract|Repair changed|Invalid plan|\w+ must be an array)/
const list = (v) => (Array.isArray(v) ? v : [])
// A plan with a patch applied: steps rewritten by number (one past the last added), removed by number, and the design,
// tools, joints, makes or goals the patch gives, each whole.
export function patched(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('a patch must be a JSON object')
  // (asked for a patch, an answer may still be the whole plan: taken as it is)
  if (Array.isArray(patch.objects) || typeof patch.title === 'string') return patch
  const script = structuredClone(base), count = list(script.steps).length
  if (Object.hasOwn(patch, 'objectUpdates')) script.objects = hydrateInventory({ objectUpdates: patch.objectUpdates }, script.objects.filter(o => o.source !== 'additional-supply')).objects
  // (and steps given without their numbers are the steps, all of them)
  script.steps = list(patch.steps).length && list(patch.steps).every((s) => s?.at == null) ? [] : list(script.steps)
  for (const field of ['tools', 'joints', 'makes', 'goals', 'profiles', 'supplies', 'confirmations', 'materials', 'cuts']) if (Array.isArray(patch[field])) script[field] = patch[field]
  if (patch.assembly && typeof patch.assembly === 'object') script.assembly = patch.assembly
  else if (Object.hasOwn(patch, 'assembly') && patch.assembly === null) script.assembly = null
  if (patch.design && typeof patch.design === 'object') script.design = patch.design
  for (const { at, ...step } of list(patch.steps).filter((s) => s && typeof s === 'object')) {
    if (Number.isInteger(at) && at >= 1 && at <= script.steps.length) script.steps[at - 1] = step
    else script.steps.push(step)
  }
  // (a thing's states redrawn, wherever it is declared — the photo's objects included: only its states and the state it
  // starts in, never what identifies it)
  const things = [...list(script.objects), ...list(script.tools), ...list(script.makes), ...script.steps.flatMap((s) => list(s?.do).flatMap((a) => list(a?.into)))]
  for (const { k, state, states } of list(patch.states).filter((s) => s && Array.isArray(s.states))) {
    for (const o of things.filter((o) => o?.k === k)) { o.states = states; if (typeof state === 'string') o.state = state }
  }
  const drop = new Set(list(patch.remove).filter((i) => Number.isInteger(i) && i >= 1 && i <= Math.min(count, script.steps.length)))
  script.steps = script.steps.filter((_, i) => !drop.has(i + 1))
  // A repair may correct entry faces in the operations without repeating the full joints array. Promote only
  // explicit, unanimous edits to existing operations; otherwise settling would silently undo the correction.
  if (!Array.isArray(patch.joints)) {
    const oldActs = new Map(list(base.steps).flatMap((s) => list(s.do)).map((a) => [a.id, a]))
    const faces = new Map()
    for (const a of list(patch.steps).flatMap((s) => list(s.do))) {
      const old = oldActs.get(a.id), j = list(base.joints).find((j) => j.id === a.joint)
      if (!old || !j || j.method !== 'fasten' || old.joint !== j.id || old.face !== j.face || !['upper', 'lower', 'front', 'back', 'left', 'right', 'start', 'end'].includes(a.face) || a.face === old.face) continue
      if (!faces.has(j.id)) faces.set(j.id, new Set())
      faces.get(j.id).add(a.face)
    }
    for (const [id, edits] of faces) {
      if (edits.size !== 1) throw new Error(`Conflicting entry face edits for joint ${id}; supply one consistent joint update`)
      const face = [...edits][0]
      if (list(patch.steps).flatMap((s) => list(s.do)).some((a) => a.joint === id && a.face != null && a.face !== face))
        throw new Error(`Conflicting entry face edits for joint ${id}; supply one consistent joint update`)
      const j = list(script.joints).find((j) => j.id === id)
      j.face = j.otherFace = face
    }
  }
  return script
}

export async function planPhoto(source, dir, options = {}) {
  return writePlan(dir, await preparePhoto(source, dir), options)
}
