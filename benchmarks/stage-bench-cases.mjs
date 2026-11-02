import sharp from 'sharp'
import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { here, read, save } from './planning-data.mjs'
import { preparePhoto, perceptionPrompt } from '../src/pipeline/plan.mjs'
import { gradePlan } from './planning-grade.mjs'
import { PERCEPTION_SCHEMA, PHYSICAL_PLAN_SCHEMA } from '../src/pipeline/plan-schema.mjs'

export const STAGES = ['recognition', 'repair', 'revisions']
const fixtures = ['wood8', 'lego-pile', 'groceries', 'yarn']
// Saved engine plans contain derived fields that are not provider output fields.
// Apply this only to authored fixtures, never to a model response before grading it.
export function fixtureProjection(value, schema) {
  if (value && typeof value === 'object' && !Array.isArray(value) && schema.required?.includes('assembly')) value = { cuts: [], assembly: null, ...value }
  if (schema.anyOf && !schema.properties) schema = schema.anyOf.find(s => s.type === (Array.isArray(value) ? 'array' : typeof value) || s.enum?.includes(value)) || schema.anyOf[0]
  if (Array.isArray(value)) return value.map(v => fixtureProjection(v, schema.items || {}))
  if (value && typeof value === 'object' && schema.properties) return Object.fromEntries(Object.entries(value).filter(([k]) => k in schema.properties).map(([k,v]) => [k, fixtureProjection(v, schema.properties[k])]))
  return value
}
export function stageRequest(stage, c) {
  if (stage === 'recognition') return { prompt: perceptionPrompt(c.photo, c.guidance), schema: PERCEPTION_SCHEMA, name: 'PhotoPerception' }
  if (stage === 'repair') return { name: 'InstructionPlan', schema: PHYSICAL_PLAN_SCHEMA,
    prompt: `Correct this physical instruction plan using the original photo and the deterministic diagnostics below. Return one complete plan in the supplied schema. Preserve the chosen project, all unaffected instructions and the inventory identity, photo boxes, dimensions and measurement provenance. Do not invent materials or delete required work to hide a diagnostic.\nDiagnostics: ${JSON.stringify(c.diagnostics)}\nPrevious plan: ${JSON.stringify(c.baseline)}` }
  return null // Revisions use writePlan and guidancePrompt directly.
}

