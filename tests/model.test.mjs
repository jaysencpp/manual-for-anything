import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generate, events, estimatedCost, configuration } from '../src/pipeline/model.mjs'

const usage = { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 100 }, completion_tokens_details: { reasoning_tokens: 20 } }
const event = (value) => `data: ${JSON.stringify(value)}\r\n\r\n`
function complete(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.write(': heartbeat\r\n\r\n')
  res.write(event({ model: 'muse-wonder-1.0', choices: [{ delta: { content: '{"ok":' } }] }))
  res.write(event({ choices: [{ delta: { content: 'true}' }, finish_reason: 'stop' }] }))
  res.end(event({ choices: [], usage }) + 'data: [DONE]\r\n\r\n')
}
async function fixture(t, handler) {
  const dir = mkdtempSync(join(tmpdir(), 'meta-model-test-'))
  const server = createServer(handler)
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true }) })
  return { dir, options: { provider: 'meta', model: 'muse-wonder-1.0', apiKey: 'test-secret-never-log', baseURL: `http://127.0.0.1:${server.address().port}/v1`, timeoutMs: 2000 } }
}

test('SSE decoding preserves split UTF-8, CRLF, comments and a final event without newline', async () => {
  const bytes = Buffer.from(': ping\r\ndata: {"text":"blå"}\r\n\r\ndata: [DONE]')
  const chunks = async function* () { for (const b of bytes) yield Uint8Array.of(b) }
  const received = []
  for await (const value of events(chunks())) received.push(value)
  assert.deepEqual(received, ['{"text":"blå"}', '[DONE]'])
})

test('SSE decoding accepts every line ending, multiline data and split boundaries', async () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const bytes = Buffer.from('\uFEFF' + [': heartbeat', 'event: message', 'id: 1', 'data: first', 'data: blå', '', 'data: second', '', ''].join(newline))
    const chunks = async function* () { for (const b of bytes) yield Uint8Array.of(b) }
    const received = []
    for await (const value of events(chunks())) received.push(value)
    assert.deepEqual(received, ['first\nblå', 'second'], JSON.stringify(newline))
  }
})

test('vision requests stream incrementally, capture usage and persist no request secrets or images', async (t) => {
  let request
  const { dir, options } = await fixture(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    request = { path: req.url, auth: req.headers.authorization, body: JSON.parse(body) }; complete(res)
  })
  writeFileSync(join(dir, 'photo.png'), Buffer.from([137, 80, 78, 71]))
  const updates = [], r = await generate(dir, 'Return JSON.', { ...options, images: ['photo.png'], onText: (s) => updates.push(s) })
  assert.equal(request.path, '/v1/chat/completions')
  assert.equal(request.auth, 'Bearer test-secret-never-log')
  assert.equal(request.body.reasoning_effort, 'low')
  assert.equal(request.body.stream_options.include_usage, true)
  assert.match(request.body.messages[1].content[2].image_url.url, /^data:image\/png;base64,/)
  assert.deepEqual(updates, ['{"ok":', '{"ok":true}'])
  assert.equal(r.thinking, 20); assert.equal(r.output, 100); assert.ok(r.firstTokenSeconds >= 0)
  assert.equal(r.cost, estimatedCost('muse-wonder-1.0', usage))
  const saved = readFileSync(join(dir, 'out.json'), 'utf8')
  assert.doesNotMatch(saved, /test-secret-never-log|data:image/)
  assert.equal(JSON.parse(saved).result, '{"ok":true}')
})

test('rate limiting retries before publishing any output', async (t) => {
  let calls = 0
  const { dir, options } = await fixture(t, (req, res) => {
    req.resume()
    if (++calls === 1) { res.writeHead(429, { 'Retry-After': '0' }); res.end('rate limited') } else complete(res)
  })
  const r = await generate(dir, 'JSON', options)
  assert.equal(calls, 2); assert.equal(r.attempts, 2)
})

test('authentication failure is not retried and does not echo the error body', async (t) => {
  let calls = 0
  const { dir, options } = await fixture(t, (req, res) => { req.resume(); calls++; res.writeHead(401); res.end('test-secret-never-log') })
  await assert.rejects(generate(dir, 'JSON', options), (e) => /HTTP 401/.test(e.message) && !/test-secret/.test(e.message))
  assert.equal(calls, 1); assert.equal(existsSync(join(dir, 'out.json')), false)
})

test('an interrupted or token-limited stream never replays published output', async (t) => {
  let calls = 0
  const { dir, options } = await fixture(t, (req, res) => {
    req.resume(); calls++; res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end(event({ choices: [{ delta: { content: '{"partial":' }, finish_reason: 'length' }] }) + 'data: [DONE]\n\n')
  })
  await assert.rejects(generate(dir, 'JSON', options), /response incomplete/)
  assert.equal(calls, 1); assert.equal(existsSync(join(dir, 'out.json')), false)
})

test('requests have a timeout and respect cancellation', async (t) => {
  const { dir, options } = await fixture(t, (req) => req.resume())
  await assert.rejects(generate(dir, 'JSON', { ...options, timeoutMs: 30 }), /timeout|aborted/i)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(generate(dir, 'JSON', { ...options, signal: controller.signal }), /abort/i)
})

test('missing credentials fail locally; unknown usage or model does not invent a cost', async () => {
  await assert.rejects(generate('/tmp', 'JSON', { provider: 'meta', apiKey: '' }), /MODEL_API_KEY/)
  assert.equal(estimatedCost('unknown', usage), null)
  assert.equal(estimatedCost('muse-wonder-1.0', null), null)
})


test('the model client supports Meta only and never falls back to a CLI', () => {
  assert.equal(configuration({ provider: 'meta', model: 'test-model' }).model, 'test-model')
  assert.throws(() => configuration({ provider: 'claude' }), /Only Meta is supported/)
  assert.throws(() => configuration({ provider: 'unknown' }), /Only Meta is supported/)
})
