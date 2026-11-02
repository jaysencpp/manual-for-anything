import { operationSites, entities } from './operations.mjs'
import { checkDemonstration } from '../film/demonstrations.mjs'
import { TOOL_KINDS } from './tools.mjs'
import { sheetSize } from './fold.mjs'
import { strandSize, strandOp } from './strand.mjs'
import { hasSheetCuts, hasSheetToolPaths } from './sheets.mjs'
import { settleProcesses } from './processes.mjs'
import { settlePlanningInputs } from '../pipeline/planning-inputs.mjs'

// A piece cut off and not used (an offcut): need not be in the design, and is not what a later mention of its stock means.
export const OFFCUT = /off-?cut|waste|scrap|spare|left-?over|remainder|rest\b/i
const INTENTS = { place: ['place'], cut: ['cut'], pour: ['pour'], sprinkle: ['sprinkle'], stir: ['stir'],
  heat: ['heat', 'cool'], work: ['work'], measure: ['measure'], fold: ['fold', 'crease', 'unfold', 'turn', 'rotate', 'cut', 'open'], use: ['use', 'fasten', 'drill', 'glue', 'sand', 'clamp', 'mark', 'apply', 'fit', 'stitch'] }
const FACE = new Set(['upper', 'lower', 'front', 'back', 'left', 'right', 'start', 'end'])
const list = (v) => Array.isArray(v) ? v.filter((v) => v != null) : []

