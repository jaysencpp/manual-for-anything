import { fileURLToPath } from 'node:url'
import { openDrawingBrowser, chromePresent } from '../benchmarks/drawing-chrome.mjs'
import { spawnServer } from './support/server.mjs'
// The catalogue, offline: thumbnails on the recording canvas, the streamed projects, the checks, the catalogue call and a
// picked project's plan through a stubbed model API, and the server's catalogue stream. No paid requests.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordingCanvas } from '../scripts/offline-canvas.mjs'
import { drawThumb, checkLook, dimensions, dimensionLabel } from '../src/film/thumbs.mjs'
import { streamedItems, checkProject, writeCatalogue, runawayWatch } from '../src/pipeline/catalogue.mjs'
import { preparePhoto, writePlan, onInventory } from '../src/pipeline/plan.mjs'
import { stubModel, wood8Catalogue, wood8Plan } from './support/stub-model.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const samples = JSON.parse(readFileSync(new URL('support/catalogue-samples.json', import.meta.url), 'utf8'))
const allLooks = Object.entries(samples).filter(([k]) => k !== 'note').flatMap(([, list]) => list)

test('every sample look draws in a few milliseconds, balanced and finite, in every domain', () => {
  let total = 0
  for (const p of allLooks) {
    const { ctx, calls, depth } = recordingCanvas()
    const started = performance.now()
    const r = drawThumb(ctx, p.look, { width: 480, height: 360, background: '#fbf9f4' })
    total += performance.now() - started
    assert.equal(depth(), 0, p.title)
    assert.equal(r.solids, p.look.length, p.title)
    assert.ok(calls.some((c) => c.method === 'fill') && calls.some((c) => c.method === 'stroke'), p.title)
    // everything inside the picture
    for (const c of calls) if (['moveTo', 'lineTo'].includes(c.method)) {
      assert.ok(c.args[0] >= -1 && c.args[0] <= 481 && c.args[1] >= -1 && c.args[1] <= 361, `${p.title}: ${c.args}`)
    }
  }
  // The best of three passes: this measures the drawing code, not whatever else the machine is doing.
  for (let pass = 0; pass < 2; pass++) {
    const started = performance.now()
    for (const p of allLooks) drawThumb(recordingCanvas().ctx, p.look, { width: 480, height: 360, background: '#fbf9f4' })
    total = Math.min(total, performance.now() - started)
  }
  assert.ok(total / allLooks.length < 5, `${(total / allLooks.length).toFixed(2)} ms a thumbnail`)
})

