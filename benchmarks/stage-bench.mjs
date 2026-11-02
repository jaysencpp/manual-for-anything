import { repoRoot, sourceFiles } from './code-hashes.mjs'
// Offline-first experiments for recognition, isolated full-plan repair, and revisions.
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, cpSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash, randomBytes } from 'node:crypto'
import { parseArgs } from 'node:util'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { here, read, save, fresh, safe, fromRaw } from './planning-data.mjs'
import { generate } from '../src/pipeline/model.mjs'
import { writePlan, preparePhoto } from '../src/pipeline/plan.mjs'
import { gradePlan, productionGeometryCheck } from './planning-grade.mjs'
import { hydrateInventory } from '../src/pipeline/planning-inputs.mjs'
import { openPlanningBrowser } from './planning-browser.mjs'
import { EFFORTS, schedule, wilson } from './drawing-bench.mjs'
import { validatePlanReview } from './planning-report.mjs'
import { STAGES, seedStageCases, stageRequest } from './stage-bench-cases.mjs'
import { assertionErrors, gradeRecognition, pointer } from './stage-bench-grade.mjs'

const hash = data => createHash('sha256').update(data).digest('hex')
function treeHashes(dir) {
  const result = {}
  const walk = folder => { for (const e of readdirSync(folder, { withFileTypes: true })) {
    const p = join(folder, e.name)
    if (e.isDirectory()) walk(p)
    else if (e.isFile()) result[relative(dir, p)] = hash(readFileSync(p))
    else throw new Error('Frozen suites must contain ordinary files, not symlinks')
  } }
  walk(dir); return result
}
function codeHashes() {
  return Object.fromEntries(sourceFiles().map(f => [f, hash(readFileSync(join(repoRoot, f)))]))
}
const caseAt = (out, id) => { if (!safe(id)) throw new Error('Invalid case id'); return read(join(out, 'cases', id, 'case.json')) }
function validateCase(c, stage) {
  if (!safe(c.id) || !c.photo?.width || !c.photo?.height) throw new Error('Case needs an id and photo dimensions')
  validatePlanReview(c.qualification)
  if (stage === 'recognition') {
    if (!['physical', 'problem'].includes(c.expected?.mode) || !Array.isArray(c.expected.objects)) throw new Error('Recognition case needs expected mode and objects')
    if (c.expected.coverage != null && !['partial', 'complete'].includes(c.expected.coverage)) throw new Error('Invalid recognition label coverage')
    if (c.expected.mode === 'problem' && c.expected.objects.length) throw new Error('Problem labels must have no objects')
    if (c.expected.iouThreshold != null && !(c.expected.iouThreshold > 0 && c.expected.iouThreshold <= 1)) throw new Error('Invalid IoU threshold')
    for (const o of c.expected.objects) if (!Array.isArray(o.b) || o.b.length !== 4 || !o.b.every(Number.isFinite) || o.b[2] <= 0 || o.b[3] <= 0 || typeof o.segment !== 'string' || !o.segment || o.classes && (!Array.isArray(o.classes) || !o.classes.length || o.classes.some(s => typeof s !== 'string' || !s))) throw new Error('Invalid recognition object label')
  } else {
    if (!c.baseline || !Array.isArray(c.inventory) || !c.cut?.geometry || !c.cut?.sizes) throw new Error('Plan case needs baseline, inventory and saved geometry')
    if (stage === 'repair' && (!Array.isArray(c.diagnostics) || !c.diagnostics.length || c.diagnostics.some(x => typeof x !== 'string'))) throw new Error('Repair case needs diagnostics')
    if (stage === 'revisions' && (!c.guidance?.messages?.length || !c.checks?.length)) throw new Error('Revision case needs requests and task assertions')
    for (const a of c.checks || []) { pointer(c.baseline, a.path); if (!['equals', 'preserve', 'change', 'excludes'].includes(a.op)) throw new Error('Invalid task assertion') }
  }
}

