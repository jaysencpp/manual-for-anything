import { referenceImage } from '../src/pipeline/images.mjs'
import { repoRoot } from './code-hashes.mjs'
// Isolated photo cut-out → vector drawing experiment. No planning, SAM, repairs or fallback art.
import { validateDrawing, drawingSVG } from '../src/pipeline/drawing-format.mjs'
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, renameSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { parseArgs } from 'node:util'
import { configuration, generate } from '../src/pipeline/model.mjs'
import { drawingReference } from '../src/pipeline/artwork.mjs'
import { openDrawingBrowser } from './drawing-chrome.mjs'

const here = dirname(fileURLToPath(import.meta.url))
export const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const read = file => JSON.parse(readFileSync(file, 'utf8'))
const save = (file, value) => { writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2)); renameSync(`${file}.tmp`, file) }
const hash = data => createHash('sha256').update(data).digest('hex')
const tokenPrices = { 'muse-wonder-1.0': [4, 0.2, 20], 'muse-spark-1.3': [1.25, 0.15, 4.25], 'muse-spark-1.2': [1.25, 0.15, 4.25] }

export function schedule(efforts, samples, seed) {
  if (!efforts.length || new Set(efforts).size !== efforts.length || efforts.some(e => !EFFORTS.includes(e))) throw new Error('Choose distinct supported efforts')
  if (!Number.isInteger(samples) || samples < 1 || samples > 100) throw new Error('Samples must be an integer from 1 to 100')
  let order = 0
  return Array.from({ length: samples }, (_, round) => efforts.map(effort => ({ effort, round: round + 1,
    shuffle: hash(`${seed}:order:${round}:${effort}`) })).sort((a, b) => a.shuffle.localeCompare(b.shuffle))
    .map(({ effort, round }) => ({ id: hash(`${seed}:anonymous:${round}:${effort}`).slice(0, 12), effort, round, order: ++order, status: 'pending' }))).flat()
}

export { checkPath, drawingSVG } from '../src/pipeline/drawing-format.mjs'
export function checkDrawing(drawing, fixture) {
  validateDrawing(drawing, { width: fixture.width * 4, height: fixture.height * 4 })
  if (drawing.parts.length !== 1 || drawing.parts[0].id !== fixture.key || drawing.parts[0].parent !== null) throw new Error('Expected exactly one part with frozen identity')
  return drawing
}

