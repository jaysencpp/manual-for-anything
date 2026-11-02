import { renderDrawing } from './drawing-render.mjs'
const $ = id => document.getElementById(id)
const state = await fetch('/api/blind').then(r => r.json())
const previews = new Map(), urls = [], scoreKeys = ['identity', 'shape', 'colour', 'cleanliness']
let selected = 0, revealed = false, labelsVisible = false, labelledRows = new Map(), effortOrder = []
const message = text => { $('message').textContent = text }
const element = (tag, text) => { const node = document.createElement(tag); if (text != null) node.textContent = text; return node }
const option = (value, label) => { const node = element('option', label); node.value = value; return node }
const title = effort => effort[0].toUpperCase() + effort.slice(1)
const label = row => labelsVisible ? `${title(labelledRows.get(row.id).effort)} effort · attempt ${labelledRows.get(row.id).round}` : row.id
const metrics = row => {
  const value = labelledRows.get(row.id)
  return `${label(row)} · ${value.usableSeconds == null ? 'No usable drawing' : `${value.usableSeconds.toFixed(2)}s`} · ${value.cost == null ? 'Cost unknown' : `$${value.cost.toFixed(5)} estimated`}`
}
async function post(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bench-Token': state.token }, body: JSON.stringify(body) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error)
  return result
}
function download(label, blob, filename) {
  const link = element('a', label), url = URL.createObjectURL(blob)
  urls.push(url); link.href = url; link.download = filename
  return link
}
function svg(drawing) {
  // Server admits only validated path data and hex paints. Escape anyway for exported XML.
  const escape = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c])
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${drawing.width}" height="${drawing.height}" viewBox="0 0 ${drawing.width} ${drawing.height}"><g stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${drawing.parts.flatMap(p => p.shapes.map(s => `<path d="${escape(s.d)}" fill="${escape(s.fill)}" stroke="${escape(s.stroke)}"/>`)).join('')}</g></svg>`
}
for (const row of state.rows) if (row.drawing) {
  try { previews.set(row.id, renderDrawing(row.drawing).png) } catch (error) { message(`Preview failed: ${error.message}`) }
}
$('mode').textContent = state.mode === 'live' ? 'Live model outputs. Review all attempts before drawing conclusions.' : `${state.mode.toUpperCase()} — this is not evidence of model quality.`
for (const text of state.fixture.expectations) $('expectations').append(element('li', text))
$('limitations').textContent = state.fixture.knownInputLimitations.join(' ')
for (const key of scoreKeys) {
  const label = element('label', `${key[0].toUpperCase() + key.slice(1)} `), select = element('select')
  select.id = `score-${key}`; select.append(option('', 'Not scored'))
  for (let n = 1; n <= 5; n++) select.append(option(n, n))
  label.append(select); $('scores').append(label)
}
function updateThumbs() {
  $('thumbs').replaceChildren()
  let judged = 0
  const entries = [...state.rows.entries()]
  if (labelsVisible) entries.sort(([, a], [, b]) => effortOrder.indexOf(labelledRows.get(a.id).effort) - effortOrder.indexOf(labelledRows.get(b.id).effort) || labelledRows.get(a.id).round - labelledRows.get(b.id).round)
  for (const [index, row] of entries) {
    const verdict = row.status === 'ready' ? state.reviews.drawings[row.id]?.verdict || 'pending' : row.status
    if (['pass', 'fail', 'api-error', 'drawing-failure'].includes(verdict)) judged++
    const button = element('button'); button.className = 'thumb'; button.setAttribute('aria-current', String(index === selected))
    if (previews.has(row.id)) { const img = element('img'); img.src = previews.get(row.id); img.alt = `Drawing ${label(row)}`; button.append(img) }
    button.append(element('strong', label(row)))
    if (labelsVisible) {
      const value = labelledRows.get(row.id)
      button.append(element('span', `${value.usableSeconds == null ? 'No usable drawing' : `${value.usableSeconds.toFixed(2)}s`} · ${value.cost == null ? 'Cost unknown' : `$${value.cost.toFixed(5)}`}`), element('span', `ID ${row.id}`))
    }
    button.append(element('span', verdict)); button.onclick = () => { show(index); $('sample').scrollIntoView({ behavior: 'smooth', block: 'center' }) }
    $('thumbs').append(button)
  }
  $('progress').textContent = `${judged} / ${state.rows.length} outcomes resolved`
}
function overlay() {
  $('overlay-reference').hidden = !$('overlay').checked
  $('drawing').style.opacity = $('overlay').checked ? $('opacity').value : '1'
}
function show(index) {
  selected = (index + state.rows.length) % state.rows.length
  const row = state.rows[selected], preview = previews.get(row.id), review = state.reviews.drawings[row.id]
  $('sample').value = row.id
  $('selected-meta').hidden = !labelsVisible
  $('selected-meta').textContent = labelsVisible ? metrics(row) : ''
  $('status').textContent = row.status === 'ready' ? `${row.edgePixels ? 'Boundary pixels detected; check for clipping. ' : ''}Ready for visual review.` : row.status
  for (const id of ['drawing', 'small-drawing']) { $(id).hidden = !preview; if (preview) $(id).src = preview }
  for (const input of $('review-form').elements) input.disabled = row.status !== 'ready'
  $('verdict').value = review?.verdict || 'pending'; $('reason').value = review?.reason || ''
  for (const key of scoreKeys) $(`score-${key}`).value = review?.scores[key] ?? ''
  $('downloads').replaceChildren()
  if (preview) {
    $('downloads').append(download('SVG', new Blob([svg(row.drawing)], { type: 'image/svg+xml' }), `${row.id}.svg`), document.createTextNode(' · '))
    const link = element('a', 'PNG'); link.href = preview; link.download = `${row.id}.png`; $('downloads').append(link)
  }
  overlay(); updateThumbs()
}
for (const row of state.rows) {
  $('sample').append(option(row.id, row.id))
  if (row.status === 'ready') for (const id of ['pair-a', 'pair-b']) $(id).append(option(row.id, row.id))
}
$('sample').onchange = () => show(state.rows.findIndex(r => r.id === $('sample').value))
$('previous').onclick = () => show(selected - 1); $('next').onclick = () => show(selected + 1)
$('overlay').onchange = overlay; $('opacity').oninput = overlay
$('review-form').onsubmit = async event => {
  event.preventDefault()
  const input = { id: state.rows[selected].id, verdict: $('verdict').value, reason: $('reason').value,
    scores: Object.fromEntries(scoreKeys.map(key => [key, $(`score-${key}`).value ? Number($(`score-${key}`).value) : null])) }
  try {
    await post('/api/review', input); state.reviews.drawings[input.id] = input; updateThumbs()
    message(`Saved review for ${input.id}.`)
    if (revealed) await reveal()
  } catch (error) { message(error.message) }
}
function showPair() {
  for (const side of ['a', 'b']) {
    const id = $(`pair-${side}`).value, preview = previews.get(id)
    $(`image-${side}`).hidden = !preview; if (preview) $(`image-${side}`).src = preview
    $(`meta-${side}`).hidden = !labelsVisible || !id
    $(`meta-${side}`).textContent = labelsVisible && id ? metrics(state.rows.find(row => row.id === id)) : ''
  }
  for (const button of $('pair-buttons').children) button.disabled = !$('pair-a').value || $('pair-a').value === $('pair-b').value
  const pair = state.reviews.pairs.find(p => [p.a, p.b].sort().join(':') === [$('pair-a').value, $('pair-b').value].sort().join(':'))
  $('pair-note').textContent = pair ? 'This pair already has a saved comparison; another choice replaces it.' : ''
}
if ($('pair-b').options.length > 1) $('pair-b').selectedIndex = 1
for (const side of ['a', 'b']) $(`pair-${side}`).onchange = showPair
for (const button of $('pair-buttons').children) button.onclick = async () => {
  const input = { a: $('pair-a').value, b: $('pair-b').value, choice: button.dataset.choice }
  try {
    await post('/api/pair', input)
    state.reviews.pairs = state.reviews.pairs.filter(p => [p.a, p.b].sort().join(':') !== [input.a, input.b].sort().join(':'))
    state.reviews.pairs.push(input); showPair(); message('Saved comparison.')
    if (revealed) await reveal()
  } catch (error) { message(error.message) }
}
const format = (v, digits = 2) => v == null ? '—' : v.toFixed(digits)
function plot(report) {
  const root = $('latencies'), width = 900, height = 70 + report.groups.length * 45
  root.replaceChildren(); root.setAttribute('viewBox', `0 0 ${width} ${height}`)
  const max = Math.max(1, ...report.rows.map(r => r.usableSeconds || 0))
  const add = (tag, attrs, text) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag)
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
    if (text != null) node.textContent = text
    root.append(node); return node
  }
  for (let i = 0; i <= 4; i++) {
    const x = 105 + i / 4 * 730
    add('line', { x1: x, x2: x, y1: 25, y2: height - 30, stroke: '#dce1e9' })
    add('text', { x, y: height - 8, 'font-size': 12 }, `${format(max * i / 4, 1)}s`)
  }
  for (const [i, group] of report.groups.entries()) {
    const y = 45 + i * 45
    add('text', { x: 5, y: y + 4, 'font-size': 14 }, group.effort)
    report.rows.filter(r => r.effort === group.effort && r.usableSeconds != null).forEach((row, j) => {
      const dot = add('circle', { cx: 105 + row.usableSeconds / max * 730, cy: y + ((j % 5) - 2) * 3, r: 4, fill: row.outcome === 'pass' ? '#16764c' : row.outcome === 'fail' ? '#bd3c34' : '#526b91' })
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title'); title.textContent = `${row.id}: ${format(row.usableSeconds)}s (${row.outcome})`; dot.append(title)
    })
  }
}
async function reveal() {
  const report = await fetch('/api/reveal').then(r => r.json())
  labelledRows = new Map(report.rows.map(row => [row.id, row])); effortOrder = report.groups.map(group => group.effort)
  labelsVisible = true; updateLabels()
  revealed = true; $('report').hidden = false
  $('report-note').textContent = `${report.mode}. ${report.limitation} ${report.intervalNote}`
  const table = $('report-table'); table.replaceChildren()
  const header = element('tr')
  for (const text of ['Effort', 'Pass@1', '95% interval', 'Pending', 'Median usable time', 'Median cost', 'Known total', 'Unknown costs']) header.append(element('th', text))
  table.append(header)
  for (const group of report.groups) {
    const row = element('tr')
    for (const value of [group.effort, group.passAt1 == null ? `${group.passes}/${group.scheduled} (pending)` : `${group.passes}/${group.scheduled} (${format(group.passAt1 * 100, 0)}%)`,
      group.passAt1Wilson95?.map(v => `${format(v * 100, 1)}%`).join('–') || '—', group.pending, `${format(group.medianUsableSeconds)}s`,
      `$${format(group.medianCost, 5)}`, `$${format(group.knownCostTotal, 5)}`, group.costUnknown]) row.append(element('td', value))
    table.append(row)
  }
  $('details').textContent = JSON.stringify(report, null, 2); plot(report)
  $('reveal').textContent = 'Refresh revealed report'
}
function updateLabels() {
  for (const id of ['sample', 'pair-a', 'pair-b']) for (const option of $(id).options) option.textContent = label(state.rows.find(row => row.id === option.value))
  $('labels-toggle').textContent = labelsVisible ? 'Hide effort labels' : 'Show effort labels and timing'
  $('label-mode').textContent = labelsVisible ? 'Labelled comparison: effort, time and estimated cost are shown on every drawing.' : revealed ? 'Labels hidden. Seeing labels previously ends blind review for this reviewer.' : 'Blind review: effort labels are hidden.'
  const url = new URL(location.href)
  if (labelsVisible) url.searchParams.set('labels', '1'); else url.searchParams.delete('labels')
  history.replaceState(null, '', url)
  $('selected-meta').hidden = !labelsVisible
  $('selected-meta').textContent = labelsVisible ? metrics(state.rows[selected]) : ''
  updateThumbs(); showPair()
  message(labelsVisible ? 'Effort labels, timing and estimated cost are visible.' : 'Effort labels are hidden.')
}
$('labels-toggle').onclick = () => {
  if (labelsVisible) { labelsVisible = false; updateLabels(); $('report').hidden = true }
  else reveal().catch(error => message(error.message))
}
$('reveal').onclick = () => reveal().catch(error => message(error.message))
show(0); showPair(); message('Ready. Effort labels are hidden.')
if (new URL(location.href).searchParams.get('labels') === '1') await reveal()
addEventListener('beforeunload', () => urls.forEach(url => URL.revokeObjectURL(url)))
