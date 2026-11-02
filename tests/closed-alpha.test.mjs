import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { Accounts } from '../src/server/auth.mjs'
import { FilmRepository } from '../src/server/repository.mjs'
import { spawnServer } from './support/server.mjs'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { openDrawingBrowser } from '../benchmarks/drawing-chrome.mjs'

async function hosted(t) {
  const dir = await mkdtemp(join(tmpdir(), 'manual-alpha-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const repo = new FilmRepository(join(dir, 'app.sqlite'), 'local')
  const owner = await new Accounts(repo.db).provision('tester', 'closed alpha offline password')
  repo.save('existing', { ownerId: owner, finished: true }, [])
  repo.close()
  // Password mode on loopback exercises hosted access control without real Azure/TLS.
  const listener = createServer()
  listener.listen(0, '127.0.0.1'); await once(listener, 'listening')
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  const base = `http://127.0.0.1:${port}`
  const child = spawnServer(['--port', String(port), '--live'], { MANUAL_DATA_DIR: dir, AUTH_MODE: 'password', APP_ORIGIN: base, MODEL_BASE_URL: 'http://127.0.0.1:1/' })
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const closed = once(child, 'close'); child.kill('SIGTERM'); await closed
  }
  t.after(stop)
  await new Promise((resolve, reject) => {
    child.stdout.on('data', data => { if (/localhost:\d+/.test(String(data))) resolve() })
    child.once('error', reject); child.once('exit', () => reject(Error(child.serverErrors)))
  })
  return { base, stop, dir }
}

test('Closed Alpha has no account-creation API and every signed-out project creation route is denied before work starts', async t => {
  const server = await hosted(t), headers = { Origin: server.base, 'Content-Type': 'application/json' }
  const projectRoutes = ['/api/films', '/api/films?example=wood8', '/api/films/existing/refine', '/api/films/existing/retry', '/api/films/existing/films?i=0']
  for (const path of projectRoutes) {
    const response = await fetch(server.base + path, { method: 'POST', headers, body: JSON.stringify({ message: 'Make another project' }) })
    assert.equal(response.status, 401, path)
    assert.match((await response.json()).error, /sign in/i)
  }
  const accountRoutes = ['/api/register', '/api/signup', '/api/accounts', '/api/users']
  const attemptSignup = async cookie => {
    for (const path of accountRoutes) assert.equal((await fetch(server.base + path, {
      method: 'POST', headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify({ username: 'outsider', password: 'must never become an account' }),
    })).status, 404, path)
  }
  await attemptSignup()
  const login = await fetch(server.base + '/api/login', { method: 'POST', headers, body: JSON.stringify({ username: 'tester', password: 'closed alpha offline password' }) })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  await attemptSignup(cookie)
  assert.equal((await fetch(server.base + '/api/films', { headers: { Cookie: cookie } })).status, 200)
  await fetch(server.base + '/api/logout', { method: 'POST', headers: { ...headers, Cookie: cookie } })
  for (const path of projectRoutes) assert.equal((await fetch(server.base + path, { method: 'POST', headers: { ...headers, Cookie: cookie } })).status, 401, path)
  await server.stop()
  const check = new FilmRepository(join(server.dir, 'app.sqlite'), 'local')
  try {
    assert.equal(check.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1)
    assert.equal(check.db.prepare('SELECT COUNT(*) AS n FROM films').get().n, 1)
    assert.equal(check.db.prepare('SELECT COUNT(*) AS n FROM job_allowances').get().n, 0)
  } finally { check.close() }
})

const chromePresent = spawnSync(process.env.CHROME_BIN || 'google-chrome', ['--version']).status === 0
test('Closed Alpha screen links to X, hides project creation, and lets provisioned users sign in on mobile', { skip: !chromePresent, timeout: 30000 }, async t => {
  const server = await hosted(t)
  const browser = await openDrawingBrowser(server.base, undefined, { renderModule: null }); t.after(browser.close)
  await browser.viewport(390, 844)
  await browser.evaluate(`new Promise(resolve=>{const timer=setInterval(()=>{if(!document.getElementById('sign-in').hidden){clearInterval(timer);resolve(true)}},20)})`)
  const screen = await browser.evaluate(`({
    badge:document.getElementById('release-status').textContent,
    badgeVisible:!document.getElementById('release-status').hidden,
    contact:document.querySelector('#alpha-access a').href,
    label:document.querySelector('#alpha-access a').textContent,
    visibleMain:[...document.querySelectorAll('main')].filter(n=>!n.hidden).map(n=>n.id),
    libraryHidden:document.getElementById('library').hidden,
    overflow:document.documentElement.scrollWidth>innerWidth
  })`)
  assert.equal(screen.badge, 'Closed Alpha'); assert.equal(screen.badgeVisible, true)
  assert.equal(screen.contact, 'https://x.com/josendev'); assert.equal(screen.label, '@josendev on X')
  assert.deepEqual(screen.visibleMain, ['sign-in']); assert.equal(screen.libraryHidden, true); assert.equal(screen.overflow, false)
  await browser.evaluate(`document.getElementById('login-username').value='tester';document.getElementById('login-password').value='closed alpha offline password';document.getElementById('login-form').requestSubmit();true`)
  const deadline = Date.now() + 10000
  let signedIn = false
  while (Date.now() < deadline && !signedIn) {
    try { signedIn = await browser.evaluate(`!document.getElementById('home').hidden`) } catch { /* Navigation replaces the JS context. */ }
    if (!signedIn) await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.equal(signedIn, true, 'operator-provisioned account signs in through the real form')
  assert.equal(await browser.evaluate(`document.getElementById('sign-in').hidden && !document.getElementById('release-status').hidden && !document.getElementById('library').hidden && document.documentElement.scrollWidth<=innerWidth`), true)
})
