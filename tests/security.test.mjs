import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { DatabaseSync } from 'node:sqlite'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { JobLimits } from '../src/server/job-limits.mjs'
import { spawnWorker } from '../src/server/job-worker.mjs'
import { FilmRepository } from '../src/server/repository.mjs'
import { startServer } from './support/server.mjs'
import { openDrawingBrowser, chromePresent, chromeExecutable } from '../benchmarks/drawing-chrome.mjs'
import { checkDemonstration } from '../src/film/demonstrations.mjs'
import { check as checkPanel } from '../src/pipeline/panel.mjs'
import { workerEnv } from '../src/server/job-worker.mjs'
import { createServer } from 'node:http'

const playerSource = readFileSync(new URL('../public/player.js', import.meta.url), 'utf8')
function player(standalone = false) {
  let receive
  const parent = {}, window = { parent, location: { href: 'https://manual.example/player.html' }, addEventListener: (_, handler) => { receive = handler } }
  if (standalone) window.parent = window
  const context = { window, parent, URL, document: { getElementById: () => ({ getContext: () => ({}) }) }, requestAnimationFrame() {} }
  parent.postMessage = () => {}
  runInNewContext(playerSource, context)
  return { window, context, receive }
}

test('player rejects foreign origins, unrelated windows and standalone messages before evaluating assets', async () => {
  const p = player(), data = { type: 'assets', kit: '(()=>{globalThis.marker=true;return ()=>({})})()', fonts: [] }
  await p.receive({ origin: 'https://evil.example', source: p.window.parent, data })
  await p.receive({ origin: 'https://manual.example', source: {}, data })
  assert.equal(p.context.marker, undefined)
  await p.receive({ origin: 'https://manual.example', source: p.window.parent, data })
  assert.equal(p.context.marker, true)
  assert.equal(player(true).receive, undefined)
})

test('HTTP sandbox preserves real playback and blocks hostile framing and direct-page messages', { skip: !chromePresent, timeout: 120000 }, async t => {
  const server = await startServer(); t.after(server.stop)
  const browser = await openDrawingBrowser(server.base, undefined, { renderModule: null }); t.after(browser.close)
  const probe = (url, legitimate) => `new Promise(resolve => {
    const frame = document.createElement('iframe');frame.style='position:fixed;inset:0;width:800px;height:450px;z-index:9999';frame.src=${JSON.stringify(url)};
    let ready=false; const listener=event=>{if(event.source!==frame.contentWindow)return;
      if(event.data.type==='ready'){ready=true;frame.contentWindow.postMessage({type:'program',source:'(ctx,t,env)=>ctx.fillRect(0,0,10,10)',duration:1,play:true},'*')}
      if(event.data.type==='error'){clearTimeout(timer);removeEventListener('message',listener);frame.remove();resolve(event.data.message)}
      if(event.data.type==='time'&&event.data.duration===1){clearTimeout(timer);removeEventListener('message',listener);frame.remove();resolve('played')}
    };
    addEventListener('message',listener);
    const timer=setTimeout(()=>{removeEventListener('message',listener);frame.remove();resolve(ready?'ready':'blocked')},${legitimate ? 5000 : 500});
    frame.onload=()=>frame.contentWindow.postMessage({type:'assets',kit:'()=>({style:"print"})',fonts:[]},'*');
    document.body.append(frame);
  })`
  assert.equal(await browser.evaluate(probe(server.base + '/player.html', true)), 'played')
  // A distinct origin frames the actual resource without an iframe sandbox attribute.
  const hostile = createServer((req, res) => { res.end('<!doctype html><title>Foreign parent</title>') })
  hostile.listen(0, '127.0.0.1'); await once(hostile, 'listening')
  t.after(() => { hostile.closeAllConnections(); hostile.close() })
  const attacker = await openDrawingBrowser(`http://127.0.0.1:${hostile.address().port}/`, undefined, { renderModule: null }); t.after(attacker.close)
  assert.equal(await attacker.evaluate(probe(server.base + '/player.html', false)), 'blocked')
  const direct = await openDrawingBrowser(server.base + '/player.html', undefined, { renderModule: null }); t.after(direct.close)
  assert.equal(await direct.evaluate(`new Promise(resolve=>{postMessage({type:'assets',kit:'(()=>{globalThis.marker=true;return ()=>({})})()',fonts:[]},'*');setTimeout(()=>resolve({opaque:self.origin==='null',executed:!!globalThis.marker}),100)})`).then(r => r.opaque && !r.executed), true)
})