export async function prepareStageExperiment(out, { stage, suite, only, models = ['muse-wonder-1.0', 'muse-spark-1.3'], efforts = EFFORTS,
  samples = 1, seed = 'stage-pilot-v1', maxTokens = stage === 'recognition' ? 8000 : 32000, browserFactory = openPlanningBrowser } = {}) {
  if (!STAGES.includes(stage)) throw new Error(`Choose --stage ${STAGES.join(', ')}`)
  if (!models.length || new Set(models).size !== models.length || models.some(m => !/^[a-zA-Z0-9._-]+$/.test(m))) throw new Error('Choose distinct model identifiers')
  schedule(efforts, samples, seed)
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 128000) throw new Error('Invalid token cap')
  fresh(out)
  let browser, cases
  try {
    if (stage !== 'recognition') browser = await browserFactory()
    if (suite) {
      const m = read(join(suite, 'manifest.json'))
      if (m.stage !== stage || !m.cases?.length || new Set(m.cases.map(c => c.id)).size !== m.cases.length || m.cases.some(c => !safe(c.id))) throw new Error('Invalid source suite or stage mismatch')
      cpSync(join(suite, 'cases'), join(out, 'cases'), { recursive: true, dereference: false })
      cases = m.cases.map(({ id }) => caseAt(out, id))
      for (const c of cases) {
        const dir = join(out, 'cases', c.id), { path, ...photo } = await preparePhoto(join(dir, 'photo.png'), dir)
        if (photo.width !== c.photo.width || photo.height !== c.photo.height) throw new Error('Photo dimensions differ from labels')
        c.request = stageRequest(stage, c); save(join(dir, 'case.json'), c)
      }
    } else cases = await seedStageCases(out, stage, browser?.smoke)
    if (only && (!only.length || new Set(only).size !== only.length || only.some(id => !cases.some(c => c.id === id)))) throw new Error('Unknown or duplicate case in --only')
    if (only) cases = cases.filter(c => only.includes(c.id))
    for (const c of cases) {
      validateCase(c, stage)
      if (stage === 'repair') {
        const bad = await gradePlan({ ...c, candidate: c.baseline, smoke: browser.smoke })
        if (bad.machine !== 'fail') throw new Error(`Repair baseline ${c.id} must fail production checks`)
        const witness = read(join(out, 'cases', c.id, 'witness.json'))
        if ((await gradePlan({ ...c, candidate: witness, smoke: browser.smoke })).machine !== 'pass') throw new Error(`Repair witness ${c.id} must pass production checks`)
      }
    }
  } finally { await browser?.close() }
  const tasks = cases.flatMap(c => models.flatMap(model => schedule(efforts, samples, `${seed}:${c.id}:${model}`).map(t => ({
    id: hash(`${seed}:${stage}:${c.id}:${model}:${t.effort}:${t.round}`).slice(0, 20), caseId: c.id, model, effort: t.effort, sample: t.round, status: 'pending' }))))
    .sort((a, b) => a.sample - b.sample || hash(`${seed}:order:${a.id}`).localeCompare(hash(`${seed}:order:${b.id}`)))
  const manifest = { version: 1, stage, mode: 'prepared', created: new Date().toISOString(), models, efforts, samples, seed, maxTokens,
    retries: 0, callsPerTrial: 1, cases: cases.map(({ id, title, qualification }) => ({ id, title, qualification })),
    codeHashes: codeHashes(), inputHashes: treeHashes(join(out, 'cases')), taskHash: hash(JSON.stringify(tasks)), execution: null }
  save(join(out, 'manifest.json'), manifest); save(join(out, 'tasks.json'), tasks); save(join(out, 'results.json'), []); save(join(out, 'reviews.json'), { cases: {}, attempts: {} })
  writeStageReport(out); return { manifest, tasks }
}

export function verifyStageExperiment(out) {
  const m = read(join(out, 'manifest.json'))
  if (!STAGES.includes(m.stage)) throw new Error('Unknown benchmark stage')
  if (JSON.stringify(treeHashes(join(out, 'cases'))) !== JSON.stringify(m.inputHashes)) throw new Error('Frozen inputs changed; prepare a fresh experiment')
  for (const [file, expected] of Object.entries(m.codeHashes)) if (hash(readFileSync(join(repoRoot, file))) !== expected) throw new Error(`Execution code changed: ${file}; prepare a fresh experiment`)
  if (hash(JSON.stringify(read(join(out, 'tasks.json')))) !== m.taskHash) throw new Error('Frozen task schedule changed or experiment already started')
  return m
}

