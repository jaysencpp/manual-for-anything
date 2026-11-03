import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { once } from 'node:events'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { FilmRepository } from '../src/server/repository.mjs'
import { LocalFiles, AzureFiles, FilmFiles, configuredFiles } from '../src/server/storage.mjs'

async function fixture(t, store) {
  const dir = await mkdtemp(join(tmpdir(), 'storage-test-')), files = store || new LocalFiles(join(dir, 'files'))
  await files.init()
  const repository = new FilmRepository(join(dir, 'app.sqlite'), files.identity), archive = new FilmFiles(repository, files)
  t.after(async () => { await archive.close(); repository.close(); await rm(dir, { recursive: true, force: true }) })
  return { dir, files, repository, archive }
}

test('local files and SQLite survive cache loss, deduplicate bytes and keep interrupted state consistent', async t => {
  const { files, repository, archive, dir } = await fixture(t)
  const path = archive.allocate('one'); await mkdir(join(path, 'screens'), { recursive: true })
  await writeFile(join(path, 'screens/photo.png'), 'picture'); await writeFile(join(path, 'copy.png'), 'picture')
  await archive.commit('one', path, { finished: false, ready: true }, [{ type: 'film' }])
  assert.equal(repository.files('one').length, 2)
  assert.equal(new Set(repository.files('one').map(f => f.hash)).size, 1)
  archive.finished('one'); archive.maxCached = 0; await archive.prune()
  assert.equal((await archive.read('one', 'screens/photo.png')).toString(), 'picture')
  assert.ok((await archive.ensure('one')).startsWith(archive.cache))
  const second = new FilmRepository(join(dir, 'app.sqlite'), files.identity)
  second.interruptRunning()
  assert.equal(second.get('one').status, 'interrupted')
  assert.equal(second.get('one').events.at(-1).type, 'failed')
  assert.equal(second.get('one').state.ready, true)
  second.close()
  assert.throws(() => new FilmRepository(join(dir, 'app.sqlite'), 'azure:some-other-store'), /different file store/)
  await assert.rejects(archive.read('one', '../app.sqlite'), /Invalid stored/)
})

test('shutdown waits for background cache pruning before removing its parent directory', async t => {
  const { archive } = await fixture(t)
  const path = archive.allocate('pruning'); await mkdir(path)
  archive.finished('pruning'); archive.maxCached = 0
  const realRm = fsPromises.rm
  let release, entered
  const blocked = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  let parentRemoved = false
  const removal = t.mock.method(fsPromises, 'rm', async (target, options) => {
    if (target === path) { entered(); await blocked }
    if (target === archive.cache) parentRemoved = true
    return realRm(target, options)
  })
  syncBuiltinESMExports()
  let pruning, closing
  try {
    pruning = archive.prune(); await started
    closing = archive.close()
    // Let shutdown reach its directory-removal step while pruning is held open.
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(parentRemoved, false, 'cache parent must remain until pruning finishes')
    release(); await pruning; await closing
    assert.equal(parentRemoved, true)
  } finally {
    release(); await Promise.allSettled([pruning, closing])
    removal.mock.restore(); syncBuiltinESMExports()
  }
})

test('failed Azure publication cannot commit a file manifest or a completed film', async t => {
  const files = new AzureFiles({ url: 'https://fake.invalid/manual-files', createIfNotExists: async () => {}, getProperties: async () => ({}),
    getBlockBlobClient: () => ({ uploadData: async () => { throw { statusCode: 403, message: 'do not expose credentials' } } }) })
  const { repository, archive } = await fixture(t, files)
  const path = archive.allocate('failed'); await mkdir(path); await writeFile(join(path, 'photo.png'), 'picture')
  repository.save('failed', { finished: false }, [])
  await assert.rejects(archive.commit('failed', path, { finished: true }, [{ type: 'done' }]), /Azure file upload failed/)
  assert.deepEqual(repository.files('failed'), [])
  assert.equal(repository.get('failed').status, 'running')
})

