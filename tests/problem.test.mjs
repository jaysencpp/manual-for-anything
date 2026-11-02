import { fileURLToPath } from 'node:url'
import { spawnServer } from './support/server.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { validateProblem, problemScript, problemProgram, problemTimeline } from '../src/pipeline/problem.mjs'
import { preparePhoto, writePlan } from '../src/pipeline/plan.mjs'
import { stubModel } from './support/stub-model.mjs'
import { recordingCanvas, offlineEnv } from '../scripts/offline-canvas.mjs'
import { readRun, filmProgram } from '../src/film/film.mjs'
import { refusedIn } from '../src/pipeline/words.mjs'
import { validatePlan } from '../src/pipeline/validate.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const example = () => ({ title: 'Solve the equation', subject: 'Algebra', status: 'solved', transcription: '2x + 3 = 11', expression: '2x + 3 = 11', assumptions: [], uncertainties: [],
  steps: [{ title: 'Subtract 3', expression: '2x = 8', explanation: 'Subtract 3 from both sides.' }, { title: 'Divide by 2', expression: 'x = 4', explanation: 'Divide both sides by 2.' }],
  answer: 'x = 4', verification: 'Substitute x = 4: 2 × 4 + 3 = 11.' })

test('linear solution transformations and the answer are independently checked', () => {
  assert.equal(validateProblem(example()).check.status, 'verified_linear')
  const bad = example(); bad.steps[0].expression = '2x = 14'
  assert.equal(validateProblem(bad).valid, false)
  const wrong = example(); wrong.answer = 'x = 7'
  assert.match(validateProblem(wrong).errors.join(';'), /changes the solution/)
  const nonLinear = example(); nonLinear.expression = 'x² = 16'
  assert.equal(validateProblem(nonLinear).check.status, 'not_checked')
})

test('uncertain transcription cannot be presented as a solved problem', () => {
  const p = example(); p.uncertainties = ['The sign before 3 is unclear']
  assert.equal(validateProblem(p).valid, false)
  p.status = 'needs_clarification'; p.steps = []; p.answer = ''; p.verification = ''
  assert.equal(validateProblem(p).valid, true)
  assert.equal(problemScript(p).objects.length, 0)
  assert.deepEqual(problemTimeline(p).starts, [])
  assert.equal(validateProblem({ ...p, answer: 42 }).valid, false)
  const physical = validatePlan({ mode: 'physical' })
  assert.match(physical.errors.join(';'), /plan must provide joints/)
})

test('problem films show the original reading, explanations and result without segmentation assets', () => {
  const p = example(), { source } = problemProgram(p), times = problemTimeline(p)
  assert.deepEqual(refusedIn(source), [])
  const draw = new Function(`return (${source})`)(), env = offlineEnv()
  for (const at of [0, ...times.starts.map((t) => t + 1), times.finale + 1]) {
    const c = recordingCanvas(); draw(c.ctx, at, env); assert.equal(c.depth(), 0)
    assert.ok(c.calls.some((x) => x.method === 'fillText' && x.args[0] === 'Problem as read'))
  }
  const c = recordingCanvas(); draw(c.ctx, times.starts[1] + 1, env)
  assert.ok(c.calls.some((x) => x.method === 'fillText' && x.args[0].includes('x = 4')))
})

test('the shared planner routes a problem without ever publishing physical objects', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'problem-plan-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const seen = [], server = await stubModel({ answers: { InstructionPlan: { mode: 'problem', problem: example() } }, seen })
  t.after(server.close)
  const photo = await preparePhoto(join(here, '../examples/photos/wood8.png'), dir)
  let published = false
  const result = await writePlan(dir, photo, { provider: 'meta', apiKey: 'stub', baseURL: server.url, maxRepairs: 0, onObjects: () => { published = true } })
  assert.equal(result.script.mode, 'problem'); assert.equal(published, false)
  assert.equal(seen.length, 1); assert.equal(result.validation.check.status, 'verified_linear')
})