function mockOutput(stage, c, out) {
  if (stage === 'recognition') return c.expected.mode === 'problem' ? { mode: 'problem', objects: [] } : { mode: 'physical', objects: c.inventory.map(o => Object.fromEntries(Object.entries(o).filter(([k]) => ['k','n','segment','b','cm','w','thick','tip','measurements','toolKind'].includes(k)))) }
  if (stage === 'repair') return read(join(out, 'cases', c.id, 'witness.json'))
  const plan = structuredClone(c.baseline)
  plan.objects = structuredClone(c.inventory)
  for (const a of c.checks) if (a.op === 'equals' && a.path === '/title') plan.title = a.value
  if (c.checks.some(a => a.op === 'change' && a.path === '/steps/0/c')) plan.steps[0].c += ' Work carefully, completing this step before continuing.'
  return plan
}
export async function runStageExperiment(out, { mock = false, browserFactory = openPlanningBrowser, caller = generate, planner = writePlan, callOptions = {} } = {}) {
  const m = verifyStageExperiment(out), tasks = read(join(out, 'tasks.json')), rows = []
  if (m.execution || tasks.some(t => t.status !== 'pending')) throw new Error('Experiment already started; use a fresh directory')
  const browser = m.stage === 'recognition' ? null : await browserFactory()
  try {
    m.mode = mock ? 'mock' : 'live'; m.execution = { started: new Date().toISOString() }; save(join(out, 'manifest.json'), m)
    for (const [i, task] of tasks.entries()) {
      task.status = 'running'; save(join(out, 'tasks.json'), tasks)
      const c = caseAt(out, task.caseId), dir = join(out, 'attempts', task.id); mkdirSync(dir, { recursive: true })
      for (const f of ['photo.png', 'photo.jpg']) copyFileSync(join(out, 'cases', c.id, f), join(dir, f))
      console.log(`${i + 1}/${tasks.length}: ${m.stage}, ${c.id}, ${task.model}, ${task.effort}`)
      const began = performance.now(); let response, failure, candidate
      const options = { ...callOptions, model: task.model, effort: task.effort, noThinking: false, maxTokens: m.maxTokens, retries: 0 }
      try {
        if (mock) response = { text: JSON.stringify(mockOutput(m.stage, c, out)), cost: null, usage: null }
        else if (m.stage === 'revisions') {
          const r = await planner(dir, { ...c.photo, path: join(dir, 'photo.png') }, { ...options, inventory: c.inventory,
            guidance: { ...c.guidance, previousPlan: c.baseline }, confirmedMeasurements: c.confirmedMeasurements,
            perception: false, maxRepairs: 0, background: false, checkPlan: script => productionGeometryCheck(script, c.cut) })
          candidate = r.script; response = fromRaw(join(dir, 'out-0.json'))
        } else response = await caller(dir, c.request.prompt, { ...options, images: ['photo.jpg'],
          responseFormat: { type: 'json_schema', json_schema: { name: c.request.name, schema: c.request.schema } } })
      } catch (error) { failure = error.message; response = fromRaw(join(dir, 'out-0.json')) || fromRaw(join(dir, 'out.json')) || fromRaw(join(dir, 'out-0.partial.json')) || fromRaw(join(dir, 'out.partial.json')) }
      const text = response?.text ?? ''
      save(join(dir, 'response.json'), { ...response, text, failure: failure ?? null })
      let grade
      if (m.stage === 'recognition') grade = gradeRecognition(text, c)
      else {
        if (!candidate && existsSync(join(dir, 'candidate-0.json'))) candidate = read(join(dir, 'candidate-0.json'))
        const planningRequest = existsSync(join(dir, 'request-0.json')) ? read(join(dir, 'request-0.json')) : null
        const full = await gradePlan({ ...c, candidate, rawText: text, rawSchema: planningRequest?.schema || c.request?.schema,
          smoke: browser.smoke, normalize: !candidate })
        const output = full.normalizedPlan
        const errors = full.findings.map(f => f.message)
        if (m.stage === 'repair' && full.rawFirstResponseValid !== true) errors.push('Raw repair did not pass production checks before deterministic settling')
        // Compare authored fields before deterministic settling adds derived action/caption fields.
        // Raw checks also prevent production normalization from hiding a disobeyed request.
        if (m.stage === 'revisions') try { errors.push(...assertionErrors(hydrateInventory(JSON.parse(text), c.inventory), c.baseline, c.checks)) } catch {}
        grade = { machine: errors.length ? 'fail' : full.machine, errors: [...new Set(errors)], output, planGrade: full }
      }
      if (failure) { grade.machine = 'fail'; grade.errors.push(failure) }
      rows.push({ ...task, status: failure ? response?.is_error === false ? 'invalid-plan' : 'provider-failure' : 'complete', grade, actualModel: response?.model ?? null,
        responseSeconds: response?.seconds ?? null, firstTokenSeconds: response?.firstTokenSeconds ?? null,
        elapsedSeconds: (performance.now() - began) / 1000, cost: response?.cost ?? null, usage: response?.usage ?? null })
      task.status = 'complete'; save(join(out, 'tasks.json'), tasks); save(join(out, 'results.json'), rows); writeStageReport(out)
      if (grade.planGrade?.grades.execution.status === 'unavailable') throw new Error('Browser playback unavailable; stopped before further calls')
    }
    m.execution.finished = new Date().toISOString(); save(join(out, 'manifest.json'), m); return writeStageReport(out)
  } finally { await browser?.close() }
}

