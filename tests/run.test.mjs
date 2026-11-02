import { fileURLToPath } from 'node:url'
import { physicalPlan } from './support/physical-plan.mjs'
// run.mjs end to end with a stand-in model (MODEL_BASE_URL) and the wood8 fixture's saved cut-outs (--idea reuses
// them: no SAM), no films: the plan's background repair as the pipeline takes it. No real model calls.
import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readRun, filmProgram } from '../src/film/film.mjs'
import { withTools } from '../src/solvers/tools.mjs'
import { requiredDrawingKeys } from '../src/pipeline/artwork.mjs'
import { recordingCanvas, offlineEnv } from '../scripts/offline-canvas.mjs'
import { vesselGeometry } from '../src/solvers/vessels.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const fixture = () => JSON.parse(readFileSync(join(here, '../examples/fixtures/wood8/script.json'), 'utf8'))

test('an invalid numeric assembly is repaired before the layout is published', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'run-revision-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  cpSync(join(here, '../examples/fixtures/wood8/screens'), join(dir, 'screens'), { recursive: true })
  const original = fixture()
  // (board-a with only its length: cuts longer than it are a soft problem, which a film is still made with)
  const inventory = original.objects
  const first = structuredClone(original); first.objects = inventory
  first.steps[1].do.find((a) => a.v === 'cut').into = [{ k: 'base', label: '100 cm', cm: 100 }, { k: 'end-a', label: '16 cm', cm: 16 }, { k: 'end-b', label: '16 cm', cm: 16 }]
  const asked = []
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    const schema = JSON.parse(body).response_format?.json_schema?.name
    asked.push(schema || 'other')
    // (the patch takes a moment, as a model's would: it comes in after the layout)
    if (schema === 'InstructionPlanPatch') await new Promise((r) => setTimeout(r, 300))
    const content = JSON.stringify(schema === 'InstructionPlan' ? first : schema === 'InstructionPlanPatch' ? { steps: [{ at: 2, ...original.steps[1] }] } : {})
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close() })
  writeFileSync(join(dir, 'idea.json'), JSON.stringify({ project: { title: original.title, kind: 'build', pitch: 'A planter box', look: [] }, objects: inventory }))
  const child = spawn(process.execPath, [join(here, '../src/pipeline/run.mjs'), join(here, '../examples/photos/wood8.png'), dir, '--idea', join(dir, 'idea.json'), '--no-catalogue'],
    { env: { ...process.env, MODEL_PROVIDER: 'meta', MODEL_API_KEY: 'local-test-only', MODEL_BASE_URL: `http://127.0.0.1:${server.address().port}/v1/` } })
  let out = '', err = ''
  child.stdout.on('data', (c) => { out += c }); child.stderr.on('data', (c) => { err += c })
  const timer = setTimeout(() => child.kill(), 30000)
  const [code] = await once(child, 'close'); clearTimeout(timer)
  assert.equal(code, 0, err)
  const marks = [...out.matchAll(/^\s*[\d.]+s {2}(.+)$/gm)].map((m) => m[1].trim())
  const at = (name) => { const i = marks.indexOf(name); assert.ok(i >= 0, `${name} in ${marks.join(' | ')}`); return i }
  assert.ok(at('script: patch 1') < at('layout'))
  assert.ok(!marks.some(m => m.startsWith('script: kept with')))
  assert.equal(asked.filter((s) => s === 'InstructionPlan').length, 1); assert.equal(asked.filter((s) => s === 'InstructionPlanPatch').length, 1)
  // (the film's plan is the patched one, laid out again)
  const script = JSON.parse(readFileSync(join(dir, 'script.json'), 'utf8'))
  assert.deepEqual(script.steps[1].do.find((a) => a.v === 'cut').into.map((p) => p.label), ['80 cm', '16 cm', '16 cm'])
  assert.ok(JSON.parse(readFileSync(join(dir, 'layout.json'), 'utf8')).order.includes('base'))
  // (the reference panel is asked for the plan the film keeps, after the revision)
  assert.ok(marks.findIndex((m) => m.startsWith('panel: ')) > at('script: done'))
})

