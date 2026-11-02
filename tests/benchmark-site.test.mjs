import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startServer } from './support/server.mjs'
import { openDrawingBrowser } from '../benchmarks/drawing-chrome.mjs'
import { exportDrawingBenchmark } from '../benchmarks/export-drawing-benchmark.mjs'
import { prepareExperiment, runExperiment, mockDrawing } from '../benchmarks/drawing-bench.mjs'

test('public comparison page serves only curated read-only results and displays labelled outputs on desktop and mobile', { timeout: 45000 }, async t => {
  const server = await startServer(); t.after(() => server.stop())
  const get = path => fetch(server.base + path)
  assert.match(await (await get('/')).text(), /href="\/comparisons"/)
  const home = await (await get('/')).text()
  assert.match(home, />Comparisons<\/a>/)
  const page = await (await get('/comparisons')).text()
  assert.match(page, /<title>Drawing comparisons/)
  assert.doesNotMatch(page, /[Bb]enchmark/)
  assert.equal((await get('/benchmarks')).status, 200)
  assert.equal((await get('/benchmarks/data/index.json')).status, 200)
  assert.equal((await get('/comparisons.js')).status, 200)
  assert.equal((await get('/comparisons.css')).status, 200)
  assert.equal((await fetch(server.base + '/comparisons', { method: 'POST' })).status, 405)
  const index = await (await get('/comparisons/data/index.json')).json()
  const datasets = new Map()
  assert.ok(index.cases.some(c => c.id === 'lego'))
  for (const entry of index.cases) {
    const base = `/comparisons/data/${entry.id}/`
    const data = await (await get(base + 'case.json')).json()
    datasets.set(entry.id, data)
    assert.equal(data.rows.length, 6)
    assert.deepEqual(data.rows.map(row => row.effort), ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    assert.doesNotMatch(JSON.stringify(data), /MODEL_API_KEY|out.request|\/tmp\/manual|promptSha256/)
    for (const row of data.rows.filter(row => row.png)) {
      const png = await get(base + row.png), svg = await get(base + row.svg)
      assert.equal(png.headers.get('content-type'), 'image/png'); assert.equal(svg.headers.get('content-type'), 'image/svg+xml')
      assert.match(await svg.text(), /^<svg/)
    }
    assert.equal((await get(base + 'manifest.json')).status, 404)
    assert.equal((await get(base + '..%2F..%2Fdrawing-bench.mjs')).status, 404)
  }
  const browser = await openDrawingBrowser(server.base + '/comparisons', undefined, { renderModule: null })
  const evaluate = browser.evaluate
  browser.evaluate = expression => evaluate(expression).catch(error => { error.message += ` while evaluating ${expression.slice(0, 240)}`; throw error })
  t.after(() => browser.close())
  await browser.evaluate(`new Promise(resolve => {
    const ready=()=>document.querySelectorAll('.output').length===6;
    if(ready()) return resolve(true);
    const observer=new MutationObserver(()=>{if(ready()){observer.disconnect();resolve(true)}});
    observer.observe(document.getElementById('outputs'),{childList:true});
  })`)
  const labels = await browser.evaluate(`({labels:[...document.querySelectorAll('.output h3')].map(n=>n.textContent),images:[...document.querySelectorAll('.output img')].map(n=>n.getAttribute('src')),costs:[...document.querySelectorAll('.output .metrics')].map(n=>n.textContent),tabs:document.querySelectorAll('#cases a').length})`)
  assert.deepEqual(labels.labels, ['Minimal effort', 'Low effort', 'Medium effort', 'High effort', 'Xhigh effort', 'Max effort'])
  assert.equal(await browser.evaluate(`document.querySelectorAll('.output .badge').length`), 0)
  assert.doesNotMatch(await browser.evaluate(`document.getElementById('outputs').textContent`), /Observed pass@1|Visual pass|Renders · visual review pending/)
  assert.equal(labels.images.length, 6); assert.ok(labels.costs.every(text => text.includes('$') && text.includes('Time to usable drawing')))
  assert.equal(labels.tabs, new Set(index.cases.map(item => item.objectId || item.id)).size)
  await browser.evaluate(`document.querySelector('.output .image-button').click(); true`)
  assert.equal(await browser.evaluate(`document.getElementById('zoom').open`), true)
  await browser.evaluate(`document.getElementById('close-zoom').click(); true`)
  assert.equal(await browser.evaluate(`document.getElementById('zoom').open`), false)
  if (index.cases.some(c => c.id === 'rope')) {
    await browser.evaluate(`new Promise(resolve=>{
      const observer=new MutationObserver(()=>{if(document.getElementById('case-title').textContent==='Rope'){observer.disconnect();resolve(true)}});
      observer.observe(document.getElementById('case-title'),{childList:true});
      document.querySelector('#cases [data-id="rope"]').click();
    })`)
    assert.ok((await browser.evaluate(`document.getElementById('source').textContent`)).includes('9fa3d281fa144008bf5a9d3253b8faac'))
  }
  if (index.cases.some(c => (c.objectId || c.id) === 'scissors' && c.model === 'muse-spark-1.3')) {
    await browser.evaluate(`new Promise(resolve=>{
      const observer=new MutationObserver(()=>{if(document.getElementById('model-select').options.length===2){observer.disconnect();resolve(true)}});
      observer.observe(document.getElementById('model-select'),{childList:true});
      document.querySelector('#cases [data-id="scissors"]').click();
    })`)
    await browser.evaluate(`new Promise(resolve=>{
      const observer=new MutationObserver(()=>{if(document.querySelectorAll('.output').length===12){observer.disconnect();resolve(true)}});
      observer.observe(document.getElementById('outputs'),{childList:true});
      document.getElementById('compare-models').click();
    })`)
    const comparison = await browser.evaluate(`({efforts:[...document.querySelectorAll('.output h3')].map(n=>n.textContent),models:[...document.querySelectorAll('.model-label')].map(n=>n.textContent),images:[...document.querySelectorAll('.output img')].map(n=>n.getAttribute('src')),url:location.search})`)
    assert.equal(comparison.images.length, ['scissors', 'scissors-spark-1-3'].reduce((n, id) => n + datasets.get(id).rows.filter(row => row.png).length, 0))
    assert.deepEqual(comparison.efforts.slice(0, 4), ['Minimal effort', 'Minimal effort', 'Low effort', 'Low effort'])
    assert.deepEqual(comparison.models.slice(0, 4), ['Muse Wonder 1.0', 'Muse Spark 1.3', 'Muse Wonder 1.0', 'Muse Spark 1.3'])
    assert.ok(comparison.images[0].includes('/scissors/')); assert.ok(comparison.images[1].includes('/scissors-spark-1-3/'))
    assert.match(comparison.url, /compare=1/)
    await browser.viewport(1280, 900)
    await browser.evaluate(`Promise.all([...document.images].map(img=>{img.loading='eager';return img.decode().catch(()=>{})})).then(()=>true)`)
    writeFileSync(join(tmpdir(), 'benchmark-model-comparison.png'), Buffer.from(await browser.screenshot(), 'base64'))
    await browser.evaluate(`new Promise(resolve=>{
      const observer=new MutationObserver(()=>{if(document.querySelectorAll('.output').length===6){observer.disconnect();resolve(true)}});
      observer.observe(document.getElementById('outputs'),{childList:true});
      document.getElementById('compare-models').click();
    })`)
    await browser.evaluate(`new Promise(resolve=>{
      const observer=new MutationObserver(()=>{if([...document.querySelectorAll('.model-label')].every(n=>n.textContent==='Muse Spark 1.3')){observer.disconnect();resolve(true)}});
      observer.observe(document.getElementById('outputs'),{childList:true});
      const select=document.getElementById('model-select'); select.value='scissors-spark-1-3'; select.dispatchEvent(new Event('change'));
    })`)
    assert.match(await browser.evaluate(`location.search`), /model=muse-spark-1.3/)
  }
  await browser.viewport(1280, 900)
  await browser.evaluate(`Promise.all([...document.images].map(img=>{img.loading='eager';return img.decode().catch(()=>{})})).then(()=>true)`)
  writeFileSync(join(tmpdir(), 'benchmark-site-desktop.png'), Buffer.from(await browser.screenshot(), 'base64'))
  await browser.viewport(390, 844)
  assert.equal(await browser.evaluate(`document.documentElement.scrollWidth <= innerWidth`), true)
  writeFileSync(join(tmpdir(), 'benchmark-site-mobile.png'), Buffer.from(await browser.screenshot(), 'base64'))
})

test('export excludes incomplete or mock runs and refreshes a case without duplicating it', async t => {
  const temp = mkdtempSync(join(tmpdir(), 'public-benchmark-test-')); t.after(() => rmSync(temp, { recursive: true, force: true }))
  const source = join(temp, 'experiment')
  const prepared = await prepareExperiment(source, { samples: 1 })
  // Local dependency stubs exercise the export path without network calls or a second browser.
  await runExperiment(source, {
    generateCall: async () => ({ text: JSON.stringify(mockDrawing(prepared.fixture)), model: prepared.model, cost: .01 }),
    browserFactory: async () => ({ render: async () => ({ png: `data:image/png;base64,${readFileSync(new URL('../benchmarks/published/lego/reference.png', import.meta.url)).toString('base64')}`, pixels: 1 }), close: async () => {} }),
  })
  const root = join(temp, 'published')
  const data = exportDrawingBenchmark(source, { id: 'lego', title: 'LEGO brick', root })
  assert.equal(data.rows.length, 6)
  exportDrawingBenchmark(source, { id: 'lego', title: 'LEGO brick', root })
  assert.equal(JSON.parse(readFileSync(join(root, 'index.json'))).cases.length, 1)
  const sourceManifest = JSON.parse(readFileSync(join(source, 'manifest.json')))
  sourceManifest.model = 'muse-spark-1.3'
  writeFileSync(join(source, 'manifest.json'), JSON.stringify(sourceManifest))
  assert.throws(() => exportDrawingBenchmark(source, { id: 'lego', title: 'LEGO brick', root }), /another model/)
  const pending = join(temp, 'pending')
  await prepareExperiment(pending, { samples: 1, efforts: ['minimal'], caseFile: fileURLToPath(new URL('../benchmarks/cases/rope/case.json', import.meta.url)) })
  const manifest = JSON.parse(readFileSync(join(pending, 'manifest.json')))
  assert.equal(manifest.fixture.key, 'rope'); assert.match(manifest.fixture.source, /9fa3d281/)
  assert.match(readFileSync(join(pending, 'fixture/prompt.txt'), 'utf8'), /"approximateBox":\[4,4,3560,3656\]/)
  assert.throws(() => exportDrawingBenchmark(pending, { id: 'rope', title: 'Rope', root }), /Only completed live/)
  assert.throws(() => exportDrawingBenchmark(source, { id: '../rope', title: 'Rope', root }), /safe case id/)
})


test('planning comparisons expose each saved run with isolated reports, attempts and photos', async t => {
  const server = await startServer(); t.after(() => server.stop())
  const index = await fetch(server.base + '/comparisons/plans/api/runs').then(r => r.json())
  assert.ok(index.runs.some(run => run.id === index.defaultRun))
  for (const id of ['planning-comparison-all','planning-fixes','planning-v2','planning-v2-broader','planning-v3','planning-v4','planning-v4-required']) assert.ok(index.runs.some(run => run.id === id))
  let attempts = 0
  for (const run of index.runs) {
    const base = `${server.base}/comparisons/plans/runs/${run.id}`
    const report = await fetch(base + '/api/report').then(r => r.json())
    assert.equal(report.created, run.created)
    assert.equal(report.rows.filter(r => r.first).length, run.attempts)
    assert.deepEqual(report.efforts, run.efforts)
    assert.doesNotMatch(JSON.stringify(report), /MODEL_API_KEY|rawFile|candidateFile|normalizedPlan/)
    for (const row of report.rows) {
      const attempt = await fetch(base + '/api/attempt/' + row.id).then(r => r.json())
      assert.equal(attempt.row.responseSeconds, row.responseSeconds)
      assert.equal(attempt.row.caseId, row.caseId)
      assert.equal(attempt.rawText, null)
    }
    for (const c of report.cases) assert.equal((await fetch(base + '/photo/' + c.id + '.png')).headers.get('content-type'), 'image/png')
    assert.equal((await fetch(base + '/api/report', { method: 'POST' })).status, 405)
    assert.equal((await fetch(base + '/manifest.json')).status, 404)
    attempts += run.attempts
  }
  assert.ok(attempts >= 168)
  assert.equal((await fetch(server.base + '/comparisons/plans/runs/unknown/api/report')).status, 404)
  const browser = await openDrawingBrowser(server.base + '/comparisons/plans?run=planning-comparison-all', undefined, { renderModule: null }); t.after(() => browser.close())
  await browser.evaluate(`new Promise(resolve=>{const cards=document.getElementById('plan-cards');const ready=()=>cards.children.length===6;if(ready())return resolve(true);const observer=new MutationObserver(()=>{if(ready()){observer.disconnect();resolve(true)}});observer.observe(cards,{childList:true})})`)
  assert.equal(await browser.evaluate(`document.getElementById('run-select').value`), 'planning-comparison-all')
  assert.deepEqual(await browser.evaluate(`[...document.querySelectorAll('.plan-card h3')].map(n=>n.textContent)`), ['Minimal effort','Low effort','Medium effort','High effort','Xhigh effort','Max effort'])
  assert.match(await browser.evaluate(`document.getElementById('compare-photo').getAttribute('src')`), /runs\/planning-comparison-all\/photo/)
})