const median = values => { const v = values.filter(Number.isFinite).sort((a,b) => a-b); return v.length ? (v[Math.floor((v.length-1)/2)] + v[Math.floor(v.length/2)]) / 2 : null }
export function writeStageReport(out) {
  const m = read(join(out, 'manifest.json')), reviews = read(join(out, 'reviews.json')), tasks = read(join(out, 'tasks.json'))
  const cases = m.cases.map(c => ({ ...c, qualification: reviews.cases[c.id] || c.qualification }))
  const rows = read(join(out, 'results.json')).map(r => {
    const review = reviews.attempts[r.id] || { verdict: 'pending', reason: '' }, eligible = cases.find(c => c.id === r.caseId).qualification.verdict === 'pass'
    return { ...r, review, eligible, outcome: r.grade.machine === 'fail' || review.verdict === 'fail' ? 'fail' : eligible && r.grade.machine === 'pass' && review.verdict === 'pass' ? 'pass' : 'pending' }
  })
  const summarize = scheduled => {
    const found = rows.filter(r => scheduled.some(t => t.id === r.id)), n = scheduled.length
    const passes = found.filter(r => r.outcome === 'pass').length, failures = found.filter(r => r.outcome === 'fail').length, pending = n - passes - failures
    const knownCost = found.reduce((s,r) => s + (r.cost ?? 0), 0), unknownCosts = found.filter(r => r.cost == null).length
    const resolved = m.mode === 'live' && n > 0 && pending === 0
    return { scheduled: n, completed: found.length, passes, failures, pending, machinePasses: found.filter(r => r.grade.machine === 'pass').length,
      passAt1: resolved ? passes / n : null, wilson95: resolved ? wilson(passes,n) : null,
      medianSeconds: median(found.map(r => r.elapsedSeconds)), knownCost, unknownCosts,
      costPerPass: resolved && passes && !unknownCosts ? knownCost / passes : null }
  }
  const eligibleTasks = tasks.filter(t => cases.find(c => c.id === t.caseId).qualification.verdict === 'pass')
  const groups = m.models.flatMap(model => m.efforts.map(effort => ({ model, effort,
    ...summarize(eligibleTasks.filter(t => t.model === model && t.effort === effort)),
    perCase: cases.map(c => ({ caseId: c.id, eligible: c.qualification.verdict === 'pass', ...summarize(tasks.filter(t => t.model === model && t.effort === effort && t.caseId === c.id)) })) })))
  // Unqualified cases retain diagnostics but never publish pass-rate estimates.
  for (const group of groups) for (const c of group.perCase) if (!c.eligible) { c.passAt1 = null; c.wilson95 = null; c.costPerPass = null }
  const report = { stage: m.stage, mode: m.mode, cases, rows, groups, scheduled: tasks.length,
    note: 'Only qualified cases enter aggregate groups. A pass requires automated checks and human acceptance. Mock runs do not estimate model quality. Cost estimates are not billing records. Intervals describe repeated attempts on these fixed cases, not unseen photos.' }
  save(join(out, 'report.json'), report)
  const cell = value => String(value ?? '—').replaceAll('|', '\\|').replaceAll('\n', ' ')
  const lines = [`# ${m.stage} benchmark`, '', `Mode: ${m.mode}. ${report.note}`, '', '| Model | Effort | Qualified trials | Passes | Pending | Pass@1 | Median seconds | Known cost | Unknown costs |', '|---|---|---|---|---|---|---|---|---|',
    ...groups.map(g => `| ${[g.model,g.effort,g.scheduled,g.passes,g.pending,g.passAt1,g.medianSeconds,g.knownCost,g.unknownCosts].map(cell).join(' | ')} |`)]
  save(join(out, 'report-data.json'), { groups })
  // Markdown is intentionally a small summary; report.json retains every diagnostic and output.
  writeFileSync(join(out, 'report.md'), lines.join('\n') + '\n')
  return report
}

export function saveStageReview(out, { kind = 'attempt', id, ...value }) {
  const m = read(join(out, 'manifest.json')), rows = read(join(out, 'results.json')), reviews = read(join(out, 'reviews.json'))
  if (!['case', 'attempt'].includes(kind) || !(kind === 'case' ? m.cases : rows).some(r => r.id === id)) throw new Error('Unknown review target')
  reviews[kind === 'case' ? 'cases' : 'attempts'][id] = validatePlanReview(value)
  save(join(out, 'reviews.json'), reviews); return writeStageReport(out)
}

