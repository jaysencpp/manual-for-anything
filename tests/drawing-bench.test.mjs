import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawnSync } from 'node:child_process'
import { EFFORTS, schedule, checkDrawing, checkPath, drawingSVG, prepareExperiment, verifyFrozen,
  validateReview, summarize, wilson, serveExperiment, runExperiment, mockDrawing } from '../benchmarks/drawing-bench.mjs'
import { openDrawingBrowser } from '../benchmarks/drawing-chrome.mjs'

const read = file => JSON.parse(readFileSync(file, 'utf8'))
function directory(t) {
  const root = mkdtempSync(join(tmpdir(), 'drawing-bench-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return join(root, 'experiment')
}
test('effort schedule is balanced by round, reproducible, anonymous and shuffled', () => {
  const rows = schedule(EFFORTS, 10, 'fixed')
  assert.equal(rows.length, 60); assert.equal(new Set(rows.map(r => r.id)).size, 60)
  assert.deepEqual(rows, schedule(EFFORTS, 10, 'fixed'))
  assert.notDeepEqual(rows, schedule(EFFORTS, 10, 'other'))
  for (let round = 1; round <= 10; round++) assert.deepEqual(rows.filter(r => r.round === round).map(r => r.effort).sort(), [...EFFORTS].sort())
  assert.ok(new Set(Array.from({ length: 10 }, (_, i) => rows.filter(r => r.round === i + 1).map(r => r.effort).join(','))).size > 1)
  assert.throws(() => schedule(['low', 'low'], 1, 's'))
  assert.throws(() => schedule(['low'], 0, 's'))
})
test('strict paths reject silent truncation, nonfinite coordinates and XML/code injection', () => {
  for (const path of ['M0 0 L1 2 3 4 Z', 'm.5 -.2c1 2 3 4 5 6z', 'M1e2 2 A3 4 20 0 1 8 9']) assert.doesNotThrow(() => checkPath(path))
  for (const path of ['', 'L1 2', 'M1', 'M0 0 L1', 'M0 0 Z1', 'M0 0 R1 2', 'M0 0 L1e999 0', 'M0 0 A2 2 0 2 0 3 3', 'M0 0"/><script>alert(1)</script>']) assert.throws(() => checkPath(path), path)
  const fixture = { key: 'brick', width: 50, height: 40 }, drawing = mockDrawing(fixture)
  assert.equal(checkDrawing(drawing, fixture), drawing)
  assert.match(drawingSVG(drawing), /<svg/)
  assert.throws(() => checkDrawing({ ...drawing, width: 5 }, fixture))
  drawing.parts[0].shapes[0].fill = 'url(https://example.com)'
  assert.throws(() => checkDrawing(drawing, fixture))
})
test('frozen production prompt and image hashes detect changed inputs', async t => {
  const out = directory(t), manifest = await prepareExperiment(out, { samples: 1, efforts: ['minimal', 'medium'], seed: 'fixture' })
  assert.equal(manifest.fixture.width, 258); assert.equal(manifest.fixture.height, 255)
  const prompt = readFileSync(join(out, 'fixture/prompt.txt'), 'utf8')
  assert.doesNotMatch(prompt, /\{\{/); assert.match(prompt, /1032×1020/); assert.match(prompt, /orange 2×2 brick/)
  assert.equal(verifyFrozen(out).model, manifest.model)
  assert.equal(read(join(out, 'results.json')).length, 2)
  await assert.rejects(() => prepareExperiment(out))
  writeFileSync(join(out, 'fixture/prompt.txt'), prompt + 'changed')
  assert.throws(() => verifyFrozen(out), /Frozen input changed/)
})
test('pass@1 stays pending until every outcome is resolved; failures and unknown costs remain visible', () => {
  const manifest = { model: 'test', efforts: ['low'], limitation: 'one object', execution: { mode: 'mock' } }
  const rows = [
    { id: 'a', effort: 'low', status: 'ready', cost: 0.02, usableSeconds: 2, responseSeconds: 1.9 },
    { id: 'b', effort: 'low', status: 'ready', cost: 0.03, usableSeconds: 3, responseSeconds: 2.9 },
    { id: 'c', effort: 'low', status: 'api-error', cost: null, error: 'timeout' },
    { id: 'd', effort: 'low', status: 'drawing-failure', cost: 0.01, error: 'path' },
  ]
  const reviews = { drawings: { a: { verdict: 'pass' } }, pairs: [] }
  let group = summarize(manifest, rows, reviews).groups[0]
  assert.equal(group.passAt1, null); assert.equal(group.pending, 1)
  assert.deepEqual(group.possiblePassRateRange, [.25, .5]); assert.equal(group.costUnknown, 1)
  assert.ok(Math.abs(group.knownCostTotal - .06) < 1e-12); assert.equal(group.medianUsableSeconds, 2.5)
  reviews.drawings.b = { verdict: 'fail', reason: 'Missing studs' }
  group = summarize(manifest, rows, reviews).groups[0]
  assert.equal(group.passAt1, .25); assert.equal(group.failures, 3); assert.equal(group.estimatedCostPerPass, null)
  assert.equal(group.failureReasons.length, 3)
  const interval = wilson(10, 10)
  assert.ok(interval[0] < .75); assert.ok(interval[1] > .999)
  assert.throws(() => validateReview({ verdict: 'fail', reason: '' }))
  assert.throws(() => validateReview({ verdict: 'pass', reason: '', scores: { identity: 6 } }))
})

const chromePresent = spawnSync(process.env.CHROME_BIN || 'google-chrome', ['--version']).status === 0
test('local HTTP stub → model client → real browser → blind review → report; no paid calls', { skip: !chromePresent, timeout: 45000 }, async t => {
  const out = directory(t)
  const manifest = await prepareExperiment(out, { samples: 1, efforts: ['minimal', 'low', 'medium', 'high', 'max'], seed: 'integration' })
  const requested = []
  const stub = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw); requested.push(body)
    if (body.reasoning_effort === 'high') { res.writeHead(503); res.end('{"error":{"message":"test unavailable"}}'); return }
    const drawing = mockDrawing(manifest.fixture)
    if (body.reasoning_effort === 'medium') drawing.parts[0].shapes[0].d = 'M0 0 L'
    if (body.reasoning_effort === 'low') drawing.parts[0].shapes[0] = { d: 'M0 0 L20 20', fill: 'none', stroke: 'none' }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ model: manifest.model, choices: [{ delta: { content: JSON.stringify(drawing) }, finish_reason: 'stop' }] })}\n\n`)
    res.end(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 200, completion_tokens_details: { reasoning_tokens: 50 } } })}\n\ndata: [DONE]\n\n`)
  })
  stub.listen(0, '127.0.0.1'); await once(stub, 'listening')
  t.after(() => { stub.closeAllConnections(); stub.close() })
  const report = await runExperiment(out, { callOptions: { baseURL: `http://127.0.0.1:${stub.address().port}/v1`, apiKey: 'local-test-only' } })
  assert.equal(requested.length, 5, '503 must not retry')
  assert.equal(report.groups.find(g => g.effort === 'minimal').pending, 1)
  const rows = read(join(out, 'results.json')), good = rows.find(r => r.effort === 'minimal')
  assert.equal(good.effort, 'minimal'); assert.equal(good.usage.completion_tokens, 200)
  assert.equal(rows.find(r => r.effort === 'medium').status, 'drawing-failure')
  assert.match(rows.find(r => r.effort === 'low').error, /no visible pixels|no drawable visible shapes/)
  assert.equal(rows.find(r => r.effort === 'high').status, 'api-error')
  assert.ok(existsSync(join(out, 'attempts', good.id, 'drawing.svg')))
  assert.deepEqual([...readFileSync(join(out, 'attempts', good.id, 'drawing.png')).subarray(0, 4)], [137, 80, 78, 71])
  assert.ok(good.usableSeconds >= good.responseSeconds)
  await assert.rejects(() => runExperiment(out, { mock: true }), /already started/)
  const service = await serveExperiment(out)
  t.after(() => service.close())
  const blind = await fetch(`${service.url}/api/blind`).then(r => r.json())
  assert.equal(blind.rows[0].effort, undefined); assert.equal(blind.rows[0].cost, undefined)
  assert.equal((await fetch(`${service.url}/../manifest.json`)).status, 404)
  const review = { id: good.id, verdict: 'pass', reason: '', scores: { identity: 4 } }
  assert.equal((await fetch(`${service.url}/api/review`, { method: 'POST', body: JSON.stringify(review) })).status, 403)
  const saved = await fetch(`${service.url}/api/review`, { method: 'POST', headers: { 'X-Bench-Token': blind.token }, body: JSON.stringify(review) })
  assert.equal(saved.status, 200)
  assert.equal(read(join(out, 'report.json')).groups.find(g => g.effort === 'minimal').passAt1, 1)
  const browser = await openDrawingBrowser(service.url)
  t.after(() => browser.close())
  const initial = await browser.evaluate(`({thumbs:document.querySelectorAll('.thumb').length, reportHidden:document.getElementById('report').hidden, text:document.getElementById('message').textContent})`)
  assert.equal(initial.thumbs, 5); assert.equal(initial.reportHidden, true); assert.match(initial.text, /Ready/)
  await browser.evaluate(`document.getElementById('sample').value=${JSON.stringify(good.id)}; document.getElementById('sample').dispatchEvent(new Event('change')); document.getElementById('sample').closest('section').scrollIntoView(); true`)
  writeFileSync(join(tmpdir(), 'drawing-bench-review-check.png'), Buffer.from(await browser.screenshot(), 'base64'))
  // Exercise actual gallery form submission and blind pair persistence, not just HTTP endpoints.
  await browser.evaluate(`new Promise(resolve => {
    const sample=document.getElementById('sample'); sample.value=${JSON.stringify(good.id)}; sample.dispatchEvent(new Event('change'));
    document.getElementById('verdict').value='fail'; document.getElementById('reason').value='Missing all four studs';
    const observer=new MutationObserver(()=>{if(document.getElementById('message').textContent.startsWith('Saved review')){observer.disconnect();resolve(true)}});
    observer.observe(document.getElementById('message'),{childList:true});
    document.getElementById('review-form').requestSubmit();
  })`)
  assert.equal(read(join(out, 'report.json')).groups.find(g => g.effort === 'minimal').passAt1, 0)
  await browser.evaluate(`new Promise(resolve => {
    const observer=new MutationObserver(()=>{if(document.getElementById('message').textContent==='Saved comparison.'){observer.disconnect();resolve(true)}});
    observer.observe(document.getElementById('message'),{childList:true});
    document.querySelector('[data-choice="tie"]').click();
  })`)
  assert.equal(read(join(out, 'reviews.json')).pairs.length, 1)
  await browser.evaluate(`document.getElementById('reveal').click(); true`)
  // Wait for the observable report mutation, not a fixed-duration sleep.
  await browser.evaluate(`new Promise(resolve => {
    const node=document.getElementById('report');
    if(!node.hidden) return resolve(true);
    const observer=new MutationObserver(()=>{if(!node.hidden){observer.disconnect();resolve(true)}});
    observer.observe(node,{attributes:true});
  })`)
  assert.equal(await browser.evaluate(`document.querySelectorAll('#report-table tr').length`), 6)
  const labels = await browser.evaluate(`({cards:[...document.querySelectorAll('.thumb strong')].map(n=>n.textContent), selected:document.getElementById('selected-meta').textContent, pair:document.getElementById('meta-a').textContent, url:location.search})`)
  assert.deepEqual(labels.cards, ['Minimal effort · attempt 1', 'Low effort · attempt 1', 'Medium effort · attempt 1', 'High effort · attempt 1', 'Max effort · attempt 1'])
  assert.match(labels.selected, /Minimal effort.*\$[\d.]+ estimated/)
  assert.match(labels.pair, /effort.*\$[\d.]+ estimated/)
  assert.equal(labels.url, '?labels=1')
  await browser.evaluate(`document.getElementById('reason').value='Unsaved note'; document.getElementById('labels-toggle').click(); true`)
  assert.equal(await browser.evaluate(`document.getElementById('reason').value`), 'Unsaved note')
  assert.equal(await browser.evaluate(`document.getElementById('selected-meta').hidden`), true)
  assert.match(readFileSync(join(out, 'report.md'), 'utf8'), /0\/1/)
})

test('browser infrastructure failure stops the sweep and stays unresolved instead of becoming a model failure', async t => {
  const out = directory(t), manifest = await prepareExperiment(out, { samples: 1, efforts: ['low', 'medium'] })
  let calls = 0
  await assert.rejects(() => runExperiment(out, {
    generateCall: async () => { calls++; return { text: JSON.stringify(mockDrawing(manifest.fixture)), cost: .01, model: manifest.model } },
    browserFactory: async () => ({ render: async () => { throw Object.assign(new Error('test browser crash'), { code: 'BENCH_BROWSER' }) }, close: async () => {} }),
  }), /infrastructure failed/)
  assert.equal(calls, 1)
  const rows = read(join(out, 'results.json'))
  assert.equal(rows.filter(r => r.status === 'infrastructure-error').length, 1)
  assert.equal(rows.filter(r => r.status === 'pending').length, 1)
  assert.ok(read(join(out, 'report.json')).groups.every(g => g.passAt1 == null && g.failures === 0))
})