export async function prepareExperiment(out, { efforts = EFFORTS, samples = 10, seed = randomBytes(12).toString('hex'), model = configuration().model, maxTokens = 16384, caseFile, promptTemplate = readFileSync(join(here, '../prompts/drawing-prompt.txt'), 'utf8') } = {}) {
  if (existsSync(out)) throw new Error('Output directory already exists; choose a new directory')
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 128000) throw new Error('Invalid token limit')
  const tasks = schedule(efforts, samples, seed)
  const custom = caseFile ? read(resolve(caseFile)) : null
  if (custom && (!/^[a-z][a-z0-9-]*$/.test(custom.key) || typeof custom.name !== 'string' || !custom.name.trim() || !Array.isArray(custom.expectations) || !custom.expectations.length || custom.expectations.some(x => typeof x !== 'string') || !Array.isArray(custom.knownInputLimitations) || custom.knownInputLimitations.some(x => typeof x !== 'string'))) throw new Error('Invalid custom drawing case')
  const source = join(here, '../examples/fixtures/lego-pile'), key = custom?.key || 'brick-orange'
  const inputImage = custom ? resolve(dirname(resolve(caseFile)), custom.image) : join(source, 'screens', `${key}.png`)
  const imageBytes = readFileSync(inputImage)
  if (!imageBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Reference must be a PNG image')
  const objects = read(join(source, 'script.json')).objects
  const size = custom ? { width: imageBytes.readUInt32BE(16), height: imageBytes.readUInt32BE(20) } : read(join(source, 'screens/screens.json'))[key]
  if (!size.width || !size.height || size.width * size.height > 4000000) throw new Error('Reference must contain 1–4,000,000 pixels')
  const geometry = custom ? { origin: [0, 0] } : read(join(source, 'screens/geometry.json'))[key]
  const fixture = custom ? { key, name: custom.name, ...size, source: custom.source || custom.image,
    expectations: custom.expectations, knownInputLimitations: custom.knownInputLimitations } : { key, name: 'orange 2×2 brick', ...size,
    source: 'examples/fixtures/lego-pile/screens/brick-orange.png',
    expectations: ['Orange 2×2 brick, viewed from above at an angle.', 'Four visible top studs arranged in two rows of two.',
      'Top and two side faces keep the reference perspective and proportions.', 'Preserve the target silhouette and position for a photo-to-drawing cross-fade.',
      'Exclude the blue neighbour at the left and the background; do not invent hidden features.',
      'Flat orange shades with clean dark outlines; no textures or gradients.'],
    knownInputLimitations: ['Saved segmentation contains background and a blue neighbour at the left edge. The production prompt tells the model to exclude them.'] }
  const replacements = { name: fixture.name, key, width: size.width, height: size.height, width4: size.width * 4, height4: size.height * 4,
    parts: `one part, id "${key}", parent null, its pivot the middle of its underside.`,
    reference: custom?.reference ? JSON.stringify(custom.reference) : drawingReference(key, custom ? [{ k: key, n: custom.name, b: [0, 0, size.width, size.height] }] : objects, geometry, size) }
  const prompt = promptTemplate.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (!(k in replacements)) throw new Error(`Unfilled prompt field ${k}`)
    return replacements[k]
  })
  mkdirSync(join(out, 'fixture'), { recursive: true })
  copyFileSync(inputImage, join(out, 'fixture', `${key}.png`))
  // Match run.mjs's reference preparation exactly, without model services.
  await referenceImage(join(out, 'fixture', `${key}.png`), join(out, 'fixture', `${key}-x4.png`))
  writeFileSync(join(out, 'fixture/prompt.txt'), prompt)
  save(join(out, 'fixture/expected.json'), fixture)
  const inputs = [`${key}.png`, `${key}-x4.png`, 'prompt.txt', 'expected.json']
  const tracked = ['src/pipeline/model.mjs', 'benchmarks/drawing-bench.mjs', 'benchmarks/drawing-render.mjs', 'benchmarks/drawing-chrome.mjs', 'src/pipeline/drawing-format.mjs']
  const manifest = { version: 1, created: new Date().toISOString(), model, efforts, samples, seed, maxTokens, fixture,
    inputHashes: Object.fromEntries(inputs.map(f => [f, hash(readFileSync(join(out, 'fixture', f)))])),
    codeHashes: Object.fromEntries(tracked.map(f => [f, hash(readFileSync(join(repoRoot, f)))])),
    pricing: { usdPerMillionTokens: tokenPrices[model] || null, order: ['input', 'cachedInput', 'outputIncludingReasoning'],
      source: 'Project pricing estimates checked 2026-10-27; not billing records.' },
    retries: 0, repairs: 0, concurrency: 1, strokeWidth: 3,
    playbackPreviewLongestSide: 160, note: '160px is a fixed comparison size, not a measured film object size.',
    limitation: 'One object and one view. No claim of general drawing quality or effort equivalence.', execution: null }
  save(join(out, 'manifest.json'), manifest)
  save(join(out, 'results.json'), tasks)
  save(join(out, 'reviews.json'), { drawings: {}, pairs: [] })
  return manifest
}

export function verifyFrozen(out) {
  const manifest = read(join(out, 'manifest.json'))
  for (const [file, expected] of Object.entries(manifest.inputHashes)) if (hash(readFileSync(join(out, 'fixture', file))) !== expected) throw new Error(`Frozen input changed: ${file}`)
  for (const [file, expected] of Object.entries(manifest.codeHashes)) if (hash(readFileSync(join(repoRoot, file))) !== expected) throw new Error(`Benchmark code changed: ${file}; prepare a new experiment`)
  return manifest
}

