// Offline grading: production validators/solver/compiler, without SAM or model artwork.
import { validatePlan } from '../src/pipeline/validate.mjs'
import { PHYSICAL_PLAN_SCHEMA } from '../src/pipeline/plan-schema.mjs'
import { settleOperations, settleStates, settleCaptions, settleWorkTargets } from '../src/solvers/contracts.mjs'
import { plain } from '../src/pipeline/script.mjs'
import { withTools } from '../src/solvers/tools.mjs'
import { withUp } from '../src/film/helper.mjs'
import { solveBuild, geometryReview } from '../src/solvers/layout.mjs'
import { program, timeline } from '../src/film/engine.mjs'
import { settlePlanningInputs, suppliedObjects, hydrateInventory } from '../src/pipeline/planning-inputs.mjs'

export function issue(stage, message, details = {}) {
  let code = `${stage}-failure`
  if (/unknown object|unknown tool|refers to unknown|not declared/i.test(message)) code = 'unknown-reference'
  else if (/only .*long|only .*cm|exceeds|stock|cut.*length/i.test(message)) code = 'stock-conservation'
  else if (/design:.*size|steps build|designed size/i.test(message)) code = 'design-dimensions'
  else if (/inventory|identity|published object/i.test(message)) code = 'inventory-change'
  else if (/measurement|confirmed|provenance/i.test(message)) code = 'measurement-provenance'
  else if (/state|reshap|appearance|effect/i.test(message)) code = 'state-contract'
  else if (/joint|connection|fastener|contact|intersect/i.test(message)) code = 'joint-geometry'
  else if (/caption|claims|count/i.test(message)) code = 'caption-action-mismatch'
  else if (/unsupported|unknown operation|unknown verb/i.test(message)) code = 'unsupported-operation'
  else if (/JSON|parse/i.test(message)) code = 'invalid-json'
  else if (/timeout|timed out/i.test(message)) code = 'provider-timeout'
  else if (/incomplete|empty|no.*answer/i.test(message)) code = 'empty-or-incomplete-response'
  return { stage, code, message: String(message), ...details }
}

// The subset used by our shipped schemas. This does not claim to implement all JSON Schema dialects.
export function schemaProblems(value, schema = PHYSICAL_PLAN_SCHEMA, path = '$') {
  const errors = [], add = message => errors.push(`${path}: ${message}`)
  const supported = new Set(['type', 'enum', 'anyOf', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'pattern', 'description'])
  for (const key of Object.keys(schema)) if (!supported.has(key)) throw new Error(`Unsupported schema keyword: ${key}`)
  if (schema.anyOf && !schema.anyOf.some(branch => !schemaProblems(value, branch, path).length)) add('does not match any allowed schema branch')
  if (schema.enum && !schema.enum.some(v => JSON.stringify(v) === JSON.stringify(value))) add('value is outside the schema enum')
  const types = [].concat(schema.type || [])
  const matches = type => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? value != null && typeof value === 'object' && !Array.isArray(value) : type === 'integer' ? Number.isInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type
  if (types.length && !types.some(matches)) { add(`expected ${types.join('|')}`); return errors }
  if (typeof value === 'number') {
    for (const [key, test] of [['minimum', n => value >= n], ['maximum', n => value <= n], ['exclusiveMinimum', n => value > n], ['exclusiveMaximum', n => value < n]]) if (schema[key] != null && !test(schema[key])) add(`violates ${key} ${schema[key]}`)
  }
  if (typeof value === 'string') {
    if (schema.minLength != null && [...value].length < schema.minLength) add('string is too short')
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) add('string does not match pattern')
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) add('too few items')
    if (schema.maxItems != null && value.length > schema.maxItems) add('too many items')
    if (schema.items) value.forEach((v, i) => errors.push(...schemaProblems(v, schema.items, `${path}[${i}]`)))
  } else if (value != null && typeof value === 'object') {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) add(`missing required field ${key}`)
    for (const [key, v] of Object.entries(value)) {
      if (schema.properties?.[key]) errors.push(...schemaProblems(v, schema.properties[key], `${path}.${key}`))
      else if (schema.additionalProperties === false) add(`unexpected field ${key}`)
    }
  }
  return errors
}

const identityFields = ['k', 'n', 'segment', 'b', 'cm', 'w', 'thick', 'tip', 'measurements']
export function inventoryProblems(script, inventory) {
  if (!inventory) return []
  let supplied
  try { supplied = new Map(suppliedObjects(script).map(o => [o.k, o])) } catch { return ['Invalid additional materials declaration'] }
  const photographed = Array.isArray(script?.objects) ? script.objects.filter(o => !(o?.source === 'additional-supply' && JSON.stringify(o) === JSON.stringify(supplied.get(o.k)))) : script?.objects
  const projected = objects => Array.isArray(objects) ? objects.map(o => o && typeof o === 'object' ? Object.fromEntries(identityFields.filter(key => key in o).map(key => [key, o[key]])) : null) : null
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value
  return JSON.stringify(canonical(projected(photographed))) === JSON.stringify(canonical(projected(inventory))) ? [] : ['Plan changed the frozen inventory identity, dimensions or measurement provenance']
}

