import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { Authentication, Accounts } from '../src/server/auth.mjs'
import { FilmRepository } from '../src/server/repository.mjs'
import { startServer } from './support/server.mjs'

test('legacy films migrate to local ownership and checkpoints cannot change owners', () => {
  const repo = new FilmRepository(':memory:', 'local')
  try {
    repo.save('one', { ownerId: 'alice', finished: true }, [{ type: 'script', title: '<Lego>' }])
    repo.save('one', { finished: true }, [{ type: 'script', title: '<Lego>' }])
    repo.save('old', { finished: true }, [])
    assert.equal(repo.owner('one'), 'alice')
    assert.equal(repo.owner('old'), 'local')
    assert.deepEqual(repo.list('bob').films, [])
    assert.equal(repo.list('alice').films[0].title, '<Lego>')
    for (let i = 0; i < 26; i++) repo.save(`film${i}`, { ownerId: 'alice', finished: true }, [])
    assert.equal(repo.list('alice').films.length, 24)
    assert.equal(repo.list('alice').more, true)
    assert.equal(repo.list('alice', { offset: 24 }).films.length, 3)
  } finally { repo.close() }
})

test('authentication fails closed in production and requires configured accounts', () => {
  const db = new DatabaseSync(':memory:')
  try {
    assert.throws(() => new Authentication(db, { NODE_ENV: 'production', AUTH_MODE: 'local' }), /Production requires/)
    assert.throws(() => new Authentication(db, { NODE_ENV: 'production' }), /APP_ORIGIN/)
    assert.throws(() => new Authentication(db, { NODE_ENV: 'production', APP_ORIGIN: 'http://localhost' }), /HTTPS/)
    assert.throws(() => new Authentication(db, { NODE_ENV: 'production', APP_ORIGIN: 'https://manual.example' }), /Create an account/)
  } finally { db.close() }
})

test('password hashing, generic failures, expiry, throttling and reset revocation', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    const accounts = new Accounts(db), id = await accounts.provision('Alice', 'a long offline test password')
    const auth = new Authentication(db, { AUTH_MODE: 'password', APP_ORIGIN: 'https://manual.example' })
    assert.equal((await auth.login('missing', 'incorrect')).error, (await auth.login('alice', 'incorrect')).error)
    const session = await auth.login('ALICE', 'a long offline test password')
    assert.ok(session.token)
    const cookie = auth.cookie(session.token)
    assert.match(cookie, /__Host-manual_session=/)
    assert.match(cookie, /HttpOnly; SameSite=Strict/)
    assert.match(cookie, /; Secure$/)
    const req = { headers: { cookie } }
    assert.equal(auth.user(req).id, id)
    assert.equal(auth.validOrigin({ headers: { origin: 'https://evil.example' } }), false)
    assert.equal(auth.validOrigin({ headers: {} }), false)
    assert.equal(auth.validOrigin({ headers: { origin: 'https://manual.example' } }), true)
    db.prepare('UPDATE sessions SET expires=0').run()
    assert.equal(auth.user(req), null)
    const second = await auth.login('alice', 'a long offline test password')
    const secondReq = { headers: { cookie: auth.cookie(second.token) } }
    await accounts.provision('alice', 'a completely different password')
    assert.equal(auth.user(secondReq), null)
    db.prepare('INSERT OR REPLACE INTO login_limits VALUES(?,?,?)').run('user:alice', 10, Date.now() + 60000)
    assert.equal((await auth.login('alice', 'a completely different password')).status, 429)
    assert.equal(db.prepare('SELECT password FROM users').get().password.includes('different'), false)
  } finally { db.close() }
})

test('an in-flight old-password login cannot issue a session after an operator resets the password', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    const accounts = new Accounts(db), id = await accounts.provision('alice', 'the previous private password')
    await accounts.provision('replacement', 'the replacement private password')
    const auth = new Authentication(db, { AUTH_MODE: 'password', APP_ORIGIN: 'https://manual.example' })
    const pending = auth.login('alice', 'the previous private password')
    // Simulate the CLI reset transaction committing while scrypt is awaiting.
    db.prepare('UPDATE users SET password=(SELECT password FROM users WHERE username=?) WHERE id=?').run('replacement', id)
    assert.equal((await pending).status, 401)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0)
  } finally { db.close() }
})