test('production selects Azure without silently falling back; local development selects disk', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'storage-config-')); t.after(() => rm(dir, { recursive: true, force: true }))
  assert.ok(await configuredFiles({}, dir) instanceof LocalFiles)
  await assert.rejects(configuredFiles({ NODE_ENV: 'production' }, dir), /Azure storage needs/)
  await assert.rejects(configuredFiles({ FILE_STORAGE: 'invalid' }, dir), /must be local or azure/)
  await assert.rejects(configuredFiles({ NODE_ENV: 'production', FILE_STORAGE: 'local' }, dir), /must use Azure/)
})

// Azure SDK integration, using only a local HTTP implementation of the blob protocol.
export async function blobStub() {
  const blobs = new Map(), calls = []
  let containerExists = false
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'); calls.push({ method: req.method, path: url.pathname })
    if (url.searchParams.get('restype') === 'container') {
      if (req.method === 'PUT') { containerExists = true; res.writeHead(201) }
      else res.writeHead(containerExists ? 200 : 404)
      return res.end()
    }
    const key = url.pathname
    if (req.method === 'PUT') {
      if (blobs.has(key) && req.headers['if-none-match'] === '*') { res.writeHead(412, { 'x-ms-error-code': 'ConditionNotMet' }); return res.end() }
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      blobs.set(key, Buffer.concat(chunks)); res.writeHead(201, { etag: '"test"' }); return res.end()
    }
    const data = blobs.get(key)
    if (!data) { res.writeHead(404); return res.end() }
    res.writeHead(200, { 'Content-Length': data.length, 'Content-Type': 'application/octet-stream', etag: '"test"', 'last-modified': 'Fri, 30 Oct 2026 00:00:00 GMT', 'x-ms-blob-type': 'BlockBlob' })
    res.end(req.method === 'HEAD' ? undefined : data)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const connection = `DefaultEndpointsProtocol=http;AccountName=testaccount;AccountKey=${Buffer.alloc(32, 1).toString('base64')};BlobEndpoint=http://127.0.0.1:${server.address().port}/testaccount;`
  return { connection, blobs, calls, close: () => { server.closeAllConnections(); server.close() } }
}

test('official Azure SDK uploads immutable files and restores them through the configured connection string', async t => {
  const stub = await blobStub(); t.after(stub.close)
  const files = await configuredFiles({ FILE_STORAGE: 'azure', AZURE_STORAGE_CONNECTION_STRING: stub.connection }, '/unused')
  const { archive, repository } = await fixture(t, files)
  const path = archive.allocate('azure'); await mkdir(path); await writeFile(join(path, 'photo.png'), 'azure picture')
  await archive.commit('azure', path, { finished: true, status: 'completed' }, [{ type: 'done' }])
  archive.finished('azure'); archive.maxCached = 0; await archive.prune()
  assert.equal((await archive.read('azure', 'photo.png')).toString(), 'azure picture')
  await archive.ensure('azure')
  assert.equal(repository.get('azure').status, 'completed')
  assert.ok(stub.calls.every(c => c.path.startsWith('/testaccount/manual-files')))
})

const { startServer } = await import('./support/server.mjs')
async function finished(base, id) {
  const response = await fetch(`${base}/api/films/${id}/events`), reader = response.body.getReader()
  let buffer = ''; const events = []
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break
      buffer += new TextDecoder().decode(value)
      let end
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const event = JSON.parse(buffer.slice(6, end)); buffer = buffer.slice(end + 2); events.push(event)
        if (['done', 'failed'].includes(event.type)) return events
      }
    }
  } finally { await reader.cancel() }
  throw Error('Stream ended without a terminal event')
}

