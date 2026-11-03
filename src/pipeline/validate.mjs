// Deterministic plan checks. These catch contradictions, not whether guessed sizes or a recipe are true.
import { TOOL_KINDS } from '../solvers/tools.mjs'
import { validateContract, OFFCUT } from '../solvers/contracts.mjs'
import { checkFolds } from '../solvers/fold.mjs'
import { checkStrands } from '../solvers/strand.mjs'
import { checkSheets, sheetParts } from '../solvers/sheets.mjs'
import { settlePlanningInputs, suppliedObjects } from './planning-inputs.mjs'

const VERBS = new Set(['place', 'pour', 'sprinkle', 'cut', 'stir', 'heat', 'work', 'use', 'measure', 'demonstrate', 'reshape', 'fold', 'strand'])
const VIEWS = new Set(['side', 'plan', 'front', 'iso'])
const RELATIONS = new Set(['floor', 'on', 'in', 'hang', 'pivot', 'lean', 'parallel', 'end', 'between', 'across', 'under', 'wall', 'next', 'onto'])
const positive = (x) => typeof x === 'number' && Number.isFinite(x) && x > 0
const text = (x) => typeof x === 'string' && x.trim().length > 0
const list = (x) => Array.isArray(x) ? x : []

// A grouped pile cannot supply the identity, dimensions and mask of each independently manipulated solid.
// Consumable mixtures (flour, rice, yarn lengths, etc.) intentionally remain collections.
export function groupedInventoryProblems(objects) {
  return list(objects).flatMap((o) => {
    const name = `${o?.n || ''} ${o?.k || ''}`.replace(/-/g, ' ')
    const collection = /\b(pile|stack|bundle|assortment|collection|set|several|multiple)\b/i.test(name)
    const discrete = /\b(logs|boards|planks|bricks|sheets|panels|rods|poles|sticks|skeins|bottles|cups|boxes|books|tools)\b/i.test(name)
    const errors = collection && discrete ? [`${o.k}: identify each visible independently usable piece with its own key and photo box; a collection (${o.n}) cannot be one stock object. Do not invent counts or duplicate a pile's box.`] : []
    if (/^(freeform-stack|freeform-pile|thin-structure)$/i.test(o?.segment || '')) errors.push(`${o.k}: segment must be a literal physical class (such as split log or loose bark), not the output category ${o.segment}`)
    return errors
  })
}