test('private library, every film route, sessions across restart and logout', { timeout: 20000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'manual-auth-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const repo = new FilmRepository(join(dataDir, 'app.sqlite'), 'local'), accounts = new Accounts(repo.db)
  const alice = await accounts.provision('alice', 'alice offline test password')
  const bob = await accounts.provision('bob', 'bob offline test password')
  repo.save('alicesfilm', { ownerId: alice, finished: true }, [{ type: 'script', title: 'Lego house' }])
  repo.save('bobsfilm', { ownerId: bob, finished: true }, [])
  repo.close()
  const origin = 'http://localhost:8080', env = { MANUAL_DATA_DIR: dataDir, AUTH_MODE: 'password', APP_ORIGIN: origin }
  let server = await startServer(['--speed', '1000'], env)
  t.after(() => server.stop())
  const login = async (username, password) => {
    const response = await fetch(server.base + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) })
    assert.equal(response.status, 200)
    return response.headers.get('set-cookie').split(';')[0]
  }
  assert.equal((await fetch(server.base + '/api/films')).status, 401)
  assert.equal((await fetch(server.base + '/api/films/alicesfilm/photo')).status, 401)
  assert.equal((await fetch(server.base + '/api/films', { method: 'POST', headers: { Origin: origin } })).status, 401)
  assert.equal((await fetch(server.base + '/api/login', { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403)
  const cookie = await login('alice', 'alice offline test password')
  const library = await fetch(server.base + '/api/films', { headers: { Cookie: cookie } })
  assert.match(library.headers.get('cache-control'), /no-store/)
  assert.deepEqual((await library.json()).films.map(f => f.id), ['alicesfilm'])
  // Creating and reopening a real fixture uses no models and exercises durable owner propagation.
  const created = await fetch(server.base + '/api/films?example=lego', { method: 'POST', headers: { Cookie: cookie, Origin: origin } }).then(r => r.json())
  assert.ok(created.id)
  const stream = await fetch(`${server.base}/api/films/${created.id}/events`, { headers: { Cookie: cookie } })
  const reader = stream.body.getReader()
  let recorded = ''
  while (!recorded.includes('"type":"done"')) {
    const { done, value } = await reader.read()
    assert.equal(done, false)
    recorded += new TextDecoder().decode(value)
  }
  await reader.cancel()
  assert.ok((await fetch(server.base + '/api/films', { headers: { Cookie: cookie } }).then(r => r.json())).films.some(f => f.id === created.id && f.photo))
  const bobCookie = await login('bob', 'bob offline test password')
  for (const route of ['about', 'photo', 'prelude', 'events', 'program', 'screens/photo.png', 'artwork', 'refine', 'films?i=0']) {
    const method = /refine|films\?/.test(route) ? 'POST' : 'GET'
    assert.equal((await fetch(`${server.base}/api/films/alicesfilm/${route}`, { method, headers: { Cookie: bobCookie, Origin: origin } })).status, 404, route)
  }
  assert.equal((await fetch(`${server.base}/api/films/alicesfilm/artwork`, { method: 'POST', headers: { Cookie: bobCookie, Origin: origin } })).status, 404)
  assert.equal((await fetch(`${server.base}/api/films/${created.id}/photo`, { headers: { Cookie: bobCookie } })).status, 404)
  assert.equal((await fetch(server.base + '/api/films/alicesfilm/about', { headers: { Cookie: cookie } })).status, 200)
  await server.stop()
  server = await startServer([], env)
  assert.equal((await fetch(server.base + '/api/session', { headers: { Cookie: cookie } }).then(r => r.json())).user.id, alice)
  assert.equal((await fetch(`${server.base}/api/films/${created.id}/program?name=replay`, { headers: { Cookie: cookie } })).status, 200)
  const active = await fetch(`${server.base}/api/films/${created.id}/events`, { headers: { Cookie: cookie } })
  const activeReader = active.body.getReader()
  await activeReader.read()
  assert.equal((await fetch(server.base + '/api/logout', { method: 'POST', headers: { Cookie: cookie, Origin: origin } })).status, 200)
  assert.equal((await fetch(server.base + '/api/films', { headers: { Cookie: cookie } })).status, 401)
  let ended = false
  while (!ended) ended = (await activeReader.read()).done
})

test('account CLI explicitly claims old local films and keeps ownership after a checkpoint', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'manual-claim-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  // Exercise an actual old database with no ownership column.
  const db = new DatabaseSync(join(dir, 'app.sqlite'))
  db.exec(`CREATE TABLE films (id TEXT PRIMARY KEY,status TEXT,state TEXT,events TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO films(id,status,state,events) VALUES('legacy','completed','{"finished":true}','[]');`)
  db.close()
  const child = spawn(process.execPath, ['scripts/account.mjs', 'alice', '--claim-local-films'], { env: { ...process.env, MANUAL_DATA_DIR: dir }, stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  child.stdin.end('a private offline password\n')
  const [code] = await once(child, 'close')
  assert.equal(code, 0, output)
  assert.equal(output.includes('a private offline password'), false)
  const repo = new FilmRepository(join(dir, 'app.sqlite'), 'local')
  try {
    const owner = repo.owner('legacy')
    assert.notEqual(owner, 'local')
    repo.save('legacy', { finished: true, ownerId: 'local' }, [])
    assert.equal(repo.owner('legacy'), owner)
  } finally { repo.close() }
})