export async function seedStageCases(out, stage, smoke) {
  const cases = []
  for (const fixture of fixtures) {
    const source = join(here, '../examples/fixtures', fixture), saved = read(join(source, 'script.json'))
    saved.design.standard ||= 'Saved fixture project; photo dimensions remain estimates.'
    for (const o of saved.objects) o.segment ||= o.part?.family === 'brick' ? 'toy brick' : /board|batten/.test(o.n) ? 'wooden board' : o.n
    const witness = fixtureProjection(saved, PHYSICAL_PLAN_SCHEMA)
    const inventory = structuredClone(witness.objects)
    witness.objects = inventory
    const screens = read(join(source, 'screens/screens.json'))
    const common = { source: 'saved-fixture', fixture, inventory, confirmedMeasurements: {},
      cut: { geometry: read(join(source, 'screens/geometry.json')), sizes: Object.fromEntries(Object.entries(screens).filter(([k]) => k !== 'photo').map(([k, s]) => [k, { width: s.width, height: s.height }])) },
      reviewQuestions: ['Does the response fulfill the task?', 'Are unchanged details preserved?', 'Are materials and measurements grounded?'] }
    const variants = stage === 'recognition' ? ['inventory'] : stage === 'repair'
      ? ['unknown-reference', 'contract-version', 'caption-claims', ...(fixture === 'wood8' ? ['stock-overrun'] : fixture === 'lego-pile' ? ['detached-placement'] : [])]
      : ['rename', 'clarify', 'constraint-history', 'identity-correction']
    for (const variant of variants) {
      const id = `${fixture}-${variant}`, folder = join(out, 'cases', id)
      mkdirSync(folder, { recursive: true }); copyFileSync(join(source, 'screens/photo.png'), join(folder, 'photo.png'))
      const { path, ...photo } = await preparePhoto(join(folder, 'photo.png'), folder)
      const c = { ...structuredClone(common), id, title: `${fixture}: ${variant}`, photo,
        qualification: { verdict: 'pending', reason: 'Fixture-derived labels/task need independent human review.' } }
      if (stage === 'recognition') {
        c.expected = { mode: 'physical', coverage: fixture === 'wood8' ? 'complete' : 'partial', iouThreshold: 0.5, objects: inventory.map(o => ({ b: o.b, segment: o.segment, classes: [o.segment, o.n] })) }
        c.reviewQuestions = ['Is the routing label correct?', 'Are all independently usable visible instances labelled once?', 'Are names/classes and individual boxes accurate? Add accepted class synonyms in a custom suite if needed.', 'Do not score estimated dimensions as measured truth.']
      } else {
        const good = await gradePlan({ ...c, candidate: witness, smoke })
        if (good.machine !== 'pass') throw new Error(`Seed witness ${fixture} failed: ${JSON.stringify(good.findings)}`)
        save(join(folder, 'witness.json'), witness)
        c.baseline = structuredClone(witness)
        if (stage === 'repair') {
          if (variant === 'unknown-reference') c.baseline.steps.find(s => s.do?.some(a => a.k)).do.find(a => a.k).k = 'missing-benchmark-object'
          else if (variant === 'contract-version') c.baseline.contractVersion = 1
          else if (variant === 'caption-claims') c.baseline.steps[0].claims = ['missing-benchmark-operation']
          else if (variant === 'detached-placement') c.baseline.steps.flatMap(s => s.do || []).find(a => a.rel === 'on').studs = [40,40]
          else c.baseline.steps.flatMap(s => s.do || []).find(a => a.v === 'cut' && Array.isArray(a.into)).into[0].cm = 9999
          const bad = await gradePlan({ ...c, candidate: c.baseline, smoke })
          if (bad.machine !== 'fail') throw new Error(`Repair seed ${id} did not introduce a detected error`)
          c.diagnostics = bad.findings.map(f => f.message)
          c.reviewQuestions.push('Did the correction fix the underlying error while preserving valid work?')
        } else {
          const rename = variant === 'rename' || variant === 'constraint-history'
          c.guidance = { messages: [rename
            ? `Keep the same project, materials, dimensions and operations. Change only the title to "${fixture} at home".`
            : 'Explain the first step more clearly for a complete beginner. Rewrite its caption. Keep the same project, materials, design and every operation.'], previousPlan: c.baseline }
          if (variant === 'constraint-history') c.guidance.messages = [
            'Keep every operation and dimension unchanged. Rename the project "Weekend project".',
            `Actually, use the title "${fixture} at home" instead. Keep my earlier constraints.`]
          if (variant === 'identity-correction') {
            c.baseline.objects[0].n = 'incorrect previous identification'
            c.guidance.messages = [`The first object was incorrectly identified. It is ${inventory[0].n}. Correct its name, keeping its key and the same project, design and operations. Keep every other object unchanged.`]
          }
          c.checks = [{ op: 'preserve', path: '/design' }, ...witness.steps.map((_, i) => ({ op: 'preserve', path: `/steps/${i}/do` })),
            rename ? { op: 'equals', path: '/title', value: `${fixture} at home` }
              : variant === 'identity-correction' ? { op: 'equals', path: '/objects/0/n', value: inventory[0].n }
              : { op: 'change', path: '/steps/0/c' }]
          if (rename || variant === 'identity-correction') c.checks.push({ op: 'preserve', path: '/steps' })
          c.reviewQuestions.push('Is the requested revision useful and complete, with no unrelated changes?')
        }
      }
      c.request = stageRequest(stage, c)
      save(join(folder, 'case.json'), c); cases.push(c)
    }
  }
  if (stage === 'recognition') {
    const id = 'written-equation', folder = join(out, 'cases', id); mkdirSync(folder, { recursive: true })
    const line = (text, top) => ({ input: { text: { text, fontfile: join(here, '../assets/fonts/jetbrains-mono-600.ttf'), font: 'JetBrains Mono', dpi: 216, rgba: true } }, left: 70, top })
    await sharp({ create: { width: 1000, height: 500, channels: 3, background: 'white' } }).composite([line('Solve for x', 100), line('3x + 6 = 21', 220)]).png().toFile(join(folder, 'photo.png'))
    const { path, ...photo } = await preparePhoto(join(folder, 'photo.png'), folder)
    const c = { id, title: 'Written equation routing', source: 'synthetic', photo, expected: { mode: 'problem', objects: [] },
      qualification: { verdict: 'pass', reason: 'Deterministically generated written equation; routing label follows rendered text.' }, reviewQuestions: ['Was this routed as a written problem with no physical inventory?'] }
    c.request = stageRequest(stage, c); save(join(folder, 'case.json'), c); cases.push(c)
  }
  return cases
}