export function validateReview(value) {
  const criteria = ['identity', 'shape', 'colour', 'cleanliness']
  if (!value || !['pass', 'fail', 'pending'].includes(value.verdict)) throw new Error('Choose pass, fail or pending')
  if (typeof value.reason !== 'string' || value.reason.length > 4000) throw new Error('Invalid review reason')
  if (value.verdict === 'fail' && !value.reason.trim()) throw new Error('A failed review needs a reason')
  const scores = {}
  for (const k of criteria) {
    const v = value.scores?.[k]
    if (v != null && (!Number.isInteger(v) || v < 1 || v > 5)) throw new Error('Scores must be 1–5 or blank')
    scores[k] = v ?? null
  }
  return { verdict: value.verdict, reason: value.reason.trim(), scores, updated: new Date().toISOString() }
}

const median = values => {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b), n = v.length
  return n ? (v[Math.floor((n - 1) / 2)] + v[Math.floor(n / 2)]) / 2 : null
}
export function wilson(passes, n) {
  if (!n) return null
  const z = 1.959963984540054, p = passes / n, d = 1 + z * z / n
  const mid = (p + z * z / (2 * n)) / d, half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
  return [Math.max(0, mid - half), Math.min(1, mid + half)]
}

export function summarize(manifest, rows, reviews) {
  const outcomes = new Map(rows.map(row => [row.id, row.status === 'ready' ? reviews.drawings[row.id]?.verdict || 'pending'
    : ['api-error', 'drawing-failure'].includes(row.status) ? 'fail' : 'pending']))
  return { mode: manifest.execution?.mode || 'not run', model: manifest.model, limitation: manifest.limitation,
    intervalNote: '95% Wilson intervals describe repeat-attempt variability for this one fixed object, not variation across objects.',
    groups: manifest.efforts.map(effort => {
      const group = rows.filter(r => r.effort === effort), n = group.length
      const passes = group.filter(r => outcomes.get(r.id) === 'pass').length
      const pending = group.filter(r => outcomes.get(r.id) === 'pending').length
      const called = group.filter(r => !['pending', 'running'].includes(r.status))
      const knownCosts = called.map(r => r.cost).filter(Number.isFinite)
      const ready = group.filter(r => r.status === 'ready')
      const pairCounts = { wins: 0, ties: 0, losses: 0 }
      for (const pair of reviews.pairs || []) {
        const a = rows.find(r => r.id === pair.a), b = rows.find(r => r.id === pair.b)
        if (!a || !b || a.effort === b.effort || ![a.effort, b.effort].includes(effort)) continue
        if (pair.choice === 'tie') pairCounts.ties++
        else if (pair.choice === 'both-fail') pairCounts.bothUnacceptable = (pairCounts.bothUnacceptable || 0) + 1
        else if ((pair.choice === 'a' ? a : b).effort === effort) pairCounts.wins++
        else pairCounts.losses++
      }
      return { effort, scheduled: n, completed: called.length, passes, failures: n - passes - pending, pending,
        passAt1: pending ? null : passes / n, passAt1Wilson95: pending ? null : wilson(passes, n),
        possiblePassRateRange: [passes / n, (passes + pending) / n],
        technicalSuccesses: ready.length, apiFailures: group.filter(r => r.status === 'api-error').length,
        medianResponseSeconds: median(called.map(r => r.responseSeconds)),
        medianUsableSeconds: median(ready.map(r => r.usableSeconds)),
        maxUsableSeconds: ready.length ? Math.max(...ready.map(r => r.usableSeconds)) : null,
        medianCost: median(knownCosts), knownCostTotal: knownCosts.reduce((a, b) => a + b, 0),
        costUnknown: called.length - knownCosts.length, costNotYetObserved: n - called.length,
        estimatedCostPerPass: !pending && passes && knownCosts.length === n ? knownCosts.reduce((a, b) => a + b, 0) / passes : null,
        scores: Object.fromEntries(['identity', 'shape', 'colour', 'cleanliness'].map(k => [k, median(group.map(r => reviews.drawings[r.id]?.scores?.[k]))])),
        pairCounts, failureReasons: group.filter(r => outcomes.get(r.id) === 'fail').map(r => ({ id: r.id, reason: r.error || reviews.drawings[r.id]?.reason })) }
    }),
    preferenceNote: 'Pairwise choices are descriptive. Manually selected pairs can be biased; they do not determine pass@1.',
    rows: rows.map(r => ({ ...r, outcome: outcomes.get(r.id), review: reviews.drawings[r.id] || null })) }
}