export async function serveStageReport(out, { port = 0 } = {}) {
  const token = randomBytes(24).toString('hex')
  const server = createServer(async (req,res) => {
    const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)) }
    try {
      if (![`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`].includes(req.headers.host)) return reply(403, { error: 'Loopback Host required' })
      const path = new URL(req.url, 'http://localhost').pathname
      if (req.method === 'POST') {
        if (path !== '/api/review' || req.headers['x-bench-token'] !== token) return reply(403, { error: 'Invalid review token' })
        let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 12000) return reply(413, { error: 'Review too large' }) }
        saveStageReview(out, JSON.parse(body)); return reply(200, { saved: true })
      }
      if (req.method !== 'GET') return reply(405, { error: 'GET or POST required' })
      if (path === '/api/report') {
        const report = writeStageReport(out), reveal = new URL(req.url, 'http://localhost').searchParams.get('labels') === '1'
        if (!reveal) { report.groups = []; report.rows = report.rows.map(({ model, actualModel, effort, sample, cost, usage, responseSeconds, firstTokenSeconds, elapsedSeconds, ...r }) => r) }
        return reply(200, { ...report, token })
      }
      const match = /^\/api\/case\/([a-z0-9-]+)$/.exec(path)
      if (match) return reply(200, caseAt(out, match[1]))
      const photo = /^\/photo\/([a-z0-9-]+)\.png$/.exec(path)
      let file, type
      if (photo && read(join(out, 'manifest.json')).cases.some(c => c.id === photo[1])) { file = join(out, 'cases', photo[1], 'photo.png'); type = 'image/png' }
      else if (path === '/') { file = join(here, 'stage-review.html'); type = 'text/html' }
      else if (path === '/stage-review.mjs') { file = join(here, 'stage-review.mjs'); type = 'text/javascript' }
      else return reply(404, { error: 'Not found' })
      res.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'" }); res.end(readFileSync(file))
    } catch (e) { reply(400, { error: e.message }) }
  })
  server.listen(port, '127.0.0.1'); await once(server, 'listening')
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }) }
}

export async function stageBenchmarkCLI(args = process.argv.slice(2)) {
  const { values: v, positionals: p } = parseArgs({ args, allowPositionals: true, options: Object.fromEntries([
    ...['out','stage','suite','only','models','efforts','samples','seed','max-tokens','port','case','verdict','reason'].map(k => [k,{ type: 'string' }]),
    ...['live','mock','help'].map(k => [k,{ type: 'boolean' }])]) })
  if (v.help || !p.length) { console.log('Stage benchmarks (offline by default)\n prepare --stage recognition|repair|revisions --out DIR [--suite DIR --models MODEL,MODEL --efforts low,medium --samples 3 --seed SEED]\n run --out DIR --mock | --live (paid, requires authorization)\n serve --out DIR [--port 8100]\n report --out DIR\n qualify --out DIR --case ID --verdict pass|fail|pending --reason TEXT'); return }
  if (!v.out) throw new Error('Supply --out DIR')
  const out = resolve(v.out)
  if (p[0] === 'prepare') {
    const { tasks } = await prepareStageExperiment(out, { stage: v.stage, suite: v.suite ? resolve(v.suite) : undefined, only: v.only?.split(','), models: v.models?.split(','), efforts: v.efforts?.split(','), samples: Number(v.samples || 1), seed: v.seed, maxTokens: v['max-tokens'] ? Number(v['max-tokens']) : undefined })
    console.log(`Prepared ${tasks.length} trials, at most ${tasks.length} model calls. No paid calls. ${out}`)
  } else if (p[0] === 'run') {
    if (!!v.live === !!v.mock) throw new Error('Choose exactly one of --mock or --live; paid runs require explicit authorization')
    await runStageExperiment(out, { mock: !!v.mock })
  } else if (p[0] === 'report') console.log(JSON.stringify(writeStageReport(out).groups, null, 2))
  else if (p[0] === 'qualify') saveStageReview(out, { kind: 'case', id: v.case, verdict: v.verdict, reason: v.reason })
  else if (p[0] === 'serve') {
    const service = await serveStageReport(out, { port: Number(v.port || 8100) }); console.log(`Review: ${service.url}`)
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await service.close(); process.exit(0) })
  } else throw new Error('Unknown command; use --help')
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await stageBenchmarkCLI().catch(e => { console.error(e.message); process.exitCode = 1 })
