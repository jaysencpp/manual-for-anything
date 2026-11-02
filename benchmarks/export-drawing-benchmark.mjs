// Curate completed local experiment artifacts for the read-only /comparisons page. No provider calls or deployment.
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { createHash } from 'node:crypto'
import { writeReport } from './drawing-bench.mjs'

export const publishedBenchmarks = join(dirname(fileURLToPath(import.meta.url)), 'published')
export function exportDrawingBenchmark(out, { id, title, objectId = id, root = publishedBenchmarks } = {}) {
  if (!/^[a-z][a-z0-9-]*$/.test(id) || typeof title !== 'string' || !title.trim()) throw new Error('Supply a safe case id and title')
  if (!/^[a-z][a-z0-9-]*$/.test(objectId)) throw new Error('Supply a safe object id')
  const read = path => JSON.parse(readFileSync(path, 'utf8'))
  const manifest = read(join(out, 'manifest.json'))
  if (manifest.execution?.mode !== 'live' || !manifest.execution.finished || manifest.execution.cancelled) throw new Error('Only completed live experiments can be exported')
  for (const [name, digest] of Object.entries(manifest.inputHashes)) {
    if (createHash('sha256').update(readFileSync(join(out, 'fixture', name))).digest('hex') !== digest) throw new Error('Frozen input was changed')
  }
  const report = writeReport(out)
  if (report.rows.some(row => !['ready', 'api-error', 'drawing-failure'].includes(row.status))) throw new Error('Experiment has unresolved execution attempts')
  const target = join(root, id)
  if (existsSync(join(target, 'case.json')) && read(join(target, 'case.json')).model !== manifest.model) throw new Error('This snapshot belongs to another model; choose a distinct --id and use --object to group it')
  mkdirSync(target, { recursive: true })
  copyFileSync(join(out, 'fixture', `${manifest.fixture.key}.png`), join(target, 'reference.png'))
  const rows = report.rows.map(row => {
    if (!/^[a-z0-9]+$/.test(row.id) || !manifest.efforts.includes(row.effort) || !Number.isInteger(row.round) || row.round < 1) throw new Error('Invalid output identity')
    const name = `${row.effort}-${row.round}`
    if (row.status === 'ready') for (const extension of ['png', 'svg']) copyFileSync(join(out, 'attempts', row.id, `drawing.${extension}`), join(target, `${name}.${extension}`))
    return { id: row.id, effort: row.effort, attempt: row.round, status: row.status, outcome: row.outcome,
      visualVerdict: row.review?.verdict || 'pending', reviewReason: row.review?.reason || null,
      usableSeconds: row.usableSeconds ?? null, responseSeconds: row.responseSeconds ?? null,
      elapsedSeconds: row.elapsedSeconds ?? row.usableSeconds ?? null,
      failureReason: row.status === 'api-error' ? /response incomplete/i.test(row.error || '') ? 'The model response ended without a usable answer.' : /timeout|timed out/i.test(row.error || '') ? 'The API request timed out.' : 'The API request failed.' : row.status === 'drawing-failure' ? 'The output failed technical drawing validation.' : null,
      cost: row.cost ?? null, actualModel: row.actualModel || manifest.model,
      inputTokens: row.usage?.prompt_tokens ?? null, outputTokens: row.usage?.completion_tokens ?? null,
      reasoningTokens: row.usage?.completion_tokens_details?.reasoning_tokens ?? null,
      cachedInputTokens: row.usage?.prompt_tokens_details?.cached_tokens ?? null,
      png: row.status === 'ready' ? `${name}.png` : null, svg: row.status === 'ready' ? `${name}.svg` : null }
  }).sort((a, b) => manifest.efforts.indexOf(a.effort) - manifest.efforts.indexOf(b.effort) || a.attempt - b.attempt)
  const data = { id, objectId, title: title.trim(), model: manifest.model, provider: 'Meta Model API',
    comparisonKey: createHash('sha256').update(JSON.stringify({ inputs: manifest.inputHashes, maxTokens: manifest.maxTokens })).digest('hex'),
    generatedAt: manifest.execution.finished, samplesPerEffort: manifest.samples, maxTokens: manifest.maxTokens,
    width: manifest.fixture.width, height: manifest.fixture.height, reference: 'reference.png',
    source: manifest.fixture.source, expectations: manifest.fixture.expectations, limitations: manifest.fixture.knownInputLimitations,
    pricingNote: manifest.pricing.source, rows, groups: report.groups,
    method: 'Same saved cut-out, production prompt, model and token limit. Only reasoning effort changes. One request at a time, shuffled order, no retries or repairs.',
    conclusionLimit: 'One object and one view. A single attempt per level cannot establish a reliable success rate or equivalence.' }
  writeFileSync(join(target, 'case.json'), JSON.stringify(data, null, 2) + '\n')
  const indexFile = join(root, 'index.json'), index = existsSync(indexFile) ? read(indexFile) : { cases: [] }
  index.cases = index.cases.filter(item => item.id !== id)
  index.cases.push({ id, objectId, title: title.trim(), model: manifest.model, samplesPerEffort: manifest.samples })
  writeFileSync(indexFile, JSON.stringify(index, null, 2) + '\n')
  return data
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { out: { type: 'string' }, id: { type: 'string' }, title: { type: 'string' }, object: { type: 'string' } } })
    if (!values.out) throw new Error('Supply --out EXPERIMENT --id CASE --title TITLE')
    const data = exportDrawingBenchmark(resolve(values.out), { ...values, objectId: values.object || values.id })
    console.log(`Saved local public snapshot: ${data.title}, ${data.rows.length} attempts. No deployment or model calls.`)
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
