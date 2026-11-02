import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FilmRepository } from '../src/server/repository.mjs'
import { startServer } from './support/server.mjs'

test('HTTP routing preserves HEAD, encoded aliases, API boundaries and the player policy', async t => {
  const server = await startServer(); t.after(server.stop)
  for (const path of ['/', '/films/saved', '/app.js', '/drawing-format.mjs', '/api/config', '/%61pi/%63onfig']) {
    const get = await fetch(server.base + path)
    assert.equal(get.status, 200, path)
    assert.equal(get.headers.get('x-powered-by'), null)
    assert.equal(get.headers.get('etag'), null)
    const head = await fetch(server.base + path, { method: 'HEAD' })
    assert.equal(head.status, 200, path)
    assert.equal(head.headers.get('content-type'), get.headers.get('content-type'))
    assert.equal(await head.text(), '')
    await get.arrayBuffer()
  }
  for (const path of ['/player.html', '/%70layer.html', '/player%2ehtml', '/%70layer%2ehtml']) {
    const response = await fetch(server.base + path)
    assert.equal(response.status, 200, path)
    assert.match(response.headers.get('content-security-policy'), /sandbox allow-scripts;/)
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'self'/)
    assert.doesNotMatch(response.headers.get('content-security-policy'), /allow-same-origin/)
    await response.arrayBuffer()
  }
  for (const path of ['/api/config/', '/API/config', '/.env.local', '/assets/fonts/..%2f..%2fserver.mjs', '/server.mjs']) {
    const response = await fetch(server.base + path)
    assert.equal(response.status, 404, path)
    await response.arrayBuffer()
  }
  const malformed = await fetch(server.base + '/%ZZ')
  assert.equal(malformed.status, 400)
  assert.deepEqual(await malformed.json(), { error: 'Invalid request URL.' })
  const method = await fetch(server.base + '/api/%63onfig', { method: 'POST' })
  assert.equal(method.status, 405)
  assert.equal(method.headers.get('allow'), 'GET, HEAD')
})

test('Express body-parser errors refund admission without starting jobs or model calls', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'manual-http-'))
  const repo = new FilmRepository(join(dir, 'app.sqlite'), 'local')
  repo.save('source', { ownerId: 'local', finished: true }, [])
  const server = await startServer(['--live'], { MANUAL_DATA_DIR: dir, MAX_ACTIVE_JOBS: '1', DAILY_JOBS: '1',
    MODEL_API_KEY: 'offline-only', MODEL_BASE_URL: 'http://127.0.0.1:1/' })
  t.after(async () => { await server.stop(); repo.close(); await rm(dir, { recursive: true, force: true }) })
  for (const [path, headers, body, status] of [
    ['/api/films/source/refine', { 'Content-Type': 'application/json' }, '{', 400],
    ['/api/films/source/refine', { 'Content-Type': 'application/json' }, JSON.stringify({ message: 'x'.repeat(16000) }), 413],
    ['/api/films', { 'Content-Type': 'image/png', 'Content-Encoding': 'gzip' }, 'compressed request', 415],
    ['/api/films', { 'Content-Type': 'multipart/form-data; boundary=broken' }, 'not a form', 400],
    ['/api/films', { 'Content-Type': 'image/png' }, Buffer.alloc(25e6 + 1), 413],
  ]) {
    const response = await fetch(server.base + path, { method: 'POST', headers, body })
    assert.equal(response.status, status, path)
    assert.equal(typeof (await response.json()).error, 'string')
    assert.equal(repo.db.prepare('SELECT SUM(used) AS n FROM job_allowances').get().n, 0)
    assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM films').get().n, 1)
  }
  assert.doesNotMatch(server.child.serverErrors, /Meta API/)
})

test('pages carry security headers, the player keeps its own policy, and /healthz reports readiness', async t => {
  const server = await startServer(); t.after(server.stop)
  const page = await fetch(server.base + '/')
  assert.match(page.headers.get('content-security-policy'), /script-src 'self';/)
  assert.doesNotMatch(page.headers.get('content-security-policy'), /unsafe-eval/)
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(page.headers.get('referrer-policy'), 'same-origin')
  await page.arrayBuffer()
  const player = await fetch(server.base + '/player.html')
  assert.match(player.headers.get('content-security-policy'), /^sandbox allow-scripts;/)
  await player.arrayBuffer()
  const comparisons = await fetch(server.base + '/comparisons')
  assert.match(comparisons.headers.get('content-security-policy'), /frame-ancestors 'none'/)
  await comparisons.arrayBuffer()
  const health = await fetch(server.base + '/healthz')
  assert.equal(health.status, 200)
  assert.deepEqual(await health.json(), { ok: true })
  assert.equal((await fetch(server.base + '/healthz', { method: 'POST' })).status, 405)
})

test('event streams are capped per account and free their slot on close', { timeout: 20000 }, async t => {
  const server = await startServer(['--speed', '100']); t.after(server.stop)
  const [example] = await (await fetch(server.base + '/api/examples')).json()
  const { id } = await (await fetch(`${server.base}/api/films?example=${example.name}`, { method: 'POST' })).json()
  const url = `${server.base}/api/films/${id}/events`, controllers = []
  const open = async () => { const c = new AbortController(); controllers.push(c); return fetch(url, { signal: c.signal }) }
  t.after(() => controllers.forEach(c => c.abort()))
  for (let i = 0; i < 32; i++) assert.equal((await open()).status, 200)
  const refused = await open()
  assert.equal(refused.status, 429)
  assert.equal(refused.headers.get('retry-after'), '30')
  controllers[0].abort()
  let reopened
  for (let i = 0; i < 50 && reopened?.status !== 200; i++) {
    await new Promise(done => setTimeout(done, 20))
    reopened = await open()
  }
  assert.equal(reopened.status, 200)
})