test('full pipeline problem mode bypasses SAM, catalogue, drawings and finale model calls', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'problem-run-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const seen = [], server = await stubModel({ answers: { InstructionPlan: { mode: 'problem', problem: example() } }, seen })
  t.after(server.close)
  const child = spawn(process.execPath, [join(here, '../src/pipeline/run.mjs'), join(here, '../examples/photos/wood8.png'), dir], {
    env: { ...process.env, MODEL_PROVIDER: 'meta', MODEL_API_KEY: 'local-stub', META_BASE_URL: server.url, MODEL_BASE_URL: server.url, SAM_FIXTURE: '/missing-sam-must-not-run' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => { if (child.exitCode == null) child.kill() })
  let output = ''; child.stdout.on('data', (x) => { output += x }); child.stderr.on('data', (x) => { output += x })
  const [code] = await once(child, 'exit')
  assert.equal(code, 0, output); assert.deepEqual(seen.map((x) => x.name), ['PhotoPerception', 'InstructionPlan'])
  assert.equal(existsSync(join(dir, 'screens/boxes.json')), false)
  assert.equal(existsSync(join(dir, 'catalogue.json')), false)
  assert.equal(JSON.parse(readFileSync(join(dir, 'problem-audit.json'))).valid, true)
  const run = readRun(dir), film = filmProgram(run)
  assert.equal(run.script.mode, 'problem'); assert.deepEqual(Object.keys(run.screens), ['photo'])
  assert.equal(film.duration, problemTimeline(example()).duration)
})

test('the web upload streams a playable problem film with the original photo and no object events', { timeout: 20000 }, async (t) => {
  const seen = [], stub = await stubModel({ answers: { InstructionPlan: { mode: 'problem', problem: example() } }, seen })
  t.after(stub.close)
  const child = spawnServer(['--port', '0', '--live'], { MODEL_PROVIDER: 'meta', MODEL_API_KEY: 'stub', META_BASE_URL: stub.url, MODEL_BASE_URL: stub.url, SAM_FIXTURE: '/missing-sam-must-not-run' })
  t.after(() => child.kill())
  const port = await new Promise((done, fail) => { child.stdout.on('data', (b) => { const m = /localhost:(\d+)/.exec(String(b)); if (m) done(m[1]) }); child.on('exit', (code) => fail(Error(`server exited ${code}`))) })
  const base = `http://127.0.0.1:${port}`
  const { id } = await fetch(`${base}/api/films`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: readFileSync(join(here, '../examples/photos/wood8.png')) }).then((r) => r.json())
  const reader = (await fetch(`${base}/api/films/${id}/events`)).body.getReader(), events = [], decoder = new TextDecoder()
  let buffer = '', finished = false
  while (!finished) {
    const { done, value } = await reader.read(); if (done) break
    buffer += decoder.decode(value, { stream: true })
    let end
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const e = JSON.parse(buffer.slice(6, end)); buffer = buffer.slice(end + 2); events.push(e)
      if (['done', 'failed'].includes(e.type)) { finished = true; break }
    }
  }
  await reader.cancel()
  assert.equal(events.at(-1).type, 'done', JSON.stringify(events))
  assert.equal(events.find((e) => e.type === 'script').mode, 'problem')
  assert.ok(!events.some((e) => ['objects', 'project'].includes(e.type)))
  const film = events.find((e) => e.type === 'film'); assert.deepEqual(Object.keys(film.screens), ['photo'])
  const rendered = await fetch(`${base}/api/films/${id}/program?name=live&t=0`).then((r) => r.json())
  assert.ok(rendered.source.includes('Problem as read'))
  assert.deepEqual(seen.map((e) => e.name), ['PhotoPerception', 'InstructionPlan'])
  const c = recordingCanvas(); new Function(`return (${rendered.source})`)()(c.ctx, film.starts[0] + 1, offlineEnv()); assert.equal(c.depth(), 0)
})
