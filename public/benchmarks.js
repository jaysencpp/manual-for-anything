const $ = id => document.getElementById(id)
const node = (tag, text, className) => { const element = document.createElement(tag); if (text != null) element.textContent = text; if (className) element.className = className; return element }
const number = (value, digits = 2) => value == null ? 'Unknown' : value.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits })
const dollars = value => value == null ? 'Unknown' : `$${number(value, 5)}`
const title = value => value[0].toUpperCase() + value.slice(1)
const modelName = model => ({ 'muse-wonder-1.0': 'Muse Wonder 1.0', 'muse-spark-1.3': 'Muse Spark 1.3' })[model] || model
const objectId = item => item.objectId || item.id
let entries = [], activeId, comparing = false
function fact(label, value, secondary = false) {
  const item = node('div'); item.append(node('dt', label), node('dd', value, secondary ? 'secondary' : '')); return item
}
function zoom(src, heading, details) {
  $('zoom-image').src = src; $('zoom-image').alt = heading; $('zoom-title').textContent = heading; $('zoom-details').textContent = details; $('zoom').showModal()
}
$('close-zoom').onclick = () => $('zoom').close()
$('zoom').addEventListener('click', event => { if (event.target === $('zoom')) { const box = $('zoom').getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) $('zoom').close() } })
let loading = 0
async function showCase(id, compare = false) {
  const request = ++loading
  $('status').hidden = false; $('status').textContent = 'Loading results…'
  try {
    const selectedEntry = entries.find(item => item.id === id)
    const variants = entries.filter(item => objectId(item) === objectId(selectedEntry))
    const experiments = await Promise.all((compare ? variants : [selectedEntry]).map(async item => {
      const base = `/comparisons/data/${encodeURIComponent(item.id)}/`, response = await fetch(`${base}case.json`)
      if (!response.ok) throw new Error('Results could not be loaded. Please refresh the page.')
      return { data: await response.json(), base }
    }))
    const { data, base } = experiments.find(item => item.data.id === id)
    if (compare && experiments.some(item => !item.data.comparisonKey || item.data.comparisonKey !== data.comparisonKey)) throw new Error('These model runs have different inputs or output limits and cannot be paired.')
    if (request !== loading) return
    activeId = id; comparing = compare
    $('experiment').hidden = false; $('status').hidden = true
    for (const link of $('cases').children) { if (link.dataset.id === objectId(selectedEntry)) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current') }
    $('model-tools').hidden = false
    $('model-select').replaceChildren(...variants.map(item => { const option = node('option', modelName(item.model)); option.value = item.id; return option }))
    $('model-select').value = id
    $('compare-models').hidden = variants.length < 2
    $('compare-models').setAttribute('aria-pressed', String(compare))
    $('compare-models').textContent = compare ? 'Show selected model only' : 'Compare models side by side'
    $('reference').src = base + data.reference; $('case-title').textContent = data.title
    $('case-description').textContent = `${data.samplesPerEffort} attempt${data.samplesPerEffort === 1 ? '' : 's'} ${compare ? 'per model ' : ''}at each effort level, using the same saved segmentation cut-out.`
    const allRows = experiments.flatMap(experiment => experiment.data.rows.map(row => ({ row, experiment })))
    if (compare) allRows.sort((a, b) => data.groups.findIndex(g => g.effort === a.row.effort) - data.groups.findIndex(g => g.effort === b.row.effort) || a.row.attempt - b.row.attempt || variants.findIndex(v => v.id === a.experiment.data.id) - variants.findIndex(v => v.id === b.experiment.data.id))
    const total = allRows.reduce((sum, { row }) => sum + (row.cost || 0), 0), unknown = allRows.filter(({ row }) => row.cost == null).length
    $('facts').replaceChildren(fact(compare ? 'Models' : 'Model', experiments.map(item => modelName(item.data.model)).join(' + ')), fact('Attempts', String(allRows.length)), fact(unknown ? 'Known estimated cost' : 'Total estimated cost', dollars(total)), fact('Generated', new Date(data.generatedAt).toLocaleDateString('en-GB', { dateStyle: 'medium' })))
    $('input-note').textContent = data.limitations[0] || ''
    $('expectations').replaceChildren(...data.expectations.map(text => node('li', text)))
    $('reference-button').onclick = () => zoom(base + data.reference, `${data.title} · reference`, 'The exact saved segmentation cut-out supplied to every drawing attempt.')
    $('outputs').replaceChildren()
    $('outputs').classList.toggle('compare', compare)
    $('comparison-note').hidden = !compare
    $('results-title').textContent = compare ? 'Same effort. Two models.' : 'Same object, different effort.'
    for (const { row, experiment } of allRows) {
      const card = node('article', null, 'output'), heading = node('div', null, 'output-head')
      heading.append(node('h3', `${title(row.effort)} effort`), node('span', `Attempt ${row.attempt}`, 'attempt')); card.append(heading)
      card.append(node('p', modelName(row.actualModel), 'model-label'))
      const description = `${row.actualModel} · ${title(row.effort)} effort · ${number(row.usableSeconds)}s to usable drawing · ${dollars(row.cost)} estimated`
      if (row.png) {
        const button = node('button', null, 'image-button'), image = node('img')
        image.src = experiment.base + row.png; image.alt = `${data.title} drawn by ${modelName(row.actualModel)} at ${row.effort} effort`; image.loading = 'lazy'
        button.setAttribute('aria-label', `Enlarge ${row.effort} effort drawing`); button.append(image); button.onclick = () => zoom(image.src, `${data.title} · ${title(row.effort)} effort`, description)
        card.append(button)
      } else card.append(node('p', row.failureReason || (row.status === 'api-error' ? 'The API request failed.' : 'The drawing failed technical validation.')))
      const metrics = node('dl', null, 'metrics')
      metrics.append(fact(row.usableSeconds == null ? 'Failed attempt time' : 'Time to usable drawing', row.usableSeconds == null ? row.elapsedSeconds == null ? 'Unavailable' : `${number(row.elapsedSeconds)}s` : `${number(row.usableSeconds)}s`), fact('Estimated cost · USD', dollars(row.cost)),
        fact('Output tokens', row.outputTokens == null ? 'Unknown' : row.outputTokens.toLocaleString('en-US'), true),
        fact('Reasoning tokens¹', row.reasoningTokens == null ? 'Not reported' : row.reasoningTokens.toLocaleString('en-US'), true))
      card.append(metrics)
      if (row.reviewReason) card.append(node('p', row.reviewReason, 'review-note'))
      if (row.png) {
        const links = node('div', null, 'downloads')
        for (const [label, file] of [['Download SVG', row.svg], ['Download PNG', row.png]]) { const link = node('a', label); link.href = experiment.base + file; link.download = `${experiment.data.id}-${file}`; links.append(link) }
        card.append(links)
      }
      $('outputs').append(card)
    }
    $('method').textContent = compare ? `Within each model: ${data.method} Both models receive identical frozen inputs and output limits.` : data.method
    $('conclusion').textContent = data.conclusionLimit
    $('pricing').textContent = `¹ Reasoning tokens are included in output tokens. ${data.pricingNote} Timing includes validation and rendering, excluding browser startup. Cached-input usage may affect costs.`
    $('source').textContent = `Reference: ${data.source}. Output cap: ${data.maxTokens.toLocaleString('en-US')} tokens per request.`
    $('limitations').replaceChildren(...data.limitations.map(text => node('li', text)))
    $('data-download').href = base + 'case.json'; $('data-download').download = `${id}-comparison.json`
    const url = new URL(location.href); url.searchParams.set('case', objectId(selectedEntry)); url.searchParams.set('model', data.model)
    if (compare) url.searchParams.set('compare', '1'); else url.searchParams.delete('compare')
    history.replaceState(null, '', url)
  } catch (error) { if (request === loading) { $('status').hidden = false; $('status').textContent = error.message } }
}
$('model-select').onchange = () => showCase($('model-select').value, comparing)
$('compare-models').onclick = () => showCase(activeId, !comparing)
try {
  const response = await fetch('/comparisons/data/index.json')
  if (!response.ok) throw new Error('No comparison results have been added yet.')
  const index = await response.json()
  if (!index.cases.length) throw new Error('No comparison results have been added yet.')
  entries = index.cases
  const objects = [...new Map(entries.map(item => [objectId(item), item])).values()]
  for (const item of objects) {
    const key = objectId(item)
    const link = node('a', item.title); link.href = `/comparisons?case=${encodeURIComponent(key)}`; link.dataset.id = key
    link.onclick = event => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey && event.button === 0) {
      event.preventDefault()
      const currentModel = entries.find(entry => entry.id === activeId)?.model
      showCase((entries.find(entry => objectId(entry) === key && entry.model === currentModel) || entries.find(entry => objectId(entry) === key)).id)
    } }
    $('cases').append(link)
  }
  const params = new URL(location.href).searchParams, selected = params.get('case'), model = params.get('model')
  const initial = entries.find(item => (objectId(item) === selected || item.id === selected) && (!model || item.model === model)) || entries.find(item => objectId(item) === selected || item.id === selected) || entries[0]
  await showCase(initial.id, params.get('compare') === '1' && entries.filter(item => objectId(item) === objectId(initial)).length > 1)
} catch (error) { $('status').textContent = error.message }