for (const scenario of [null, 'nested', 'scene', 'response', 'cutout', 'supply', 'supply-size', 'supply-interior', 'supply-invalid-interior', 'retry-once', 'retry-three', 'unauthorized']) test(scenario?.startsWith('retry-') ? `a required drawing recovers after ${scenario === 'retry-once' ? 'one retry' : 'three retries'}` : scenario && !['nested', 'scene', 'cutout'].includes(scenario) ? `a failed required drawing (${scenario}) fails generation with diagnostics` : `added supplies retain generated artwork in ${scenario || 'recipe'} playback`, async (t) => {
  const failure = ['nested', 'scene', 'cutout', 'retry-once', 'retry-three'].includes(scenario) ? null : scenario
  const dir = mkdtempSync(join(tmpdir(), 'selected-artwork-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  cpSync(join(here, '../examples/fixtures/wood8/screens'), join(dir, 'screens'), { recursive: true })
  const inventory = fixture().objects.map((o, i) => ({ k: o.k, n: ['white espresso machine', 'black milk frother', 'small coffee capsule'][i],
    b: o.b, cm: o.cm, segment: ['espresso machine', 'milk frother', 'coffee capsule'][i] }))
  const script = physicalPlan({ title: 'Counter setup', view: 'side', objects: inventory, tools: [], joints: [], goals: [], finale: [],
    ideas: [0, 1, 2].map(i => ({ title: `Idea ${i}`, pitch: 'Arrange machine' })), pick: 0,
    materials: [{ k: 'pitcher', n: 'Required pitcher', family: 'cylinder', size: [18, 18, 24] },
      { k: 'orange-juice', n: 'Orange juice carton', family: 'box', size: [7, 7, 20] },
      { k: 'ice', n: 'Ice cubes', family: 'loose', size: [10, 10, 5] }],
    steps: [{ t: 'Position machine', c: 'Place the machine', do: [{ v: 'place', k: inventory[0].k, rel: 'floor' }] },
      ...['pitcher', 'orange-juice', 'ice'].map(k => ({ t: `Position ${k}`, c: `Place the ${k}`, do: [{ v: 'place', k, rel: 'floor' }] })),
      { t: 'Add juice', c: 'Pour 100 ml orange juice into the pitcher', do: [{ v: 'pour', k: 'orange-juice', to: 'pitcher', color: '#ff9a24', label: '100 ml' }] }] })
  if (scenario === 'scene') script.steps.pop()
  if (scenario === 'cutout') rmSync(join(dir, 'screens', `${inventory[0].k}.png`))
  const requested = [], supplies = {}, schemas = []
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    const request = JSON.parse(body), schema = request.response_format?.json_schema?.name
    schemas.push(schema || 'artwork')
    const prompt = request.messages[1].content[0].text
    let content = {}
    if (schema === 'InstructionPlan') {
      // Give the segmentation/inventory path time to start speculative artwork before the plan is returned.
      await new Promise(resolve => setTimeout(resolve, 200)); content = script
    } else if (prompt.startsWith('Draw one complete photographed object')) {
      const key = JSON.parse(/^Object: (.+)$/m.exec(prompt)[1]).key; requested.push(key)
      assert.equal(request.messages[1].content.filter(c => c.type === 'image_url').length, 1)
      assert.match(prompt, /original photo/)
      const size = /inside a (\d+)×(\d+) canvas/.exec(prompt)
      content = failure === 'response' ? {} : { width: +size[1], height: +size[2], parts: [{ id: key, parent: null, pivot: [0, 0], shapes: [{ d: 'M0 0L10 0L10 10Z', fill: '#fff' }] }] }
    } else if (prompt.startsWith('Draw one additional supply')) {
      assert.ok(request.messages[1].content.every(c => c.type === 'text'))
      const object = JSON.parse(/^Object: (.+)$/m.exec(prompt)[1]), key = object.key
      assert.ok(script.materials.some(m => m.k === key))
      assert.match(prompt, new RegExp(`Place the ${key}`))
      const size = /inside a (\d+)×(\d+) canvas/.exec(prompt)
      requested.push(key)
      const attempt = requested.filter(k => k === key).length
      if (key === 'pitcher' && scenario === 'unauthorized') {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Invalid API key' } })); return
      }
      const retryFailures = scenario === 'retry-once' ? 1 : scenario === 'retry-three' ? 3 : 0
      if (key === 'pitcher' && attempt > 1 && retryFailures) assert.match(prompt, /previous drawing attempt failed/)
      content = key === 'pitcher' && (failure === 'supply' || attempt <= retryFailures) ? {} : {
        width: +size[1] + (failure === 'supply-size' && key === 'pitcher' ? 10 : 0), height: +size[2],
        parts: [{ id: key, parent: null, pivot: [+size[1] / 2, +size[2]],
          shapes: [{ d: 'M10 10L100 10L80 200Z', fill: '#28b9cc', stroke: '#1d2b4f' }] }],
      }
      if (key === 'orange-juice' && content.parts) content.outlet = [content.width * 0.3, content.height * 0.08]
      if (key === 'pitcher' && content.parts && scenario !== 'scene') {
        const W = content.width, H = content.height
        assert.match(prompt, /MUST include/)
        content.vessel = { seat: [W / 2, H * 0.2], rx: W * 0.35, ry: H * 0.04,
          interior: [[W * 0.15, H * 0.2], [W * 0.85, H * 0.2], [W * 0.75, H * 0.95], [W * 0.25, H * 0.95]], spout: [W * 0.1, H * 0.2] }
        content.vessel = vesselGeometry(content)
        if (failure === 'supply-interior') delete content.vessel
        if (failure === 'supply-invalid-interior') content.vessel.interior[0][0] = -100
      }
      supplies[key] = structuredClone(content)
      if (scenario === 'nested' && content.vessel) {
        content.parts[0].vessel = content.vessel; delete content.vessel
      }
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(content) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close() })
  writeFileSync(join(dir, 'idea.json'), JSON.stringify({ project: { title: script.title, pitch: 'Arrange machine' }, objects: inventory }))
  const child = spawn(process.execPath, [join(here, '../src/pipeline/run.mjs'), join(here, '../examples/photos/wood8.png'), dir, '--idea', join(dir, 'idea.json'), '--no-catalogue', '--no-finale'],
    { env: { ...process.env, MODEL_PROVIDER: 'meta', MODEL_API_KEY: 'local-test-only', MODEL_BASE_URL: `http://127.0.0.1:${server.address().port}/v1/` } })
  let out = '', err = ''; child.stdout.on('data', c => { out += c }); child.stderr.on('data', c => { err += c })
  const timer = setTimeout(() => child.kill(), 15000)
  const [code] = await once(child, 'close'); clearTimeout(timer)
  assert.ok(requested.includes('pitcher'), requested.join(', '))
  if (failure) {
    assert.equal(code, 1, err)
    assert.match(JSON.parse(readFileSync(join(dir, 'failure.json'))).message, /Could not finish the object drawings/)
    assert.ok(!out.includes('drawings: all'), out)
    const key = failure.startsWith('supply') || failure === 'unauthorized' ? 'pitcher' : inventory[0].k
    assert.equal(requested.filter(k => k === key).length, failure === 'unauthorized' ? 1 : 4)
    for (const other of new Set(requested.filter(k => k !== key))) {
      if (failure !== 'response') assert.equal(requested.filter(k => k === other).length, 1)
    }
    const diagnostic = JSON.parse(readFileSync(join(dir, 'draw', key, 'failure.json')))
    const expected = { cutout: /ENOENT.*copyfile/, 'supply-size': /dimensions do not match/,
      unauthorized: /HTTP 401/, 'supply-interior': /missing its opening and interior/, 'supply-invalid-interior': /invalid container geometry/ }
    assert.match(diagnostic.message, expected[failure] || /no usable object drawing/)
    return
  }
  assert.equal(code, 0, err)
  assert.ok(requested.includes(inventory[0].k))
  assert.ok(!requested.includes(inventory[2].k), requested.join(', '))
  const retries = scenario === 'retry-once' ? 1 : scenario === 'retry-three' ? 3 : 0
  assert.equal(new Set(requested).size + retries, requested.length)
  assert.equal(existsSync(join(dir, 'draw', 'pitcher', 'failure.json')), false)
  for (let i = 1; i <= retries; i++) {
    assert.ok(existsSync(join(dir, 'draw', 'pitcher', `failure-attempt-${i}.json`)))
    assert.ok(existsSync(join(dir, 'draw', 'pitcher', `out-retry-${i}.json`)))
  }
  assert.ok(out.indexOf('drawing: '+inventory[0].k) > out.indexOf('script: done'), out)
  const timings = JSON.parse(readFileSync(join(dir, 'timings.json')))
  for (const key of requested) assert.ok(timings.calls['draw '+key])
  for (let i = 1; i <= retries; i++) assert.ok(timings.calls[`draw pitcher retry ${i}`])
  assert.ok(!out.includes("Cannot access 'drawings' before initialization"), out)
  assert.ok(out.indexOf('panel: ') > out.indexOf('drawings: all'), out)
  if (scenario === null) {
    const resumed = mkdtempSync(join(tmpdir(), 'resumed-artwork-'))
    t.after(() => rmSync(resumed, { recursive: true, force: true }))
    // A failed run has successful siblings but no vectors.json. One saved sibling
    // is corrupt: it must be regenerated rather than silently reused.
    rmSync(join(dir, 'vectors.json'))
    rmSync(join(dir, 'draw/pitcher/drawing.json'))
    writeFileSync(join(dir, 'draw/ice/drawing.json'), '{}')
    const before = schemas.length, start = requested.length
    const retry = spawn(process.execPath, [join(here, '../src/pipeline/run.mjs'), join(here, '../examples/photos/wood8.png'), resumed,
      '--resume-from', dir, '--no-finale'], { env: { ...process.env, MODEL_PROVIDER: 'meta', MODEL_API_KEY: 'local-test-only',
        MODEL_BASE_URL: `http://127.0.0.1:${server.address().port}/v1/` } })
    let retryLog = ''; retry.stdout.on('data', c => { retryLog += c }); retry.stderr.on('data', c => { retryLog += c })
    const limit = setTimeout(() => retry.kill(), 15000)
    const [result] = await once(retry, 'close'); clearTimeout(limit)
    assert.equal(result, 0, retryLog)
    assert.deepEqual(requested.slice(start).sort(), ['ice', 'pitcher'])
    assert.ok(schemas.slice(before).every(s => s === 'artwork'), schemas.slice(before).join(','))
    assert.deepEqual(JSON.parse(readFileSync(join(resumed, 'script.json'))), JSON.parse(readFileSync(join(dir, 'script.json'))))
    const resumedVectors = JSON.parse(readFileSync(join(resumed, 'vectors.json')))
    assert.deepEqual(resumedVectors['orange-juice'], supplies['orange-juice'])
    // Restore vectors for the playback assertions below.
    writeFileSync(join(dir, 'vectors.json'), JSON.stringify(resumedVectors))
  }
  const run = readRun(dir), fitted = withTools(run.script, run.rawGeometry, run.cutSizes, run.vectors)
  assert.ok(run.layout.order.includes('pitcher'))
  for (const material of script.materials) {
    assert.deepEqual(run.vectors[material.k], supplies[material.k])
    assert.deepEqual(fitted.vectors[material.k], supplies[material.k])
  }
  assert.deepEqual(new Set(requiredDrawingKeys(run.layout, fitted.geometry)), new Set([inventory[0].k, ...script.materials.map(m => m.k)]))
  if (scenario === 'scene') for (const material of script.materials) {
    assert.equal(run.layout.boards[material.k], undefined)
    assert.equal(run.layout.scene[material.k].illustrated, true)
  }
  const program = filmProgram(run)
  assert.ok(program.duration > 0)
  assert.match(program.source, /#28b9cc/)
  const previousPath = globalThis.Path2D
  globalThis.Path2D = class { constructor(d) { this.d = d } }
  try {
    const draw = new Function(`return (${program.source})`)()
    for (const act of run.times.acts) {
      const canvas = recordingCanvas()
      draw(canvas.ctx, act.at + act.len * 0.75, offlineEnv())
      assert.equal(canvas.depth(), 0)
      if (act.k === 'pitcher') assert.ok(canvas.calls.some(c => c.method === 'fill' && c.fill === '#28b9cc'))
    }
  } finally { globalThis.Path2D = previousPath }
})