// Names reach every caption, so "brick-2" or "Item 3" tells a viewer nothing. A name counts as a placeholder when it just
// repeats a numbered key, or differs from another name only by the next number. "Board 40" beside "Board 60" is a
// real description, as is a plain key like "mug".
export function placeholderNames(objects) {
  const numbered = list(objects).map((o) => {
    const match = /^(.*?)[\s#-]*(\d+)$/.exec(String(o?.n || '').trim())
    return match ? { o, base: match[1].toLowerCase(), number: +match[2] } : null
  }).filter(Boolean)
  return numbered.filter(({ o, base, number }) => String(o.n).trim().toLowerCase().replace(/\s+/g, '-') === String(o.k).toLowerCase()
    || numbered.some((other) => other.o !== o && other.base === base && Math.abs(other.number - number) === 1)).map(({ o }) => o)
}

export function validateObjects(objects, photo) {
  const errors = [], keys = new Set()
  if (!Array.isArray(objects) || !objects.length) return ['objects must be a nonempty array']
  for (const [i, o] of objects.entries()) {
    const label = o?.k || `object ${i + 1}`
    if (!o || !/^[a-z][a-z0-9-]*$/.test(o.k)) errors.push(`${label}: invalid object key`)
    if (keys.has(o?.k)) errors.push(`${label}: duplicate object key`)
    keys.add(o?.k)
    if (!text(o?.n)) errors.push(`${label}: missing object name`)
    if (!positive(o?.cm)) errors.push(`${label}: cm must be a positive number`)
    const b = o?.b
    if (o?.source !== 'additional-supply' && (!Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite) || b[0] < 0 || b[1] < 0 || !positive(b[2]) || !positive(b[3])))
      errors.push(`${label}: invalid photo box`)
    else if (o?.source !== 'additional-supply' && photo && (b[0] + b[2] > photo.width + 1 || b[1] + b[3] > photo.height + 1)) errors.push(`${label}: box extends outside the photo`)
    if (o?.part?.size && (!Array.isArray(o.part.size) || o.part.size.length !== 3 || !o.part.size.every(positive))) errors.push(`${label}: invalid part size`)
    if (o?.contents && (!text(o.contents.name) || !['liquid', 'powder', 'pieces'].includes(o.contents.form) || !/^#[\da-f]{6}$/i.test(o.contents.color || '') || o.contents.opacity != null && !(Number.isFinite(o.contents.opacity) && o.contents.opacity >= 0 && o.contents.opacity <= 1))) errors.push(`${label}: invalid container contents`)
    if (o?.part?.family === 'brick' && (!Array.isArray(o.part.studs) || o.part.studs.length !== 2 || !o.part.studs.every((n) => Number.isInteger(n) && n > 0) || !Number.isInteger(o.part.plates) || o.part.plates <= 0)) errors.push(`${label}: invalid brick dimensions`)
  }
  return errors
}

// Only direct placement captions with a recognizable object class are compared. Unknown names and compound
// identities stay unchecked; this is a contradiction check, not an attempt to understand arbitrary prose.
const CAPTION_TYPES = [
  ['vessel', ['cup', 'mug', 'bowl', 'glass']],
  ['bag', ['pouch', 'bag', 'sack']],
  ['mat', ['mat', 'trivet', 'coaster']],
  ['machine', ['machine', 'appliance']],
  ['capsule', ['capsule', 'pod']],
  ['bracelet', ['bracelet', 'bangle']],
]
const typeWords = CAPTION_TYPES.flatMap(([, words]) => words).join('|')
const placedNoun = new RegExp(`^(?:then\\s+)?(?:place|put|set|rest|position|move)\\s+(?:(?:the|a|an|finished|completed|empty|full|clean|filled|hot|cold)\\s+)*(${typeWords})\\b`, 'i')
const identityTypes = (name) => CAPTION_TYPES.filter(([, words]) => words.some((word) => new RegExp(`\\b${word}s?\\b`, 'i').test(name))).map(([type]) => type)

export function captionIdentityProblems(script) {
  const entities = new Map([...list(script?.objects), ...list(script?.tools), ...list(script?.makes)].filter(Boolean).map((o) => [o.k, o]))
  return list(script?.steps).flatMap((step, i) => {
    const match = placedNoun.exec(String(step?.c || '')), actions = list(step?.do)
    if (!match || actions.length !== 1 || actions[0]?.v !== 'place') return []
    const expected = identityTypes(match[1])[0], keys = [actions[0].k].flat(), actors = keys.map((k) => entities.get(k))
    const types = actors.map((o) => identityTypes(`${o?.n || o?.use || ''} ${String(o?.k || '').replace(/-/g, ' ')}`))
    if (!actors.length || actors.some((o) => !o) || types.some((ts) => ts.length !== 1) || types.some((ts) => ts[0] === expected)) return []
    return [`step ${i + 1}: caption names a ${match[1].toLowerCase()} but placement moves ${actors.map((o) => `${o.k} (${o.n || o.use || o.k})`).join(', ')}. Use the intended object's key; if it is an extra supplied utensil, declare it in tools. Keep photographed identities unchanged.`]
  })
}

export function validatePlan(script, photo, { confirmedMeasurements = script?.measurementConfirmations || {} } = {}) {
  if (!script || typeof script !== 'object' || Array.isArray(script)) return { valid: false, errors: ['plan must be a JSON object'], warnings: [] }
  if (script.materials || script.assembly || script.cuts != null || list(script.steps).some(s => list(s?.do).some(a => a?.cut != null))) {
    script = structuredClone(script)
    try { settlePlanningInputs(script) } catch (error) { return { valid: false, errors: [error.message], warnings: [], soft: [] } }
  }
  const contract = validateContract(script, { confirmedMeasurements })
  // (soft: what the plan's repair is asked to fix but a film is still made with — the design against the steps, a cut
  // list too long for a part with no timber sizes; errors stop the plan)
  const errors = [...validateObjects(script.objects, photo), ...contract.errors], warnings = [...contract.warnings], soft = []
  const supplies = new Map(suppliedObjects(script).map(o => [o.k, o]))
  const declaredSupply = ({ states, state, ...o }) => JSON.stringify(o)
  for (const o of list(script.objects)) if (o?.source === 'additional-supply' && declaredSupply(o) !== JSON.stringify(supplies.get(o.k))) errors.push(`${o.k}: supply actor must match its explicit materials declaration`)
  if (supplies.size) warnings.push('Additional materials are required supplies, not objects observed in the photo.')
  if (list(script.makes).length) warnings.push('Skein dimensions do not establish available yarn quantity; confirm sufficient yarn for the finished piece.')
  // Explicit caption contradictions fail validation for every current plan.
  const captionProblems = captionIdentityProblems(script)
  errors.push(...captionProblems)
  if (script.mode === 'physical') {
    for (const f of ['contractVersion', 'objects', 'ideas', 'pick', 'design', 'title', 'sub', 'tag', 'view', 'tools', 'joints', 'goals', 'steps', 'finale', 'end'])
      if (!(f in script)) errors.push(`plan must provide ${f} in physical mode`)
    if (script.contractVersion !== 2) errors.push('plan must use operation contract version 2 in physical mode')
  }
  if (!text(script.title)) errors.push('title is required')
  if (!VIEWS.has(script.view)) errors.push('view must be side, plan, front or iso')
  if (!Array.isArray(script.steps) || !script.steps.length) errors.push('steps must be a nonempty array')
  for (const field of ['tools', 'makes', 'rigs', 'finale']) if (script[field] != null && !Array.isArray(script[field])) errors.push(`${field} must be an array`)
  for (const field of ['supplies', 'confirmations']) if (script[field] != null && (!Array.isArray(script[field]) || script[field].some((s) => !text(s)))) errors.push(`${field} must be an array of nonempty strings`)
  const objects = new Map(list(script.objects).filter(Boolean).map((o) => [o.k, o]))
  const known = new Set(objects.keys()), available = new Set(known), placed = new Set(), consumed = new Set()
  const declare = (k, what) => {
    if (!text(k)) errors.push(`${what}: missing key`)
    else if (known.has(k)) errors.push(`${what}: duplicate key ${k}`)
    else known.add(k)
  }
  for (const t of list(script.tools)) {
    declare(t?.k, 'tool')
    if (!TOOL_KINDS.includes(t?.use)) errors.push(`tool ${t?.k}: unsupported tool ${t?.use}`)
    available.add(t?.k)
  }
  for (const m of list(script.makes)) { declare(m?.k, 'made piece'); available.add(m?.k) }
  // Declare cut outputs first, but don't make them available until the cut happens.
  for (const s of list(script.steps)) for (const a of list(s?.do)) for (const part of list(a?.into)) declare(part?.k, 'cut part')
  for (const [i, step] of list(script.steps).entries()) {
    const label = `step ${i + 1}`
    if (!text(step?.t) || !text(step?.c)) errors.push(`${label}: title and caption are required`)
    if (!Array.isArray(step?.do) || !step.do.length) { errors.push(`${label}: actions are required`); continue }
    for (const a of step.do) {
      if (!a || !VERBS.has(a.v)) { errors.push(`${label}: unsupported action ${a?.v}`); continue }
      if (a.pattern != null && (a.v !== 'stir' || !['circle', 'zigzag'].includes(a.pattern))) errors.push(`${label}: invalid stirring pattern`)
      if (a.pace != null && (a.v !== 'stir' || !['gentle', 'normal', 'brisk'].includes(a.pace))) errors.push(`${label}: invalid stirring pace`)
      if (a.finish != null && (a.v !== 'stir' || !['mixed', 'foam'].includes(a.finish))) errors.push(`${label}: invalid stirring finish`)
      if (a.opacity != null && !(Number.isFinite(a.opacity) && a.opacity >= 0 && a.opacity <= 1)) errors.push(`${label}: invalid transfer opacity`)
      if (a.v === 'heat' && a.level != null && !['high', 'medium', 'low', 'off'].includes(a.level)) errors.push(`${label}: invalid heat level`)
      if (!(text(a.k) || (Array.isArray(a.k) && a.k.length && a.k.every(text)))) errors.push(`${label}: action must name an object key or nonempty list of keys`)
      for (const field of ['k', 'to', 'also', 'with', 'part', 'and']) for (const k of [a[field]].flat().filter((k) => k != null)) {
        if (!known.has(k)) errors.push(`${label}: ${field} refers to unknown object ${k}`)
        else if (!available.has(k)) errors.push(`${label}: ${k} is used before it is created`)
      }
      for (const k of [a.k].flat().filter(Boolean)) if (consumed.has(k)) warnings.push(`${label}: ${k} is used again after pouring or sprinkling it`)
      if (a.v === 'place') {
        if (a.rel != null && !RELATIONS.has(a.rel)) errors.push(`${label}: unsupported placement relation ${a.rel}`)
        if (a.to && !placed.has(a.to)) errors.push(`${label}: ${a.to} must be placed before it supports ${a.k}`)
        for (const x of Array.isArray(a.also) ? a.also : []) if (!placed.has(x)) errors.push(`${label}: ${x} must be placed before it supports ${a.k}`)
        for (const k of [a.k].flat()) placed.add(k)
        if (a.rel === 'next' && !['left', 'right'].includes(a.at)) warnings.push(`${label}: next placement omits left/right direction`)
      }
      if (['pour', 'sprinkle', 'stir', 'heat'].includes(a.v) && (!a.to || !placed.has(a.to))) errors.push(`${label}: ${a.v} needs a placed target`)
      if (['pour', 'sprinkle'].includes(a.v) && objects.has(a.k)) consumed.add(a.k)
      if (a.v === 'cut' && Array.isArray(a.into)) {
        for (const p of a.into) available.add(p?.k)
        const o = objects.get(a.k)
        // (a log, or anything else with only a length: its cut list must fit too)
        const pieces = a.into.map((p) => +p?.cm).filter(positive), sum = pieces.reduce((n, v) => n + v, 0)
        if (!a.into.some((p) => p?.size) && !(positive(o?.w) && positive(o?.thick)) && positive(o?.cm) && sum > o.cm + 0.01)
          soft.push(`${label}: cuts total ${+sum.toFixed(1)} cm (${pieces.join(' + ')}) but ${a.k} is only ${o.cm} cm long: cut fewer or shorter parts, or from more objects`)
        if (positive(o?.w) && positive(o?.thick) && o?.part?.family !== 'sheet' && !a.into.some(p => p?.size)) {
          const lengths = a.into.map((p) => {
            const m = String(p?.label || '').match(/^\s*(\d+(?:\.\d+)?|\.\d+)\s*(cm|mm|m)\b/i)
            const labelled = m ? +m[1] * ({ cm: 1, mm: 0.1, m: 100 }[m[2].toLowerCase()]) : null
            if (p?.cm != null && (!positive(p.cm) || labelled != null && Math.abs(labelled - p.cm) > 0.00001)) errors.push(`${label}: typed cut length contradicts its label`)
            if (!positive(p?.cm)) errors.push(`${label}: numeric cut parts need an explicit cm length`)
            return positive(p?.cm) ? p.cm : labelled
          })
          if (lengths.every(positive)) {
            const total = lengths.reduce((sum, n) => sum + n, 0), margin = o.cm - total
            if (margin < -0.01) errors.push(`${label}: cuts total ${total} cm but ${a.k} is only ${o.cm} cm`)
            else if (margin < Math.max(0, lengths.length - 1) * 0.3) warnings.push(`${label}: cut list leaves insufficient allowance for an assumed 3 mm saw kerf`)
          } else warnings.push(`${label}: cut lengths cannot be checked`)
        }
      }
      if (a.v === 'cut' && a.into == null && a.shape == null) errors.push(`${label}: cut needs explicit into outputs or a sheet cut shape`)
      if (a.v === 'work') {
        if (!list(script.makes).some((m) => m?.k === a.k)) errors.push(`${label}: work target ${a.k} must name a piece declared in makes, not source material`)
        if (!objects.has(a.to) || a.to === a.k) errors.push(`${label}: work source to must name a distinct photographed material`)
        if (!(typeof a.p === 'number') || !Number.isFinite(a.p) || a.p < 0 || a.p > 1) errors.push(`${label}: work progress must be between 0 and 1`)
      }
    }
    // What the caption promises, against what the step's actions carry: a tool it names that none uses, a quantity it
    // gives a unit that no action holds (in label, cm, n or gap). Warnings: a word can be another word ("saw it square").
    const caption = text(step?.c) ? step.c : '', used = new Set(step.do.flatMap((a) => [a?.k, a?.with, a?.part, a?.to].flat()).filter(Boolean))
    for (const t of list(script.tools)) if (t?.k && !used.has(t.k) && [t.k, t.use].some((w) => /^[a-z]+$/i.test(w || '') && new RegExp(`\\b${w}\\b`, 'i').test(caption)))
      warnings.push(`${label}: the caption names ${t.k}, but no action uses it`)
    const carried = new Set(step.do.flatMap((a) => [a?.label, a?.cm, a?.n, a?.gap, ...list(a?.into).map((p) => p?.label)].flat()).filter((v) => v != null)
      .flatMap((v) => String(v).match(/\d+(?:\.\d+)?/g) || []))
    for (const m of caption.matchAll(/(\d+(?:\.\d+)?)\s*(mm|cm|m|minutes?|min|hours?|g|kg|ml|l)(?![a-z])/gi))
      if (!carried.has(m[1])) warnings.push(`${label}: the caption gives ${m[0]}, but no action carries it`)
  }
  for (const made of list(script.makes)) {
    const work = list(script.steps).flatMap((s) => list(s?.do)).filter((a) => a?.v === 'work' && a.k === made?.k)
    if (!work.length) errors.push(`made piece ${made?.k}: needs work operations that visibly create it`)
    else if (work.some((a, i) => i && a.p < work[i - 1].p) || work.at(-1).p !== 1) errors.push(`made piece ${made.k}: work progress must increase and finish at 1`)
  }
  // Shaped parts (shapes.mjs): each a part the steps make or use, its outline inside it, its numbers ones a saw can cut.
  const lengthOf = (k) => {
    const cut = list(script.steps).flatMap((s) => list(s?.do)).flatMap((a) => list(a?.into)).find((p) => p?.k === k)
    const o = objects.get(k)
    return { L: +cut?.cm || +o?.cm || null, W: +(objects.get(list(script.steps).flatMap((s) => list(s?.do)).find((a) => list(a?.into).some((p) => p?.k === k))?.k)?.w) || +o?.w || null }
  }
  if (script.profiles != null && !Array.isArray(script.profiles)) errors.push('profiles must be an array')
  for (const q of list(script.profiles)) {
    const label = `profile ${q?.k}`
    if (!text(q?.k) || !known.has(q.k)) { errors.push(`${label}: not a part the steps cut or an object`); continue }
    const { L, W } = lengthOf(q.k)
    if (q.outline != null && (!Array.isArray(q.outline) || q.outline.length < 3 || q.outline.length > 48 || q.outline.some((p) => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite))))
      errors.push(`${label}: an outline is 3 to 48 points [cm along its length, cm across its width]`)
    else if (q.outline && L && W && q.outline.some(([u, v]) => u < -0.5 || v < -0.5 || u > L + 0.5 || v > W + 0.5)) warnings.push(`${label}: outline points outside its ${L} × ${W} cm are cut back to it`)
    if (q.taper != null && !(q.taper >= 0.2 && q.taper < 1)) errors.push(`${label}: taper is the width at its start as a fraction of its width, 0.2 to under 1`)
    if (q.round != null && !(q.round >= 0 && (!W || q.round <= W / 2))) errors.push(`${label}: round is a corner radius in cm, at most half its width`)
    if (q.ends != null && (!Array.isArray(q.ends) || q.ends.length !== 2 || q.ends.some((e) => !(e === 'mitre' || e === 'square' || (Number.isFinite(e) && Math.abs(e) <= 60)))))
      errors.push(`${label}: ends are two of "square", "mitre" or an angle in degrees (−60 to 60)`)
    for (const n of list(q.notches)) if (!(n?.at >= 0 && n?.w > 0 && n?.d > 0) || (L && n.at + n.w > L + 0.01) || (W && n.d >= W))
      errors.push(`${label}: a notch is "at" cm from its start, "w" cm wide and "d" cm deep, inside the part`)
  }
  for (const [i, step] of list(script.steps).entries()) for (const a of list(step?.do)) {
    if (a?.tilt != null && !(a.tilt >= 0 && a.tilt <= 45)) errors.push(`step ${i + 1}: tilt is 0 to 45 degrees`)
    if (a?.splay != null && !(a.splay >= 0 && a.splay <= 30)) errors.push(`step ${i + 1}: splay is 0 to 30 degrees`)
  }
  // A reshape changes a thing's shape, so its drawings before and after differ in their paths, not only their colour
  // (a snowflake's square, triangle, wedge and snowflake came as one rectangle shaded four ways: the film showed a rectangle).
  const drawn = new Map([...list(script.objects), ...list(script.tools), ...list(script.makes), ...list(script.steps).flatMap((s) => list(s?.do).flatMap((a) => list(a?.into)))]
    .filter((o) => o && Array.isArray(o.states)).map((o) => [o.k, o.states]))
  const outline = (k, id) => {
    const art = drawn.get(k)?.find((s) => s?.id === id)?.appearance
    return Array.isArray(art?.shapes) ? JSON.stringify(art.shapes.map((sh) => String(sh?.d ?? '').replace(/\s+/g, ' ').trim())) : null
  }
  for (const [i, step] of list(script.steps).entries()) for (const a of list(step?.do)) if (a?.v === 'reshape') for (const e of list(a.effects)) {
    const before = list(a.requires).find((r) => r?.k === e?.k), was = before && outline(e.k, before.state)
    if (was && was === outline(e.k, e.state)) soft.push(before.state === e.state
      ? `step ${i + 1}: ${e.k} is reshaped from "${e.state}" into "${e.state}", so the step shows no change: give the shape after it its own state, drawn as it looks`
      : `step ${i + 1}: ${e.k} is drawn with the same outline "${before.state}" and "${e.state}": draw each state as the thing really looks in it (a square folded corner to corner is a triangle)`)
  }
  // Folds are worked out exactly (fold.mjs): a reference that names nothing on the sheet, or a fold that moves nothing or
  // all of it, is the plan's to fix.
  if (list(script.steps).some((s) => list(s?.do).some((a) => a?.v === 'fold' || a?.v === 'cut' && a.shape))) errors.push(...checkFolds(script))
  // Strands are worked out exactly too (strand.mjs): a place that is not on the strand, a bend that would cross it, a coil
  // whose turns the length does not make, a knot with no room.
  if (list(script.steps).some((s) => list(s?.do).some((a) => a?.v === 'strand'))) errors.push(...checkStrands(script))
  soft.push(...designProblems(script, objects))
  errors.push(...checkSheets(script))
  if (objects.size) warnings.push('Real-world dimensions and quantities are model estimates until confirmed; validation does not establish physical safety or instructional correctness.')
  return { valid: errors.length === 0, errors: [...new Set(errors)], warnings: [...new Set(warnings)], soft: [...new Set(soft)] }
}

// The maker's design (script.design) against the steps: each object's parts fit in it; every part cut is a part of the
// design under the same key and length, and every part of the design is made. Offcuts need not be listed.
export function designProblems(script, objects = new Map(list(script?.objects).filter(Boolean).map((o) => [o.k, o]))) {
  const d = script?.design, out = []
  if (!d || typeof d !== 'object') return ['design is missing: give its purpose, the sizes it follows, its size and its parts before the steps']
  const acts = list(script.steps).flatMap((s) => list(s?.do)), parts = list(d.parts).filter((p) => p && typeof p.k === 'string')
  const cuts = acts.filter((a) => a?.v === 'cut' && Array.isArray(a.into)).flatMap((a) => a.into.filter((p) => p && typeof p.k === 'string').map((p) => ({ ...p, from: a.k })))
  const made = new Set([...cuts.map((p) => p.k), ...acts.flatMap((a) => [a?.k].flat()), ...list(script.makes).map((m) => m?.k)])
  const builds = ['plan', 'front', 'iso'].includes(script.view)
  if (builds && !(Array.isArray(d.size) && d.size.length === 3 && d.size.every(positive))) out.push('design.size is missing: the finished width × depth × height in cm')
  // each object's parts fit in its length, with a 0.3 cm saw cut between them
  const byStock = new Map(), sheets = sheetParts(script)
  const madePieces = new Set(list(script.makes).map(m => m?.k))
  for (const p of parts) {
    const source = objects.get(p.from)
    const textile = madePieces.has(p.k) && /yarn|wool|skein|thread/i.test(`${source?.k} ${source?.n} ${source?.segment}`)
    if (positive(+p.cm) && source && !sheets.has(p.from) && !textile) byStock.set(p.from, [...(byStock.get(p.from) || []), ...Array(Number.isInteger(p.n) && p.n > 0 ? p.n : 1).fill(+p.cm)])
  }
  for (const [k, lengths] of byStock) {
    const o = objects.get(k), total = lengths.reduce((n, v) => n + v, 0) + 0.3 * (lengths.length - 1)
    if (positive(o?.cm) && lengths.length > 1 && total > o.cm + 0.5) out.push(`design: the parts from ${k} need ${+total.toFixed(1)} cm (${lengths.join(' + ')} and saw cuts) but ${k} is ${o.cm} cm long: take parts from more objects, or make them shorter`)
    if (positive(o?.cm) && lengths.length === 1 && lengths[0] > o.cm + 0.5) out.push(`design: ${parts.find((p) => p.from === k)?.k} is ${lengths[0]} cm but ${k} is only ${o.cm} cm long`)
  }
  for (const p of parts) if (p.from && !objects.has(p.from) && !made.has(p.from)) out.push(`design: ${p.k} comes from ${p.from}, which is not an object`)
  // the steps cut exactly the design's parts
  const byKey = new Map(parts.map((p) => [p.k, p]))
  for (const p of parts) if (p.n > 1 && !objects.has(p.k)) {
    out.push(`design: ${p.k} requests ${p.n} copies under one key: give every physical copy its own key and creation operation`)
  }
  for (const c of cuts) {
    const p = byKey.get(c.k)
    if (!p) { if (positive(+c.cm) && !OFFCUT.test(`${c.k} ${c.label || ''}`)) out.push(`design: the steps cut ${c.k} (${c.cm} cm from ${c.from}), which is not among the design's parts`); continue }
    if (positive(+c.cm) && positive(+p.cm) && Math.abs(c.cm - p.cm) > 0.5) out.push(`design: ${c.k} is ${p.cm} cm in the design but cut ${c.cm} cm`)
    if (p.from && p.from !== c.from) out.push(`design: ${c.k} comes from ${p.from} in the design but is cut from ${c.from}`)
  }
  for (const p of parts) if (positive(+p.cm) && !made.has(p.k) && !objects.has(p.k)) out.push(`design: ${p.k} is never made or used by the steps`)
  return out
}
