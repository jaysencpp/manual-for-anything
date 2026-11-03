// A stand-in for the Meta Model API, for tests and for trying the web app without spending: it streams canned answers
// in small pieces, as the real API streams. The catalogue is the hand-written wood8 sample (catalogue-samples.json),
// the plan the wood8 fixture's script; every other call (drawings, faces, panels) is refused, so the film keeps its
// tracings. Nothing here is model output.
//   node tests/support/stub-model.mjs [--port 8790] [--delay 40]
// then start the server against it:
//   MODEL_BASE_URL=http://127.0.0.1:8790/v1/ MODEL_API_KEY=stub node server.mjs --live
// and take a photo of examples/photos/wood8.png (the canned objects are that photo's).
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))

export function wood8Catalogue() {
  const script = read('../../examples/fixtures/wood8/script.json')
  const objects = script.objects.map((o) => ({ k: o.k, n: o.n, segment: 'wooden board', b: o.b, cm: o.cm, w: o.w, thick: o.thick,
    measurements: Object.fromEntries(['cm', 'w', 'thick'].map((f) => [f, { status: 'estimated', source: 'single photo estimate' }])) }))
  return { objects, projects: read('catalogue-samples.json').wood8 }
}
export function wood8Plan() { return { cuts: [], assembly: null, ...read('../../examples/fixtures/wood8/script.json') } }

// answers: {Catalogue: object, InstructionPlan: object} by the request's schema name; chunk: characters a piece. An
// answer can be a function of the call's number for that name (1, 2, …); a string it returns is streamed as it is.
export async function stubModel({ port = 0, delay = 0, chunk = 160, answers = { Catalogue: wood8Catalogue(), InstructionPlan: wood8Plan() }, seen = [] } = {}) {
  const calls = {}
  const server = createServer(async (req, res) => {
    res.on('error', () => {}) // (a client that stops reading mid-stream)
    let body = ''; for await (const c of req) body += c
    let request = {}
    try { request = JSON.parse(body) } catch {}
    const name = request.response_format?.json_schema?.name
    seen.push({ name, prompt: request.messages?.[1]?.content?.[0]?.text ?? '', effort: request.reasoning_effort, schema: request.response_format?.json_schema?.schema })
    calls[name] = (calls[name] || 0) + 1
    let given = answers[name] // (read once: a test's getter can count its calls)
    if (typeof given === 'function') given = given(calls[name])
    const answer = given || (name === 'PhotoPerception' && answers.InstructionPlan ? {
      mode: answers.InstructionPlan.mode || 'physical', objects: answers.InstructionPlan.objects || [],
    } : null)
    if (!answer) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'the stub answers only perception, catalogue and plan' } })) }
    let output = answer
    // Authored canned plans use the normalized engine format; honor the requested wire contract.
    if (request.response_format?.json_schema?.schema?.properties?.objectUpdates && Array.isArray(answer.objects)) {
      const { objects, ...rest } = answer
      output = { ...rest, objectUpdates: objects.map(o => Object.fromEntries(['k', 'part', 'toolKind', 'contents', 'state', 'states'].filter(k => k in o).map(k => [k, o[k]]))) }
    }
    if (name === 'InstructionPlan' && output.mode !== 'problem' && request.response_format?.json_schema?.schema?.required?.includes('assembly'))
      output = { cuts: [], assembly: null, ...output }
    const text = typeof output === 'string' ? output : JSON.stringify(output)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (let i = 0; i < text.length && !res.destroyed; i += chunk) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(i, i + chunk) } }] })}\n\n`)
      if (delay) await new Promise((done) => setTimeout(done, delay))
    }
    res.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: Math.round(text.length / 4) } })}\n\ndata: [DONE]\n\n`)
  })
  server.listen(port, '127.0.0.1'); await once(server, 'listening')
  return { url: `http://127.0.0.1:${server.address().port}/v1/`, close: () => { server.closeAllConnections(); server.close() } }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2), flag = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d)
  const { url } = await stubModel({ port: +flag('--port', 8790), delay: +flag('--delay', 40) })
  console.log(`stub model API at ${url}`)
}
