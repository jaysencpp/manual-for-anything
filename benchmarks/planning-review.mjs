const $ = id => document.getElementById(id)
const element = (tag, text) => { const n = document.createElement(tag); if (text != null) n.textContent = text; return n }
const isPublic = /^\/(?:comparisons|benchmarks)\/plans(?:\/|$)/.test(location.pathname)
let base = isPublic ? '/comparisons/plans' : ''
let report, selected, requestNumber = 0
const modelName = value => ({ 'muse-wonder-1.0': 'Muse Wonder 1.0', 'muse-spark-1.3': 'Muse Spark 1.3', 'saved-fixture': 'Saved example', 'not-recorded': 'Model not recorded' })[value] || value || 'Model not recorded'
const effortName = value => !value || value === 'not-recorded' ? 'Not recorded' : `${value[0].toUpperCase() + value.slice(1)} effort`
const effortOrder = value => ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'not-recorded'].indexOf(value)
function effortBadge(value) { const badge = element('span', $('blind').checked ? 'Hidden' : effortName(value)); badge.className = `effort-label${value === 'not-recorded' ? ' unknown' : ''}`; return badge }
function identities() { return [...new Set([...(report.models || []), ...report.rows.map(r => r.model), ...report.groups.map(g => g.model)])] }
function renderModels() {
  $('configurations').hidden = $('blind').checked; $('model-controls').hidden = $('blind').checked
  $('comparison-status').textContent = report.mode === 'saved-replay' ? identities().every(m => m === 'saved-fixture')
    ? 'No model/effort comparison has been run yet. These saved examples were rechecked offline; their model and effort were not recorded.'
    : 'Historical saved plans only. The recorded models and effort levels below are not a controlled comparison.'
    : report.mode === 'prepared' ? 'These model/effort combinations are prepared. No new comparison requests have run yet.' : 'Model and effort labels refer to each recorded request. Repairs may use a different effort from their initial plan.'
  $('model-cards').replaceChildren(...identities().map(model => {
    const card = element('div'), rows = report.rows.filter(r => r.model === model), groups = report.groups.filter(g => g.model === model)
    card.className = 'model-card'; card.append(element('h3', modelName(model)))
    card.append(element('code', model === 'saved-fixture' ? 'Model not recorded' : model))
    card.append(element('p', `${rows.length} saved candidate${rows.length === 1 ? '' : 's'}${groups.length ? ` · ${groups.reduce((n,g)=>n+g.completed,0)}/${groups.reduce((n,g)=>n+g.scheduled,0)} initial trials complete` : ''}`))
    const buttons = element('div'); buttons.className = 'effort-buttons'
    const efforts = [...new Set([...rows.map(r => r.effort), ...groups.map(g => g.effort)])].sort((a,b)=>effortOrder(a)-effortOrder(b))
    for (const effort of efforts) {
      const count = rows.filter(r=>r.effort===effort).length, button = element('button', `${effortName(effort)} · ${count}`)
      button.setAttribute('aria-pressed', String($('model-filter').value === model && $('effort-filter').value === effort))
      button.onclick = () => { $('model-filter').value = model; $('effort-filter').value = effort; refresh(); $('attempts').scrollIntoView({ behavior: 'smooth', block: 'start' }) }
      buttons.append(button)
    }
    card.append(buttons); return card
  }))
}
async function get(path) { const response = await fetch(base + path); const value = await response.json(); if (!response.ok) throw new Error(value.error || 'Cannot load report'); return value }
function tableRow(values, header = false) { const row = element('tr'); for (const text of values) row.append(element(header ? 'th' : 'td', text)); return row }