test('admission reserves atomically, refunds invalid requests, preserves quotas across restarts and resets at UTC boundary', () => {
  const db = new DatabaseSync(':memory:'); let now = 1000
  const env = { MAX_ACTIVE_JOBS: '2', MAX_ACTIVE_JOBS_PER_USER: '1', DAILY_JOBS: '3', DAILY_JOBS_PER_USER: '2' }
  try {
    const limits = new JobLimits(db, env, () => now)
    const first = limits.reserve('alice', 'live')
    const replay = limits.reserve('alice', 'example'); replay.attach({})
    assert.equal(limits.active, 1)
    assert.throws(() => limits.reserve('alice', 'live'), e => e.status === 429)
    const second = limits.reserve('bob', 'live')
    const busyReplay = limits.reserve('alice', 'example'); busyReplay.attach({}); busyReplay.release()
    assert.equal(limits.active, 2, 'examples can open even when generation is full')
    assert.throws(() => limits.reserve('charlie', 'live'), e => e.status === 429)
    first.release(); first.release(); second.release()
    assert.equal(limits.active, 0)
    replay.release(); replay.release()
    assert.equal(limits.active, 0)
    assert.equal(limits.owners.size, 0)
    for (let i = 0; i < 2; i++) { const lease = limits.reserve('alice', 'live'); lease.attach({}); lease.release() }
    const restarted = new JobLimits(db, env, () => now)
    assert.throws(() => restarted.reserve('alice', 'live'), e => e.status === 429 && e.retryAfter > 0)
    const last = restarted.reserve('bob', 'live'); last.attach({}); last.release()
    assert.throws(() => restarted.reserve('charlie', 'live'), e => e.status === 429)
    const example = restarted.reserve('alice', 'example'); example.attach({}); example.release()
    now = 86400000
    restarted.reserve('alice', 'live').release()
    for (const value of ['0', '-1', 'NaN', '1.5', '']) assert.throws(() => new JobLimits(db, { MAX_ACTIVE_JOBS: value }), /integer/)
  } finally { db.close() }
})

test('every paid creation route rejects exhausted allowances before restoring files, creating jobs or making calls', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'manual-limits-')); t.after(() => rm(dir, { recursive: true, force: true }))
  const repo = new FilmRepository(join(dir, 'app.sqlite'), 'local')
  repo.save('source', { ownerId: 'local', finished: true }, [])
  const limit = new JobLimits(repo.db, { DAILY_JOBS: '1' })
  const lease = limit.reserve('local', 'live'); lease.attach({}); lease.release(); repo.close()
  const server = await startServer(['--live'], { MANUAL_DATA_DIR: dir, DAILY_JOBS: '1', MODEL_API_KEY: 'dummy', MODEL_BASE_URL: 'http://127.0.0.1:1/' })
  t.after(server.stop)
  for (const path of ['/api/films', '/api/films/source/refine', '/api/films/source/retry', '/api/films/source/films?i=0']) {
    const response = await fetch(server.base + path, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: 'unread body' })
    assert.equal(response.status, 429, path)
    assert.ok(Number(response.headers.get('retry-after')) > 0)
  }
  await server.stop()
  const check = new FilmRepository(join(dir, 'app.sqlite'), 'local')
  assert.equal(check.list('local').films.length, 1); check.close()
})