export function writeReport(out) {
  const report = summarize(read(join(out, 'manifest.json')), read(join(out, 'results.json')), read(join(out, 'reviews.json')))
  save(join(out, 'report.json'), report)
  const f = (v, digits = 2) => v == null ? '—' : v.toFixed(digits)
  const lines = [`# Object drawing benchmark (${report.mode})`, '', report.limitation, '',
    '| Effort | Pass@1 | 95% interval | Pending | Median usable s | Median estimated $ | Known total $ | Unknown cost calls |',
    '|---|---|---|---|---|---|---|---|', ...report.groups.map(g => `| ${g.effort} | ${g.passAt1 == null ? 'pending' : `${g.passes}/${g.scheduled} (${f(g.passAt1 * 100, 0)}%)`} | ${g.passAt1Wilson95?.map(v => `${f(v * 100, 1)}%`).join('–') || '—'} | ${g.pending} | ${f(g.medianUsableSeconds)} | ${f(g.medianCost, 5)} | ${f(g.knownCostTotal, 5)} | ${g.costUnknown} |`), '', report.intervalNote, '',
    'Latency summaries include only technically usable drawings. API failures and invalid drawings remain failures in pass@1. Costs include invalid outputs when usage is available. See report.json for every attempt, failures, token usage, response times and pairwise choices.', '', report.preferenceNote]
  writeFileSync(join(out, 'report.md'), lines.join('\n') + '\n')
  return report
}

export async function serveExperiment(out, { port = 0 } = {}) {
  const token = randomBytes(24).toString('hex')
  const server = createServer(async (req, res) => {
    const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)) }
    try {
      if (req.headers.host !== `127.0.0.1:${server.address().port}` && req.headers.host !== `localhost:${server.address().port}`) return reply(403, { error: 'Loopback Host required' })
      const path = new URL(req.url, 'http://localhost').pathname
      if (req.method === 'POST') {
        // Loopback only, plus an unguessable token: websites cannot submit review mutations.
        if (req.headers['x-bench-token'] !== token) return reply(403, { error: 'Invalid review token' })
        let body = ''
        for await (const chunk of req) { body += chunk; if (body.length > 16000) return reply(413, { error: 'Review too large' }) }
        const input = JSON.parse(body), rows = read(join(out, 'results.json')), reviews = read(join(out, 'reviews.json'))
        if (path === '/api/review') {
          if (!rows.some(r => r.id === input.id && r.status === 'ready')) throw new Error('Review only a rendered drawing')
          reviews.drawings[input.id] = validateReview(input)
        } else if (path === '/api/pair') {
          if (input.a === input.b || ![input.a, input.b].every(id => rows.some(r => r.id === id && r.status === 'ready')) || !['a', 'b', 'tie', 'both-fail'].includes(input.choice)) throw new Error('Invalid pair')
          const key = [input.a, input.b].sort().join(':')
          reviews.pairs = reviews.pairs.filter(p => [p.a, p.b].sort().join(':') !== key)
          reviews.pairs.push({ a: input.a, b: input.b, choice: input.choice, updated: new Date().toISOString() })
        } else return reply(404, { error: 'Unknown endpoint' })
        save(join(out, 'reviews.json'), reviews); writeReport(out)
        return reply(200, { saved: true })
      }
      if (req.method !== 'GET') return reply(405, { error: 'GET or POST only' })
      if (path === '/api/blind') {
        const manifest = read(join(out, 'manifest.json')), rows = read(join(out, 'results.json'))
        return reply(200, { token, fixture: manifest.fixture, mode: manifest.execution?.mode || 'not run',
          previewSize: manifest.playbackPreviewLongestSide,
          rows: rows.map(r => ({ id: r.id, status: r.status, drawing: r.drawing || null, edgePixels: r.render?.edgePixels ?? null }))
            .sort((a, b) => a.id.localeCompare(b.id)), reviews: read(join(out, 'reviews.json')) })
      }
      if (path === '/api/reveal') return reply(200, writeReport(out))
      let file, type
      if (path === '/' || path === '/render') { file = join(here, 'drawing-review.html'); type = 'text/html' }
      else if (['/assets/drawing-review.mjs', '/assets/drawing-render.mjs'].includes(path)) { file = join(here, '.', path.split('/').at(-1)); type = 'text/javascript' }
      else if (path === '/reference.png') { file = join(out, 'fixture', `${read(join(out, 'manifest.json')).fixture.key}.png`); type = 'image/png' }
      else return reply(404, { error: 'Not found' })
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" })
      res.end(readFileSync(file))
    } catch (error) { reply(400, { error: error.message }) }
  })
  server.listen(port, '127.0.0.1'); await once(server, 'listening')
  return { server, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }) }
}

