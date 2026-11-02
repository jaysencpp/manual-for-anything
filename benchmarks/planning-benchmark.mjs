import { readFileSync, existsSync, mkdirSync, readdirSync, copyFileSync, cpSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { parseArgs } from 'node:util'
import { gradePlan, issue, productionGeometryCheck } from './planning-grade.mjs'
import { openPlanningBrowser } from './planning-browser.mjs'
import { writePlan, preparePhoto, PROMPT_VERSION } from '../src/pipeline/plan.mjs'
import { schedule, EFFORTS } from './drawing-bench.mjs'
import { repoRoot, sourceFiles } from './code-hashes.mjs'
import { here, read, save, fresh, readCase, fromRaw, auditSavedPlans } from './planning-data.mjs'
import { writePlanningReport, validatePlanReview, publishPlanningReport, publishPlanningComparison } from './planning-report.mjs'
export { auditSavedPlans, writePlanningReport }

const digest = data => createHash('sha256').update(data).digest('hex')
function codeHashes() {
  return Object.fromEntries(sourceFiles().map(file => [file, digest(readFileSync(join(repoRoot, file)))]))
}
function treeHashes(dir) {
  const result = {}
  function walk(folder) { for (const e of readdirSync(folder, { withFileTypes: true })) { const path = join(folder, e.name); if (e.isDirectory()) walk(path); else if (e.isFile()) result[relative(dir, path)] = digest(readFileSync(path)) } }
  walk(dir); return result
}
export async function preparePlanningExperiment(out, { suite, only, models = ['muse-wonder-1.0', 'muse-spark-1.3'], efforts = EFFORTS, samples = 1, seed = randomBytes(12).toString('hex'), maxTokens = 32000, maxRepairs = 0, diagnostic = false } = {}) {
  if (!suite) throw new Error('Supply --suite with an audited case collection')
  if (!models.length || new Set(models).size !== models.length || models.some(m => !/^[a-zA-Z0-9._-]+$/.test(m))) throw new Error('Models must be distinct identifiers')
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 128000 || !Number.isInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 2) throw new Error('Invalid token cap or repairs (0–2)')
  const source = read(join(suite, 'manifest.json'))
  if (only?.some(id => !source.cases.some(c => c.id === id))) throw new Error('Unknown case in --only')
  if (diagnostic && !only?.length) throw new Error('Diagnostic runs require explicit --only case IDs')
  const cases = source.cases.filter(c => (!only || only.includes(c.id)) && (diagnostic ? c.diagnostic : !c.diagnostic && c.qualification.eligibleForPilot))
  if (!cases.length || only && cases.length !== only.length) throw new Error('Selected cases include diagnostics or rejected witnesses; audit/qualify feasible cases before ranking models')
  const tasks = []
  for (const c of cases) {
    const jobs = models.flatMap(model => schedule(efforts, samples, `${seed}:${c.id}`).map(job => ({ ...job, model, caseId: c.id,
      id: digest(`${seed}:${c.id}:${model}:${job.round}:${job.effort}`).slice(0, 20), status: 'pending' })))
    jobs.sort((a, b) => a.round - b.round || digest(`${seed}:order:${c.id}:${a.round}:${a.model}:${a.effort}`).localeCompare(digest(`${seed}:order:${c.id}:${b.round}:${b.model}:${b.effort}`)))
    tasks.push(...jobs)
  }
  fresh(out)
  for (const c of cases) { const dest = join(out, 'cases', c.id); cpSync(join(suite, 'cases', c.id), dest, { recursive: true }); await preparePhoto(join(dest, 'photo.png'), dest) }
  const manifest = { version: 1, mode: 'prepared', created: new Date().toISOString(), models, efforts, samples, seed, maxTokens, maxRepairs,
    maxPlanningCallsPerTrial: maxRepairs ? 2 + maxRepairs : 1, retries: 0, perception: 'frozen audited inventory', sam: 'saved geometry', artwork: 'deterministic stand-ins',
    promptVersion: PROMPT_VERSION, cases, inputHashes: treeHashes(join(out, 'cases')), codeHashes: codeHashes(), execution: null,
    note: diagnostic ? 'Diagnostic planner comparison on an unqualified task. Automated check results are not evidence of task correctness and are excluded from model rankings. No fresh perception, SAM, catalogue or artwork calls.' : 'Isolated planner comparison. No fresh perception, SAM, catalogue or artwork calls. Human task review remains separate.' }
  save(join(out, 'manifest.json'), manifest); save(join(out, 'tasks.json'), tasks); save(join(out, 'results.json'), []); save(join(out, 'reviews.json'), {})
  writePlanningReport(out); return { manifest, tasks }
}
export function verifyPlanningExperiment(out) {
  const m = read(join(out, 'manifest.json'))
  for (const [file, expected] of Object.entries(m.inputHashes || {})) if (digest(readFileSync(join(out, 'cases', file))) !== expected) throw new Error(`Frozen case changed: ${file}`)
  for (const [file, expected] of Object.entries(m.codeHashes || {})) if (digest(readFileSync(join(repoRoot, file))) !== expected) throw new Error(`Execution code changed: ${file}; prepare a fresh experiment`)
  return m
}
export async function runPlanningExperiment(out, { browserFactory = openPlanningBrowser, planner = writePlan, callOptions = {} } = {}) {
  const manifest = verifyPlanningExperiment(out), tasks = read(join(out, 'tasks.json')), rows = []
  if (manifest.execution || tasks.some(t => t.status !== 'pending')) throw new Error('Experiment already started; do not overwrite or silently retry it')
  const browser = await browserFactory()
  try {
    manifest.execution = { started: new Date().toISOString(), endpoint: new URL(callOptions.baseURL || process.env.MODEL_BASE_URL || 'https://api.meta.ai/v1/').origin }
    manifest.mode = 'live-planner'; save(join(out, 'manifest.json'), manifest)
    for (const [index, task] of tasks.entries()) {
      task.status = 'running'; save(join(out, 'tasks.json'), tasks)
      const c = readCase(out, task.caseId), dir = join(out, 'attempts', task.id); mkdirSync(dir, { recursive: true })
      for (const f of ['photo.png', 'photo.jpg']) copyFileSync(join(out, 'cases', c.id, f), join(dir, f))
      const began = performance.now(); let returned, failure
      console.log(`${index + 1}/${tasks.length}: ${c.id}, ${task.model}, ${task.effort}, sample ${task.round}`)
      try { returned = await planner(dir, { ...c.photo, path: join(dir, 'photo.png') }, { ...callOptions, model: task.model, effort: task.effort, inventory: c.inventory,
        guidance: c.guidance, confirmedMeasurements: c.confirmedMeasurements, perception: false, maxRepairs: manifest.maxRepairs, repairEffort: 'low', retries: 0,
        maxTokens: manifest.maxTokens, background: false, checkPlan: script => productionGeometryCheck(script, c.cut) }) }
      catch (error) { failure = error }
      const selectedFile = join(dir, 'selected-attempt.json'), selected = existsSync(selectedFile) ? read(selectedFile).attempt : null
      const requests = readdirSync(dir).filter(f => /^request-\d+\.json$/.test(f)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
      if (!requests.length) requests.push(null)
      for (const requestFile of requests) {
        const attempt = requestFile ? Number(requestFile.match(/\d+/)[0]) : 0, request = requestFile ? read(join(dir, requestFile)) : null
        const candidateFile = join(dir, `candidate-${attempt}.json`), candidate = existsSync(candidateFile) ? read(candidateFile) : null
        const rawFile = join(dir, `out-${attempt}.json`), raw = fromRaw(rawFile), partial = fromRaw(join(dir, `out-${attempt}.partial.json`))
        const grade = await gradePlan({ ...c, candidate, rawText: raw?.text ?? partial?.text ?? '', rawSchema: request?.schema, isPatch: request?.name === 'InstructionPlanPatch', smoke: browser.smoke })
        if (!raw && !candidate) grade.findings.push(issue('provider', failure?.message || 'No complete model response'))
        const repairFile = join(dir, `repair-${attempt}.json`)
        rows.push({ id: `${task.id}-${attempt}`, trialId: task.id, caseId: c.id, attemptIndex: attempt, first: attempt === 0, selected: selected === attempt,
          model: task.model, actualModel: raw?.model || null, effort: attempt ? 'low' : task.effort, planningEffort: task.effort, sample: task.round,
          status: raw || candidate ? 'graded' : 'provider-failure', grade, candidateFile: candidate ? relative(out, candidateFile) : null, rawFile: raw ? relative(out, rawFile) : null,
          cost: raw?.cost ?? partial?.cost ?? null, usage: raw?.usage ?? partial?.usage ?? null, responseSeconds: raw?.seconds ?? partial?.seconds ?? null,
          elapsedTrialSeconds: (performance.now() - began) / 1000, requestKind: request?.name === 'InstructionPlanPatch' ? 'patch' : attempt ? 'full repair' : 'initial plan',
          repairDecision: existsSync(repairFile) ? read(repairFile) : null, appReturned: !!returned, appReturnedValid: returned?.validation.valid ?? false, sourceMode: 'live-planner' })
      }
      task.status = 'complete'; save(join(out, 'tasks.json'), tasks); save(join(out, 'results.json'), rows); writePlanningReport(out)
      if (rows.some(r => r.grade.grades.execution.status === 'unavailable')) throw new Error('Browser playback unavailable; stopped before paying for more ungradeable trials')
    }
    manifest.execution.finished = new Date().toISOString(); save(join(out, 'manifest.json'), manifest); return writePlanningReport(out)
  } finally { await browser.close() }
}

export async function servePlanningReport(out, { port = 0 } = {}) {
  const token = randomBytes(24).toString('hex')
  const server = createServer(async (req, res) => {
    const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)) }
    try {
      if (![ `127.0.0.1:${server.address().port}`, `localhost:${server.address().port}` ].includes(req.headers.host)) return reply(403, { error: 'Loopback Host required' })
      const path = new URL(req.url, 'http://localhost').pathname
      if (req.method === 'POST') {
        if (path !== '/api/review' || req.headers['x-bench-token'] !== token) return reply(403, { error: 'Invalid review request' })
        let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 12000) return reply(413, { error: 'Review too large' }) }
        const input = JSON.parse(text), rows = read(join(out, 'results.json'))
        if (!rows.some(r => r.id === input.id)) throw new Error('Unknown attempt')
        const reviews = read(join(out, 'reviews.json')); reviews[input.id] = validatePlanReview(input); save(join(out, 'reviews.json'), reviews)
        return reply(200, writePlanningReport(out))
      }
      if (req.method !== 'GET') return reply(405, { error: 'GET or POST only' })
      if (path === '/api/report') return reply(200, { token, ...writePlanningReport(out) })
      const attempt = /^\/api\/attempt\/([a-z0-9-]+)$/.exec(path)
      if (attempt) {
        const row = read(join(out, 'results.json')).find(r => r.id === attempt[1]); if (!row) return reply(404, { error: 'Attempt not found' })
        return reply(200, { row, case: readCase(out, row.caseId), plan: row.grade.normalizedPlan, rawText: row.rawFile ? fromRaw(join(out, row.rawFile))?.text : null })
      }
      const photo = /^\/photo\/([a-z0-9-]+)\.png$/.exec(path)
      let file, type
      if (photo && read(join(out, 'manifest.json')).cases.some(c => c.id === photo[1])) { file = join(out, 'cases', photo[1], 'photo.png'); type = 'image/png' }
      else if (path === '/') { file = join(here, 'planning-review.html'); type = 'text/html' }
      else if (path === '/comparisons-shared.css') { file = join(here, '../public/comparisons-shared.css'); type = 'text/css' }
      else if (/^\/assets\/fonts\/inter-(400|600|700)\.ttf$/.test(path)) { file = join(here, '../assets/fonts', path.split('/').at(-1)); type = 'font/ttf' }
      else if (path === '/planning-review.mjs') { file = join(here, 'planning-review.mjs'); type = 'text/javascript' }
      else return reply(404, { error: 'Not found' })
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'" }); res.end(readFileSync(file))
    } catch (error) { reply(400, { error: error.message }) }
  })
  server.listen(port, '127.0.0.1'); await once(server, 'listening')
  return { server, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }) }
}

