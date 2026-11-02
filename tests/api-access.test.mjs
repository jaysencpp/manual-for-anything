import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { request } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { Accounts } from '../src/server/auth.mjs'
import { FilmRepository } from '../src/server/repository.mjs'
import { startServer } from './support/server.mjs'

const origin = 'http://localhost:8080'
const password = 'API access offline test password'
const reads = ['about', 'program', 'photo', 'prelude', 'screens/photo.png', 'artwork', 'events']
const writes = ['artwork', 'refine', 'retry', 'films?i=0']

async function setup(t, speed = '100000') {
  const dir = await mkdtemp(join(tmpdir(), 'manual-api-access-'))
  const repo = new FilmRepository(join(dir, 'app.sqlite'), 'local'), accounts = new Accounts(repo.db)
  const alice = await accounts.provision('alice', password), bob = await accounts.provision('bob', password)
  repo.save('alicefilm', { ownerId: alice, finished: true }, [{ type: 'script', title: 'Alice private title' }])
  repo.save('bobfilm', { ownerId: bob, finished: true }, [{ type: 'script', title: 'Bob private title' }])
  const server = await startServer(['--live', '--speed', speed], { MANUAL_DATA_DIR: dir, AUTH_MODE: 'password', APP_ORIGIN: origin, MODEL_API_KEY: 'offline-only', MODEL_BASE_URL: 'http://127.0.0.1:1/' })
  t.after(async () => { await server.stop(); repo.close(); await rm(dir, { recursive: true, force: true }) })
  const api = (path, method = 'GET', cookie, extra = {}) => fetch(server.base + path, {
    method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...extra },
  })
  const login = async username => {
    const response = await fetch(server.base + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) })
    assert.equal(response.status, 200)
    return response.headers.get('set-cookie').split(';')[0]
  }
  return { ...server, repo, accounts, alice, bob, api, login }
}

async function drain(response) {
  const reader = response.body.getReader(); let text = ''
  try {
    while (!text.includes('"type":"done"') && !text.includes('"type":"failed"')) {
      const { done, value } = await reader.read(); if (done) break
      text += new TextDecoder().decode(value)
    }
  } finally { await reader.cancel() }
  return text
}

test('every private API denies missing/forged/expired credentials and cross-account reads and writes', async t => {
  const s = await setup(t), aliceCookie = await s.login('alice'), bobCookie = await s.login('bob')
  const endpoints = [['/api/films', 'GET'], ['/api/films', 'POST'], ['/api/films?example=wood8', 'POST'],
    ...reads.map(route => [`/api/films/alicefilm/${route}`, 'GET']), ...writes.map(route => [`/api/films/alicefilm/${route}`, 'POST'])]
  for (const cookie of [undefined, 'manual_session=invalid', `manual_session=${'0'.repeat(64)}`]) {
    for (const [path, method] of endpoints) {
      const response = await s.api(path, method, cookie, { Authorization: 'Bearer pretend-admin', 'X-User-Id': s.alice, 'X-Forwarded-User': 'alice' })
      assert.equal(response.status, 401, `${method} ${path}`)
      assert.match(response.headers.get('cache-control'), /no-store/)
      assert.equal(response.headers.get('access-control-allow-origin'), null)
    }
  }
  for (const route of [...reads, ...writes]) {
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const response = await s.api(`/api/films/alicefilm/${route}`, method, bobCookie)
      assert.equal(response.status, 404, `${method} ${route}`)
      if (method !== 'HEAD') assert.deepEqual(await response.json(), { error: 'No such film.' })
    }
  }
  const own = await s.api('/api/films/alicefilm/about', 'GET', aliceCookie)
  assert.equal(own.status, 200)
  const library = await s.api(`/api/films?owner_id=${s.bob}&user_id=${s.bob}`, 'GET', aliceCookie).then(r => r.json())
  assert.deepEqual(library.films.map(f => f.id), ['alicefilm'])
  s.repo.db.prepare('UPDATE sessions SET expires=0 WHERE user_id=?').run(s.alice)
  for (const [path, method] of endpoints) assert.equal((await s.api(path, method, aliceCookie)).status, 401, path)
  assert.equal(s.repo.db.prepare('SELECT COUNT(*) AS n FROM job_allowances').get().n, 0)
})

test('public APIs are explicitly read-only, private methods are strict, and all write routes require the exact origin', async t => {
  const s = await setup(t), cookie = await s.login('alice')
  for (const path of ['/api/session', '/api/config', '/api/examples', '/api/examples/wood8/photo.png']) {
    assert.equal((await s.api(path)).status, 200, path)
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = await s.api(path, method)
      assert.equal(response.status, 405, `${method} ${path}`)
      assert.match(response.headers.get('allow'), /GET/)
    }
  }
  for (const resource of reads.filter(r => r !== 'artwork')) {
    const response = await s.api(`/api/films/alicefilm/${resource}`, 'POST', cookie)
    assert.equal(response.status, 405, resource)
  }
  for (const resource of ['refine', 'retry', 'films']) assert.equal((await s.api(`/api/films/alicefilm/${resource}`, 'GET', cookie)).status, 405)
  for (const path of ['/api/login', '/api/logout', '/api/films', ...writes.map(r => `/api/films/alicefilm/${r}`)]) {
    for (const value of [undefined, 'null', 'https://evil.example', origin + '.evil.example']) {
      const response = await fetch(s.base + path, { method: 'POST', headers: { Cookie: cookie, ...(value ? { Origin: value } : {}) } })
      assert.equal(response.status, 403, `${path} ${value}`)
    }
    assert.equal((await s.api(path, 'POST', cookie, { 'Sec-Fetch-Site': 'cross-site' })).status, 403, path)
  }
  for (const path of ['/api', '/api/new-unlisted-route', '/api/register', '/api/review', '/api/blind', '/api/report', '/api/attempt/secret', '/api/case/secret', '/api/films/alicefilm/server.log', '/api/films/alicefilm/screens/..%2f..%2fscript.json'])
    assert.equal((await s.api(path, 'GET', cookie)).status, 404, path)
  assert.equal((await s.api('/api/examples/not-published/photo.png')).status, 404)
  for (const path of ['/comparisons', '/comparisons/plans/api/report', '/benchmarks/plans/api/report']) {
    assert.equal((await s.api(path)).status, 200, path)
    assert.equal((await s.api(path, 'POST')).status, 405, path)
  }
  assert.equal(s.repo.db.prepare('SELECT COUNT(*) AS n FROM job_allowances').get().n, 0)
})