export async function runExperiment(out, { mock = false, generateCall = generate, browserFactory = openDrawingBrowser, callOptions = {} } = {}) {
  const manifest = verifyFrozen(out), rows = read(join(out, 'results.json'))
  if (manifest.execution || rows.some(r => r.status !== 'pending')) throw new Error('Experiment already started; prepare a fresh directory for another run')
  const service = await serveExperiment(out)
  let browser
  try {
    // Verify the renderer is available before making any paid call.
    browser = await browserFactory(`${service.url}/render`)
    manifest.execution = { mode: mock ? 'mock — NOT model quality evidence' : 'live', started: new Date().toISOString(),
      endpoint: mock ? null : new URL(callOptions.baseURL || process.env.MODEL_BASE_URL || 'https://api.meta.ai/v1/').origin }
    save(join(out, 'manifest.json'), manifest)
    const prompt = readFileSync(join(out, 'fixture/prompt.txt'), 'utf8'), key = manifest.fixture.key
    for (const row of rows) {
      const dir = join(out, 'attempts', row.id)
      mkdirSync(dir, { recursive: true })
      for (const file of [`${key}.png`, `${key}-x4.png`]) copyFileSync(join(out, 'fixture', file), join(dir, file))
      row.status = 'running'; row.started = new Date().toISOString(); save(join(out, 'results.json'), rows)
      console.log(`${row.order}/${rows.length}: ${row.effort}, round ${row.round}`)
      const started = performance.now()
      let response
      try {
        if (mock) {
          response = { text: JSON.stringify(mockDrawing(manifest.fixture)), model: manifest.model, usage: null, cost: null, seconds: 0, firstTokenSeconds: null, mock: true }
          save(join(dir, 'out.json'), response)
        } else response = await generateCall(dir, prompt, { ...callOptions, model: manifest.model, effort: row.effort,
          images: [`${key}.png`, `${key}-x4.png`], maxTokens: manifest.maxTokens, retries: 0, timeoutMs: 180000 })
        row.responseSeconds = (performance.now() - started) / 1000
        Object.assign(row, { actualModel: response.model, usage: response.usage, cost: response.cost ?? null,
          firstTokenSeconds: response.firstTokenSeconds, apiSeconds: response.seconds, costEstimated: response.costEstimated ?? false })
        row.drawing = checkDrawing(JSON.parse(response.text), manifest.fixture)
        save(join(dir, 'drawing.json'), row.drawing)
        writeFileSync(join(dir, 'drawing.svg'), drawingSVG(row.drawing))
        const rendered = await browser.render(row.drawing)
        row.usableSeconds = (performance.now() - started) / 1000
        writeFileSync(join(dir, 'drawing.png'), Buffer.from(rendered.png.split(',')[1], 'base64'))
        const { png, ...render } = rendered
        row.render = render; row.status = 'ready'
      } catch (error) {
        row.status = error.code === 'BENCH_BROWSER' ? 'infrastructure-error' : response ? 'drawing-failure' : 'api-error'; row.error = error.message
        delete row.drawing
        row.elapsedSeconds = (performance.now() - started) / 1000
        if (!response && existsSync(join(dir, 'out.partial.json'))) {
          const partial = read(join(dir, 'out.partial.json'))
          row.usage = partial.usage; row.cost = partial.cost ?? null; row.firstTokenSeconds = partial.firstTokenSeconds
        }
      }
      row.finished = new Date().toISOString()
      save(join(out, 'results.json'), rows); writeReport(out)
      if (row.status === 'infrastructure-error') throw new Error('Browser infrastructure failed. Stopped sweep; affected and unstarted attempts remain unresolved. Prepare a new experiment after fixing the browser.')
    }
    manifest.execution.finished = new Date().toISOString(); save(join(out, 'manifest.json'), manifest)
    return writeReport(out)
  } finally { await browser?.close(); await service.close() }
}