export function validateContract(script, { confirmedMeasurements = script.measurementConfirmations || {} } = {}) {
  const errors = [], warnings = []
  if (script.contractVersion !== 2) errors.push('operation contract version 2 is required')
  for (const field of ['objects', 'tools', 'makes', 'steps', 'joints', 'goals', 'states']) if (script[field] != null && !Array.isArray(script[field])) errors.push(`${field} must be an array`)
  if ((!Array.isArray(script.joints) || !Array.isArray(script.goals))) errors.push('operation contract needs joints and goals arrays')
  const objects = new Map(list(script.objects).filter(Boolean).map((o) => [o.k, o]))
  const known = new Set([...objects.keys(), ...list(script.tools).map((o) => o.k), ...list(script.makes).map((o) => o.k),
    ...list(script.steps).flatMap((s) => list(s.do)).flatMap((a) => list(a.into).map((p) => p.k))])
  const declared = new Map(entities(script).map((o) => [o.k, o]))
  const defined = new Set()
  for (const d of list(script.states)) {
    if (!known.has(d.k) || defined.has(d.k) || !Array.isArray(d.states)) errors.push('top-level state definitions need unique known actors and states arrays')
    defined.add(d.k)
  }
  const states = new Map(), current = new Map()
  for (const o of entities(script).filter(Boolean)) {
    const declared = list(o.states).map((s) => s.id)
    if (o.states != null && !Array.isArray(o.states)) errors.push(`${o.k}: states must be an array`)
    if (list(o.states).some((s) => typeof s.id !== 'string' || !s.id || (typeof s.label !== 'string' || !s.label))) errors.push(`${o.k}: states need unique names and labels`)
    if (new Set(declared).size !== declared.length) errors.push(`${o.k}: duplicate states`)
    states.set(o.k, new Set(declared)); current.set(o.k, o.state)
    if (o.state != null && !declared.includes(o.state)) errors.push(`${o.k}: initial state is not declared`)
    for (const state of list(o.states)) if (state.appearance) {
      const v = state.appearance
      if (!(Number.isFinite(v.width) && v.width > 0 && Number.isFinite(v.height) && v.height > 0) || !list(v.shapes).length || list(v.shapes).length > 64
          || list(v.shapes).some((s) => typeof s.d !== 'string' || s.d.length > 8000 || typeof s.fill !== 'string' || typeof s.stroke !== 'string'))
        errors.push(`${o.k}: invalid state appearance`)
    }
    for (const field of ['cm', 'w', 'thick'].filter((k) => objects.has(o.k) && o[k] != null)) {
      const m = o.measurements?.[field]
      if (!m) errors.push(`${o.k}: ${field} needs measurement provenance`)
      if (m && (!['estimated', 'confirmed'].includes(m.status) || typeof m.source !== 'string' || !m.source.trim())) errors.push(`${o.k}: invalid measurement provenance for ${field}`)
      if (m?.status === 'confirmed' && confirmedMeasurements?.[o.k]?.[field] !== o[field]) errors.push(`${o.k}.${field}: confirmation has no matching user-supplied measurement`)
      if (!m || m.status === 'estimated') warnings.push(`${o.k}.${field}: unconfirmed measurement`)
    }
  }
  const joints = new Map()
  const sitesValid = (sites) => Array.isArray(sites) && sites.length > 0 && sites.length <= 64 && sites.every((p) =>
    p && Number.isFinite(p.x) && p.x >= 0 && p.x <= 1 && (p.lat == null || Number.isFinite(p.lat) && Math.abs(p.lat) <= 0.5))
    && new Set(sites.map((p) => `${p.x}:${p.lat || 0}`)).size === sites.length
  for (const j of list(script.joints)) {
    if (!j.id || joints.has(j.id)) errors.push('joint IDs must be unique and nonempty')
    joints.set(j.id, j)
    if (!known.has(j.a) || !known.has(j.b) || j.a === j.b) errors.push(`joint ${j.id}: needs two distinct known parts`)
    if (!FACE.has(j.face) || !FACE.has(j.otherFace)) errors.push(`joint ${j.id}: invalid mating faces`)
    if (!sitesValid(j.sites)) errors.push(`joint ${j.id}: invalid work sites`)
    if (!['fasten', 'glue', 'clamp', 'fit'].includes(j.method)) errors.push(`joint ${j.id}: invalid method`)
    if (j.depthCm != null && !(Number.isFinite(j.depthCm) && j.depthCm > 0)) errors.push(`joint ${j.id}: invalid depth`)
    if (j.method === 'fasten' && !(Number.isFinite(j.depthCm) && j.depthCm > 0)) errors.push(`joint ${j.id}: fastener depth is required`)
  }
  const ids = new Set(), attached = new Set(), jointUses = new Set(), positioned = new Set()
  const available = new Set([...objects.keys(), ...list(script.tools).map((o) => o.k), ...list(script.makes).map((o) => o.k)])
  for (const [step, s] of list(script.steps).entries()) {
    const local = new Set(list(s.do).map((a) => a.id).filter(Boolean))
    if ((!Array.isArray(s.claims) || !s.claims.length)) errors.push(`step ${step + 1}: declare the operation IDs the caption claims`)
    if (list(s.claims).some((id) => !local.has(id))) errors.push(`step ${step + 1}: claim refers to a missing operation`)
    if (s.caption && (typeof s.caption.template !== 'string' || !Array.isArray(s.caption.actions) || !s.caption.actions.length
        || new Set(s.caption.actions).size !== s.caption.actions.length || s.caption.actions.some((id) => !local.has(id))))
      errors.push(`step ${step + 1}: invalid caption operation references`)
    if (s.caption && [...String(s.caption.template).matchAll(/\{([^}]+)\}/g)].some((m) => m[1] !== 'count')) errors.push(`step ${step + 1}: unsupported caption placeholder`)
    for (const a of list(s.do)) {
      const label = a.id || `step ${step + 1}`
      for (const p of list(a.into)) {
        const m = String(p.label || '').match(/^\s*(\d+(?:\.\d+)?|\.\d+)\s*(cm|mm|m)\b/i)
        const labelled = m ? +m[1] * ({ cm: 1, mm: 0.1, m: 100 }[m[2].toLowerCase()]) : null
        if (p.cm != null && (!(Number.isFinite(p.cm) && p.cm > 0) || labelled != null && Math.abs(labelled - p.cm) > 0.00001))
          errors.push(`${label}: typed cut length contradicts its label`)
      }
      if ((!a.id || !a.intent)) errors.push(`${label}: operation needs id and intent`)
      if (a.v !== 'place' && !list(s.claims).includes(a.id)) errors.push(`${label}: operation is missing from the caption claims`)
      if (a.id && ids.has(a.id)) errors.push(`${label}: duplicate operation ID`)
      if (a.id) ids.add(a.id)
      if (a.intent && a.v !== 'demonstrate' && a.v !== 'reshape' && a.v !== 'strand' && !INTENTS[a.v]?.includes(a.intent)) errors.push(`${label}: intent ${a.intent} needs a faithful demonstration, not ${a.v}`)
      if (a.n != null && (!Number.isInteger(a.n) || a.n < 1 || a.n > 64)) errors.push(`${label}: count must be 1–64 per object`)
      if (a.x != null && [].concat(a.x).some((x) => !Number.isFinite(x) || x < 0 || x > 1)) errors.push(`${label}: normalized work positions must lie on the part`)
      if (a.cm != null) {
        const target = declared.get(a.v === 'place' ? a.to : a.k)
        const length = a.v === 'place' ? target?.part?.size?.[0] || target?.cm : target?.cm
        if (a.v === 'place' && (!a.to || !Number.isFinite(a.cm)))
          errors.push(`${label}: measured placement needs one cm offset and a target to place it on`)
        else if ([].concat(a.cm).some(x => !Number.isFinite(x) || x < 0 || length > 0 && x > length))
          errors.push(a.v === 'place' ? `${label}: measured placement lies outside target ${a.to}` : `${label}: measured work position lies outside the part`)
      }
      if (a.sites && (!sitesValid(a.sites) || a.n != null && a.n !== a.sites.length)) errors.push(`${label}: count and explicit sites disagree`)
      if (a.focus && (!known.has(a.focus.k) || !Array.isArray(a.focus.bounds) || a.focus.bounds.length !== 4
          || !a.focus.bounds.every(Number.isFinite) || a.focus.bounds[0] < 0 || a.focus.bounds[1] < 0 || a.focus.bounds[2] <= 0 || a.focus.bounds[3] <= 0
          || a.focus.bounds[0] + a.focus.bounds[2] > 1 || a.focus.bounds[1] + a.focus.bounds[3] > 1
          || a.focus.clearance != null && !(a.focus.clearance >= 0 && a.focus.clearance <= 0.5))) errors.push(`${label}: invalid normalized focus bounds`)
      if (a.part && (!s.caption?.actions?.includes(a.id) || !s.caption?.template?.includes('{count}'))) errors.push(`${label}: puts in ${a.part}, so its step needs "caption":{"template":"… {count} …","actions":[its fastening action ids]}`)
      if (a.part && a.intent !== 'fasten') errors.push(`${label}: fastener work must declare the fasten intent`)
      if (a.v === 'use' && ['fasten', 'glue', 'clamp'].includes(a.intent) && !a.joint) errors.push(`${label}: attachment operation needs an explicit joint`)
      if (a.intent === 'fasten') {
        const fastener = declared.get(a.part), kind = fastener?.use || fastener?.toolKind
        if (!a.part) errors.push(`${label}: fastening needs an explicit part reference to a declared screw, nail, dowel or bolt`)
        else if (!fastener) errors.push(`${label}: unknown fastener ${a.part}; declare it in tools or reference a photographed fastener`)
        else if (!['screw', 'nail', 'dowel', 'bolt'].includes(kind)) errors.push(`${label}: ${a.part} is not a declared fastener`)
        if (!a.with) errors.push(`${label}: fastening needs an explicit with reference to its driving tool`)
        if (a.path != null || a.otherPath != null) errors.push(`${label}: fastening uses joint sites, not flat-sheet path or otherPath`)
      }
      const j = joints.get(a.joint)
      if (a.joint && !j) errors.push(`${label}: unknown joint ${a.joint}`)
      if (j) {
        jointUses.add(j.id)
        if (a.k !== j.a || a.to != null && a.to !== j.b || a.face != null && a.face !== j.face || a.n != null && a.n !== j.sites?.length
            || a.sites && JSON.stringify(a.sites) !== JSON.stringify(j.sites)) errors.push(`${label}: operation contradicts joint ${j.id}`)
        if (a.intent && a.intent !== j.method && a.intent !== 'drill' && !(a.v === 'place' && j.method === 'fit')) errors.push(`${label}: operation method contradicts joint ${j.id}`)
        if (j.method === 'glue' && (attached.has(`${j.a}/${j.b}`) || attached.has(`${j.b}/${j.a}`))) errors.push(`${label}: glue must precede closing the mating faces`)
        if (a.intent === 'fasten') {
          if (!positioned.has(j.a) || !positioned.has(j.b)) errors.push(`${label}: position both joint parts before fastening`)
          const part = declared.get(a.part)
          const kind = part?.use || part?.toolKind
          if (['screw', 'nail', 'dowel', 'bolt'].includes(kind) && (!(part.cm > 0) || Math.abs(part.cm - j.depthCm) > 0.001))
            errors.push(`${label}: declared fastener length must equal the planned driven depth`)
          const tool = declared.get(a.with), using = tool?.use || tool?.toolKind
          const compatible = { screw: ['screwdriver', 'drill'], nail: ['hammer'], dowel: ['hammer'], bolt: ['wrench'] }
          if (compatible[kind] && a.with && !compatible[kind].includes(using)) errors.push(`${label}: fastening tool is incompatible with the fastener`)
        }
      }
      if (a.v === 'place' && a.to && (['on', 'end', 'between', 'across', 'under', 'in'].includes(a.rel || 'on') || a.rel === 'parallel' && !(a.gap > 0.01)))
        for (const k of [].concat(a.k)) {
          attached.add(`${k}/${a.to}`); if (a.rel === 'between' && a.and) attached.add(`${k}/${a.and}`)
          for (const x of list(a.also)) attached.add(`${k}/${x}`)
        }
      if (a.v === 'place') for (const k of [].concat(a.k)) positioned.add(k)
      if (a.v === 'demonstrate') {
        const problem = checkDemonstration(a.demo)
        if (problem) errors.push(`${label}: ${problem}`)
        if (!list(a.demo?.actors).includes(a.k) || list(a.demo?.actors).some((k) => !known.has(k))) errors.push(`${label}: invalid demonstration actors`)
        if (!a.focus) errors.push(`${label}: demonstration needs a focus region`)
        if (a.focus && !list(a.demo?.actors).includes(a.focus.k)) errors.push(`${label}: focus must belong to a demonstration actor`)
        if (list(a.effects).some((e) => !list(a.demo?.actors).includes(e.k))) errors.push(`${label}: demonstration changes an undeclared actor`)
        if (!list(a.effects).length) errors.push(`${label}: demonstration must declare its resulting state`)
        if (a.demo?.technique === 'weave-ends') {
          if (a.k !== a.demo.piece || !list(script.makes).some(m => m.k === a.demo.piece)) errors.push(`${label}: weaving ends must target a declared textile piece`)
          const needle = declared.get(a.demo.needle), yarn = objects.get(a.demo.yarn)
          if ((needle?.use || needle?.toolKind) !== 'needle') errors.push(`${label}: weaving ends needs a declared needle tool`)
          if (!yarn || !/yarn|wool|thread|skein/i.test(`${yarn.k} ${yarn.n} ${yarn.segment}`)) errors.push(`${label}: weaving ends needs photographed yarn`)
          const b = a.focus?.bounds
          if (!b || list(a.demo.path).some(q => !Array.isArray(q) || q[0] < b[0] || q[1] < b[1] || q[0] > b[0]+b[2] || q[1] > b[1]+b[3])) errors.push(`${label}: weaving path must stay inside the focus region`)
        }
      } else if (a.demo) errors.push(`${label}: drawing code requires the demonstrate verb`)
      if (a.v === 'reshape') {
        // (the film moves the thing's drawing before into its drawing after: the after must be drawn)
        const end = list(a.effects).find((e) => e.k === a.k)
        if (typeof a.k !== 'string' || !known.has(a.k)) errors.push(`${label}: reshaping needs one known thing`)
        else if (!end) errors.push(`${label}: reshaping must declare the shape ${a.k} ends in (an effect on ${a.k})`)
        else if (!list(declared.get(a.k)?.states).find((s) => s.id === end.state)?.appearance) errors.push(`${label}: reshaping needs a drawing (appearance) of ${a.k}:${end.state}`)
      }
      const requireKeys = new Set()
      for (const r of list(a.requires)) {
        if (!available.has(r.k) || !states.get(r.k)?.has(r.state) || current.get(r.k) !== r.state) errors.push(`${label}: unmet state requirement ${r.k}:${r.state}`)
        requireKeys.add(r.k)
      }
      const effectKeys = new Set()
      for (const e of list(a.effects)) {
        if (!available.has(e.k)) errors.push(`${label}: changes ${e.k} before it is created`)
        if (!states.get(e.k)?.has(e.state)) errors.push(`${label}: undeclared result state ${e.k}:${e.state}`)
        if (!requireKeys.has(e.k)) errors.push(`${label}: state change needs an explicit prior state for ${e.k}`)
        if (effectKeys.has(e.k)) errors.push(`${label}: conflicting state changes for ${e.k}`)
        effectKeys.add(e.k); current.set(e.k, e.state)
      }
      for (const p of list(a.into)) available.add(p.k)
      // Positions are materialized here as well as in the renderer; malformed counts never reach Array.from.
      if (!errors.length) operationSites(a, objects.get(a.k)?.cm)
    }
  }
  for (const goal of list(script.goals)) if (!states.get(goal.k)?.has(goal.state) || current.get(goal.k) !== goal.state)
    errors.push(`unreached goal ${goal.k}:${goal.state}`)
  for (const id of joints.keys()) if (!jointUses.has(id)) errors.push(`joint ${id}: no attachment operation`)
  return { errors, warnings }
}