test('simultaneous examples bypass generation slots, retain hourly allowances and respect deadlines', async t => {
  const server = await startServer(['--speed', '0.001'], { JOB_TIMEOUT_SECONDS: '1', MAX_ACTIVE_JOBS: '1', HOURLY_EXAMPLES_PER_USER: '5' }); t.after(server.stop)
  const replies = await Promise.all(Array.from({ length: 5 }, () => fetch(server.base + '/api/films?example=wood8', { method: 'POST' })))
  const results = await Promise.all(replies.map(async response => ({ status: response.status, body: await response.json() })))
  assert.deepEqual(results.map(r => r.status), [200, 200, 200, 200, 200], JSON.stringify(results) + '\n' + server.child.serverErrors)
  const blocked = await fetch(server.base + '/api/films?example=wood8', { method: 'POST' })
  assert.equal(blocked.status, 429)
  assert.match((await blocked.json()).error, /allowance/)
  const id = results[0].body.id
  const events = await fetch(`${server.base}/api/films/${id}/events`)
  const reader = events.body.getReader(); let text = ''
  try {
    while (!text.includes('exceeded the job time limit')) { const next = await reader.read(); assert.equal(next.done, false); text += new TextDecoder().decode(next.value) }
  } finally { await reader.cancel() }
  assert.equal((await fetch(server.base + '/api/films?example=wood8', { method: 'POST' })).status, 429)
  const policy = (await fetch(server.base + '/player.html')).headers.get('content-security-policy')
  assert.match(policy, /sandbox allow-scripts;/); assert.match(policy, /frame-ancestors 'self'/); assert.doesNotMatch(policy, /allow-same-origin/)
})

test('worker deadline escalates termination and kills descendants even when they hold pipes open', { timeout: 10000 }, async () => {
  const source = `const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});console.log(c.pid);setInterval(()=>{},1000)`
  const child = spawnWorker(process.execPath, ['-e', source], { timeoutMs: 500, graceMs: 100 })
  let output = ''; child.stdout.on('data', data => { output += data })
  await once(child, 'close')
  assert.equal(child.timedOut, true)
  // (Windows has no graceful signal: the first stop ends it outright, so it never needs escalating)
  assert.equal(child.signalCode, process.platform === 'win32' ? 'SIGTERM' : 'SIGKILL')
  if (process.platform !== 'win32') {
    const pid = Number(output.trim()); assert.ok(pid > 0)
    // A killed child may briefly be a zombie awaiting the init reaper.
    if (process.platform === 'linux') {
      let stat
      try { stat = readFileSync(`/proc/${pid}/stat`, 'utf8') } catch (error) { assert.equal(error.code, 'ENOENT') }
      if (stat) assert.match(stat, /\) Z /)
    } else {
      // No /proc here: signal 0 reports whether it still exists, once the system has reaped it.
      const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
      for (let i = 0; i < 40 && alive(); i++) await new Promise(done => setTimeout(done, 50))
      assert.equal(alive(), false, 'descendant was killed')
    }
  }
})

test('demonstration checks cannot reach the host process through the vm global', () => {
  delete process.env.VM_ESCAPE_PROBE
  const draw = `(ctx, p, env, scene) => { const g = (function () { return this })();
    const F = g['con'+'structor']['con'+'structor']; F('this["pro"+"cess"].env.VM_ESCAPE_PROBE="reached"')(); scene.draw('a') }`
  assert.match(checkDemonstration({ actors: ['a'], draw }), /demonstration failed/)
  assert.equal(process.env.VM_ESCAPE_PROBE, undefined)
  assert.equal(checkDemonstration({ actors: ['a'], draw: `(ctx,p,env,scene) => { scene.draw('a') }` }), null)
})

test('panel checks accept only compiled diagrams, never evaluating legacy JavaScript', () => {
  delete process.env.PANEL_PROBE
  const answer = { panels: { steps: [0], labels: [], draw: '() => { process.env.PANEL_PROBE = "reached" }' } }
  assert.match(checkPanel(answer), /not a compiled diagram/)
  assert.equal(process.env.PANEL_PROBE, undefined)
})