test('ownership is checked through all source relationships before restoring files; new projects ignore supplied owner IDs', async t => {
  const s = await setup(t), cookie = await s.login('alice')
  s.repo.save('badroot', { ownerId: s.alice, rootId: 'bobfilm', finished: true }, [])
  s.repo.save('badprevious', { ownerId: s.alice, previous: 'bobfilm', finished: true }, [])
  s.repo.save('indirect', { ownerId: s.alice, previous: 'badroot', finished: true }, [])
  s.repo.save('missingparent', { ownerId: s.alice, rootId: 'doesnotexist', finished: true }, [])
  // An invalid manifest would fail restoration with 500 if access was checked too late.
  s.repo.db.prepare('INSERT INTO files VALUES(?,?,?,?,?)').run('bobfilm', 'secret.txt', 'f'.repeat(64), 99, 'text/plain')
  for (const id of ['badroot', 'badprevious', 'indirect', 'missingparent']) {
    for (const [resource, method] of [['about', 'GET'], ['events', 'GET'], ['refine', 'POST'], ['retry', 'POST'], ['films?i=0', 'POST']])
      assert.equal((await s.api(`/api/films/${id}/${resource}`, method, cookie)).status, 404, `${id}/${resource}`)
  }
  const library = await s.api('/api/films', 'GET', cookie).then(r => r.json())
  assert.equal(library.films.find(f => f.id === 'badprevious').previous, null)
  assert.equal(library.films.find(f => f.id === 'indirect').previous, null)
  const response = await fetch(s.base + `/api/films?example=wood8&owner_id=${s.bob}`, { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ ownerId: s.bob, user_id: s.bob }) })
  assert.equal(response.status, 200)
  const { id } = await response.json()
  assert.match(await drain(await s.api(`/api/films/${id}/events`, 'GET', cookie)), /"type":"done"/)
  assert.equal(s.repo.owner(id), s.alice)
  for (const resource of ['program', 'photo', 'prelude', 'screens/photo.png', 'artwork', 'about']) {
    const data = await s.api(`/api/films/${id}/${resource}`, 'GET', cookie)
    assert.equal(data.status, 200, resource); await data.arrayBuffer()
    assert.equal((await s.api(`/api/films/${id}/${resource}`, 'GET', await s.login('bob'))).status, 404, resource)
  }
})

test('logout and expiry revoke in-flight uploads and revisions before creating work', { timeout: 20000 }, async t => {
  const s = await setup(t)
  for (const [path, contentType, bytes, revoke] of [
    ['/api/films', 'image/png', readFileSync(new URL('../examples/photos/wood8.png', import.meta.url)), 'logout'],
    ['/api/films/alicefilm/refine', 'application/json', Buffer.from('{"message":"Another project"}'), 'expiry'],
  ]) {
    const cookie = await s.login('alice')
    let req
    const response = new Promise((resolve, reject) => {
      req = request(s.base + path, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': contentType, 'Content-Length': bytes.length } }, res => {
        let text = ''; res.on('data', data => { text += data }); res.on('end', () => resolve({ status: res.statusCode, text }))
      })
      req.on('error', reject); req.write(bytes.subarray(0, 1))
    })
    t.after(() => req.destroy())
    const until = Date.now() + 5000
    while (!s.repo.db.prepare('SELECT SUM(used) AS n FROM job_allowances').get().n && Date.now() < until) await delay(10)
    assert.equal(s.repo.db.prepare('SELECT SUM(used) AS n FROM job_allowances').get().n, 2, 'global and account admission reserved while the body is pending')
    if (revoke === 'logout') assert.equal((await s.api('/api/logout', 'POST', cookie)).status, 200)
    else s.repo.db.prepare('UPDATE sessions SET expires=0 WHERE user_id=?').run(s.alice)
    req.end(bytes.subarray(1))
    assert.equal((await response).status, 401, path)
    assert.equal(s.repo.db.prepare('SELECT SUM(used) AS n FROM job_allowances').get().n, 0)
  }
  assert.equal(s.repo.db.prepare('SELECT COUNT(*) AS n FROM films').get().n, 2)
})

test('revoked sessions receive no further live events before the periodic stream check', { timeout: 10000 }, async t => {
  const s = await setup(t, '10'), cookie = await s.login('alice')
  const { id } = await s.api('/api/films?example=wood8', 'POST', cookie).then(r => r.json())
  const stream = await s.api(`/api/films/${id}/events`, 'GET', cookie), reader = stream.body.getReader()
  let initial = ''
  while (!initial.includes('"name":"start"')) {
    const chunk = await reader.read(); assert.equal(chunk.done, false)
    initial += new TextDecoder().decode(chunk.value)
  }
  // This is the session-revocation transaction used by an operator password reset.
  s.repo.db.prepare('DELETE FROM sessions WHERE user_id=?').run(s.alice)
  const next = await reader.read()
  assert.equal(next.done, true, 'next broadcast closes the revoked stream without sending an event')
})