// How the operations are written, settled before the checks where only one reading makes sense, so that the plan is
// not sent back to the model for it. Each repair is returned as a note. Seen in real plans:
//  - a verb that contradicts its intent where the action carries what the intent needs (a "place" with intent "cut"
//    and the pieces it cuts into: a cut); a tool used for a purpose of its own ("use" a level to "level") is a use;
//  - a step that uses a part a later step cuts, when that later step can come first: it is moved before (whole steps,
//    so captions stay with their actions; within a step, the cutting action);
//  - a name that is not declared but means one that is ("screw" for the tools' "screws", a tool by its kind), or a
//    fastener or tool named by its kind and never declared (declared: the fastener as long as its joint's depth);
//  - the stock a part was cut from, named after the cut, meaning that part ("log-2" after it was cut into "leg-2" and
//    an offcut);
//  - an operation that makes a joint but names other parts, faces, counts or sites than the joint: the joint's (the
//    numbers the solver checks);
//  - a joint fastened before both its parts were placed, where the joint says how they meet (through its upper or
//    lower face): the place is put in before it.
const STEMMED = (k) => String(k).replace(/(es|s)$/, '')
const FASTENER_KINDS = ['screw', 'nail', 'dowel', 'bolt']
const VERB_INTENTS = new Set(['place', 'cut', 'pour', 'sprinkle', 'stir', 'heat', 'measure'])
const REF_FIELDS = ['k', 'to', 'also', 'with', 'part', 'and']
const refsOf = (a) => REF_FIELDS.flatMap((f) => [a?.[f]].flat()).filter((k) => typeof k === 'string')
export function settleWorkTargets(script) {
  const notes = [], objects = new Set(list(script?.objects).map((o) => o?.k).filter(Boolean))
  const outputs = list(script?.makes).filter((m) => typeof m?.k === 'string' && !objects.has(m.k))
  if (outputs.length === 1) for (const a of list(script?.steps).flatMap((s) => list(s?.do))) if (a?.v === 'work' && a.k === a.to && objects.has(a.to)) {
    const source = a.k
    a.k = outputs[0].k
    notes.push(`${a.id || 'work'}: work targets made piece ${a.k}, not source ${source}`)
  }
  return notes
}
export function settleOperations(script) {
  const notes = []
  if (!script || typeof script !== 'object' || !Array.isArray(script.steps)) return notes
  notes.push(...settlePlanningInputs(script))
  const acts = () => script.steps.flatMap((s) => list(s?.do)).filter((a) => a && typeof a === 'object')
  notes.push(...settleProcesses(script))
  const name = (a) => a.id || [a.k].flat().join(', ')
  const joints = new Map(list(script.joints).filter((j) => j && typeof j.id === 'string').map((j) => [j.id, j]))
  // (no view: an answer cut off at its last field, mended. A build of joined parts or of a designed size is seen
  // in iso, as the planner draws builds; anything else from the side)
  if (script.view == null) { script.view = joints.size || Array.isArray(script.design?.size) ? 'iso' : 'side'; notes.push(`view ${script.view}: none given`) }

  // a part of the design that is a whole object, never cut (a top log "top-a", all 35 cm of split-log-4), named in the
  // steps and joints by its design name: it is that object. (Two photo films of split logs failed planning on exactly
  // this: every step and joint naming a part no step makes.)
  const objectKeys = new Map(list(script.objects).filter((o) => typeof o?.k === 'string').map((o) => [o.k, o]))
  // Source and output are different actors. Only a single declared output makes this reference correction
  // unambiguous; multiple-output plans must supply their own mapping and otherwise fail validation.
  notes.push(...settleWorkTargets(script))
  // a sheet that is only folded is seen from above, as folding diagrams draw it (its folds are named by where things lie
  // as seen from there: "top-left" onto the "centre line"), and has a sheet's size: its part's, else its length and width
  // (a cut with a shape is through a folded sheet: one of its folds' acts, fold.mjs)
  for (const a of acts()) if (a.v === 'cut' && Array.isArray(a.shape) && !a.into) { a.v = 'fold'; a.move = 'cut'; a.intent = 'cut'; notes.push(`${name(a)}: a cut through the folded sheet`) }
  const folding = acts().filter((a) => a.v === 'fold')
  if ((hasSheetCuts(script) || hasSheetToolPaths(script)) && script.view !== 'plan') { script.view = 'plan'; notes.push('view plan: explicit sheet cutting layouts and tool paths are seen from above') }
  if (folding.length && script.view !== 'plan' && acts().every((a) => a.v === 'place' || a.v === 'fold')) { notes.push(`view plan: a folded sheet is seen from above, not ${script.view}`); script.view = 'plan' }
  for (const k of new Set(folding.map((a) => a.k))) {
    const o = objectKeys.get(k)
    if (o && !o.part) { o.part = { family: 'sheet', size: [...sheetSize(o), 0.05] }; notes.push(`${k}: folded, so a sheet ${o.part.size[0]} × ${o.part.size[1]} cm`) }
  }
  // a strand (wire, rope, ribbon) that is bent, coiled, knotted or threaded is worked out exactly (strand.mjs), seen from
  // above like a folded sheet: its operation is its intent when the plan only said it there, and it has a strand's size
  // (a thin rod: its length, its thickness)
  const stranding = acts().filter((a) => a.v === 'strand')
  for (const a of stranding) {
    const op = strandOp(a)
    if (op && a.op !== op) { a.op = op; notes.push(`${name(a)}: strand operation ${op}`) }
    if (op && a.intent !== op) a.intent = op
  }
  if (stranding.length && script.view !== 'plan' && acts().every((a) => ['place', 'cut', 'strand', 'measure'].includes(a.v))) { notes.push(`view plan: a strand worked flat is seen from above, not ${script.view}`); script.view = 'plan' }
  for (const k of new Set(stranding.map((a) => a.k))) {
    const o = objectKeys.get(k)
    if (o && !o.part) { const { L, W } = strandSize(o); o.part = { family: 'rod', size: [L, W, W] }; notes.push(`${k}: a strand, so a rod ${L} cm long, ${W} cm thick`) }
  }
  // glue, stitching or a clamp on a strand joins it to itself (the turns of a coil glued together): no two parts to join, so it
  // is applying the glue, not a joint between parts
  const strandKeys = new Set(stranding.map((a) => a.k))
  for (const a of acts()) if (a.v === 'use' && ['fasten', 'glue', 'clamp'].includes(a.intent) && strandKeys.has(a.k) && !(typeof a.to === 'string' && a.to !== a.k)) {
    notes.push(`${name(a)}: ${a.intent} on the strand ${a.k} itself, so applying, not a joint`); a.intent = 'apply'; delete a.joint
  }
  // a demonstration on a strand (pressing the mat flat, pulling it tight): the engine draws a strand itself, and a model's
  // drawing of it would be a photo of the rope, so it is applying by hand
  for (const a of acts()) if (a.v === 'demonstrate' && strandKeys.has(a.k)) { notes.push(`${name(a)}: a hand operation on the strand ${a.k}, which the engine draws itself, so applying`); a.v = 'use'; a.intent = 'apply'; delete a.demo; delete a.focus; delete a.requires; delete a.effects }
  if (list(script.joints).some((j) => j && j.a === j.b && strandKeys.has(j.a))) { script.joints = list(script.joints).filter((j) => !(j && j.a === j.b && strandKeys.has(j.a))); notes.push('joints of a strand with itself dropped') }
  const cutFrom = new Set(acts().filter((a) => list(a.into).length).flatMap((a) => [a.k].flat()))
  const madeKeys = new Set(acts().flatMap((a) => list(a.into).map((p) => p?.k)))
  const whole = new Map()
  for (const p of list(script.design?.parts)) {
    const o = objectKeys.get(p?.from)
    if (typeof p?.k !== 'string' || !o || objectKeys.has(p.k) || madeKeys.has(p.k) || cutFrom.has(p.from) || !(Number.isInteger(p.n) ? p.n === 1 : p.n == null)) continue
    if (+p.cm > 0 && +o.cm > 0 && Math.abs(p.cm - o.cm) > Math.max(1, o.cm * 0.05)) continue
    if (list(script.design.parts).filter((q) => q?.from === p.from).length !== 1) continue
    whole.set(p.k, p.from)
  }
  if (whole.size) {
    const as = (k) => (typeof k === 'string' && whole.has(k) ? whole.get(k) : k)
    for (const a of acts()) for (const field of REF_FIELDS) a[field] = Array.isArray(a[field]) ? a[field].map(as) : as(a[field])
    for (const a of acts()) for (const r of [...list(a.requires), ...list(a.effects), ...(a.focus ? [a.focus] : [])]) r.k = as(r.k)
    for (const a of acts()) if (Array.isArray(a.demo?.actors)) a.demo.actors = a.demo.actors.map(as)
    for (const j of joints.values()) { j.a = as(j.a); j.b = as(j.b) }
    for (const g of list(script.goals)) g.k = as(g.k)
    for (const q of list(script.profiles)) if (q && typeof q.k === 'string') q.k = as(q.k)
    for (const p of list(script.design.parts)) if (whole.has(p.k)) p.k = whole.get(p.k)
    for (const [k, from] of whole) notes.push(`${k} is ${from}, used whole`)
  }

  // the joint's faces: a screw driven down through a part's upper face enters the part under it through that part's
  // upper face (a fastener goes through: both faces are named the same); glue, a clamp or a fit closes a face against the
  // opposite one. A plan wrote "upper" into "lower" for every screwed joint of a log stool, and the film left them out.
  const OPPOSITE = { upper: 'lower', lower: 'upper', front: 'back', back: 'front', left: 'right', right: 'left' }
  for (const j of joints.values()) {
    if (!OPPOSITE[j.face] || !OPPOSITE[j.otherFace]) continue
    const meets = j.method === 'fasten' ? j.face : OPPOSITE[j.face]
    if (j.otherFace !== meets) { notes.push(`joint ${j.id}: meets ${j.b} through its ${meets} face, not its ${j.otherFace}`); j.otherFace = meets }
  }

  // the verb from its intent
  for (const a of acts()) {
    if (a.v === 'demonstrate' || a.v === 'reshape' || a.v === 'strand' || !a.intent || a.intent === a.v) continue
    if (VERB_INTENTS.has(a.intent)) {
      const carries = a.intent === 'cut' ? list(a.into).length > 0 : ['pour', 'sprinkle', 'stir', 'heat'].includes(a.intent) ? typeof a.to === 'string' : a.intent !== 'place' || !a.joint && a.with == null
      if (carries) { notes.push(`${name(a)}: ${a.v} made ${a.intent}, as its intent says`); a.v = a.intent }
    } else if (a.v === 'use' && !INTENTS.use.includes(a.intent) && typeof a.with === 'string') {
      notes.push(`${name(a)}: intent ${a.intent} is a use of ${a.with}`); a.purpose = a.intent; a.intent = 'use'
    }
  }

  // names that mean a declared one, and fasteners or tools named by their kind
  if (script.tools != null && !Array.isArray(script.tools)) return notes
  const known = () => new Set(entities(script).map((o) => o.k).filter((k) => typeof k === 'string'))
  const resolve = (ref, field, a) => {
    const keys = known()
    if (typeof ref !== 'string' || keys.has(ref)) return ref
    const tools = list(script.tools)
    const same = [...keys].filter((k) => STEMMED(k) === STEMMED(ref))
    const byKind = tools.filter((t) => t.use === ref || t.use === STEMMED(ref))
    const found = same.length === 1 ? same[0] : byKind.length === 1 && ['with', 'part'].includes(field) ? byKind[0].k : null
    if (found) { notes.push(`${name(a)}: ${ref} is ${found}`); return found }
    const kind = [ref, STEMMED(ref)].find((k) => TOOL_KINDS.includes(k))
    if (field === 'part' && kind && FASTENER_KINDS.includes(kind)) {
      const depth = joints.get(a.joint)?.depthCm
      script.tools = [...tools, { k: ref, use: kind, ...(depth > 0 ? { cm: depth } : {}) }]
      notes.push(`${ref}: declared as a ${kind}${depth > 0 ? ` of ${depth} cm` : ''}`); return ref
    }
    if (field === 'with' && kind && !FASTENER_KINDS.includes(kind)) {
      script.tools = [...tools, { k: ref, use: kind }]; notes.push(`${ref}: declared as a ${kind}`); return ref
    }
    return ref
  }
  for (const a of acts()) for (const field of REF_FIELDS) {
    if (Array.isArray(a[field])) a[field] = a[field].map((k) => resolve(k, field, a))
    else if (typeof a[field] === 'string') a[field] = resolve(a[field], field, a)
  }
  for (const j of joints.values()) for (const side of ['a', 'b']) {
    const same = [...known()].filter((k) => STEMMED(k) === STEMMED(j[side]))
    if (typeof j[side] === 'string' && !known().has(j[side]) && same.length === 1) { notes.push(`joint ${j.id}: ${j[side]} is ${same[0]}`); j[side] = same[0] }
  }

  // a part used before the step that cuts it, when that step can come first
  const madeIn = () => { const m = new Map(); script.steps.forEach((s, i) => list(s?.do).forEach((a) => list(a?.into).forEach((p) => p?.k && !m.has(p.k) && m.set(p.k, i)))); return m }
  for (let pass = 0; pass < script.steps.length; pass++) {
    const made = madeIn(), placedIn = new Map()
    script.steps.forEach((s, i) => list(s?.do).forEach((a) => a?.v === 'place' && [a.k].flat().forEach((k) => !placedIn.has(k) && placedIn.set(k, i))))
    let moved = false
    for (const [i, s] of script.steps.entries()) {
      const later = list(s?.do).flatMap(refsOf).map((k) => made.get(k)).filter((j) => j != null && j > i)
      if (!later.length) continue
      const j = Math.min(...later), moving = list(script.steps[j]?.do)
      const own = new Set(moving.flatMap((a) => list(a?.into).map((p) => p?.k)))
      const ready = moving.flatMap(refsOf).every((k) => own.has(k) || !made.has(k) || made.get(k) < i)
        && moving.filter((a) => a?.v === 'place').flatMap((a) => [a.to, ...list(a.also)]).filter((k) => typeof k === 'string').every((k) => !placedIn.has(k) || placedIn.get(k) < i || placedIn.get(k) === j)
      if (!ready) continue
      const [step] = script.steps.splice(j, 1); script.steps.splice(i, 0, step)
      notes.push(`step ${j + 1} moved before step ${i + 1}: it makes what that step uses`); moved = true; break
    }
    if (!moved) break
  }
  for (const s of script.steps) {
    if (!Array.isArray(s?.do)) continue
    const ops = s.do
    for (let i = 0; i < ops.length; i++) {
      const uses = new Set(refsOf(ops[i])), c = ops.findIndex((a, at) => at > i && list(a?.into).some((p) => uses.has(p?.k)))
      if (c < 0) continue
      const between = new Set(ops.slice(i, c).flatMap((a) => list(a?.into).map((p) => p?.k)))
      if (refsOf(ops[c]).some((k) => between.has(k))) continue
      const [cut] = ops.splice(c, 1); ops.splice(i, 0, cut); notes.push(`${name(cut)}: moved before ${name(ops[i + 1])}, which uses what it cuts`)
    }
  }

  // the stock a part was cut from, named after the cut
  const main = new Map(), cutAt = new Map()
  let at = 0
  const order = new Map()
  for (const s of script.steps) for (const a of list(s?.do)) {
    order.set(a, at++)
    if (a?.v !== 'cut' || typeof a.k !== 'string' || !list(a.into).length || main.has(a.k)) continue
    const kept = list(a.into).filter((p) => typeof p?.k === 'string' && !OFFCUT.test(`${p.k} ${p.label || ''}`))
    main.set(a.k, kept.length === 1 ? kept[0].k : null); cutAt.set(a.k, order.get(a))
  }
  const piece = (k, a) => typeof k === 'string' && main.get(k) && order.get(a) > cutAt.get(k) ? main.get(k) : k
  for (const a of acts()) for (const field of ['k', 'to', 'also', 'and']) {
    const before = JSON.stringify(a[field])
    if (Array.isArray(a[field])) a[field] = a[field].map((k) => piece(k, a)); else if (a[field] != null) a[field] = piece(a[field], a)
    if (JSON.stringify(a[field]) !== before) notes.push(`${name(a)}: ${JSON.parse(before)} is ${a[field]} once cut`)
  }
  // (a shape given to the stock is its piece's)
  for (const q of list(script.profiles)) if (q && main.get(q.k)) { notes.push(`profile ${q.k}: is ${main.get(q.k)}'s, once cut`); q.k = main.get(q.k) }
  for (const j of joints.values()) {
    const ops = acts().filter((a) => a.joint === j.id)
    for (const side of ['a', 'b']) {
      const p = main.get(j[side])
      if (p && ops.length && ops.every((a) => order.get(a) > cutAt.get(j[side]))) { notes.push(`joint ${j.id}: ${j[side]} is ${p} once cut`); j[side] = p }
    }
  }

  // a fastener's length and the depth its joints drive it: the depth its joints agree on, else the fastener's own
  // length for them all (the solver then makes it the length the parts need: layout.mjs settleFasteners). A patch
  // changed the joints' depth and left the screws as they were, and the plan failed on all four.
  for (const tool of list(script.tools).filter((t) => FASTENER_KINDS.includes(t?.use))) {
    const made = [...new Set(acts().filter((a) => a.part === tool.k && a.intent === 'fasten').map((a) => joints.get(a.joint)).filter((j) => j?.method === 'fasten'))]
    if (!made.length) continue
    const depths = [...new Set(made.map((j) => j.depthCm).filter((d) => d > 0))]
    if (depths.length === 1 && tool.cm !== depths[0]) { notes.push(`${tool.k}: ${depths[0]} cm, the depth its joints drive it`); tool.cm = depths[0] }
    else if (depths.length !== 1 && tool.cm > 0 && made.some((j) => j.depthCm !== tool.cm)) { for (const j of made) j.depthCm = tool.cm; notes.push(`${tool.k}: its joints drive it its own ${tool.cm} cm`) }
  }

  // an operation that makes a joint takes the joint's parts, face, count and sites
  for (const a of acts()) {
    const j = joints.get(a.joint)
    if (!j || typeof j.a !== 'string' || typeof j.b !== 'string' || Array.isArray(a.k)) continue
    const fixed = []
    if (a.k !== j.a) { a.k = j.a; fixed.push('part') }
    if (a.to != null && a.to !== j.b) { a.to = j.b; fixed.push('receiving part') }
    if (a.face != null && a.face !== j.face) { a.face = j.face; fixed.push('face') }
    if (a.n != null && Array.isArray(j.sites) && a.n !== j.sites.length) { a.n = j.sites.length; fixed.push('count') }
    if (a.sites != null && Array.isArray(j.sites) && JSON.stringify(a.sites) !== JSON.stringify(j.sites)) { a.sites = structuredClone(j.sites); fixed.push('sites') }
    if (fixed.length) notes.push(`${name(a)}: ${fixed.join(', ')} from joint ${j.id}`)
  }

  // a joint fastened before both its parts were placed
  const ids = new Set(acts().map((a) => a.id)), fresh = (base) => { let id = base, n = 2; while (ids.has(id)) id = `${base}-${n++}`; ids.add(id); return id }
  const placed = new Set()
  for (const s of script.steps) {
    if (!Array.isArray(s?.do)) continue
    const ops = s.do
    for (let i = 0; i < ops.length; i++) {
      const a = ops[i], j = joints.get(a?.joint)
      if (a?.v === 'place') [a.k].flat().forEach((k) => placed.add(k))
      if (!j || a.intent !== 'fasten' || placed.has(j.a) && placed.has(j.b)) continue
      const rel = { upper: 'on', lower: 'under' }[j.face]
      if (!rel && !placed.has(j.a)) continue
      const put = []
      if (!placed.has(j.b)) put.push({ id: fresh(`place-${j.b}`), v: 'place', intent: 'place', k: j.b, rel: 'floor' })
      if (!placed.has(j.a)) put.push({ id: fresh(`place-${j.a}`), v: 'place', intent: 'place', k: j.a, rel, to: j.b })
      ops.splice(i, 0, ...put); i += put.length
      for (const p of put) { placed.add(p.k); notes.push(`${p.id}: ${p.k} placed${p.to ? ` ${p.rel} ${p.to}` : ''} before ${name(a)} fastens it`) }
    }
  }

  // a part laid on one support but fastened down into others placed before it (a seat "on" one leg, screwed into all
  // three): it rests on all of them ("also"), as the joints say. Fastened down: through its upper face, or up into it
  // through the other part's lower face.
  const under = (k) => [...joints.values()].filter((j) => j.method === 'fasten' || j.method === 'glue')
    .flatMap((j) => j.a === k && j.face === 'upper' ? [j.b] : j.b === k && j.face === 'lower' ? [j.a] : [])
  const laid = new Set()
  for (const a of acts()) {
    if (a.v !== 'place') continue
    if (typeof a.k === 'string' && typeof a.to === 'string' && ['on', 'across', undefined].includes(a.rel)) {
      const more = [...new Set(under(a.k))].filter((x) => x !== a.to && laid.has(x) && !list(a.also).includes(x))
      if (more.length) { a.also = [...list(a.also), ...more]; notes.push(`${name(a)}: ${a.k} rests on ${more.join(', ')} too, as its joints say`) }
    }
    ;[a.k].flat().forEach((k) => laid.add(k))
  }

  // every operation named (an id, and its verb as its intent when it has none) and claimed by its step's caption
  for (const [i, s] of script.steps.entries()) {
    const ops = list(s?.do).filter((a) => a && typeof a === 'object')
    for (const a of ops) {
      if (!a.id) { a.id = fresh(`${a.v}-${[a.k].flat()[0] || 'step'}`); notes.push(`${a.id}: named`) }
      if (!a.intent && INTENTS[a.v]) { a.intent = a.v; notes.push(`${a.id}: intent ${a.v}`) }
    }
    const missing = ops.filter((a) => a.v !== 'place' && !list(s.claims).includes(a.id)).map((a) => a.id)
    if (missing.length) { s.claims = [...list(s.claims), ...missing]; notes.push(`step ${i + 1}: claims ${missing.join(', ')}`) }
  }
  return notes
}