for (const backend of ['local', 'azure']) test(`${backend} films, images, event history and programs survive a full server restart`, { timeout: 20000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'manual-restart-'))
  const stub = backend === 'azure' ? await blobStub() : null
  let current
  t.after(async () => { await current?.stop(); stub?.close(); await rm(dataDir, { recursive: true, force: true }) })
  const env = { MANUAL_DATA_DIR: dataDir, FILE_STORAGE: backend, ...(stub ? { AZURE_STORAGE_CONNECTION_STRING: stub.connection } : {}) }
  current = await startServer(['--speed', '1000'], env)
  const { id } = await fetch(`${current.base}/api/films?example=wood8`, { method: 'POST' }).then(r => r.json())
  assert.match(id, /^[a-f0-9]{32}$/)
  const events = await finished(current.base, id)
  assert.equal(events.at(-1).type, 'done', JSON.stringify(events.at(-1)))
  const photo = Buffer.from(await fetch(`${current.base}/api/films/${id}/photo`).then(r => r.arrayBuffer()))
  const before = await fetch(`${current.base}/api/films/${id}/program?name=replay&t=0`).then(r => r.json())
  assert.ok(before.source)
  await current.stop()
  current = await startServer([], env)
  const restored = await finished(current.base, id)
  assert.deepEqual(restored, [{ type: 'state', ready: true, finished: true }, ...events.slice(1)])
  const after = await fetch(`${current.base}/api/films/${id}/program?name=replay&t=0`).then(r => r.json())
  assert.deepEqual(after, before)
  const picture = Buffer.from(await fetch(`${current.base}/api/films/${id}/photo`).then(r => r.arrayBuffer()))
  assert.deepEqual(picture, photo)
  const about = await fetch(`${current.base}/api/films/${id}/about`).then(r => r.json())
  assert.deepEqual(about.messages, [])
  if (stub) assert.ok(stub.blobs.size > 0)
})

test('a killed server marks unfinished jobs interrupted without replaying generation', { timeout: 10000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'manual-interrupted-')), env = { MANUAL_DATA_DIR: dataDir }
  let current
  t.after(async () => { await current?.stop(); await rm(dataDir, { recursive: true, force: true }) })
  current = await startServer(['--speed', '0.01'], env)
  const { id } = await fetch(`${current.base}/api/films?example=wood8`, { method: 'POST' }).then(r => r.json())
  const exit = once(current.child, 'close'); current.child.kill('SIGKILL'); await exit
  current = await startServer([], env)
  const events = await finished(current.base, id)
  assert.equal(events.at(-1).type, 'failed')
  assert.match(events.at(-1).message, /interrupted.*restart/)
  const repository = new FilmRepository(join(dataDir, 'app.sqlite'), 'local')
  assert.equal(repository.get(id).status, 'interrupted'); repository.close()
})

test('a saved film with missing object artwork stays blocked after restart and offers a generation retry', { timeout: 20000 }, async t => {
  const requested = []
  const mock = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    const request = JSON.parse(body), prompt = request.messages[1].content[0].text
    requested.push({ schema: request.response_format?.json_schema?.name, prompt })
    const canvas = /(?:inside a |in a )(\d+)×(\d+) canvas/.exec(prompt)
    const key = /In this folder: ([\w-]+)\.png/.exec(prompt)?.[1] ||
      (prompt.startsWith('Draw one complete photographed object') ? JSON.parse(/^Object: (.+)$/m.exec(prompt)[1]).key : null)
    const content = canvas && key ? { width: +canvas[1], height: +canvas[2], parts: [{ id: key, parent: null,
      pivot: [+canvas[1] / 2, +canvas[2]], shapes: [{ d: 'M0 0L10 0L10 10Z', fill: '#fff' }] }] } : {}
    if (content.parts && prompt.includes('Parts: two parts.')) content.parts.push({ id: 'moving', parent: key, pivot: [0, 0], shapes: [{ d: 'M0 0L10 0L10 10Z', fill: '#fff' }] })
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(content) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening')
  const model = { url: `http://127.0.0.1:${mock.address().port}/v1/`, close: () => { mock.closeAllConnections(); mock.close() } }
  const dataDir = await mkdtemp(join(tmpdir(), 'manual-artwork-retry-'))
  const env = { MANUAL_DATA_DIR: dataDir, MODEL_PROVIDER: 'meta', MODEL_API_KEY: 'local-test', MODEL_BASE_URL: model.url, META_BASE_URL: model.url }
  let current
  t.after(async () => { await current?.stop(); model.close(); await rm(dataDir, { recursive: true, force: true }) })
  current = await startServer(['--speed', '1000'], env)
  const { id } = await fetch(`${current.base}/api/films?example=yarn`, { method: 'POST' }).then(r => r.json())
  assert.equal((await finished(current.base, id)).at(-1).type, 'failed')
  await current.stop()
  // Simulate an older release that had already published the traced film.
  const repository = new FilmRepository(join(dataDir, 'app.sqlite'), 'local'), record = repository.get(id)
  repository.save(id, record.state, [...record.events.filter(e => e.type !== 'failed'), { type: 'film' }, { type: 'done' }])
  repository.close()
  current = await startServer(['--live'], env)
  const events = await finished(current.base, id)
  assert.equal(events[0].ready, false)
  assert.ok(!events.some(e => e.type === 'film' || e.type === 'done'))
  assert.match(events.at(-1).message, /object drawings: hook, scissors/)
  for (const name of ['live', 'replay']) assert.equal((await fetch(`${current.base}/api/films/${id}/program?name=${name}`)).status, 409)
  const retry = await fetch(`${current.base}/api/films/${id}/retry`, { method: 'POST' })
  assert.equal(retry.status, 200)
  const next = await retry.json()
  assert.notEqual(next.id, id)
  const retryEvents = await finished(current.base, next.id)
  assert.equal(retryEvents.at(-1).type, 'done', JSON.stringify({ last: retryEvents.at(-1), requested: requested.map(r => ({ schema: r.schema, prompt: r.prompt.slice(0, 350) })) }))
  assert.ok(requested.length > 0)
  assert.ok(requested.every(r => !r.schema), 'retry never asks for perception, planning or a catalogue')
  const retried = new FilmRepository(join(dataDir, 'app.sqlite'), 'local')
  const manifest = retried.files(next.id)
  const store = new LocalFiles(join(dataDir, 'files'))
  const savedScript = async filmId => JSON.parse((await store.get(retried.file(filmId, 'script.json').hash)).toString())
  assert.deepEqual(await savedScript(next.id), { ...await savedScript(id), artworkMode: 'complete' })
  assert.ok(manifest.some(f => f.path === 'vectors.json'))
  retried.close()
  assert.equal((await fetch(`${current.base}/api/films/${next.id}/about`).then(r => r.json())).previous, id)
  assert.equal((await fetch(`${current.base}/api/films/${next.id}/retry`, { method: 'POST' })).status, 409)
})

