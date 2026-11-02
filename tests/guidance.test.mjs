import { fileURLToPath } from 'node:url'
import { spawnServer } from './support/server.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { addGuidance, guidancePrompt, sameInventory } from '../src/pipeline/guidance.mjs'
import { stubModel } from './support/stub-model.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))

test('steering preserves earlier requests and bounds input without silently dropping it', () => {
  const first = addGuidance([], '  Only scissors and glue.  ')
  assert.deepEqual(addGuidance(first, 'Make a desk organiser.'), ['Only scissors and glue.', 'Make a desk organiser.'])
  assert.deepEqual(first, ['Only scissors and glue.'])
  for (const value of [null, {}, '', '   ', 'x'.repeat(2001)]) assert.throws(() => addGuidance([], value))
  assert.throws(() => addGuidance(Array(20).fill('earlier'), 'another'))
  assert.throws(() => addGuidance(Array(8).fill('x'.repeat(2000)), 'another'))
  const prompt = guidancePrompt({ messages: first, previousPlan: { title: 'Old project' } })
  assert.match(prompt, /Only scissors and glue/)
  assert.match(prompt, /Old project/)
  assert.match(prompt, /not ground truth/)
  assert.equal(guidancePrompt(null), '')
})

test('correcting an object or its dimensions prevents stale cut-out reuse', async () => {
  const objects = [{ k: 'sheet', n: 'paper', segment: 'paper', b: [1, 2, 30, 40], cm: 21 }]
  assert.equal(sameInventory(objects, structuredClone(objects)), true)
  for (const change of [{ n: 'fabric' }, { segment: 'cloth' }, { b: [2, 2, 30, 40] }, { cm: 30 }, { k: 'cloth' }])
    assert.equal(sameInventory(objects, [{ ...objects[0], ...change }]), false)
  assert.equal(sameInventory([], []), false)
})

async function finished(base, id) {
  const reader = (await fetch(`${base}/api/films/${id}/events`)).body.getReader(), decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      assert.equal(done, false, 'stream ended without a terminal event')
      buffer += decoder.decode(value, { stream: true })
      let end
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const event = JSON.parse(buffer.slice(6, end)); buffer = buffer.slice(end + 2)
        assert.notEqual(event.type, 'failed', event.message)
        if (event.type === 'done') return
      }
    }
  } finally { await reader.cancel() }
}

test('upload steering and repeated revisions reach the planner with history, previous plan and original photo', { timeout: 20000 }, async (t) => {
  const problem = { title: 'Solve the equation', subject: 'Algebra', status: 'solved', transcription: '2x = 8', expression: '2x = 8', assumptions: [], uncertainties: [],
    steps: [{ title: 'Divide by 2', expression: 'x = 4', explanation: 'Divide both sides by 2.' }], answer: 'x = 4', verification: '2 × 4 = 8.' }
  const seen = [], stub = await stubModel({ answers: { InstructionPlan: { mode: 'problem', problem } }, seen })
  t.after(stub.close)
  const child = spawnServer(['--port', '0', '--live', '--effort', 'medium'], { MODEL_PROVIDER: 'meta', MODEL_API_KEY: 'stub', META_BASE_URL: stub.url, MODEL_BASE_URL: stub.url, SAM_FIXTURE: '/missing-sam-must-not-run' })
  t.after(() => child.kill())
  const port = await new Promise((done, fail) => {
    child.stdout.on('data', (b) => { const match = /localhost:(\d+)/.exec(String(b)); if (match) done(match[1]) })
    child.on('exit', (code) => fail(Error(`server exited ${code}`)))
  })
  const base = `http://127.0.0.1:${port}`
  const postRevision = (id, message) => fetch(`${base}/api/films/${id}/refine`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) })
  const form = new FormData()
  form.append('photo', new Blob([readFileSync(joinPath('../examples/photos/wood8.png'))], { type: 'image/png' }), 'photo.png')
  form.append('message', 'Forklar på norsk: divide both sides.')
  const response = await fetch(`${base}/api/films`, { method: 'POST', body: form })
  assert.equal(response.status, 200)
  const first = await response.json(); assert.ok(first.id)
  await finished(base, first.id)
  assert.equal(seen[0].effort, 'minimal'); assert.equal(seen[1].effort, 'medium')
  assert.deepEqual(seen[1].schema.required, ['mode', 'problem'])
  assert.equal(seen[1].schema.anyOf, undefined)
  assert.match(seen[0].prompt, /Forklar på norsk/)
  for (const message of ['', 'x'.repeat(2001), null]) assert.equal((await postRevision(first.id, message)).status, 400)
  assert.equal(seen.length, 2, 'invalid requests must not start model calls')
  const secondResponse = await postRevision(first.id, 'Explain step 1 more clearly.')
  assert.equal(secondResponse.status, 200)
  const second = await secondResponse.json(); await finished(base, second.id)
  assert.notEqual(second.id, first.id)
  const plans = () => seen.filter((s) => s.name === 'InstructionPlan')
  assert.match(plans()[1].prompt, /Forklar på norsk/)
  assert.match(plans()[1].prompt, /Explain step 1 more clearly/)
  assert.match(plans()[1].prompt, /previous generated manual/)
  assert.match(plans()[1].prompt, /2x = 8/)
  const thirdResponse = await postRevision(second.id, 'Keep the same equation, use smaller steps.')
  const third = await thirdResponse.json(); await finished(base, third.id)
  const about = await fetch(`${base}/api/films/${third.id}/about`).then((r) => r.json())
  assert.equal(about.previous, second.id)
  assert.deepEqual(about.messages, ['Forklar på norsk: divide both sides.', 'Explain step 1 more clearly.', 'Keep the same equation, use smaller steps.'])
  assert.match(plans()[2].prompt, /Explain step 1 more clearly/)
  assert.match(plans()[2].prompt, /Keep the same equation/)
  const originalPhoto = Buffer.from(await (await fetch(`${base}/api/films/${first.id}/photo`)).arrayBuffer())
  const revisedPhoto = Buffer.from(await (await fetch(`${base}/api/films/${third.id}/photo`)).arrayBuffer())
  assert.deepEqual(revisedPhoto, originalPhoto)
  for (const id of [first.id, second.id, third.id]) {
    const film = await fetch(`${base}/api/films/${id}/program`).then((r) => r.json())
    assert.ok(film.source.includes('Problem as read'), 'every version remains playable')
  }
  assert.deepEqual(seen.map((s) => s.name), ['PhotoPerception', 'InstructionPlan', 'PhotoPerception', 'InstructionPlan', 'PhotoPerception', 'InstructionPlan'])
})

const joinPath = (path) => `${here}${path}`