// State bookkeeping the planner often gets wrong, settled before the checks: what a film shows comes from the
// demonstrations and appearances, not from these names, so settling them changes no picture. A paperclip photo failed
// planning twice on exactly this ("undeclared result state", "unmet state requirement", "demonstration must declare its
// resulting state", focus boxes past 1). Each repair is returned as a note, for the validation's warnings.
//  - a state named in requires, effects or goals but not declared is declared (labelled from its name);
//  - an object first required in a state, with none set, starts in it; a requirement that contradicts the state the
//    steps have reached says that state instead;
//  - an effect without its prior state gets the current one (or "as found");
//  - a demonstration with no effect gets one, named for its intent; an effect on a thing it does not draw adds it to
//    its actors;
//  - focus bounds are clamped into the part; a goal no step reaches is dropped.
// A step that puts in fasteners counts them from its sites, so its caption is a template the film fills in. A plan that
// leaves it out (a footstool's eight screws failed planning twice on exactly this) gets one: its caption with its
// number made the count, else its caption with the count after it ("… (8 screws)"); the step's fastening actions
// join it. The film shows the same; only the number in the caption becomes the counted one.
export function settleCaptions(script) {
  const notes = []
  if (!script || !Array.isArray(script.steps)) return notes
  const tools = new Map(list(script.tools).map((t) => [t?.k, t]))
  for (const [i, s] of script.steps.entries()) {
    const fixing = list(s?.do).filter((a) => a && a.part && typeof a.id === 'string')
    if (!fixing.length) continue
    const ids = fixing.map((a) => a.id), has = s.caption && typeof s.caption.template === 'string' && s.caption.template.includes('{count}') && Array.isArray(s.caption.actions)
    if (has && ids.every((id) => s.caption.actions.includes(id))) continue
    const local = new Set(list(s.do).map((a) => a?.id))
    if (has) { s.caption = { ...s.caption, actions: [...new Set([...s.caption.actions.filter((id) => local.has(id)), ...ids])] }; notes.push(`step ${i + 1}: fastening actions added to its caption`); continue }
    const use = tools.get(fixing[0].part)?.use || 'screw', noun = { screw: 'screws', nail: 'nails', dowel: 'dowels', bolt: 'bolts' }[use] || 'fixings'
    const c = typeof s.c === 'string' ? s.c.trim().replace(/[.\s]+$/, '') : ''
    // (a bare number, not a size: "Drive 8 screws", not the 16 of "16 cm screws")
    const counted = /(^|\s)\d+(?!\s*(mm|cm|m|×|x)\b)(?=\s)/i.test(c) ? c.replace(/(^|\s)\d+(?!\s*(mm|cm|m|×|x)\b)(?=\s)/i, '$1{count}') : null
    s.caption = { template: counted || (c ? `${c} ({count} ${noun})` : `Put in {count} ${noun}`), actions: ids }
    if (Array.isArray(s.claims)) s.claims = [...new Set([...s.claims, ...ids])]
    notes.push(`step ${i + 1}: caption made a count of its ${noun}`)
  }
  return notes
}