export function caseProblems(script, assertions = {}) {
  const supported = ['requiredObjects', 'forbiddenObjects', 'requiredVerbs', 'forbiddenVerbs', 'minSteps', 'maxSteps']
  if (Object.keys(assertions).some(key => !supported.includes(key))) throw new Error('Unknown case assertion')
  const actions = (script.steps || []).flatMap(s => s.do || []), keys = new Set((script.objects || []).map(o => o.k)), verbs = new Set(actions.map(a => a.v)), errors = []
  for (const key of assertions.requiredObjects || []) if (!keys.has(key)) errors.push(`Task requires inventory object ${key}`)
  for (const key of assertions.forbiddenObjects || []) if (keys.has(key)) errors.push(`Task forbids inventory object ${key}`)
  for (const verb of assertions.requiredVerbs || []) if (!verbs.has(verb)) errors.push(`Task requires operation ${verb}`)
  for (const verb of assertions.forbiddenVerbs || []) if (verbs.has(verb)) errors.push(`Task forbids operation ${verb}`)
  if (assertions.minSteps != null && script.steps.length < assertions.minSteps) errors.push(`Task requires at least ${assertions.minSteps} steps`)
  if (assertions.maxSteps != null && script.steps.length > assertions.maxSteps) errors.push(`Task allows at most ${assertions.maxSteps} steps`)
  return errors
}

export function productionGeometryCheck(script, cut) {
  const copy = structuredClone(script)
  settlePlanningInputs(copy)
  const fitted = withTools(copy, cut.geometry, cut.sizes, {})
  try { return geometryReview(copy, solveBuild(copy, fitted.geometry, fitted.sizes)) }
  catch (error) {
    if (!error.diagnostics) throw error
    return { errors: error.diagnostics.map(d => `${d.joint ? `joint ${d.joint}: ` : ''}${d.message}`), warnings: [] }
  }
}