export async function plannerBenchmarkCLI(args = process.argv.slice(2)) {
  const { values: v, positionals } = parseArgs({ args, allowPositionals: true, options: {
    id: { type: 'string' }, title: { type: 'string' }, out: { type: 'string' }, suite: { type: 'string' }, only: { type: 'string' }, models: { type: 'string' }, efforts: { type: 'string' }, samples: { type: 'string' }, seed: { type: 'string' },
    repairs: { type: 'string' }, 'max-tokens': { type: 'string' }, films: { type: 'string' }, database: { type: 'string' }, 'files-root': { type: 'string' }, port: { type: 'string' }, live: { type: 'boolean' }, diagnostic: { type: 'boolean' }, help: { type: 'boolean' },
  } })
  if (v.help || !positionals.length) { console.log('Plan reliability benchmark (offline by default)\n  audit --out DIR [--films ID,ID] [--database FILE --files-root DIR]\n  prepare --suite AUDIT_DIR --out DIR [--only wood8,lego-pile,yarn] [--models muse-wonder-1.0,muse-spark-1.3] [--efforts minimal,low,medium,high,xhigh,max] [--samples 1] [--diagnostic (explicit unqualified cases only)]\n  run --out DIR --live (paid; requires authorization)\n  serve --out DIR [--port 8099]\n  report --out DIR\n  publish --out DIR [--id RUN_ID --title TITLE] (curates local fixture results for the app; no deployment)'); return }
  if (!v.out) throw new Error('Supply --out DIR')
  const out = resolve(v.out), [command] = positionals
  if (command === 'audit') {
    await auditSavedPlans(out, { database: v.database ? resolve(v.database) : undefined, filesRoot: v['files-root'] ? resolve(v['files-root']) : undefined, films: v.films?.split(',') })
    const r = writePlanningReport(out); console.log(`Offline audit: ${r.rows.length} saved candidates, ${r.machinePasses} machine passes, ${r.pendingHuman} human reviews pending. ${out}`)
  } else if (command === 'prepare') {
    const { tasks, manifest } = await preparePlanningExperiment(out, { suite: v.suite ? resolve(v.suite) : undefined, only: v.only?.split(','), models: v.models?.split(','), efforts: v.efforts?.split(','), samples: Number(v.samples || 1), seed: v.seed, maxTokens: Number(v['max-tokens'] || 32000), maxRepairs: Number(v.repairs || 0), diagnostic: v.diagnostic })
    console.log(`Prepared ${tasks.length} trials; at most ${tasks.length * manifest.maxPlanningCallsPerTrial} planning requests. No model calls. ${out}`)
  } else if (command === 'run') {
    if (!v.live) throw new Error('Running spends model tokens; supply --live only after authorization')
    await runPlanningExperiment(out); console.log(`Finished. Review with: node benchmarks/planner-bench.mjs serve --out ${out}`)
  } else if (command === 'serve') {
    const service = await servePlanningReport(out, { port: Number(v.port || 8099) }); console.log(`Plan reliability review: ${service.url}`)
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await service.close(); process.exit(0) })
  } else if (command === 'publish') {
    const report = v.id ? publishPlanningComparison(out, { id: v.id, title: v.title }) : publishPlanningReport(out); console.log(`Saved local public snapshot: ${report.rows.length} fixture candidates. Private-film diagnostics were not published. No deployment or model calls.`)
  } else if (command === 'report') {
    const r = writePlanningReport(out); console.log(JSON.stringify({ mode: r.mode, machinePasses: r.machinePasses, strictPasses: r.strictPasses, failureCounts: r.failureCounts, groups: r.groups }, null, 2))
  } else throw new Error('Unknown command; use --help')
}