export function mockDrawing(fixture) {
  const w = fixture.width * 4, h = fixture.height * 4
  return { width: w, height: h, parts: [{ id: fixture.key, parent: null, pivot: [w / 2, h], shapes: [
    { d: `M${w * .1} ${h * .2} L${w * .9} ${h * .2} L${w * .9} ${h * .85} L${w * .1} ${h * .85} Z`, fill: '#f2a126', stroke: '#1d2b4f' },
  ] }] }
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    out: { type: 'string' }, efforts: { type: 'string' }, samples: { type: 'string' }, seed: { type: 'string' }, model: { type: 'string' }, case: { type: 'string' },
    'max-tokens': { type: 'string' }, port: { type: 'string' }, mock: { type: 'boolean' }, live: { type: 'boolean' }, help: { type: 'boolean' },
  } })
  if (values.help || !positionals.length) {
    console.log('Drawing benchmark (no paid calls by default)\n  prepare --out DIR [--samples 10] [--efforts minimal,low,medium,high,xhigh,max]\n  run --out DIR --mock|--live\n  serve --out DIR [--port 8096]\n  report --out DIR\n--live makes paid calls; obtain authorization before using it. --mock tests plumbing only.'); return
  }
  if (!values.out) throw new Error('Supply --out DIR')
  const out = resolve(values.out), [command] = positionals
  if (command === 'prepare') {
    const manifest = await prepareExperiment(out, { efforts: values.efforts?.split(','), samples: Number(values.samples || 10), seed: values.seed,
      model: values.model, maxTokens: Number(values['max-tokens'] || 16384), caseFile: values.case })
    console.log(`Prepared ${manifest.samples * manifest.efforts.length} requests, no model calls: ${out}`)
  } else if (command === 'run') {
    if (!!values.mock === !!values.live) throw new Error('Choose exactly one of --mock or --live; --live spends API tokens')
    await runExperiment(out, { mock: !!values.mock })
    console.log(`Saved results. Review with: node benchmarks/drawing-bench.mjs serve --out ${out}`)
  } else if (command === 'report') {
    const report = writeReport(out)
    console.table(report.groups.map(({ effort, passes, scheduled, pending, passAt1, medianUsableSeconds, knownCostTotal }) => ({ effort, passes, scheduled, pending, passAt1, medianUsableSeconds, knownCostTotal })))
    console.log(`Saved report.json and report.md (${report.mode})`)
  } else if (command === 'serve') {
    const service = await serveExperiment(out, { port: Number(values.port || 8096) })
    console.log(`Blind review: ${service.url} (Ctrl+C to stop)`)
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await service.close(); process.exit(0) })
  } else throw new Error('Unknown command; use --help')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1 })
