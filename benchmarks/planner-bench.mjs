// Fresh photo → plan benchmarks: planning latency, cost and validation, without rendering video.
// node planner-bench.mjs --models muse-wonder-1.0,muse-spark-1.3 --review
import { fileURLToPath } from 'node:url'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createHash } from 'node:crypto'
import { configuration, generate, json } from '../src/pipeline/model.mjs'
import { planPhoto } from '../src/pipeline/plan.mjs'
import { PLAN_SCHEMA } from '../src/pipeline/plan-schema.mjs'
import { plannerBenchmarkCLI } from './planning-benchmark.mjs'

const modern = !process.argv[2] || ['audit', 'prepare', 'run', 'serve', 'report', 'publish', '--help'].includes(process.argv[2])
if (modern) await plannerBenchmarkCLI().catch(error => { console.error(error.message); process.exitCode = 1 })
else {

const here = fileURLToPath(new URL('.', import.meta.url))
const { values } = parseArgs({ options: {
  model: { type: 'string' }, models: { type: 'string' },
  only: { type: 'string' }, samples: { type: 'string', default: '1' }, jobs: { type: 'string', default: '2' },
  effort: { type: 'string', default: 'low' }, out: { type: 'string' }, review: { type: 'boolean', default: false },
  repairs: { type: 'string', default: '1' },
  'review-model': { type: 'string', default: 'muse-wonder-1.0' }, 'office-photo': { type: 'string' },
} })
const config = configuration(values), models = values.models?.split(',') || [config.model]
const samples = Number(values.samples), jobs = Number(values.jobs)
const maxRepairs = Number(values.repairs)
if (!Number.isInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 2) throw new Error('Use 0–2 repairs')
if (!Number.isInteger(samples) || samples < 1 || !Number.isInteger(jobs) || jobs < 1 || jobs > 8) throw new Error('Use positive integer samples and 1–8 jobs')
if (new Set(models).size !== models.length || models.some((m) => !/^[a-zA-Z0-9._-]+$/.test(m))) throw new Error('Model names must be distinct identifiers')
const cases = [
  { name: 'wood8', domain: 'wood', photo: join(here, '../examples/photos/wood8.png') },
  { name: 'lego-pile', domain: 'bricks', photo: join(here, '../examples/photos/lego-pile.png') },
  { name: 'groceries', domain: 'kitchen', photo: join(here, '../examples/photos/groceries.png') },
  { name: 'yarn', domain: 'crochet', photo: join(here, '../examples/photos/yarn.png') },
  { name: 'office', domain: 'everyday objects', photo: values['office-photo'] ? resolve(values['office-photo']) : join(here, '../runs/office6/script/photo.png') },
]
const only = values.only?.split(',')
if (only?.some((name) => !cases.some((c) => c.name === name))) throw new Error('Unknown case in --only')
const selected = cases.filter((c) => !only || only.includes(c.name))
const out = resolve(values.out || join(here, '../runs', `planner-${new Date().toISOString().replace(/[:.]/g, '-')}`))
if (existsSync(join(out, 'results.json'))) throw new Error('Benchmark output already exists; choose a new --out directory')
mkdirSync(out, { recursive: true })
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const manifest = { created: new Date().toISOString(), provider: config.provider, models, effort: values.effort, samples, maxRepairs,
  promptSha256: hash(readFileSync(join(here, '../prompts/script-prompt.txt'))),
  schemaSha256: hash(JSON.stringify(PLAN_SCHEMA)),
  review: values.review ? { provider: 'meta', model: values['review-model'], note: 'Model review is a noisy proxy, not a real-world completion test.' } : null,
  cases: selected.map((c) => ({ ...c, photoSha256: existsSync(c.photo) ? hash(readFileSync(c.photo)) : null })),
  limitations: ['Dimensions and quantities inferred from a single photo are unconfirmed.',
    'Deterministic checks catch supported plan contradictions; they do not certify real-world feasibility.',
    'Cost is estimated from successful calls with reported usage; failed attempts may have additional cost.'] }
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 1))
const results = [], save = () => writeFileSync(join(out, 'results.json'), JSON.stringify({ manifest, results }, null, 1))
save()