export function settleStates(script) {
  const notes = []
  if (!script || typeof script !== 'object' || !Array.isArray(script.steps)) return notes
  // Materialize shallow state declarations before normalizing, so later inferred states update the actual entity.
  if (Array.isArray(script.states)) {
    const definitions = script.states
    const original = { ...script, states: undefined }
    for (const d of definitions) for (const o of entities(original)) if (d?.k === o.k && Array.isArray(d.states)) {
      o.states = d.states; if (typeof d.state === 'string') o.state = d.state
    }
    // Preserve invalid definitions for validation to report, rather than silently dropping them.
    if (definitions.every((d) => d && entities(original).some((o) => o.k === d.k) && Array.isArray(d.states)) && new Set(definitions.map((d) => d.k)).size === definitions.length) delete script.states
  }
  const byKey = new Map(entities(script).filter((o) => typeof o.k === 'string').map((o) => [o.k, o]))
  const name = (id) => id.replace(/[-_]+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase()) || id
  const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'done'
  const declare = (o, id) => {
    if (!Array.isArray(o.states)) o.states = []
    if (!o.states.some((s) => s?.id === id)) { o.states.push({ id, label: name(id) }); notes.push(`declared state ${o.k}:${id}`) }
  }
  const current = new Map([...byKey.values()].filter((o) => typeof o.state === 'string').map((o) => [o.k, o.state]))
  const startIn = (o, id) => { declare(o, id); o.state = id; current.set(o.k, id); notes.push(`${o.k} starts ${id}`) }
  for (const s of script.steps) for (const a of list(s?.do)) {
    if (typeof a !== 'object') continue
    const b = a.focus?.bounds
    if (Array.isArray(b) && b.length === 4 && b.every(Number.isFinite)) {
      const x = Math.min(Math.max(b[0], 0), 0.95), y = Math.min(Math.max(b[1], 0), 0.95)
      const fitted = [x, y, Math.min(b[2], 1 - x), Math.min(b[3], 1 - y)]
      const settled = fitted[2] > 0 && fitted[3] > 0 ? fitted : [0, 0, 1, 1]
      if (settled.some((v, i) => v !== b[i])) { a.focus.bounds = settled; notes.push(`${a.id || a.k}: focus clamped into the part`) }
    }
    if (a.v === 'demonstrate' && !list(a.effects).length && byKey.has(a.k)) {
      a.effects = [{ k: a.k, state: slug(a.intent || a.id) }]; notes.push(`${a.id || a.k}: result state ${a.k}:${a.effects[0].state} added`)
    }
    for (const r of list(a.requires)) {
      const o = byKey.get(r.k); if (!o || typeof r.state !== 'string') continue
      if (!current.has(r.k)) startIn(o, r.state)
      else if (current.get(r.k) !== r.state) { notes.push(`${a.id || a.k}: requires ${r.k}:${current.get(r.k)}, the state it is in, not ${r.state}`); r.state = current.get(r.k) }
      else declare(o, r.state)
    }
    for (const e of list(a.effects)) {
      const o = byKey.get(e.k); if (!o || typeof e.state !== 'string') continue
      declare(o, e.state)
      if (!list(a.requires).some((r) => r.k === e.k)) {
        if (!current.has(e.k)) startIn(o, 'as-found')
        a.requires = [...list(a.requires), { k: e.k, state: current.get(e.k) }]
      }
      if (a.v === 'demonstrate' && a.demo && Array.isArray(a.demo.actors) && !a.demo.actors.includes(e.k)) { a.demo.actors.push(e.k); notes.push(`${a.id || a.k}: ${e.k} added to the actors`) }
      current.set(e.k, e.state)
    }
  }
  if (Array.isArray(script.goals)) script.goals = script.goals.filter((g) => {
    const reached = g && current.get(g.k) === g.state
    if (!reached) notes.push(`goal ${g?.k}:${g?.state} dropped: no step reaches it`)
    return reached
  })
  return notes
}
