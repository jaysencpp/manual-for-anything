import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { auditSavedPlans, preparePlanningExperiment, verifyPlanningExperiment, runPlanningExperiment, servePlanningReport } from '../benchmarks/planning-benchmark.mjs'
import { writePlanningReport, planningSummary, validatePlanReview, publishPlanningReport } from '../benchmarks/planning-report.mjs'
import { read } from '../benchmarks/planning-data.mjs'
import { schemaProblems } from '../benchmarks/planning-grade.mjs'
import { PHYSICAL_PLAN_SCHEMA } from '../src/pipeline/plan-schema.mjs'
import { stubModel, wood8Plan } from './support/stub-model.mjs'
import { openDrawingBrowser, chromePresent } from '../benchmarks/drawing-chrome.mjs'
import { startServer } from './support/server.mjs'

const fakeBrowser = async () => ({ smoke: async () => ({ frames: 12, standInArtwork: true }), close: async () => {} })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function temporary(t) { const dir = mkdtempSync(join(tmpdir(), 'planning-benchmark-test-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir }
function constrained(value, schema) {
  if (schema.anyOf && !schema.properties) schema = schema.anyOf.find(s => s.type === (Array.isArray(value) ? 'array' : typeof value) || s.enum?.includes(value)) || schema.anyOf[0]
  if (Array.isArray(value)) return value.map(v => constrained(v, schema.items || {}))
  if (value && typeof value === 'object' && schema.properties) return Object.fromEntries(Object.entries(value).filter(([k]) => k in schema.properties).map(([k, v]) => [k, constrained(v, schema.properties[k])]))
  return value
}
function validRaw(inventory) {
  const plan = wood8Plan(); plan.objects = structuredClone(inventory); plan.design.standard = 'Explicit test plan; dimensions are estimates.'
  return constrained(plan, PHYSICAL_PLAN_SCHEMA)
}
async function suite(t, folder) {
  const out = join(folder, 'audit'); await auditSavedPlans(out, { database: join(folder, 'absent.sqlite'), browserFactory: fakeBrowser }); writePlanningReport(out); return out
}

test('offline suite qualification excludes known contract mismatches and never claims model success rates', async t => {
  const dir = temporary(t), out = await suite(t, dir), report = read(join(out, 'report.json'))
  assert.equal(report.mode, 'saved-replay'); assert.equal(report.groups.length, 0)
  assert.equal(report.machinePasses, 4); assert.equal(report.strictPasses, 0)
  assert.equal(report.cases.find(c => c.id === 'paper-plane').qualification.eligibleForPilot, false)
  assert.equal(report.cases.find(c => c.id === 'wood8').qualification.eligibleForPilot, true)
  await assert.rejects(() => preparePlanningExperiment(join(dir, 'bad'), { suite: out, only: ['paper-plane'] }), /rejected witnesses/)
  const prepared = await preparePlanningExperiment(join(dir, 'prepared'), { suite: out, only: ['wood8', 'lego-pile', 'yarn'], samples: 1, seed: 'pilot' })
  assert.equal(prepared.tasks.length, 36); assert.equal(prepared.manifest.maxPlanningCallsPerTrial, 1)
  assert.equal(prepared.manifest.execution, null); verifyPlanningExperiment(join(dir, 'prepared'))
  for (const id of ['wood8', 'lego-pile', 'yarn']) for (const model of prepared.manifest.models)
    assert.equal(prepared.tasks.filter(task => task.caseId === id && task.model === model).length, 6)
  const file = join(dir, 'prepared/cases/wood8/case.json'), original = readFileSync(file)
  writeFileSync(file, '{}'); assert.throws(() => verifyPlanningExperiment(join(dir, 'prepared')), /Frozen case changed/); writeFileSync(file, original)
})

test('saved failures import read-only, retain rejected repairs and stay out of public snapshots', async t => {
  const dir = temporary(t), dbFile = join(dir, 'app.sqlite'), filesRoot = join(dir, 'files'); mkdirSync(join(filesRoot, 'objects'), { recursive: true })
  const db = new DatabaseSync(dbFile)
  db.exec("CREATE TABLE settings(key TEXT,value TEXT); INSERT INTO settings VALUES('storage','local'); CREATE TABLE films(id TEXT,status TEXT,state TEXT,events TEXT,created_at TEXT); CREATE TABLE files(film_id TEXT,path TEXT,hash TEXT)")
  const id = 'deadbeef', good = wood8Plan(), bad = structuredClone(good); bad.steps[0].do[0].k = 'imaginary-paper'
  db.prepare('INSERT INTO films VALUES(?,?,?,?,?)').run(id, 'failed', JSON.stringify({ objects: good.objects }), JSON.stringify([{ type: 'failed', message: 'Unknown paper' }]), '2026-10-31')
  const put = (path, bytes) => { const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(JSON.stringify(bytes)), digest = hash(data); writeFileSync(join(filesRoot, 'objects', digest), data); db.prepare('INSERT INTO files VALUES(?,?,?)').run(id, path, digest) }
  for (const name of ['geometry.json', 'screens.json']) put(`screens/${name}`, readFileSync(new URL(`../examples/fixtures/wood8/screens/${name}`, import.meta.url)))
  put('script/photo.png', readFileSync(new URL('../examples/fixtures/wood8/screens/photo.png', import.meta.url)))
  for (let i = 0; i < 2; i++) { put(`script/candidate-${i}.json`, bad); put(`script/out-${i}.json`, { result: JSON.stringify(bad), model: 'test', cost: .01 }) }
  put('script/selected-attempt.json', { attempt: 0 }); put('script/repair-1.json', { accepted: false, reason: 'new errors' }); db.close()
  const before = hash(readFileSync(dbFile)), out = join(dir, 'audit')
  const { rows } = await auditSavedPlans(out, { database: dbFile, filesRoot, films: [id], includeFixtures: false, browserFactory: fakeBrowser })
  writePlanningReport(out)
  assert.equal(hash(readFileSync(dbFile)), before); assert.equal(rows.length, 2)
  assert.equal(rows[0].selected, true); assert.equal(rows[1].repairDecision.accepted, false)
  assert.ok(rows.every(r => r.grade.machine === 'fail' && r.grade.findings.some(f => f.code === 'unknown-reference')))
  const published = publishPlanningReport(out, join(dir, 'published'))
  assert.equal(published.rows.length, 0); assert.equal(published.cases.length, 0)
  await assert.rejects(() => preparePlanningExperiment(join(dir, 'unapproved'), { suite: out, only: ['film-deadbeef'] }), /diagnostics/)
  await assert.rejects(() => preparePlanningExperiment(join(dir, 'implicit'), { suite: out, diagnostic: true }), /explicit --only/)
  const diagnostic = join(dir, 'diagnostic')
  const prepared = await preparePlanningExperiment(diagnostic, { suite: out, only: ['film-deadbeef'], diagnostic: true, efforts: ['low'] })
  assert.equal(prepared.tasks.length, 2); assert.equal(prepared.manifest.cases[0].qualification.eligibleForPilot, false)
  const sample = { ...rows[0], model: prepared.tasks[0].model, planningEffort: 'low', first: true, grade: { ...rows[0].grade, machine: 'pass', humanReview: { verdict: 'pass', reason: 'Cannot qualify a diagnostic by accepting its output.' } } }
  const summary = planningSummary(prepared.manifest, [sample], {}, prepared.tasks)
  assert.equal(summary.groups.length, 0); assert.equal(summary.strictPasses, 0); assert.equal(summary.rows[0].grade.strict, 'pending')
  const qualifiedManifest = read(join(diagnostic, 'manifest.json'))
  qualifiedManifest.cases.push({ id: 'qualified', diagnostic: false })
  const mixed = planningSummary(qualifiedManifest, [sample], {}, [...prepared.tasks, { ...prepared.tasks[0], id: 'qualified-trial', caseId: 'qualified' }])
  assert.equal(mixed.groups[0].scheduled, 1); assert.equal(mixed.groups[0].completed, 0)
  const input = read(join(diagnostic, 'cases/film-deadbeef/case.json'))
  input.source = 'curated-photo'; input.publication = { approved: true }
  writeFileSync(join(diagnostic, 'cases/film-deadbeef/case.json'), JSON.stringify(input))
  assert.equal(publishPlanningReport(diagnostic, join(dir, 'curated')).cases.length, 1)
})

test('frozen-input runner uses the real planner against a local HTTP stub, then saves task review without overriding machine gates', { skip: !chromePresent, timeout: 45000 }, async t => {
  const dir = temporary(t), audited = await suite(t, dir), out = join(dir, 'experiment')
  const inventory = read(join(audited, 'cases/wood8/case.json')).inventory, answer = validRaw(inventory)
  assert.deepEqual(schemaProblems(answer), [])
  const seen = [], stub = await stubModel({ answers: { InstructionPlan: answer }, seen }); t.after(stub.close)
  await preparePlanningExperiment(out, { suite: audited, only: ['wood8'], models: ['muse-wonder-1.0'], efforts: ['minimal', 'medium'], seed: 'integration' })
  const result = await runPlanningExperiment(out, { callOptions: { baseURL: stub.url, apiKey: 'local-stub-not-a-secret' } })
  assert.equal(seen.length, 2); assert.ok(seen.every(s => s.name === 'InstructionPlan'))
  assert.deepEqual(seen.map(s => s.effort).sort(), ['medium', 'minimal'])
  assert.ok(result.rows.every(r => r.grade.machine === 'pass' && r.grade.strict === 'pending'))
  assert.ok(result.groups.every(g => g.machinePassAt1 === 1 && g.strictPassAt1 == null))
  await assert.rejects(() => runPlanningExperiment(out, { browserFactory: fakeBrowser }), /already started/)
  const service = await servePlanningReport(out); t.after(service.close)
  const report = await fetch(service.url + '/api/report').then(r => r.json()), target = result.rows[0]
  assert.equal((await fetch(service.url + '/api/review', { method: 'POST', body: '{}' })).status, 403)
  const saved = await fetch(service.url + '/api/review', { method: 'POST', headers: { 'X-Bench-Token': report.token }, body: JSON.stringify({ id: target.id, verdict: 'pass', reason: 'Matches the declared case requirements.' }) })
  assert.equal(saved.status, 200)
  assert.equal(read(join(out, 'report.json')).groups.find(g => g.effort === target.planningEffort).strictPassAt1, 1)
  const browser = await openDrawingBrowser(service.url, undefined, { renderModule: null }); t.after(browser.close)
  await browser.evaluate(`new Promise(resolve=>{const table=document.getElementById('attempts');if(table.rows.length===3)return resolve(true);const observer=new MutationObserver(()=>{if(table.rows.length===3){observer.disconnect();resolve(true)}});observer.observe(table,{childList:true})})`)
  assert.equal(await browser.evaluate(`document.querySelectorAll('#attempts tr').length`), 3)
  assert.equal(await browser.evaluate(`document.querySelector('.model-card h3').textContent`), 'Muse Wonder 1.0')
  assert.deepEqual(await browser.evaluate(`[...document.querySelectorAll('#attempts th')].slice(0,2).map(n=>n.textContent)`), ['Model', 'Effort'])
  await browser.evaluate(`document.getElementById('effort-filter').value='minimal';document.getElementById('effort-filter').dispatchEvent(new Event('change'));true`)
  assert.equal(await browser.evaluate(`document.querySelectorAll('#attempts tr').length`), 2)
  assert.equal(await browser.evaluate(`document.querySelector('#attempts .effort-label').textContent`), 'Minimal effort')
  await browser.evaluate(`document.getElementById('clear-filters').click();true`)
  await browser.evaluate(`new Promise(resolve=>{const observer=new MutationObserver(()=>{if(!document.getElementById('detail').hidden){observer.disconnect();resolve(true)}});observer.observe(document.getElementById('detail'),{attributes:true});document.querySelector('#attempts button').click()})`)
  assert.ok((await browser.evaluate(`document.getElementById('gates').textContent`)).includes('execution: pass'))
  assert.ok(await browser.evaluate(`document.querySelectorAll('#steps li').length > 0`))
  assert.equal((await fetch(service.url + '/api/attempt/..%2fmanifest.json')).status, 404)
  assert.throws(() => validatePlanReview({ verdict: 'pass', reason: '' }))
})

test('provider failures stay in the denominator and unknown cost is not zero', async t => {
  const dir = temporary(t), audited = await suite(t, dir), out = join(dir, 'experiment')
  await preparePlanningExperiment(out, { suite: audited, only: ['wood8'], models: ['muse-wonder-1.0'], efforts: ['low'] })
  let calls = 0
  const report = await runPlanningExperiment(out, { browserFactory: fakeBrowser, planner: async () => { calls++; throw new Error('Meta response incomplete') } })
  assert.equal(calls, 1); assert.equal(report.groups[0].machinePassAt1, 0); assert.equal(report.groups[0].strictPassAt1, 0)
  assert.equal(report.groups[0].unknownCosts, 1); assert.equal(report.groups[0].costPerStrictPass, null)
  assert.ok(report.rows[0].grade.findings.some(f => f.stage === 'provider'))
})

test('public planning report is read-only, excludes private diagnostics and renders on mobile', { skip: !chromePresent, timeout: 45000 }, async t => {
  const server = await startServer(); t.after(server.stop)
  const response = await fetch(server.base + '/comparisons/plans')
  assert.equal(response.status, 200)
  assert.equal((await fetch(server.base + '/comparisons/plans/api/report', { method: 'POST' })).status, 405)
  const index = await fetch(server.base + '/comparisons/plans/api/runs').then(r => r.json())
  const report = await fetch(server.base + `/comparisons/plans/runs/${index.defaultRun}/api/report`).then(r => r.json())
  assert.ok(['prepared', 'live-planner'].includes(report.mode)); assert.ok(report.cases.length >= 1)
  assert.ok(report.trials.length >= 4)
  assert.doesNotMatch(JSON.stringify(report), /film-cba5|film-9fa3|MODEL_API_KEY|rawFile|candidateFile/)
  assert.ok(report.cases.every(c => c.request && c.inventory.length))
  const browser = await openDrawingBrowser(server.base + '/comparisons/plans', undefined, { renderModule: null }); t.after(browser.close)
  const drawings = await openDrawingBrowser(server.base + '/comparisons', undefined, { renderModule: null }); t.after(drawings.close)
  const layout = `document.fonts.ready.then(()=>{
    const box=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return [r.x,r.y,r.width,r.height]};
    return {header:box('.bar'),brand:box('.brand'),nav:box('.comparison-nav'),title:box('h1').slice(0,3),titleFont:getComputedStyle(document.querySelector('h1')).fontSize,mainWidth:document.querySelector('main').getBoundingClientRect().width};
  })`
  for (const width of [1280, 390]) {
    await browser.viewport(width, 900); await drawings.viewport(width, 900)
    assert.deepEqual(await browser.evaluate(layout), await drawings.evaluate(layout), `Shared page layout at ${width}px`)
    assert.equal(await browser.evaluate(`document.documentElement.scrollWidth <= innerWidth`), true, await browser.evaluate(`JSON.stringify([...document.querySelectorAll('main *')].filter(n=>n.getBoundingClientRect().right>innerWidth).slice(0,12).map(n=>({tag:n.tagName,id:n.id,cls:n.className,right:n.getBoundingClientRect().right})))`))
  }
  await browser.viewport(1280, 900)
  writeFileSync(join(tmpdir(), 'planning-report-desktop.png'), Buffer.from(await browser.screenshot(), 'base64'))
  assert.equal(await browser.evaluate(`document.getElementById('run-select').options.length`), index.runs.length)
  assert.equal(await browser.evaluate(`document.getElementById('run-select').value`), index.defaultRun)
  const effortCount = report.efforts.length
  await browser.evaluate(`new Promise(resolve=>{const cards=document.getElementById('plan-cards');if(cards.children.length===${effortCount})return resolve(true);const observer=new MutationObserver(()=>{if(cards.children.length===${effortCount}){observer.disconnect();resolve(true)}});observer.observe(cards,{childList:true})})`)
  assert.deepEqual(await browser.evaluate(`[...document.querySelectorAll('.plan-card h3')].map(n=>n.textContent)`), report.efforts.map(e => `${e[0].toUpperCase()}${e.slice(1)} effort`))
  assert.equal(await browser.evaluate(`document.querySelectorAll('.plan-card .card-verdict').length`), effortCount)
  const firstSample = Math.min(...report.trials.map(t => t.round).filter(Number.isFinite))
  const firstProjectRows = report.rows.filter(r => r.first && r.caseId === report.cases[0].id && r.model === report.models[0] && (r.sample ?? 1) === firstSample)
  assert.equal(await browser.evaluate(`document.querySelectorAll('.plan-card .card-instructions').length`), firstProjectRows.length)
  if (!firstProjectRows.length) {
    assert.ok(await browser.evaluate(`[...document.querySelectorAll('.card-verdict')].every(n=>n.textContent==='Not run')`))
    assert.match(await browser.evaluate(`document.getElementById('compare-status').textContent`), /No instructions, pass rates, times or costs have been measured/)
  }
  await browser.evaluate(`document.getElementById('compare-model').value='all';document.getElementById('compare-model').dispatchEvent(new Event('change'));true`)
  assert.equal(await browser.evaluate(`document.querySelectorAll('.plan-card').length`), effortCount * report.models.length)
  if (report.cases.length > 1) {
    await browser.evaluate(`document.querySelectorAll('#project-tabs button')[1].click();true`)
    assert.equal(await browser.evaluate(`document.getElementById('compare-title').textContent`), report.cases[1].title)
  }
  await browser.viewport(390, 844)
  assert.equal(await browser.evaluate(`document.documentElement.scrollWidth <= innerWidth`), true, await browser.evaluate(`JSON.stringify([...document.querySelectorAll('main *')].filter(n=>n.getBoundingClientRect().right>innerWidth).slice(0,12).map(n=>({tag:n.tagName,id:n.id,cls:n.className,right:n.getBoundingClientRect().right})))`))
  writeFileSync(join(tmpdir(), 'planning-report-mobile.png'), Buffer.from(await browser.screenshot(), 'base64'))
})

test('comparison pairs the same project and sample, shows readable plans and never counts a correction as a first pass', { skip: !chromePresent, timeout: 45000 }, async t => {
  const dir = temporary(t), audited = await suite(t, dir), out = join(dir, 'comparison')
  const { tasks } = await preparePlanningExperiment(out, { suite: audited, only: ['wood8', 'lego-pile'], samples: 2 })
  const witness = read(join(audited, 'results.json')).find(r => r.caseId === 'wood8')
  const trial = effort => tasks.find(t => t.caseId === 'wood8' && t.model === 'muse-wonder-1.0' && t.round === 1 && t.effort === effort)
  const candidate = (effort, index = 0) => ({ ...structuredClone(witness), id: `${trial(effort).id}-${index}`, trialId: trial(effort).id, sample: 1,
    first: index === 0, attemptIndex: index, model: trial(effort).model, effort: index ? 'low' : effort, planningEffort: effort,
    selected: true, requestKind: index ? 'full repair' : 'initial plan', responseSeconds: 12.3, cost: .01234 })
  const failed = candidate('low'); failed.selected = false; failed.grade.machine = 'fail'
  failed.grade.findings = [{ stage: 'geometry', code: 'design-dimensions', message: 'design: the size is 10 × 10 × 2 cm but the steps build 40 × 0.8 × 0.8 cm' }]
  const repaired = candidate('low', 1); repaired.grade.humanReview = { verdict: 'pass', reason: 'Synthetic accepted correction.' }
  const pending = candidate('medium'); pending.cost = null; pending.responseSeconds = null
  const rejected = candidate('high'); rejected.grade.humanReview = { verdict: 'fail', reason: 'Does not fulfill the requested project.' }
  writeFileSync(join(out, 'results.json'), JSON.stringify([failed, repaired, pending, rejected]))
  const manifest = read(join(out, 'manifest.json')); manifest.mode = 'live-planner'; writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest))
  const service = await servePlanningReport(out); t.after(service.close)
  const browser = await openDrawingBrowser(service.url, undefined, { renderModule: null }); t.after(browser.close)
  await browser.evaluate(`new Promise(resolve=>{const cards=document.getElementById('plan-cards');const ready=()=>document.querySelectorAll('.card-instructions ol').length===3;if(ready())return resolve(true);const observer=new MutationObserver(()=>{if(ready()){observer.disconnect();resolve(true)}});observer.observe(cards,{childList:true,subtree:true})})`)
  const texts = await browser.evaluate(`[...document.querySelectorAll('.plan-card')].map(n=>n.textContent)`)
  assert.match(texts[1], /Fail/); assert.match(texts[1], /stated size does not match/); assert.match(texts[1], /10 × 10 × 2/)
  assert.match(texts[1], /Selected correction: passed/); assert.match(texts[1], /first-attempt result above is unchanged/)
  assert.match(texts[2], /Checks passed · review pending/); assert.match(texts[2], /Time unknown · Cost unknown/)
  assert.match(texts[3], /Fail/); assert.match(texts[3], /Does not fulfill the requested project/)
  assert.equal(await browser.evaluate(`document.querySelectorAll('.plan-card').length`), 6)
  await browser.viewport(1280, 900)
  assert.equal(await browser.evaluate(`document.documentElement.scrollWidth <= innerWidth`), true, await browser.evaluate(`JSON.stringify([...document.querySelectorAll('main *')].filter(n=>n.getBoundingClientRect().right>innerWidth).slice(0,12).map(n=>({tag:n.tagName,id:n.id,cls:n.className,right:n.getBoundingClientRect().right})))`))
  writeFileSync(join(tmpdir(), 'planning-comparison-results-desktop.png'), Buffer.from(await browser.screenshot(), 'base64'))
  await browser.viewport(390, 844)
  assert.equal(await browser.evaluate(`document.documentElement.scrollWidth <= innerWidth`), true, await browser.evaluate(`JSON.stringify([...document.querySelectorAll('main *')].filter(n=>n.getBoundingClientRect().right>innerWidth).slice(0,12).map(n=>({tag:n.tagName,id:n.id,cls:n.className,right:n.getBoundingClientRect().right})))`))
  writeFileSync(join(tmpdir(), 'planning-comparison-results-mobile.png'), Buffer.from(await browser.screenshot(), 'base64'))
  await browser.evaluate(`document.getElementById('compare-sample').value='2';document.getElementById('compare-sample').dispatchEvent(new Event('change'));true`)
  assert.ok(await browser.evaluate(`[...document.querySelectorAll('.card-verdict')].every(n=>n.textContent==='Not run')`))
  await browser.evaluate(`document.querySelectorAll('#project-tabs button')[1].click();true`)
  assert.equal(await browser.evaluate(`document.getElementById('compare-title').textContent`), 'LEGO build')
  assert.equal(await browser.evaluate(`document.querySelectorAll('.card-instructions').length`), 0)
  // Curated export retains trial identity for repairs and sample pairing without exposing executable plan code.
  const exported = publishPlanningReport(out, join(dir, 'published'))
  assert.equal(exported.rows[0].trialId, failed.trialId); assert.equal(exported.rows[0].sample, 1)
  const publicAttempt = read(join(dir, 'published/attempts', `${failed.id}.json`))
  assert.ok(publicAttempt.plan.steps.length); assert.equal(publicAttempt.plan.steps[0].do, undefined)
  assert.deepEqual(publicAttempt.plan.design.size, failed.grade.normalizedPlan.design.size)
  assert.equal(publicAttempt.rawText, null)
})

test('comparison pages keep their width when a scrollbar appears', { skip: !chromePresent, timeout: 45000 }, async t => {
  const server = await startServer(); t.after(server.stop)
  for (const path of ['/comparisons', '/comparisons/plans']) {
    const browser = await openDrawingBrowser(server.base + path, undefined, { renderModule: null })
    try {
      await browser.viewport(1280, 900)
      // Scrollbars that take up space, as on Windows, on every platform: first a page too short to scroll, then a tall one.
      // (a constructed stylesheet: these pages' CSP refuses inline styles)
      const width = (minHeight) => browser.evaluate(`(()=>{const s=new CSSStyleSheet();s.replaceSync('::-webkit-scrollbar{width:15px}html{overflow-y:auto}main>*:not(nav){display:none!important}');document.adoptedStyleSheets=[s];document.body.style.minHeight=${JSON.stringify(minHeight)};
        return new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done({main:document.querySelector('main').getBoundingClientRect().width,scrolls:document.documentElement.scrollHeight>innerHeight}))))})()`)
      const short = await width('0'), tall = await width('5000px')
      assert.equal(short.scrolls, false, `${path} is short`); assert.equal(tall.scrolls, true, `${path} is tall`)
      assert.equal(tall.main, short.main, `${path} keeps its width`)
    } finally { await browser.close() }
  }
})