async function review(plan, planDir, dir) {
  mkdirSync(dir, { recursive: true }); copyFileSync(join(planDir, 'photo.png'), join(dir, 'photo.png'))
  const prompt = `Review this proposed instruction plan against photo.png. Be demanding and independent of the writer.
Does it make something useful and satisfying from the visible materials? Are the quantities, dimensions, tool needs,
and sequence credible? Are captions consistent with the action data? Does a novice have the necessary information?
Distinguish observations from guesses: absolute sizes usually cannot be measured from this photo. Don't treat
plausible dimensions as verified. Identify impractical or contradictory instructions, invented materials, and
irrelevant tidying steps. Score usefulness, grounding, completeness and clarity from 1 (poor) to 5 (excellent).
This is a review of a plan, not a rendered film or a physical test.
Added ordinary tools/fasteners are allowed when declared; distinguish those from invented photo inventory.
The makes array describes textile pieces and can be empty for assemblies of cut parts. Assembly films keep their
solved geometry in a fixed reveal, overriding old per-part finale beats. Version 2 captions and counts derive from
operation facts; inspect those facts, joint sites and state transitions rather than assuming prose is authoritative.
Plan: ${JSON.stringify(plan)}
Return JSON only: {"usefulness":1,"grounding":1,"completeness":1,"clarity":1,"wouldAttempt":false,
"blockingIssues":["specific problem"],"summary":"two sentences"}`
  writeFileSync(join(dir, 'prompt.txt'), prompt)
  const call = await generate(dir, prompt, { provider: 'meta', model: values['review-model'], images: ['photo.png'], effort: 'low', maxTokens: 4096 })
  const rating = json(call.text)
  for (const k of ['usefulness', 'grounding', 'completeness', 'clarity']) if (!Number.isInteger(rating[k]) || rating[k] < 1 || rating[k] > 5) throw new Error(`Invalid review score: ${k}`)
  if (!Array.isArray(rating.blockingIssues) || typeof rating.wouldAttempt !== 'boolean') throw new Error('Invalid review format')
  writeFileSync(join(dir, 'review.json'), JSON.stringify(rating, null, 1))
  return { ...rating, cost: call.cost, seconds: call.seconds, model: call.model }
}

const tasks = models.flatMap((model) => selected.flatMap((c) => Array.from({ length: samples }, (_, i) => ({ ...c, model, sample: i + 1 }))))
async function bench(task) {
  const dir = join(out, task.model, task.name, String(task.sample)), started = performance.now()
  const row = { name: task.name, domain: task.domain, sample: task.sample, provider: config.provider, model: task.model, directory: dir }
  mkdirSync(dir, { recursive: true })
  console.log(`Starting ${task.model} · ${task.name} · ${task.sample}`)
  try {
    if (!existsSync(task.photo)) throw new Error(`Missing test photo; use --office-photo or exclude ${task.name}`)
    const result = await planPhoto(task.photo, join(dir, 'plan'), { provider: config.provider, model: task.model, effort: values.effort, maxRepairs,
      perception: true, perceptionEffort: process.env.PERCEPTION_EFFORT || 'minimal', repairEffort: process.env.REPAIR_EFFORT || 'low',
      onObjects: (objects) => { row.objectsAtSeconds = (performance.now() - started) / 1000; row.objectCount = objects.length },
      onRetry: (r) => console.log(`Retrying ${task.name}: HTTP ${r.status ?? 'network'}, attempt ${r.attempt}`),
    })
    Object.assign(row, { valid: result.validation.valid, returned: true, geometryChecked: false, title: result.script.title, scriptReadySeconds: (performance.now() - started) / 1000,
      firstTokenSeconds: result.call.firstTokenSeconds, apiSeconds: result.call.seconds, usage: result.call.usage,
      cost: result.call.cost, costEstimated: result.call.costEstimated, attempts: result.call.attempts,
      planAttempts: result.call.planAttempts, firstPassValid: result.call.firstPassValid,
      validation: result.validation, actualModel: result.call.model })
    if (!row.valid) row.error = result.validation.errors.join('; ')
    if (values.review) {
      try { row.review = await review(result.script, join(dir, 'plan'), join(dir, 'review')) }
      catch (error) { row.reviewError = error.message }
    }
  } catch (error) {
    Object.assign(row, { valid: false, error: error.message, elapsedSeconds: (performance.now() - started) / 1000,
      validation: error.validation, cost: error.call?.cost ?? null, usage: error.call?.usage,
      planAttempts: error.call?.planAttempts, firstPassValid: error.call?.firstPassValid })
  }
  results.push(row); save()
  console.log(`${row.valid ? 'VALID' : 'INVALID'} ${task.model} · ${task.name}: ${row.valid ? `${row.scriptReadySeconds.toFixed(1)}s to validated plan, $${row.cost?.toFixed(4) ?? 'unknown'}` : row.error}`)
}
let next = 0
await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, async () => {
  while (next < tasks.length) await bench(tasks[next++])
}))
console.table(results.map((r) => ({ model: r.model, photo: r.name, valid: r.valid,
  first_pass: r.firstPassValid, plan_calls: r.planAttempts,
  objects_s: r.objectsAtSeconds?.toFixed(1), plan_s: r.scriptReadySeconds?.toFixed(1),
  warnings: r.validation?.warnings.length, usefulness: r.review?.usefulness, grounding: r.review?.grounding,
  blocking: r.review?.blockingIssues.length, cost: r.cost?.toFixed(4) })))
console.log(`Saved benchmark: ${out}`)
if (results.some((r) => !r.valid || r.reviewError)) process.exitCode = 1
}