test('worker processes do not inherit storage credentials', () => {
  const env = workerEnv({ MODEL_API_KEY: 'kept', PATH: '/bin', AZURE_STORAGE_CONNECTION_STRING: 'secret' })
  assert.deepEqual(env, { MODEL_API_KEY: 'kept', PATH: '/bin' })
})

test('the page CSP allows real playback of an example with no violations', { skip: !chromePresent, timeout: 120000 }, async t => {
  const server = await startServer(['--speed', '100']); t.after(server.stop)
  const browser = await openDrawingBrowser(server.base + '/examples', undefined, { renderModule: null }); t.after(browser.close)
  await browser.evaluate(`window.violations=[];document.addEventListener('securitypolicyviolation',e=>violations.push(e.violatedDirective+' '+e.blockedURI));
    new Promise(resolve=>{const timer=setInterval(()=>{const b=document.querySelector('#examples button');if(b){clearInterval(timer);b.click();resolve(true)}},20)})`)
  const played = await browser.evaluate(`new Promise(resolve=>{const stop=setTimeout(()=>resolve('no playback'),20000);const timer=setInterval(()=>{
    if(parseFloat(document.getElementById('fill').style.width)>0){clearInterval(timer);clearTimeout(stop);resolve('played')}},50)})`)
  assert.equal(played, 'played')
  assert.deepEqual(await browser.evaluate('violations'), [])
})

test('following the steps never scrolls the player out of view, which would pause it', { skip: !chromePresent, timeout: 120000 }, async t => {
  const server = await startServer(['--speed', '100']); t.after(server.stop)
  const { id } = await (await fetch(`${server.base}/api/films?example=groceries`, { method: 'POST' })).json()
  await new Promise(done => setTimeout(done, 1500))
  const browser = await openDrawingBrowser(`${server.base}/films/${id}`, undefined, { renderModule: null }); t.after(browser.close)
  await browser.viewport(1000, 300)
  await new Promise(done => setTimeout(done, 2000))
  await browser.evaluate(`(()=>{const s=document.getElementById('scrub');s.value=550;s.dispatchEvent(new Event('input'));return 1})()`)
  await new Promise(done => setTimeout(done, 1200))
  const box = await browser.evaluate(`(()=>{const r=document.querySelector('iframe').getBoundingClientRect();return {top:r.top,scrollY,step:[...document.getElementById('steps').children].findIndex(li=>li.classList.contains('on')),fill:parseFloat(document.getElementById('fill').style.width)}})()`)
  assert.ok(box.fill >= 50, `seek reached a step below the fold (${box.fill}%)`)
  assert.ok(box.step >= 0, 'a step is highlighted')
  assert.equal(box.scrollY, 0, 'the page did not scroll to follow the step')
  assert.ok(box.top >= 0, `player still at the top of the page: ${JSON.stringify(box)}`)
})

test('a worker group that has already finished is not an error, on any platform', async () => {
  const realKill = process.kill
  for (const code of ['ESRCH', 'EPERM']) {
    const child = spawnWorker(process.execPath, ['-e', ''], { timeoutMs: 5000 })
    await once(child, 'spawn')
    process.kill = () => { throw Object.assign(new Error(`kill ${code}`), { code }) }
    try { assert.doesNotThrow(() => child.stopWorker()) } finally { process.kill = realKill }
    await once(child, 'close')
  }
})

test('Chrome is found where each platform installs it', () => {
  const found = (...paths) => (path) => paths.includes(path)
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  assert.equal(chromeExecutable({}, 'darwin', found(mac)), mac)
  assert.equal(chromeExecutable({}, 'darwin', found()), null)
  const win = join('C:\\PF', 'Google', 'Chrome', 'Application', 'chrome.exe')
  assert.equal(chromeExecutable({ PROGRAMFILES: 'C:\\PF' }, 'win32', found(win)), win)
  assert.equal(chromeExecutable({ CHROME_BIN: '/custom/chrome' }, 'darwin', found()), '/custom/chrome')
  assert.equal(chromeExecutable({ PATH: '/usr/bin' }, 'linux', found(join('/usr/bin', 'chromium'))), join('/usr/bin', 'chromium'))
})