let comparisonCase, comparisonNumber = 0
const planCache = new Map()
const readableFinding = code => ({
  'design-dimensions': 'The stated size does not match what the steps build.',
  'stock-conservation': 'The steps need more material than is available.',
  'unknown-reference': 'The steps refer to an object or tool that was not declared.',
  'inventory-change': 'The plan changes the materials or measurements it was given.',
  'measurement-provenance': 'The plan treats an unsupported measurement as confirmed.',
  'state-contract': 'A material transformation is missing or inconsistent.',
  'joint-geometry': 'The parts do not connect as required.',
  'caption-action-mismatch': 'The written instructions disagree with the planned actions.',
  'unsupported-operation': 'An action cannot be performed by the application.',
  'invalid-json': 'The response could not be read as a complete plan.',
  'provider-timeout': 'The model request timed out.'
})[code]
function appendSteps(parent, plan) {
  if (!plan?.steps?.length) { parent.append(element('p', 'No readable instructions were produced.')); return }
  if (plan.title) parent.append(element('h4', plan.title))
  else if (plan.design?.purpose) parent.append(element('h4', plan.design.purpose))
  if (plan.design?.size) parent.append(element('p', `Planned result: ${plan.design.size.join(' × ')} cm (width × depth × height).`))
  const list = element('ol')
  for (const step of plan.steps) {
    const li = element('li'); li.append(element('strong', step.t || 'Step'))
    const caption = typeof step.c === 'string' ? step.c : step.c?.template || ''
    if (caption) li.append(element('p', caption))
    list.append(li)
  }
  parent.append(list)
}
function comparisonModels() { return report.models?.length ? report.models : [...new Set(report.groups.map(g => g.model))] }
function setupComparison() {
  const previous = $('compare-model').value
  $('compare-model').replaceChildren(...comparisonModels().map(model => { const option = element('option', modelName(model)); option.value = model; return option }))
  if (comparisonModels().includes(previous)) $('compare-model').value = previous
  if (comparisonModels().length > 1) { const option = element('option', 'Both models side by side'); option.value = 'all'; $('compare-model').append(option) }
  if (previous === 'all' && comparisonModels().length > 1) $('compare-model').value = previous
  const rounds = [...new Set([...(report.trials || []).map(t => t.round), ...report.rows.filter(r => r.first).map(r => r.sample)].filter(Number.isFinite))].sort((a,b) => a-b)
  const previousSample = $('compare-sample').value
  $('compare-sample').replaceChildren(...(rounds.length ? rounds : [1]).map(round => { const option = element('option', `Attempt ${round}`); option.value = round; return option }))
  if (rounds.includes(Number(previousSample))) $('compare-sample').value = previousSample
  $('sample-control').hidden = rounds.length < 2
  if (!report.cases.some(c => c.id === comparisonCase)) comparisonCase = report.cases[0]?.id
  renderComparison().catch(error => { $('compare-status').textContent = error.message })
}
async function renderComparison() {
  const number = ++comparisonNumber, c = report.cases.find(c => c.id === comparisonCase)
  if (!c) { $('compare-status').textContent = 'No projects are available in this report.'; return }
  $('project-tabs').replaceChildren(...report.cases.map(project => {
    const button = element('button', project.title); button.setAttribute('aria-current', String(project.id === c.id))
    button.onclick = () => { comparisonCase = project.id; renderComparison().catch(error => { $('compare-status').textContent = error.message }) }; return button
  }))
  $('compare-photo').src = `${base}/photo/${c.id}.png`; $('compare-title').textContent = c.title
  $('compare-request').textContent = c.request || 'See the saved example below for its original instructions.'
  $('compare-inventory').replaceChildren(...(c.inventory || []).map(o => element('li', `${o.n}${Number.isFinite(o.cm) ? ` — ${o.cm} cm${Number.isFinite(o.w) ? ` × ${o.w} cm` : ''}${Number.isFinite(o.thick) ? ` × ${o.thick} cm` : ''}` : ''}`)))
  $('compare-expectations').replaceChildren(...(c.expectations || []).map(q => element('li', q)))
  $('compare-model').disabled = !comparisonModels().length || $('blind').checked
  $('plan-cards').replaceChildren()
  if (report.mode === 'saved-replay') {
    $('compare-status').textContent = 'No effort comparison has been run. The saved examples below only check the comparison machinery; they cannot tell us which effort writes the best plan.'
    const button = element('button', 'See saved examples and their checks'); button.onclick = () => { $('technical').open = true; $('case-filter').value = c.id; refresh(); $('attempts').scrollIntoView({ behavior: 'smooth' }) }
    $('plan-cards').append(button); return
  }
  const models = $('compare-model').value === 'all' ? comparisonModels() : [$('compare-model').value]
  $('plan-cards').classList.toggle('compare', models.length > 1)
  const sample = Number($('compare-sample').value)
  const efforts = report.efforts?.length ? report.efforts : [...new Set(report.groups.map(g => g.effort))].sort((a,b)=>effortOrder(a)-effortOrder(b))
  const trials = (report.trials || []).filter(t => t.caseId === c.id && models.includes(t.model) && t.round === sample)
  const firsts = report.rows.filter(r => r.caseId === c.id && r.first && models.includes(r.model) && (r.sample ?? 1) === sample)
  $('compare-status').textContent = firsts.length ? `${firsts.length}/${trials.length || efforts.length * models.length} initial responses recorded for this project and attempt. Compare the instructions and their checks below.` : 'Not run yet. These are the prepared effort levels. No instructions, pass rates, times or costs have been measured.'
  if (c.diagnostic) $('compare-status').textContent = `Diagnostic case: the task has not been qualified as feasible. Automated passes do not establish task correctness; this case is excluded from model rankings. ${$('compare-status').textContent}`
  const loads = []
  for (const effort of efforts) for (const model of models) {
    const row = firsts.find(r => r.model === model && (r.planningEffort || r.effort) === effort)
    const trial = trials.find(t => t.model === model && t.effort === effort)
    const card = element('article'); card.className = 'plan-card'
    card.append(element('h3', $('blind').checked ? 'Effort hidden' : effortName(effort)))
    card.append(element('p', $('blind').checked ? 'Model hidden' : modelName(model)))
    const badge = element('span'); badge.className = 'gate card-verdict'
    card.append(badge)
    if (!row) {
      badge.textContent = trial?.status === 'running' ? 'In progress' : trial?.status === 'complete' ? 'Result unavailable' : trial ? 'Not run' : 'Not scheduled'
      card.append(element('p', trial?.status === 'running' ? 'The initial response has not been recorded yet.' : 'No initial response to compare.'))
      $('plan-cards').append(card); continue
    }
    const grade = row.grade
    badge.textContent = grade.strict === 'pass' ? 'Pass' : grade.strict === 'fail' ? 'Fail' : grade.machine === 'pass' ? 'Checks passed · review pending' : 'Checks unresolved'
    badge.classList.add(grade.strict === 'pass' ? 'pass' : grade.strict === 'fail' ? 'fail' : 'pending')
    const metrics = element('p', `${row.responseSeconds == null ? 'Time unknown' : `${row.responseSeconds.toFixed(1)}s`} · ${row.cost == null ? 'Cost unknown' : `$${row.cost.toFixed(5)}`}`); metrics.className = 'card-metrics'; card.append(metrics)
    const repeats = report.rows.filter(r => r.first && r.caseId === c.id && r.model === model && (r.planningEffort || r.effort) === effort)
    card.append(element('p', c.diagnostic ? `Automated checks passed: ${repeats.filter(r => r.grade.machine === 'pass').length}/${repeats.length} recorded attempts. Task correctness is unqualified.` : `Correct plans across recorded attempts: ${repeats.filter(r => r.grade.strict === 'pass').length}/${repeats.length}. ${repeats.filter(r => r.grade.strict === 'pending').length} awaiting a verdict.`))
    const failures = grade.findings || []
    if (failures.length) {
      const list = element('ul')
      for (const text of [...new Set(failures.map(f => readableFinding(f.code) || `${f.stage}: ${f.message}`))]) list.append(element('li', text))
      card.append(list)
      const details = element('details'); details.append(element('summary', 'Exact check messages'))
      const messages = element('ul'); for (const f of failures) messages.append(element('li', f.message)); details.append(messages); card.append(details)
    } else card.append(element('p', grade.machine === 'pass' ? 'Automated checks passed: materials, steps, dimensions and sampled playback.' : 'Some checks could not be completed.'))
    if (grade.humanReview?.verdict !== 'pending' && grade.humanReview?.reason) card.append(element('p', `Reviewer: ${grade.humanReview.reason}`))
    const instructions = element('div'); instructions.className = 'card-instructions'; instructions.textContent = 'Loading instructions…'; card.append(instructions)
    const repairs = report.rows.filter(r => !r.first && r.trialId && r.trialId === row.trialId)
    if (repairs.length) {
      const chosen = repairs.find(r => r.selected)
      card.append(element('p', `${repairs.length} correction request${repairs.length === 1 ? '' : 's'} followed. ${chosen ? `Selected correction: ${chosen.grade.strict === 'pass' ? 'passed' : chosen.grade.strict === 'fail' ? 'failed' : 'review pending'}.` : 'No correction replaced the initial plan.'} The first-attempt result above is unchanged.`))
    }
    const button = element('button', 'Inspect plan and checks'); button.onclick = () => inspect(row.id).catch(error => { $('message').textContent = error.message }); card.append(button)
    $('plan-cards').append(card)
    loads.push((async () => {
      try {
        if (!planCache.has(row.id)) planCache.set(row.id, get(`/api/attempt/${encodeURIComponent(row.id)}`))
        const value = await planCache.get(row.id)
        if (number !== comparisonNumber) return
        instructions.replaceChildren(); appendSteps(instructions, value.plan)
      } catch (error) { planCache.delete(row.id); if (number === comparisonNumber) instructions.textContent = `Could not load instructions: ${error.message}` }
    })())
  }
  await Promise.all(loads)
}
$('compare-model').onchange = $('compare-sample').onchange = () => renderComparison().catch(error => { $('compare-status').textContent = error.message })