test('a public existing Azure container is rejected without changing its access policy', async () => {
  let changed = false
  const files = new AzureFiles({ url: 'https://fake.invalid/manual-files', createIfNotExists: async () => {},
    getProperties: async () => ({ blobPublicAccess: 'blob' }), setAccessPolicy: () => { changed = true } })
  await assert.rejects(files.init(), /must be private/)
  assert.equal(changed, false)
})

test('Azure uploads and revision history survive restart without new model calls on read', { timeout: 20000 }, async t => {
  const { stubModel } = await import('./support/stub-model.mjs')
  const { readFile } = await import('node:fs/promises')
  const sample = { title: 'Solve the equation', subject: 'Algebra', status: 'solved', transcription: '2x = 8',
    expression: '2x = 8', assumptions: [], uncertainties: [],
    steps: [{ title: 'Divide by 2', explanation: 'Divide both sides by 2.', expression: 'x = 4' }],
    answer: 'x = 4', verification: 'Substitute 4: 2 × 4 = 8.' }
  const seen = [], model = await stubModel({ answers: { InstructionPlan: { mode: 'problem', problem: sample } }, seen })
  const blobs = await blobStub(), dataDir = await mkdtemp(join(tmpdir(), 'manual-upload-restart-'))
  let current
  t.after(async () => { await current?.stop(); model.close(); blobs.close(); await rm(dataDir, { recursive: true, force: true }) })
  const env = { MANUAL_DATA_DIR: dataDir, FILE_STORAGE: 'azure', AZURE_STORAGE_CONNECTION_STRING: blobs.connection,
    MODEL_PROVIDER: 'meta', MODEL_API_KEY: 'local-test', MODEL_BASE_URL: model.url, META_BASE_URL: model.url }
  current = await startServer(['--live'], env)
  const photo = await readFile(new URL('../examples/photos/wood8.png', import.meta.url)), body = new FormData()
  body.append('photo', new Blob([photo], { type: 'image/png' }), 'photo.png'); body.append('message', 'Explain simply')
  const response = await fetch(`${current.base}/api/films`, { method: 'POST', body })
  assert.equal(response.status, 200)
  const { id } = await response.json()
  assert.ok([...blobs.blobs.values()].some(bytes => bytes.equals(photo)), 'upload is durable before POST returns')
  const done = await finished(current.base, id)
  assert.equal(done.at(-1).type, 'done', JSON.stringify(done.at(-1)))
  const count = seen.length
  const image = Buffer.from(await fetch(`${current.base}/api/films/${id}/photo`).then(r => r.arrayBuffer()))
  await current.stop(); current = await startServer(['--live'], env)
  assert.ok((await fetch(`${current.base}/api/films/${id}/program`).then(r => r.json())).source)
  assert.deepEqual(Buffer.from(await fetch(`${current.base}/api/films/${id}/photo`).then(r => r.arrayBuffer())), image)
  assert.equal(seen.length, count, 'recovery must not call models')
  const revision = await fetch(`${current.base}/api/films/${id}/refine`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Use smaller steps' }) }).then(r => r.json())
  assert.ok(revision.id)
  const revised = await finished(current.base, revision.id)
  assert.equal(revised.at(-1).type, 'done', JSON.stringify(revised.at(-1)))
  await current.stop(); current = await startServer(['--live'], env)
  const about = await fetch(`${current.base}/api/films/${revision.id}/about`).then(r => r.json())
  assert.equal(about.previous, id); assert.deepEqual(about.messages, ['Explain simply', 'Use smaller steps'])
  assert.equal((await fetch(`${current.base}/api/films/${id}/screens/%5c.png`)).status, 500)
  assert.equal((await fetch(`${current.base}/api/config`)).status, 200)
})


test('an existing private Azure container needs read/write credentials only, without container creation', async () => {
  const files = new AzureFiles({ url: 'https://fake.invalid/manual-files', getProperties: async () => ({}),
    createIfNotExists: async () => { throw Error('Creation must not be attempted') } })
  await files.init()
})

test('checkpoints reject partially written JSON and preserve the coherent script/layout being played', async t => {
  const { repository, archive } = await fixture(t)
  const path = archive.allocate('coherent'); await mkdir(path)
  await writeFile(join(path, 'script.json'), '{"version":1}')
  await archive.commit('coherent', path, { finished: false }, [])
  const before = repository.files('coherent')
  await writeFile(join(path, 'script.json'), '{"version":')
  await assert.rejects(archive.commit('coherent', path, { finished: true }, [{ type: 'done' }]))
  assert.deepEqual(repository.files('coherent'), before)
  assert.equal(repository.get('coherent').status, 'running')
  await archive.commit('coherent', path, { finished: false }, [], { 'script.json': Buffer.from('{"version":2}') })
  archive.finished('coherent'); archive.maxCached = 0; await archive.prune()
  assert.deepEqual(JSON.parse((await archive.read('coherent', 'script.json')).toString()), { version: 2 })
})

test('opening many stored films restores a bounded number at a time', async t => {
  let active = 0, peak = 0
  const base = new LocalFiles(join(await mkdtemp(join(tmpdir(), 'restore-bound-')), 'files'))
  const slow = { identity: 'local', init: () => base.init(), put: (...a) => base.put(...a),
    get: async digest => { peak = Math.max(peak, ++active); await new Promise(done => setTimeout(done, 5)); try { return await base.get(digest) } finally { active-- } } }
  const { archive } = await fixture(t, slow)
  archive.restoreSlots = 2
  const ids = ['a', 'b', 'c', 'd', 'e', 'f']
  for (const id of ids) {
    const path = archive.allocate(id)
    await writeFile(join(path, '..', `${id}.tmp`), ''); await mkdir(path, { recursive: true }); await writeFile(join(path, 'file.txt'), id)
    await archive.commit(id, path, { finished: true }, [])
    archive.finished(id)
  }
  archive.maxCached = 0; await archive.prune(); archive.maxCached = 8
  const paths = await Promise.all(ids.map(id => archive.ensure(id)))
  assert.equal(new Set(paths).size, ids.length)
  // Each film has one file, so concurrent downloads equal concurrent restorations.
  assert.ok(peak <= 2, `peak ${peak}`)
  assert.equal(archive.restoreSlots, 2)
})
