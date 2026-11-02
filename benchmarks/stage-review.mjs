const $ = id => document.getElementById(id)
let report, selectedCase, image, labelled = false
const el = (tag, text) => { const node = document.createElement(tag); node.textContent = text; return node }
async function refresh() {
  const caseId = $('case').value, attemptId = $('attempt').value
  report = await fetch(`/api/report${labelled ? '?labels=1' : ''}`).then(r => r.json())
  $('title').textContent = `${report.stage} benchmark`; $('note').textContent = `${report.mode}. ${report.note}`
  $('case').replaceChildren(...report.cases.map(c => { const n = el('option', c.title); n.value = c.id; return n }))
  if (report.cases.some(c => c.id === caseId)) $('case').value = caseId
  await showCase(attemptId)
  $('report').replaceChildren()
  if (labelled) {
    const table = el('table'), head = el('tr')
    for (const s of ['Model','Effort','Trials','Machine passes','Accepted','Pending','Pass@1','95% interval','Median time','Known cost','Unknown costs','Cost/pass']) head.append(el('th',s))
    table.append(head)
    for (const g of report.groups) {
      const row = el('tr')
      for (const s of [g.model,g.effort,g.scheduled,g.machinePasses,g.passes,g.pending,g.passAt1 == null ? '—' : `${(100*g.passAt1).toFixed(0)}%`,g.wilson95?.map(x => `${(100*x).toFixed(1)}%`).join('–') ?? '—',g.medianSeconds == null ? '—' : `${g.medianSeconds.toFixed(2)}s`,`$${g.knownCost.toFixed(5)}`,g.unknownCosts,g.costPerPass == null ? '—' : `$${g.costPerPass.toFixed(5)}`]) row.append(el('td',s))
      table.append(row)
    }
    $('report').append(table)
  }
}
async function showCase(attemptId) {
  selectedCase = await fetch(`/api/case/${$('case').value}`).then(r => r.json())
  const c = report.cases.find(c => c.id === selectedCase.id)
  $('input').textContent = JSON.stringify(selectedCase,null,2)
  $('qualification').textContent = `Case qualification: ${c.qualification.verdict}. Review labels/task against the photo before accepting.`
  $('case-verdict').value = c.qualification.verdict; $('case-reason').value = c.qualification.reason
  $('attempt').replaceChildren(...report.rows.filter(r => r.caseId === selectedCase.id).map((r,i) => {
    const n = el('option', labelled ? `${r.model} · ${r.effort} · sample ${r.sample}` : `Attempt ${i+1} · ${r.outcome}`); n.value = r.id; return n
  }))
  if ([...$('attempt').options].some(o => o.value === attemptId)) $('attempt').value = attemptId
  image = new Image(); image.onload = draw; image.src = `/photo/${selectedCase.id}.png`
  showAttempt()
}
function showAttempt() {
  const r = report.rows.find(r => r.id === $('attempt').value)
  $('meta').textContent = !r ? 'Not run' : labelled ? `${r.model} · ${r.effort} · ${r.elapsedSeconds.toFixed(2)}s · ${r.cost == null ? 'cost unknown' : `$${r.cost.toFixed(5)}`}` : 'Model and effort hidden'
  $('output').textContent = JSON.stringify(r?.grade.output ?? null,null,2)
  $('checks').textContent = r ? JSON.stringify({ machine: r.grade.machine, outcome: r.outcome, errors: r.grade.errors, metrics: r.grade.metrics, limitation: r.grade.limitation },null,2) : 'No result yet'
  $('verdict').value = r?.review.verdict ?? 'pending'; $('reason').value = r?.review.reason ?? ''
  $('save-attempt').disabled = !r
  draw()
}
function draw() {
  if (!image?.complete || !image.naturalWidth) return
  const canvas = $('photo'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
  const ctx = canvas.getContext('2d'); ctx.drawImage(image,0,0)
  const r = report.rows.find(r => r.id === $('attempt').value)
  const objects = $('overlay').value === 'expected' ? selectedCase.expected?.objects : $('overlay').value === 'output' ? r?.grade.output?.objects : []
  ctx.lineWidth = Math.max(2,canvas.width/350); ctx.font = `${Math.max(14,canvas.width/60)}px sans-serif`
  for (const [i,o] of (objects || []).entries()) if (Array.isArray(o.b) && o.b.length === 4 && o.b.every(Number.isFinite)) {
    ctx.strokeStyle = i%2 ? '#b00070' : '#007c50'; ctx.fillStyle = ctx.strokeStyle; ctx.strokeRect(...o.b); ctx.fillText(`${i+1}: ${o.segment ?? o.n ?? o.k}`,o.b[0],Math.max(20,o.b[1]))
  }
}
async function save(kind) {
  const prefix = kind === 'case' ? 'case-' : ''
  try {
    const response = await fetch('/api/review', { method:'POST',headers:{'Content-Type':'application/json','X-Bench-Token':report.token},body:JSON.stringify({ kind,id:kind === 'case' ? selectedCase.id : $('attempt').value,verdict:$(prefix+'verdict').value,reason:$(prefix+'reason').value }) })
    const result = await response.json(); if (!response.ok) throw new Error(result.error)
    await refresh(); $('message').textContent = 'Review saved.'
  } catch(e) { $('message').textContent = e.message }
}
$('case').onchange = () => showCase(); $('attempt').onchange = showAttempt; $('overlay').onchange = draw
$('save-case').onclick = () => save('case'); $('save-attempt').onclick = () => save('attempt')
$('labels').onclick = async () => { labelled = !labelled; $('mode').textContent = labelled ? 'Labels revealed; review is no longer blind.' : 'Labels hidden; previously revealed labels remain known to this reviewer.'; await refresh() }
await refresh()