test('a look is made safe: unknown shapes, bad numbers and colours never reach the canvas', () => {
  const { look, problems } = checkLook([
    { s: 'box', p: [0, 0, 0], d: [10, 10, 10], c: '#abc' },
    { s: 'pyramid', p: [0, 0, 0], d: [1, 1, 1], c: '#000000' },
    { s: 'box', p: [0, 0, NaN], d: [1, 1, 1], c: '#000000' },
    { s: 'cyl', p: [0, 0, 0], d: [1, -1, 1], c: '#000000' },
    { s: 'brick', p: [0, 0, 0], d: [2.5, 2, 3], c: '#000000' },
    { s: 'cone', p: [0, 0, 0], d: [5, 5, 3], c: 'red', open: true, f: 'nonsense', t: 99 },
  ])
  assert.equal(look.length, 2)
  assert.equal(look[0].c, '#aabbcc')
  assert.equal(look[1].t, 8); assert.equal(look[1].f, undefined); assert.match(look[1].c, /^#[0-9a-f]{6}$/)
  assert.equal(problems.length, 5)
  assert.deepEqual(checkLook('no').look, [])
  // (a prism's outline under another name the model gave it is still its outline)
  const renamed = checkLook([{ s: 'prism', p: [0, 0, 0], d: [10, 1, 10], c: '#ffffff', 'o/polygon': [[0, 0], [1, 0], [0.5, 1]] }])
  assert.deepEqual(renamed.problems, []); assert.deepEqual(renamed.look[0].o, [[0, 0], [1, 0], [0.5, 1]])
  // (or run into the key, its value null, as a Meta answer parsed: half a paper catalogue's cards had no picture)
  const glued = checkLook([{ c: '#f5f5f5', d: [28, 0.2, 3], p: [0, 5, 0], s: 'prism', "o':[[0,0],[1,0.5],[0,1]]},{": null },
    { c: '#f5f5f5', d: [25, 0.3, 8], p: [0, 4, 0], s: 'box', "m':stripes'},{": null }, { '     \t\t': null }])
  assert.deepEqual(glued.look.map((s) => [s.s, s.o, s.m]), [['prism', [[0, 0], [1, 0.5], [0, 1]], undefined], ['box', undefined, 'stripes']])
  // (or run into a key whose value is not null, or two run into one key — a whole paper catalogue's cards were flat)
  const valued = checkLook([{ c: '#ffffff', d: [16, 14, 0.3], p: [2, 3, 5], s: 'prism', "o': [[0.5,0],[1,0.45],[0.85,1],[0.5,0.8],[0.15,1],[0,0.45]],": [0, 0] },
    { c: '#ffffff', d: [14, 14, 0.3], p: [3, 3, 0], s: 'prism', "axis':'z'  ,'o': [[0.5,0],[1,0.5],[0.5,1],[0,0.5]]}]  ,": [0, 0] }])
  assert.deepEqual(valued.look.map((x) => [x.o.length, x.axis]), [[6, 'z'], [4, 'z']])
  // (a flat thing lying down is its outline seen from above; a bow tie's corners are put back in order round it)
  assert.ok(valued.problems.some((p) => /lies flat/.test(p)))
  const tie = checkLook([{ s: 'prism', p: [0, 0, 0], d: [12, 12, 3], c: '#ffffff', o: [[0, 0], [1, 1], [1, 0], [0, 1]] }])
  assert.equal(tie.look[0].s, 'prism'); assert.equal(tie.look[0].o.length, 4)
  // (and a prism with no outline at all is its box — from above, a disc — not a card with no picture)
  const bare = checkLook([{ s: 'prism', p: [0, 0, 0], d: [14, 14, 1], c: '#a8d8e0', axis: 'z', m: 'rings' }, { s: 'prism', p: [0, 0, 0], d: [22, 5, 1], c: '#e2e2dc', 'o/polygon': null }])
  assert.deepEqual(bare.look.map((s) => [s.s, s.axis]), [['cyl', 'z'], ['box', undefined]])
  assert.ok(bare.problems.every((p) => /drawn as a plain (disc|block)/.test(p)))
  const { ctx, depth } = recordingCanvas()
  assert.equal(drawThumb(ctx, [{ s: 'box', p: [0, 0, 0], d: [0, 0, 0] }], { width: 100, height: 100 }).solids, 0)
  assert.equal(depth(), 0)
})

test('stacked solids draw lower first, and the size is the whole thing in centimetres', () => {
  // a plate resting on two legs: both legs before the plate, whatever their depth
  const bench = samples['lego-pile'][0].look
  const { ctx, calls } = recordingCanvas()
  drawThumb(ctx, bench, { width: 400, height: 300 })
  const order = [...new Set(calls.filter((c) => c.method === 'fill' && typeof c.fill === 'string').map((c) => c.fill))]
  const firstOf = (hex) => order.findIndex((f) => f === hex)
  assert.ok(firstOf('#3f8a3a') >= 0 && firstOf('#7a4a2a') > firstOf('#3f8a3a'), order.join(' '))
  assert.deepEqual(dimensions(checkLook(samples.wood8[0].look).look), [80, 20, 18])
  assert.equal(dimensionLabel(checkLook(bench).look), '6.4 × 1.6 × 1.3 cm')
  // a turned solid's size is its turned box
  const roof = dimensions(checkLook([{ s: 'box', p: [0, 0, 0], d: [10, 2, 2], c: '#000000', r: [0, 90, 0] }]).look)
  assert.ok(Math.abs(roof[0] - 2) < 1e-9 && Math.abs(roof[2] - 10) < 1e-9)
})

test('projects stream one by one: only closed ones, quoted brackets ignored', () => {
  const text = '{"objects":[],"projects":[{"title":"A ] {","look":[{"s":"box"}]},{"title":"B","look":[{"s":'
  assert.deepEqual(streamedItems(text, 'projects').map((p) => p.title), ['A ] {'])
  assert.equal(streamedItems(text + '"box"}]}]}', 'projects').length, 2)
  assert.deepEqual(streamedItems('{"objects":[', 'projects'), [])
})

test('a project keeps only what is in the photo and tools the films know', () => {
  const objects = [{ k: 'board-a' }, { k: 'board-b' }]
  const { project, problems } = checkProject({ title: ' Shelf ', kind: 'furniture', pitch: 'A shelf', minutes: 40.5, level: 'easy', serves: 2,
    uses: ['board-a', 'board-a', 'ghost'], needs: ['saw', 'laser'], look: [{ s: 'box', p: [0, 0, 0], d: [1, 1, 1], c: '#ffffff' }] }, objects)
  assert.equal(project.title, 'Shelf'); assert.equal(project.kind, 'other'); assert.equal(project.minutes, undefined)
  assert.equal(project.serves, undefined) // (only recipes serve)
  assert.deepEqual(project.uses, ['board-a']); assert.deepEqual(project.needs, ['saw'])
  assert.equal(problems.length, 3)
  assert.equal(checkProject({ pitch: 'no title' }, objects).project, null)
})

test('a wooden build with a part longer than its longest wood is left out; other materials become other shapes', () => {
  const logs = [{ k: 'log-a', n: 'split firewood log', cm: 35, part: { family: 'loose', size: [35, 12, 12], shape: 'log' } }, { k: 'yarn', n: 'yarn ball', cm: 8 }]
  const card = (uses, d, kind = 'build') => ({ title: 'Thing', kind, pitch: 'A thing', minutes: 30, level: 'easy', uses, needs: ['saw'], look: [{ s: 'box', p: [0, 0, 0], d, c: '#8a6b4a' }] })
  const long = checkProject(card(['log-a'], [40, 18, 5]), logs)
  assert.equal(long.project, null); assert.match(long.problems.join(), /a 40 cm part, but the longest wood is 35 cm/)
  assert.ok(checkProject(card(['log-a'], [30, 12, 12]), logs).project)
  assert.ok(checkProject(card(['yarn'], [40, 40, 1], 'craft'), logs).project) // (a blanket from a ball of yarn)
})

test('given the planner\'s objects, the catalogue asks only for projects', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'catalogue-given-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const seen = [], stub = await stubModel({ answers: { Catalogue: { projects: wood8Catalogue().projects } }, seen }); t.after(stub.close)
  const photo = await preparePhoto(fileURLToPath(new URL('../examples/photos/wood8.png', import.meta.url)), join(dir, 'script'))
  let told = false
  const catalogue = await writeCatalogue(dir, photo, { provider: 'meta', apiKey: 'fake', baseURL: stub.url, inventory: wood8Catalogue().objects, onObjects: () => { told = true } })
  assert.equal(told, false) // (the objects are the caller's: nothing new to announce)
  assert.equal(catalogue.projects.length, wood8Catalogue().projects.length)
  assert.match(seen[0].prompt, /already identified/); assert.doesNotMatch(seen[0].prompt, /"segment"/); assert.doesNotMatch(seen[0].prompt, /\[\[/)
  // (the sizes still estimates say so, and what is the same for every photo comes before what is not, for the cache)
  assert.match(seen[0].prompt, /"estimated":\["cm"/); assert.doesNotMatch(seen[0].prompt, /\{\{/)
  assert.ok(seen[0].prompt.indexOf('Answer with compact JSON') < seen[0].prompt.indexOf('already identified'))
})

test('the catalogue streams its objects, then each project in order, through the real HTTP adapter', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'catalogue-http-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const seen = [], stub = await stubModel({ chunk: 97, seen }); t.after(stub.close)
  const photo = await preparePhoto(fileURLToPath(new URL('../examples/photos/wood8.png', import.meta.url)), join(dir, 'script'))
  const order = []
  const catalogue = await writeCatalogue(dir, photo, { provider: 'meta', apiKey: 'fake', baseURL: stub.url,
    onObjects: (objects) => order.push(`objects ${objects.length}`), onProject: (i, p) => order.push(`${i} ${p.title}`) })
  const expected = wood8Catalogue()
  assert.equal(order[0], `objects ${expected.objects.length}`)
  assert.deepEqual(order.slice(1), expected.projects.map((p, i) => `${i} ${p.title}`))
  assert.equal(catalogue.projects.length, expected.projects.length)
  assert.deepEqual(catalogue.problems, [])
  assert.equal(seen[0].name, 'Catalogue'); assert.match(seen[0].prompt, /20 different projects/)
  assert.ok(existsSync(join(dir, 'catalogue.json')))
})

test('a picked project is planned on the catalogue inventory: segmentation starts first, identity kept, the pick first', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'catalogue-pick-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { objects, projects } = wood8Catalogue(), idea = projects[1]
  // The authored fixture drifts; the annotation-only wire contract excludes its identity changes.
  const plan = wood8Plan()
  plan.objects[0].b = [5, 5, 50, 50]; plan.objects[1].n = 'renamed'
  plan.objects[2].states = [{ id: 'raw', label: 'Raw board' }]
  const seen = [], stub = await stubModel({ answers: { InstructionPlan: plan }, seen }); t.after(stub.close)
  const photo = await preparePhoto(fileURLToPath(new URL('../examples/photos/wood8.png', import.meta.url)), join(dir, 'script'))
  let objectsAt = null
  const result = await writePlan(join(dir, 'script'), photo, { provider: 'meta', apiKey: 'fake', baseURL: stub.url, idea, inventory: objects,
    onObjects: (list) => { objectsAt = seen.length; assert.deepEqual(list, objects) } })
  assert.equal(objectsAt, 0, 'segmentation was told before the plan was asked for')
  assert.match(seen[0].prompt, new RegExp(`"title":"${idea.title}"`)); assert.doesNotMatch(seen[0].prompt, /"look"/)
  // (the card's sizes, so the plan builds what was picked, to its proportions)
  assert.match(seen[0].prompt, /The card they picked shows it [\d.]+ × [\d.]+ × [\d.]+ cm overall/); assert.doesNotMatch(seen[0].prompt, /"c":"#/)
  const s = result.script
  assert.deepEqual(s.objects.map((o) => o.k), objects.map((o) => o.k))
  assert.deepEqual(s.objects[0].b, objects[0].b); assert.equal(s.objects[1].n, objects[1].n)
  assert.deepEqual(s.objects[2].states, [{ id: 'raw', label: 'Raw board' }])
  assert.equal(s.ideas[0].title, idea.title); assert.equal(s.pick, 0); assert.equal(s.ideas.length, 3)
  // (a field the catalogue never gave is not kept from the plan either, when it identifies the thing)
  assert.equal(onInventory([{ k: 'a', n: 'A', b: [0, 0, 1, 1], cm: 1 }], [{ k: 'a', tip: [3, 3], part: { family: 'box' } }])[0].tip, undefined)
})

// ---- the server ----
async function serve(env) {
  const child = spawnServer(['--port', '0', '--live'], env)
  const port = await new Promise((done, fail) => {
    child.stdout.on('data', (c) => { const m = /localhost:(\d+)/.exec(String(c)); if (m) done(+m[1]) })
    child.on('exit', (code) => fail(new Error(`server exited ${code}`)))
  })
  return { url: `http://localhost:${port}`, stop: () => child.kill(), errors: () => child.serverErrors }
}
async function events(url) {
  const res = await fetch(url), reader = res.body.getReader(), all = []
  let text = ''
  for (;;) {
    const { value, done } = await reader.read(); if (done) break
    text += new TextDecoder().decode(value)
    let at
    while ((at = text.indexOf('\n\n')) >= 0) {
      const event = JSON.parse(text.slice(6, at)); text = text.slice(at + 2); all.push(event)
      if (event.type === 'done' || event.type === 'failed') { reader.cancel(); return all }
    }
  }
  return all
}

test('a photo film writes its catalogue alongside; a pick is a film on the same cut-outs that shares the catalogue', async (t) => {
  const stub = await stubModel({ chunk: 400 }); t.after(stub.close)
  const server = await serve({ MODEL_BASE_URL: stub.url, MODEL_API_KEY: 'stub', MODEL_PROVIDER: 'meta', SAM_FIXTURE: join(here, '../examples/fixtures/wood8/screens') }); t.after(server.stop)
  const { id } = await fetch(`${server.url}/api/films`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: readFileSync(`${here}../examples/photos/wood8.png`) }).then((r) => r.json())
  const all = await events(`${server.url}/api/films/${id}/events`)
  const types = all.map((e) => e.type)
  assert.equal(types.at(-1), 'done', JSON.stringify(all.filter((e) => e.type === 'stage').map((e) => e.name)))
  // (this has failed now and then on Windows only: say what arrived, so a failure can be told from the log alone)
  const arrived = () => JSON.stringify({ types, stages: all.filter((e) => e.type === 'stage').map((e) => e.name), serverErrors: server.errors().slice(-2000) })
  assert.ok(types.includes('film'), `no film event: ${arrived()}`)
  assert.ok(types.includes('catalogue'), `no catalogue event: ${arrived()}`)
  const projects = all.filter((e) => e.type === 'project')
  assert.deepEqual(projects.map((e) => e.i), wood8Catalogue().projects.map((_, i) => i))
  assert.ok(types.indexOf('objects') < types.indexOf('project'))
  assert.deepEqual(await fetch(`${server.url}/api/films/${id}/about`).then((r) => r.json()), { root: null, pick: null, previous: null, messages: [] })
  assert.equal((await fetch(`${server.url}/api/films/${id}/films?i=999`, { method: 'POST' })).status, 409)
  // the pick: its own film, the first film's catalogue replayed into it, the cut-outs reused (no segmentation run)
  const pick = await fetch(`${server.url}/api/films/${id}/films?i=2`, { method: 'POST' }).then((r) => r.json())
  const picked = await events(`${server.url}/api/films/${pick.id}/events`)
  assert.equal(picked.at(-1).type, 'done', JSON.stringify(picked.at(-1)))
  assert.equal(picked.filter((e) => e.type === 'project').length, projects.length)
  assert.ok(picked.some((e) => e.type === 'catalogue') && picked.some((e) => e.type === 'film'))
  assert.equal(picked.find((e) => e.type === 'script').ideas[0].title, wood8Catalogue().projects[2].title)
  assert.ok(!picked.some((e) => e.type === 'stage' && /^project: /.test(e.name)), 'a pick writes no catalogue of its own')
  assert.deepEqual(await fetch(`${server.url}/api/films/${pick.id}/about`).then((r) => r.json()), { root: id, pick: 2, previous: null, messages: [] })
  assert.equal((await fetch(`${server.url}/thumbs.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8')
})


// A model slipping out of its JSON: the key swallows its colon and the rest is reasoning, then a loop, in one string.
const runaway = (before = '') => `{"projects":[${before}{"kind":"build","title":"Gate","confirmations:" \t: 0, "-> wait: tool output is corrupted. ${'Done.   Stop.   Close.   '.repeat(4000)}`

test('a string far longer than any catalogue field is caught as it streams, and real answers are not', () => {
  const watch = runawayWatch()
  assert.equal(watch(JSON.stringify(wood8Catalogue())), false)
  const text = runaway(), seen = runawayWatch()
  const at = [...Array(Math.ceil(text.length / 100)).keys()].find((n) => seen(text.slice(0, (n + 1) * 100)))
  assert.ok(at !== undefined && (at + 1) * 100 < 2000, `stopped after ${(at + 1) * 100} characters`)
  assert.equal(runawayWatch()(`{"a":"${'x\\"'.repeat(300)}","b":"${'y'.repeat(900)}"}`), false, 'escaped quotes neither end a string nor run two together')
  assert.equal(runawayWatch()(`{"a":"${'x\\"'.repeat(400)}`), true)
})

test('a runaway catalogue answer is stopped early and asked once more when no project was shown', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'catalogue-runaway-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const good = { projects: wood8Catalogue().projects }
  const seen = [], stub = await stubModel({ chunk: 97, answers: { Catalogue: (n) => n === 1 ? runaway() : good }, seen }); t.after(stub.close)
  const photo = await preparePhoto(fileURLToPath(new URL('../examples/photos/wood8.png', import.meta.url)), join(dir, 'script'))
  const catalogue = await writeCatalogue(dir, photo, { apiKey: 'stub', baseURL: stub.url, inventory: wood8Catalogue().objects })
  assert.equal(seen.length, 2)
  assert.equal(catalogue.status, 'ready')
  assert.equal(catalogue.projects.length, good.projects.length)
  assert.match(catalogue.problems.join(), /ran away/)
  const partial = JSON.parse(readFileSync(join(dir, 'catalogue', 'out.partial.json'), 'utf8'))
  assert.ok(partial.aborted && partial.result.length < 3000, `read ${partial.result.length} characters before stopping`)
})

test('a runaway after projects were shown keeps them without another call; twice with none fails', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'catalogue-runaway-kept-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const first = wood8Catalogue().projects[0]
  const seen = [], stub = await stubModel({ chunk: 97, answers: { Catalogue: () => runaway(`${JSON.stringify(first)},`) }, seen }); t.after(stub.close)
  const photo = await preparePhoto(fileURLToPath(new URL('../examples/photos/wood8.png', import.meta.url)), join(dir, 'script'))
  const shown = []
  const catalogue = await writeCatalogue(dir, photo, { apiKey: 'stub', baseURL: stub.url, inventory: wood8Catalogue().objects, onProject: (i, p) => shown.push(p.title) })
  assert.equal(seen.length, 1)
  assert.deepEqual(shown, [first.title]); assert.deepEqual(catalogue.projects.map((p) => p.title), [first.title])
  assert.equal(catalogue.status, 'ready'); assert.equal(catalogue.call.costIncomplete, true)

  const none = [], loop = await stubModel({ chunk: 97, answers: { Catalogue: () => runaway() }, seen: none }); t.after(loop.close)
  const again = mkdtempSync(join(tmpdir(), 'catalogue-runaway-none-')); t.after(() => rmSync(again, { recursive: true, force: true }))
  await assert.rejects(writeCatalogue(again, photo, { apiKey: 'stub', baseURL: loop.url, inventory: wood8Catalogue().objects }), /ran away twice/)
  assert.equal(none.length, 2)
})

test('an empty catalogue is recorded explicitly without retrying and explains tool-only supplies', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'catalogue-empty-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const seen = [], stub = await stubModel({ answers: { Catalogue: { projects: [] } }, seen }); t.after(stub.close)
  const photo = await preparePhoto(fileURLToPath(new URL('../examples/photos/wood8.png', import.meta.url)), join(dir, 'script'))
  const catalogue = await writeCatalogue(dir, photo, { apiKey: 'stub', baseURL: stub.url, inventory: wood8Catalogue().objects })
  assert.equal(catalogue.status, 'empty')
  assert.deepEqual(catalogue.projects, [])
  assert.equal(seen.length, 1)
  assert.match(seen[0].prompt, /photographed scissors can support a paper snowflake/)
  assert.match(seen[0].prompt, /supplies:\["Paper"\]/)
  assert.doesNotMatch(seen[0].prompt, /no pens, plants or paper that are not there/)
  assert.equal(JSON.parse(readFileSync(join(dir, 'catalogue.json'))).status, 'empty')
})

test('empty catalogues replay planner suggestions as cards without pretending supplies or previews exist', { skip: !chromePresent, timeout: 120000 }, async t => {
  const seen = [], stub = await stubModel({ chunk: 2000, answers: { Catalogue: { projects: [] }, InstructionPlan: wood8Plan() }, seen }); t.after(stub.close)
  const server = await serve({ MODEL_BASE_URL: stub.url, MODEL_API_KEY: 'stub', SAM_FIXTURE: join(here, '../examples/fixtures/wood8/screens') }); t.after(server.stop)
  const { id } = await fetch(`${server.url}/api/films`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: readFileSync(`${here}../examples/photos/wood8.png`) }).then(r => r.json())
  const all = await events(`${server.url}/api/films/${id}/events`)
  assert.equal(all.at(-1).type, 'done')
  assert.ok(all.some(e => e.type === 'stage' && e.name === 'catalogue: empty'))
  assert.ok(all.some(e => e.type === 'catalogue' && e.empty && !e.failed))
  assert.equal(seen.filter(r => r.name === 'Catalogue').length, 1)
  const script = all.find(e => e.type === 'script'), alternatives = script.ideas.filter((_, i) => i !== script.pick)
  assert.ok(alternatives.length > 0)
  const browser = await openDrawingBrowser(`${server.url}/films/${id}`, undefined, { renderModule: null }); t.after(() => browser.close())
  await browser.evaluate(`new Promise(resolve=>{const ready=()=>document.querySelectorAll('.idea-card').length===${alternatives.length};if(ready())return resolve(true);const observer=new MutationObserver(()=>{if(ready()){observer.disconnect();resolve(true)}});observer.observe(document.body,{childList:true,subtree:true})})`)
  assert.deepEqual(await browser.evaluate(`[...document.querySelectorAll('.idea-card b')].map(n=>n.textContent)`), alternatives.map(i => i.title))
  assert.equal(await browser.evaluate(`document.getElementById('cat-tools').hidden`), true)
  assert.equal(await browser.evaluate(`document.querySelectorAll('.idea-card canvas,.idea-card button,#cat-grid .ghost').length`), 0)
  assert.equal(await browser.evaluate(`document.getElementById('cat-note').hidden`), true)
  await browser.viewport(390, 844)
  assert.equal(await browser.evaluate(`document.documentElement.scrollWidth <= innerWidth`), true)
  assert.equal(await browser.evaluate(`getComputedStyle(document.querySelector('.idea-card .pitch')).display`), 'block')
})