function refresh() {
  setupComparison()
  $('mode').textContent = `${report.mode}: ${report.note} Machine passes ${report.machinePasses}/${report.rows.length}; strict passes ${report.strictPasses}; human reviews pending ${report.pendingHuman}.`
  renderModels()
  $('cases').replaceChildren(...report.cases.map(c => { const p = element('p'); p.append(element('strong', `${c.title}: `), document.createTextNode(c.diagnostic ? 'Diagnostic only. ' : c.qualification.eligibleForPilot ? 'Machine-qualified for pilot. ' : 'Contract review needed. '), document.createTextNode(c.qualification.reason)); return p }))
  $('ranking').hidden = !report.groups.length || $('blind').checked
  $('interval-note').textContent = report.intervalNote
  $('groups').replaceChildren(tableRow(['Model', 'Effort', 'Trials', 'Machine pass@1', 'Strict pass@1', 'Unresolved', 'Median first response', 'Known estimated cost', 'Unknown costs', 'Selected machine passes after repairs'], true))
  for (const g of report.groups) $('groups').append(tableRow([modelName(g.model), effortName(g.effort), `${g.completed}/${g.scheduled}`, g.machinePassAt1 == null ? 'pending' : `${(g.machinePassAt1 * 100).toFixed(0)}%`, g.strictPassAt1 == null ? 'pending' : `${g.strictPasses}/${g.scheduled}`, g.pending, g.medianInitialSeconds == null ? '—' : `${g.medianInitialSeconds.toFixed(2)}s`, `$${g.knownCost.toFixed(5)}`, g.unknownCosts, g.selectedMachinePasses]))
  $('failure-counts').replaceChildren(...Object.entries(report.failureCounts).map(([code, count]) => element('p', `${code}: ${count} candidate${count === 1 ? '' : 's'}`)))
  if (!Object.keys(report.failureCounts).length) $('failure-counts').append(element('p', 'No failures recorded yet.'))
  $('attempts').replaceChildren(tableRow(['Model', 'Effort', 'Case', 'Kind', 'Machine', 'Strict', 'Findings'], true))
  const rows = [...report.rows].sort((a, b) => $('blind').checked ? a.id.localeCompare(b.id) : a.caseId.localeCompare(b.caseId) || a.attemptIndex - b.attemptIndex)
  for (const row of rows) {
    if ($('case-filter').value !== 'all' && row.caseId !== $('case-filter').value || $('failures-only').checked && row.grade.machine !== 'fail') continue
    if ($('model-filter').value !== 'all' && row.model !== $('model-filter').value || $('effort-filter').value !== 'all' && row.effort !== $('effort-filter').value) continue
    const button = element('button', 'Open plan'), tr = tableRow(['', '', report.cases.find(c => c.id === row.caseId)?.title || row.caseId, `${row.requestKind}${row.selected ? ' · selected' : ''}`, row.grade.machine, row.grade.strict, [...new Set(row.grade.findings.map(f => f.code))].join(', ') || '—'])
    tr.children[0].className = 'model-column'; tr.children[1].className = 'effort-column'
    const name = element('strong', $('blind').checked ? 'Hidden' : modelName(row.model)); name.className = 'model-name'
    const subtitle = element('span', $('blind').checked ? '' : row.model === 'saved-fixture' ? 'Model not recorded' : row.model); subtitle.className = 'model-subtitle'
    tr.children[0].append(name, subtitle); tr.children[1].append(effortBadge(row.effort))
    button.onclick = () => inspect(row.id).catch(error => { $('message').textContent = error.message }); tr.firstChild.append(button); $('attempts').append(tr)
  }
}
async function inspect(id) {
  const number = ++requestNumber, value = await get(`/api/attempt/${encodeURIComponent(id)}`)
  if (number !== requestNumber) return
  selected = id
  const row = report.rows.find(row => row.id === id), c = value.case
  $('technical').open = true; $('detail').hidden = false; $('detail-title').textContent = `${c.title} · ${row.requestKind}`
  const identity = element('strong', $('blind').checked ? 'Model hidden' : modelName(row.model)); identity.className = 'model-name'
  $('detail-identity').replaceChildren(identity, effortBadge(row.effort))
  $('photo').src = `${base}/photo/${c.id}.png`; $('request').textContent = c.guidance?.messages?.join('\n') || c.request
  $('qualification').textContent = c.qualification.reason
  $('gates').replaceChildren(...Object.entries(row.grade.grades).map(([stage, gate]) => { const span = element('span', `${stage === 'task' ? 'case assertions' : stage}: ${gate.status}`); span.className = `gate ${gate.status}`; return span }))
  for (const [label, status] of [['Human task review', row.grade.humanReview.verdict], ['Strict result', row.grade.strict]]) { const span = element('span', `${label}: ${status}`); span.className = `gate ${status}`; $('gates').append(span) }
  $('limits').textContent = row.grade.limitation
  $('findings').replaceChildren(...row.grade.findings.map(f => element('li', `${f.stage} / ${f.code}: ${f.message}`)))
  if (!row.grade.findings.length) $('findings').append(element('li', 'No blocking machine findings. Task correctness still needs review.'))
  $('corrections').textContent = JSON.stringify({ warnings: row.grade.warnings, corrections: row.grade.corrections }, null, 2)
  $('steps').replaceChildren(...(value.plan?.steps || []).map(s => { const li = element('li'); li.append(element('strong', s.t), document.createTextNode(` — ${typeof s.c === 'string' ? s.c : s.c?.template || ''}`)); return li }))
  $('questions').replaceChildren(...c.reviewQuestions.map(q => element('li', q)))
  $('verdict').value = row.grade.humanReview.verdict; $('reason').value = row.grade.humanReview.reason
  $('review').hidden = isPublic; $('readonly').hidden = !isPublic
  $('plan-json').textContent = JSON.stringify(value.plan, null, 2); $('raw-section').hidden = isPublic
  $('raw').textContent = value.rawText || 'Raw response was not recorded for this historical witness.'
  $('repair').textContent = JSON.stringify({ decision: row.repairDecision, gates: row.grade.grades }, null, 2)
  $('detail').scrollIntoView({ behavior: 'smooth', block: 'start' })
}
$('review').onsubmit = async event => {
  event.preventDefault()
  try {
    const response = await fetch('/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bench-Token': report.token }, body: JSON.stringify({ id: selected, verdict: $('verdict').value, reason: $('reason').value }) })
    const value = await response.json(); if (!response.ok) throw new Error(value.error)
    report = { ...value, token: report.token }; refresh(); await inspect(selected); $('message').textContent = 'Review saved. Machine and task verdicts remain separate.'
  } catch (error) { $('message').textContent = error.message }
}
try {
  if (isPublic) {
    const index = await get('/api/runs'), requested = new URLSearchParams(location.search).get('run')
    const run = index.runs.find(r => r.id === (requested || index.defaultRun))
    if (!run) throw new Error('Comparison not found. Choose a saved comparison from the Plans page.')
    base = `/comparisons/plans/runs/${encodeURIComponent(run.id)}`
    $('run-select').replaceChildren(...index.runs.map(r => { const option = element('option', r.title); option.value = r.id; return option }))
    $('run-select').value = run.id
    $('run-select').onchange = () => { const url = new URL(location.href); url.searchParams.set('run', $('run-select').value); location.href = url.href }
    $('run-tools').hidden = false
    $('run-note').textContent = `${run.cases} project${run.cases === 1 ? '' : 's'} · ${run.attempts} first attempts · ${run.efforts.join(', ')} effort. Runs use different prompts and checks; results are kept separate.`
    $('run-note').hidden = false
  }
  report = await get('/api/report')
  for (const model of identities()) { const option = element('option', modelName(model)); option.value = model; $('model-filter').append(option) }
  for (const effort of [...new Set([...report.rows.map(r=>r.effort),...report.groups.map(g=>g.effort)])].sort((a,b)=>effortOrder(a)-effortOrder(b))) { const option = element('option', effortName(effort)); option.value = effort; $('effort-filter').append(option) }
  $('public-header').hidden = !isPublic
  $('public-nav').hidden = !isPublic
  $('public-footer').hidden = !isPublic
  for (const c of report.cases) { const option = element('option', c.title); option.value = c.id; $('case-filter').append(option) }
  for (const id of ['case-filter', 'failures-only', 'blind', 'model-filter', 'effort-filter']) $(id).onchange = () => { if (id === 'blind' && $('blind').checked) { $('model-filter').value='all';$('effort-filter').value='all' } refresh(); if (selected && id === 'blind') inspect(selected) }
  $('clear-filters').onclick = () => { for (const id of ['case-filter','model-filter','effort-filter']) $(id).value='all';$('failures-only').checked=false;refresh() }
  refresh(); $('message').textContent = isPublic ? 'Read-only curated results. No model calls occur on this page.' : 'Offline review ready. Opening plans and saving reviews makes no model calls.'
} catch (error) { $('message').textContent = error.message }
