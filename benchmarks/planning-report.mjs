import { existsSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { here, read, save, readCase } from './planning-data.mjs'
import { wilson } from './drawing-bench.mjs'

const median = values => { const v = values.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? (v[Math.floor((v.length - 1) / 2)] + v[Math.floor(v.length / 2)]) / 2 : null }
export function validatePlanReview(value) {
  if (!value || !['pass', 'fail', 'pending'].includes(value.verdict) || typeof value.reason !== 'string' || value.reason.length > 4000 || value.verdict !== 'pending' && !value.reason.trim()) throw new Error('Choose pass/fail/pending and give a reason for a completed review')
  return { verdict: value.verdict, reason: value.reason.trim(), updated: new Date().toISOString() }
}
export function planningSummary(manifest, rows, reviews = {}, tasks = []) {
  const diagnosticIds = new Set(manifest.cases.filter(c => c.diagnostic).map(c => c.id))
  const enriched = rows.map(row => {
    const review = reviews[row.id] || row.grade.humanReview, machine = row.grade.machine
    return { ...row, grade: { ...row.grade, normalizedPlan: undefined, humanReview: review,
      strict: machine === 'fail' || review.verdict === 'fail' ? 'fail' : !diagnosticIds.has(row.caseId) && machine === 'pass' && review.verdict === 'pass' ? 'pass' : 'pending' } }
  })
  const groups = []
  if (manifest.mode !== 'saved-replay') for (const model of manifest.models) for (const effort of manifest.efforts) {
    const scheduled = tasks.filter(t => !diagnosticIds.has(t.caseId) && t.model === model && t.effort === effort), first = enriched.filter(r => !diagnosticIds.has(r.caseId) && r.first && r.model === model && r.planningEffort === effort)
    const all = enriched.filter(r => !diagnosticIds.has(r.caseId) && r.model === model && r.planningEffort === effort), n = scheduled.length, completed = first.length
    if (!n) continue
    const pass = first.filter(r => r.grade.strict === 'pass').length, fail = first.filter(r => r.grade.strict === 'fail').length, pending = n - pass - fail
    const perCase = manifest.cases.filter(c => !c.diagnostic).map(c => { const found = first.filter(r => r.caseId === c.id); return { caseId: c.id, completed: found.length, machinePasses: found.filter(r => r.grade.machine === 'pass').length, strictPasses: found.filter(r => r.grade.strict === 'pass').length } })
    groups.push({ model, effort, scheduled: n, completed, strictPasses: pass, strictFailures: fail, pending,
      strictPassAt1: pending || !n ? null : pass / n, strictWilson95: pending || !n ? null : wilson(pass, n),
      machinePassAt1: completed === n && n ? first.filter(r => r.grade.machine === 'pass').length / n : null,
      rawFirstResponsePasses: first.filter(r => r.grade.rawFirstResponseValid === true).length,
      selectedMachinePasses: all.filter(r => r.selected && r.grade.machine === 'pass').length,
      selectedStrictPasses: all.filter(r => r.selected && r.grade.strict === 'pass').length,
      medianInitialSeconds: median(first.map(r => r.responseSeconds)), knownCost: all.reduce((s, r) => s + (r.cost || 0), 0), unknownCosts: all.filter(r => r.cost == null).length,
      requestCount: all.length, costPerStrictPass: !pending && pass && all.every(r => r.cost != null) ? all.reduce((s, r) => s + r.cost, 0) / pass : null,
      silentBadPlans: all.filter(r => r.selected && r.appReturned && r.grade.machine === 'fail').length, perCase })
  }
  const failureCounts = {}
  for (const row of enriched) for (const code of new Set(row.grade.findings.map(f => `${f.stage}/${f.code}`))) failureCounts[code] = (failureCounts[code] || 0) + 1
  return { mode: manifest.mode, created: manifest.created, cases: manifest.cases, groups, failureCounts,
    models: manifest.models || [], efforts: manifest.efforts || [],
    trials: tasks.map(({ id, caseId, model, effort, round, status }) => ({ id, caseId, model, effort, round, status })),
    machinePasses: enriched.filter(r => r.grade.machine === 'pass').length, strictPasses: enriched.filter(r => r.grade.strict === 'pass').length,
    pendingHuman: enriched.filter(r => r.grade.humanReview.verdict === 'pending').length, rows: enriched, note: manifest.note,
    intervalNote: 'Wilson intervals describe trials conditional on these fixed cases, not generalization to new objects. Inspect per-case results. Diagnostic cases are excluded from model rankings. Saved replays are never ranked as a controlled model experiment.' }
}
export function writePlanningReport(out) {
  const report = planningSummary(read(join(out, 'manifest.json')), existsSync(join(out, 'results.json')) ? read(join(out, 'results.json')) : [], read(join(out, 'reviews.json')), existsSync(join(out, 'tasks.json')) ? read(join(out, 'tasks.json')) : [])
  report.cases = report.cases.map(c => ({ ...c, ...comparisonInput(readCase(out, c.id)) }))
  save(join(out, 'report.json'), report)
  const lines = ['# Plan reliability report', '', `Mode: ${report.mode}. ${report.note}`, '',
    `Machine passes: ${report.machinePasses}/${report.rows.length}. Strict passes: ${report.strictPasses}. Human reviews pending: ${report.pendingHuman}.`, '',
    '| Case | Candidate | Model / effort | Machine | Strict | Findings |', '|---|---|---|---|---|---|',
    ...report.rows.map(r => `| ${r.caseId} | ${r.attemptIndex}${r.selected ? ' (selected)' : ''} | ${r.model} / ${r.effort} | ${r.grade.machine} | ${r.grade.strict} | ${[...new Set(r.grade.findings.map(f => f.code))].join(', ')} |`), '', report.intervalNote]
  writeFileSync(join(out, 'report.md'), lines.join('\n') + '\n'); return report
}

// Readable frozen inputs only; geometry, prompts and executable demonstrations stay in the local artifacts.
function comparisonInput(c) {
  return { request: c.guidance?.messages?.join('\n') || c.request,
    inventory: c.inventory.map(({ k, n, cm, w, thick }) => ({ k, n, cm, w, thick })),
    expectations: c.reviewQuestions || [] }
}

export function publishPlanningComparison(out, { id, title, root = join(here, 'published-plans') }) {
  if (!/^[a-z][a-z0-9-]*$/.test(id || '') || !title?.trim()) throw new Error('Provide a safe comparison id and title')
  const manifest = read(join(out, 'manifest.json'))
  if (manifest.mode !== 'live-planner' || !read(join(out, 'results.json')).length) throw new Error('Only recorded live planning comparisons can be added')
  const report = publishPlanningReport(out, join(root, 'runs', id))
  const indexFile = join(root, 'index.json')
  const index = existsSync(indexFile) ? read(indexFile) : { runs: [] }
  const entry = { id, title: title.trim(), created: report.created, cases: report.cases.length, attempts: report.rows.filter(r => r.first).length,
    models: report.models, efforts: report.efforts }
  index.runs = [...index.runs.filter(r => r.id !== id), entry].sort((a, b) => b.created.localeCompare(a.created))
  index.defaultRun = index.runs[0].id
  save(indexFile, index)
  return report
}

export function publishPlanningReport(out, destination = join(here, 'published-plans')) {
  const original = read(join(out, 'manifest.json'))
  // A user can explicitly curate a photo case. Its copied inputs contain no saved film history.
  const cases = original.cases.filter(c => { const input = readCase(out, c.id); return input.source === 'saved-fixture' || input.source === 'curated-photo' && input.publication?.approved === true })
    .map(c => ({ ...c, ...comparisonInput(readCase(out, c.id)) }))
  const ids = new Set(cases.map(c => c.id)), rows = (read(join(out, 'results.json')) || []).filter(r => ids.has(r.caseId))
  const manifest = { ...original, cases, note: `${original.note} Public snapshot contains only curated cases; saved private-film histories remain local.` }
  const tasks = existsSync(join(out, 'tasks.json')) ? read(join(out, 'tasks.json')).filter(t => ids.has(t.caseId)) : []
  const report = planningSummary(manifest, rows, read(join(out, 'reviews.json')), tasks)
  mkdirSync(join(destination, 'attempts'), { recursive: true }); mkdirSync(join(destination, 'photos'), { recursive: true })
  for (const c of cases) copyFileSync(join(out, 'cases', c.id, 'photo.png'), join(destination, 'photos', `${c.id}.png`))
  report.rows = report.rows.map(r => {
    const c = readCase(out, r.caseId), saved = rows.find(row => row.id === r.id)
    const plan = saved.grade.normalizedPlan ? { title: saved.grade.normalizedPlan.title,
      design: saved.grade.normalizedPlan.design ? { purpose: saved.grade.normalizedPlan.design.purpose, size: saved.grade.normalizedPlan.design.size } : undefined,
      steps: saved.grade.normalizedPlan.steps.map(s => ({ t: s.t, c: s.c })) } : null
    const clean = { id: r.id, caseId: r.caseId, attemptIndex: r.attemptIndex, first: r.first, selected: r.selected, model: r.model, effort: r.effort,
      trialId: r.trialId, sample: r.sample, planningEffort: r.planningEffort,
      requestKind: r.requestKind, grade: r.grade, cost: r.cost ?? null, responseSeconds: r.responseSeconds ?? null, repairDecision: null }
    save(join(destination, 'attempts', `${r.id}.json`), { row: clean, case: { id: c.id, title: c.title, request: c.request,
      guidance: { messages: c.guidance?.messages || [] }, qualification: c.qualification, reviewQuestions: c.reviewQuestions }, plan, rawText: null })
    return clean
  })
  save(join(destination, 'report.json'), report); return report
}
