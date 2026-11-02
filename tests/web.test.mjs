import { fileURLToPath } from 'node:url'
import { spawnServer } from './support/server.mjs'
// The web app's server, offline: every example streamed (at 50× its recorded pace), every program it hands the player
// run over the whole film on a recording canvas, and the replay. No models, no renderer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, existsSync } from 'node:fs'
import { recordingCanvas, offlineEnv } from '../scripts/offline-canvas.mjs'
import { readRun } from '../src/film/film.mjs'
import { withTools } from '../src/solvers/tools.mjs'
import { requiredDrawingKeys } from '../src/pipeline/artwork.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const examples = readdirSync(`${here}../examples/fixtures`).filter((f) => existsSync(`${here}../examples/fixtures/${f}/timings.json`))

async function serve() {
  const child = spawnServer(['--port', '0', '--speed', '50'])
  const port = await new Promise((done, fail) => {
    child.stdout.on('data', (c) => { const m = /localhost:(\d+)/.exec(String(c)); if (m) done(+m[1]) })
    child.on('exit', (code) => fail(new Error(`server exited ${code}`)))
  })
  return { url: `http://localhost:${port}`, stop: () => child.kill() }
}

// A film's events, until it is done: [{type, …}].
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

// A program, drawn every quarter second of its film: no throw, the canvas state balanced.
function plays({ source, duration }, screens) {
  const old = globalThis.Path2D; globalThis.Path2D = class {}
  try {
    const draw = new Function(`return (${source})`)(), env = { ...offlineEnv(), screens }
    for (let t = 0; t <= duration; t += 0.25) {
      const { ctx, depth } = recordingCanvas()
      draw(ctx, t, env)
      assert.equal(depth(), 0, `unbalanced save/restore at ${t}`)
    }
  } finally { globalThis.Path2D = old }
}

test('every example streams, and every program it sends plays', async () => {
  const server = await serve()
  try {
    for (const name of examples) {
      const { id } = await fetch(`${server.url}/api/films?example=${name}`, { method: 'POST' }).then((r) => r.json())
      const all = await events(`${server.url}/api/films/${id}/events`)
      const types = all.map((e) => e.type)
      // This old recording has no artwork for its photographed hook and scissors.
      // It must now offer a retry rather than silently show their tracings.
      if (name === 'yarn') {
        assert.equal(types.at(-1), 'failed')
        assert.match(all.at(-1).message, /object drawings: hook, scissors/)
        assert.ok(!types.includes('film'))
        for (const mode of ['live', 'replay']) {
          const response = await fetch(`${server.url}/api/films/${id}/program?name=${mode}&t=0`)
          assert.equal(response.status, 409)
        }
        continue
      }
      assert.ok(types.includes('script') && types.includes('film'), `${name}: ${types.join(' ')}`)
      assert.equal(types.at(-1), 'done', name)
      assert.equal(all[0].type, 'state')
      const reloaded = await events(`${server.url}/api/films/${id}/events`)
      assert.deepEqual(reloaded[0], { type: 'state', ready: true, finished: true })
      assert.deepEqual(reloaded.slice(1), all.slice(1), 'reloading reuses the same generated film')
      assert.ok(types.indexOf('objects') < types.indexOf('film'), name)
      const saved = readRun(`${here}../examples/fixtures/${name}`)
      const { geometry } = withTools(saved.script, saved.rawGeometry, saved.cutSizes, {})
      if (requiredDrawingKeys(saved.layout, geometry).length) {
        assert.ok(all.findIndex(e => e.type === 'stage' && e.name === 'drawings: all') < types.indexOf('film'), `${name}: drawings must finish before playback`)
      }
      const film = all.find((e) => e.type === 'film')
      const screens = Object.fromEntries(Object.entries(film.screens).map(([k, s]) => [k, { width: s.width, height: s.height }]))
      for (const k of Object.keys(film.screens)) assert.equal((await fetch(server.url + film.screens[k].url)).status, 200, `${name}: screen ${k}`)
      // The first program, then one as everything has come in partway through, then the replay.
      for (const ask of ['name=live&t=0', `name=live&t=${(film.starts[1] ?? 3).toFixed(2)}`, 'name=replay&t=0']) {
        const program = await fetch(`${server.url}/api/films/${id}/program?${ask}`).then((r) => r.json())
        assert.ok(program.source?.length > 1000 && program.source.length <= 400000, `${name} ${ask}: ${program.error ?? program.source?.length}`)
        try { plays(program, screens) } catch (e) { e.message = `${name} ${ask}: ${e.message}`; throw e }
      }
    }
  } finally { server.stop() }
})

test('photos are refused unless the server runs with --live', async () => {
  const server = await serve()
  try {
    const res = await fetch(`${server.url}/api/films`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: new Uint8Array(8) })
    assert.equal(res.status, 403)
    const example = await fetch(`${server.url}/api/films?example=wood8`, { method: 'POST' }).then((r) => r.json())
    const revise = await fetch(`${server.url}/api/films/${example.id}/refine`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Make it smaller.' }) })
    assert.equal(revise.status, 403)
    assert.equal((await fetch(`${server.url}/assets/fonts/..%2F..%2Fserver.mjs`)).status, 404)
    assert.match((await fetch(`${server.url}/player.html`)).headers.get('content-security-policy'), /default-src 'none'/)
  } finally { server.stop() }
})