function resultGate(errors, extra = {}) { return { status: errors.length ? 'fail' : 'pass', errors, ...extra } }
export async function gradePlan({ candidate, rawText, rawSchema = PHYSICAL_PLAN_SCHEMA, isPatch = false, photo, cut, inventory, assertions = {}, review, smoke, normalize = false, confirmedMeasurements = {} }) {
  const grades = { response: { status: rawText == null ? 'not-recorded' : 'pass', errors: [] }, rawSchema: { status: 'not-recorded', errors: [] },
    structure: { status: 'skipped', errors: [] }, semantics: { status: 'skipped', errors: [] }, geometry: { status: 'skipped', errors: [] },
    execution: { status: 'skipped', errors: [] }, task: { status: 'skipped', errors: [] } }
  const findings = [], warnings = [], corrections = []
  let raw = null
  if (rawText != null) {
    try { raw = JSON.parse(rawText); grades.rawSchema = resultGate(schemaProblems(raw, rawSchema)) }
    catch (error) { grades.response = resultGate([`Invalid JSON: ${error.message}`]) }
  }
  let rawPlan = raw, annotationErrors = []
  if (raw?.objectUpdates != null) try { rawPlan = hydrateInventory(raw, inventory) } catch (error) { annotationErrors.push(error.message) }
  let script = candidate ? structuredClone(candidate) : rawPlan ? structuredClone(rawPlan) : null
  if (script?.objectUpdates != null) try { script = hydrateInventory(script, inventory) } catch (error) { annotationErrors.push(error.message) }
  const rawIdentityErrors = [...annotationErrors, ...(raw && inventory && (!isPatch || raw.objects) ? inventoryProblems(rawPlan, inventory) : [])]
  findings.push(...rawIdentityErrors.map(message => issue('structure', message, { rawOnly: true })))
  if (!script) grades.structure = resultGate(['No parsed plan candidate is available'])
  else if (script.mode === 'problem') grades.structure = resultGate(['Written-problem mode is outside this physical-plan benchmark'])
  else {
    try {
      corrections.push(...settlePlanningInputs(script))
      if (normalize) {
        corrections.push(...settleOperations(script), ...settleStates(script), ...settleCaptions(script))
        script = plain(script)
      }
      const validation = validatePlan(script, photo, { confirmedMeasurements })
      warnings.push(...validation.warnings)
      grades.structure = resultGate([...new Set([...inventoryProblems(script, inventory), ...rawIdentityErrors]), ...(rawText != null ? grades.rawSchema.errors : [])])
      grades.semantics = resultGate([...validation.errors, ...(validation.soft || [])])
      grades.task = resultGate(caseProblems(script, assertions))
      if (cut?.geometry && cut?.sizes) {
        const checked = productionGeometryCheck(script, cut)
        warnings.push(...checked.warnings)
        grades.geometry = resultGate(checked.errors)
      } else grades.geometry = { status: 'unavailable', errors: ['Saved cut-out geometry is unavailable'] }
      if ([grades.structure, grades.semantics, grades.geometry].every(g => g.status === 'pass')) {
        const compiled = compilePlan(script, photo, cut)
        corrections.push(...compiled.corrections)
        if (smoke) grades.execution = resultGate([], await smoke(compiled))
        else grades.execution = { status: 'unavailable', errors: ['Browser playback smoke check not run'] }
      }
    } catch (error) {
      const stage = error.stage || (grades.semantics.status === 'skipped' ? 'semantics' : grades.geometry.status === 'skipped' ? 'geometry' : 'execution')
      grades[stage] = resultGate([error.message])
      if (error.code === 'BENCH_BROWSER') grades[stage].status = 'unavailable'
    }
  }
  for (const [stage, gate] of Object.entries(grades)) if (gate.status === 'fail') findings.push(...gate.errors.map(message => issue(stage, message)))
  const machineGates = ['response', 'structure', 'semantics', 'geometry', 'execution', 'task']
  const machineFail = machineGates.some(stage => grades[stage].status === 'fail')
  const unavailable = machineGates.some(stage => ['unavailable', 'skipped'].includes(grades[stage].status))
  const machine = machineFail ? 'fail' : unavailable ? 'pending' : 'pass'
  const strict = machine === 'fail' || review?.verdict === 'fail' ? 'fail' : machine === 'pass' && review?.verdict === 'pass' ? 'pass' : 'pending'
  let rawPlanProblems = []
  if (raw && !isPatch) try {
    const checked = validatePlan(rawPlan, photo, { confirmedMeasurements })
    rawPlanProblems = [...checked.errors, ...(checked.soft || []), ...rawIdentityErrors]
    if (!rawPlanProblems.length && cut) rawPlanProblems.push(...productionGeometryCheck(rawPlan, cut).errors)
  } catch (error) { rawPlanProblems.push(error.message) }
  return { machine, strict, humanReview: review || { verdict: 'pending', reason: '' }, grades, findings,
    warnings: [...new Set(warnings)], corrections: [...new Set(corrections)], normalizedPlan: script,
    rawSchemaValid: rawText == null ? null : grades.rawSchema.status === 'pass', rawPlanProblems,
    rawFirstResponseValid: rawText == null || isPatch ? null : grades.response.status === 'pass' && grades.rawSchema.status === 'pass' && !rawPlanProblems.length,
    limitation: 'Deterministic stand-in artwork and sampled browser playback; does not establish visual quality, physical feasibility or full provider success.' }
}

export function compilePlan(input, photo, cut) {
  const script = structuredClone(input)
  settlePlanningInputs(script)
  settleWorkTargets(script)
  const fitted = withTools(script, cut.geometry, cut.sizes, {}), layout = solveBuild(script, fitted.geometry, fitted.sizes)
  const times = timeline(script)
  const boxes = Object.fromEntries(script.objects.filter(o => o.source !== 'additional-supply').map(o => [o.k, cut.geometry[o.k]?.box || o.b]))
  // No saved finale/panel/drawing JS is loaded. Model demonstration code executes only in the disposable browser.
  const source = program({ script, vectors: withUp(fitted.vectors), boxes, geometry: fitted.geometry, sizes: fitted.sizes, layout,
    photo: { width: photo.width, height: photo.height }, finale: null, panel: null, faces: {}, look: 'photo' })
  const moments = new Set([0, .8, times.steps0, times.finale, times.duration - .01])
  for (const act of times.acts) for (const time of [act.from ?? act.start ?? act.at, act.to ?? (act.at != null && act.len != null ? act.at + act.len : null)]) if (Number.isFinite(time)) moments.add(time)
  for (const act of times.acts) if (Number.isFinite(act.at) && Number.isFinite(act.len)) moments.add(act.at + act.len / 2)
  for (const start of times.starts) { moments.add(start); moments.add(start + .5) }
  // Engine acts expose at/len or from/to depending on operation; always sample every step's midpoint and end.
  for (let i = 0; i < times.starts.length; i++) {
    const from = times.starts[i], to = times.starts[i + 1] ?? times.finale
    moments.add((from + to) / 2); moments.add(to - .001)
  }
  return { source, times: [...moments].filter(t => Number.isFinite(t) && t >= 0 && t <= times.duration).sort((a, b) => a - b),
    screens: { ...Object.fromEntries(Object.entries(fitted.sizes).map(([k, s]) => [k, { width: s.width, height: s.height }])), photo: { width: photo.width, height: photo.height } },
    corrections: layout.settled || [], layout, duration: times.duration }
}
