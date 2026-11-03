import { fileURLToPath } from 'node:url'
import { drawingStyle as selectDrawingStyle } from '../pipeline/drawing-style.mjs'
import { namedDrawing, editDrawing, drawingMetrics } from '../pipeline/drawing-format.mjs'
// The web app's server: the phone page (web/), and each film as it is made, streamed to the page. The page plays the
// film in the browser (public/player.js) once its layout and required object drawings are ready. Faces, panels and
// finales that arrive afterwards rebuild the program (film.mjs) at the player's current time.
//   node server.mjs [--port 8080] [--host 127.0.0.1] [--live] [--speed 1] [--effort minimal] [--drawing-style layered] [--no-thinking]
// Examples (the saved fixtures) replay a real run's recorded timings (timings.json's marks), with no model calls.
// --live also takes a photo from the page and runs the whole pipeline on it (run.mjs, real model calls: it costs).
// --host 0.0.0.0: reachable from a phone on the same network (with --live, anyone there can spend on models).
// --speed: examples replay that many times faster (for working on the page; the default is the recorded pace).
// --effort: base reasoning effort: minimal (the default), low, medium, high, xhigh or max.
// Stages have separate defaults/overrides in efforts.mjs. --no-thinking forces every stage to minimal.
//
// A film's events (GET /api/films/<id>/events, server-sent):
//   state {ready, finished}   current availability before the saved event history
//   stage {name, at}           a pipeline mark, seconds from the start
//   objects {objects}          what was found in the photo: [{key, name}]
//   script {title, sub, ideas, pick, steps: [{t, c}]}
//   film {duration, starts, finale, screens}    layout and object drawings are ready (screens: pictures to load)
//   update {what, key}         something came in: ask for the program again
//   revised {title, sub, steps, duration?, starts?, finale?}   the plan's repair came in before the first step: the
//                              film's plan now (its times once the film plays; an update follows)
//   done {}  failed {message}
// GET /api/films/<id>/program?name=live|replay&t=<the player's time>: {source, duration}. Whatever came in since the
// last ask is counted as arriving at t, so a drawing cross-fades in from where the viewer is.
//   project {i, project}       a photo film's catalogue (run.mjs writes it beside the film): one more thing to make
// POST /api/films/<id>/films?i=<n> (--live) makes catalogue project n's film, on the same objects and cut-outs, and
// answers {id}. It is a film like any other and shares the first film's catalogue (its project events, so far and to
// come). GET /api/films/<id>/about: {root, pick} — the film whose catalogue this is, and which project this film is.
import express from 'express'
import { JobLimits } from './job-limits.mjs'
import { spawnWorker, workerEnv } from './job-worker.mjs'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readRun, filmProgram } from '../film/film.mjs'
import { relayout } from '../pipeline/relayout.mjs'
import { prelude } from '../film/engine.mjs'
import { addGuidance } from '../pipeline/guidance.mjs'
import { stageEfforts, effortArgs } from '../pipeline/efforts.mjs'
import { FilmRepository } from './repository.mjs'
import { Authentication } from './auth.mjs'
import { apiAccess } from './api-access.mjs'
import { configuredFiles, FilmFiles } from './storage.mjs'
import { serveBenchmarkPage } from './benchmark-site.mjs'
import { requiredDrawingKeys, drawingFailure, usableDrawing } from '../pipeline/artwork.mjs'
import { withTools } from '../solvers/tools.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const args = process.argv.slice(2)
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const PORT = +flag('--port', 8080), HOST = flag('--host', '127.0.0.1'), LIVE = args.includes('--live'), SPEED = +flag('--speed', 1) || 1
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const EFFORT = flag('--effort', 'minimal')
if (!EFFORTS.includes(EFFORT)) { console.error(`--effort must be one of ${EFFORTS.join(', ')}`); process.exit(1) }
// The plan's own effort (--plan-effort or PLAN_EFFORT), the rest's by default. Measured Oct 28: at low the planner
// thought 4,600 tokens before its first object (44 s against ~6 s at minimal), holding up the cut-outs and everything
// after; the plan's design block carries its reasoning at minimal.
const PLAN_EFFORT = flag('--plan-effort', process.env.PLAN_EFFORT || EFFORT)
if (!EFFORTS.includes(PLAN_EFFORT)) { console.error(`--plan-effort must be one of ${EFFORTS.join(', ')}`); process.exit(1) }
const STAGE_EFFORTS = stageEfforts(args), DRAWING_STYLE = selectDrawingStyle(args)
const pipeline = join(here, '../pipeline'), web = join(here, '../../public'), assets = join(here, '../../assets')
const fixtures = resolve(flag('--examples-dir', join(here, '../../examples/published')))
const dataDir = resolve(process.env.MANUAL_DATA_DIR || join(here, '../../data'))
mkdirSync(dataDir, { recursive: true, mode: 0o700 })
const files = await configuredFiles(process.env, dataDir)
try { await files.init() } catch { throw Error('Could not initialize file storage; check its configuration and permissions') }
const repository = new FilmRepository(join(dataDir, 'app.sqlite'), files.identity)
const authentication = new Authentication(repository.db, process.env)
repository.interruptRunning()
const jobLimits = new JobLimits(repository.db, process.env)
const archive = new FilmFiles(repository, files)
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.ttf': 'font/ttf', '.json': 'application/json', '.svg': 'image/svg+xml' }
// The player runs model-written code: its document is sandboxed (public/index.html's iframe) and may load nothing but its
// own script.
const PLAYER_POLICY = "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-eval'; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'"
// Everything else: only this app's own scripts. Styles stay inline-capable for computed layout; drawings use data/blob images.
const APP_POLICY = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'"
// Event streams are cheap until they are not: bound how many are open, and drop a client too slow to drain its buffer.
const MAX_STREAMS = 256, MAX_STREAMS_PER_USER = 32, MAX_STREAM_BUFFER = 8e6, STREAM_HEARTBEAT_MS = 25000
// The fonts the kit and the engine name (assets/fonts).
const FONTS = readdirSync(join(assets, 'fonts')).filter((f) => f.endsWith('.ttf')).map((f) => {
  const [, name, weight] = /^(.+)-(\d+)\.ttf$/.exec(f)
  const family = { inter: 'Inter', 'jetbrains-mono': 'JetBrains Mono', 'dm-serif-display': 'DM Serif Display' }[name] || name
  return { family, weight: +weight, url: `/assets/fonts/${f}` }
})

const examples = () => readdirSync(fixtures).filter((name) => existsSync(join(fixtures, name, 'timings.json'))).map((name) => {
  const script = JSON.parse(readFileSync(join(fixtures, name, 'script.json'), 'utf8'))
  return { name, title: script.title, sub: script.sub, photo: `/api/examples/${name}/photo.png` }
})

// A plan's steps as the page lists them: each title and caption (a counted caption's template).
const stepsOf = (script) => (script.steps || []).map((x) => ({ t: x.t, c: typeof x.c === 'string' ? x.c : x.c?.template ?? '' }))

// Something being made whose events the page follows: every event kept, so a page that joins late hears them all.
class Stream {
  constructor(runDir, registry, id) {
    Object.assign(this, { id, runDir, events: [], clients: new Set(), marks: {}, finished: false })
    registry.set(this.id, this)
  }
  send(type, data = {}) {
    const event = { type, ...data }
    this.events.push(event)
    this.broadcast(event)
    this.queueCheckpoint?.()
  }
  broadcast(event) {
    for (const res of this.clients) {
      try {
        res.authorize()
        if (res.writableLength > MAX_STREAM_BUFFER) { res.destroy(); continue }
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      } catch { res.end() }
    }
  }
  read(path) { return JSON.parse(readFileSync(join(this.runDir, path), 'utf8')) }

}

// ---- a film being made: its run folder, the marks so far, and what has come in ----
const jobs = new Map()
class Job extends Stream {
  constructor(runDir, { example = null, root = null, pick = null, previous = null, guidance = null, ownerId = 'local', admission = null } = {}, restored = null) {
    const id = restored?.id || randomUUID().replaceAll('-', '')
    runDir ||= archive.allocate(id)
    mkdirSync(runDir, { recursive: true })
    super(runDir, jobs, id)
    Object.assign(this, { ownerId, example, run: null, root, pick, previous, guidance, children: new Set(), projects: [], objects: null,
      // what has come in: key → value, and key → the film time it counts from (set at the next program ask)
      vectors: {}, faces: {}, panel: null, finale: null, pending: new Set(), filmAt: {} })
    if (!restored) repository.save(this.id, this.snapshot(), [])
    admission?.attach(this)
  }
  snapshot() {
    return { ownerId: this.ownerId, example: this.example, rootId: this.root?.id || null, pick: this.pick, previous: this.previous,
      guidance: this.guidance, marks: this.marks, projects: this.projects, objects: this.objects,
      catalogueDone: !!this.catalogueDone, filmAt: this.filmAt, pending: [...this.pending], ready: !!this.run,
      drawingKeys: Object.keys(this.vectors), faceKeys: Object.keys(this.faces), panelReady: !!this.panel,
      finaleReady: !!this.finale, finished: this.finished, status: this.status || 'running' }
  }
  persist() {
    // A repair can rewrite script/layout files before its revised mark. Store the coherent pair currently playing.
    const overrides = {}
    if (this.run) {
      overrides['script.json'] = Buffer.from(JSON.stringify(this.run.script))
      if (this.run.layout) overrides['layout.json'] = Buffer.from(JSON.stringify(this.run.layout))
    }
    return archive.commit(this.id, this.runDir, structuredClone(this.snapshot()), structuredClone(this.events), overrides)
  }
  queueCheckpoint() {
    if (this.finishing) return
    if (this.finished) { repository.save(this.id, this.snapshot(), this.events); return }
    clearTimeout(this.checkpointTimer)
    this.checkpointTimer = setTimeout(() => {
      this.persist().catch(() => console.error(`File checkpoint failed for film ${this.id}`))
    }, 100)
  }
  finish(error) { return this.finishPromise ||= this.finishStored(error) }
  async finishStored(error) {
    this.finishing = true; clearTimeout(this.checkpointTimer)
    for (const timer of this.exampleTimers || []) clearTimeout(timer)
    try {
      if (!this.run && 'layout' in this.marks) {
        this.loadRun()
        if (this.run) this.publishFilm()
        else if (!error) { console.error(`Could not read the finished film ${this.id}:`, this.runError); error = 'Could not read the finished film. Please try again.' }
      }
      const missing = this.missingDrawings()
      if (!error && this.run && missing.length) error = drawingFailure(missing)
      await this.persist()
      this.finished = true; this.status = error ? 'failed' : 'completed'
      const event = error ? { type: 'failed', message: error } : { type: 'done' }
      repository.save(this.id, this.snapshot(), [...this.events, event])
      this.events.push(event); this.broadcast(event)
    } catch {
      this.finished = true; this.status = 'failed'
      const event = { type: 'failed', message: 'Could not save the film files. Please try again.' }
      const previous = repository.get(this.id)
      repository.save(this.id, { ...previous.state, finished: true, status: 'failed' }, [...previous.events, event])
      this.events.push(event); this.broadcast(event)
    } finally { this.releaseSource?.(); archive.finished(this.id); this.finishing = false; this.admission?.release() }
  }
  // The run, once its layout is marked. A live run goes on writing (timings.json last) while the server is still
  // reading its marks, so a read can meet a half-written file: it is tried again at each later mark and at the finish,
  // when every file is complete. (A film that never loaded was once finished as done, with no film.)
  loadRun() {
    try { this.run = readRun(this.runDir) } catch (error) { this.runError = error; return }
    this.runError = null
    const saved = this.example ? this.saved : null
    // (an example's panel and faces that were written after its run have no marks: they were in from the start)
    if (saved) {
      if (saved.panel && !('panel: checked' in saved.marks)) this.panel = saved.panel
      for (const [k, f] of Object.entries(saved.faces)) if (!(`face: ${k}` in saved.marks)) this.faces[k] = f
      if (saved.reveal) this.finale = saved.reveal
    } else if (this.run.reveal) this.finale = this.run.reveal
  }
  arrived(what, key, value) {
    if (value == null) return
    if (what === 'drawing') this.vectors[key] = value
    else if (what === 'face') this.faces[key] = value
    else this[what] = value
    this.pending.add(`${what}:${key ?? ''}`)
    this.send('update', { what, key })
  }
  // A pipeline mark: what it means for the page. (Examples have everything on disk from the start; a live run writes
  // each piece just before its mark.)
  mark(name, at) {
    this.marks[name] = at
    this.send('stage', { name, at })
    const saved = this.example ? this.saved : null
    let m
    if ((m = /^project: (\d+)$/.exec(name))) {
      // the catalogue beside the film: to this film and every film picked from it
      const i = +m[1], project = this.read(`catalogue/projects/${i}.json`)
      this.objects ??= this.maybe('catalogue/objects.json')
      this.projects[i] = project
      for (const job of [this, ...this.children]) job.send('project', { i, project })
    } else if (name === 'catalogue: done' || name === 'catalogue: empty' || name.startsWith('catalogue: FAILED')) {
      this.catalogueDone = true
      for (const job of [this, ...this.children]) job.send('catalogue', { done: true, failed: name.includes('FAILED'), empty: !this.projects.some(Boolean) })
    } else if (name === 'script: object list') {
      const boxes = existsSync(join(this.runDir, 'screens/boxes.json')) ? this.read('screens/boxes.json').objects : []
      this.send('objects', { objects: boxes.map((o) => ({ key: o.key, name: o.name })) })
    } else if (name === 'script: done' && existsSync(join(this.runDir, 'script.json'))) {
      const s = this.read('script.json')
      this.send('script', { mode: s.mode || 'physical', title: s.title, sub: s.sub, ideas: s.ideas || [], pick: s.pick || 0, steps: stepsOf(s), ...(s.mode === 'problem' ? { problem: s.problem } : {}) })
    } else if (name === 'script: revised' && existsSync(join(this.runDir, 'script.json'))) {
      // The plan's repair, taken before the film's first step (run.mjs): its steps, and once the film is playing, its
      // times and a new program, which the player takes over where it is.
      const s = this.read('script.json')
      if (!this.run) this.send('revised', { title: s.title, sub: s.sub, steps: stepsOf(s) })
      else {
        this.run = readRun(this.runDir)
        if (this.run.reveal) this.finale = this.run.reveal
        const { times } = this.run
        this.send('revised', { title: s.title, sub: s.sub, steps: stepsOf(this.run.script), duration: times.duration, starts: times.starts, finale: times.finale })
        this.pending.add('plan:'); this.send('update', { what: 'plan' })
      }
    } else if (name === 'layout') {
      this.loadRun()
    } else if (name.startsWith('drawing: ') && !name.endsWith('FAILED')) {
      const key = name.slice(9)
      this.arrived('drawing', key, saved ? saved.vectors[key] : this.maybe(`draw/${key}/drawing.json`))
    } else if (name.startsWith('face: ')) {
      const key = name.slice(6)
      this.arrived('face', key, saved ? saved.faces[key] : this.maybe(`faces/${key}/face.json`))
    } else if (name === 'panel: checked') this.arrived('panel', null, saved ? saved.panel : this.maybe('panel/panel.ok.json'))
    else if (name === 'finale: checked' && !(saved || this.run)?.reveal) {
      const file = join(this.runDir, 'finale/finale.ok.js')
      this.arrived('finale', null, saved ? saved.finale : existsSync(file) ? readFileSync(file, 'utf8') : null)
    }
    if (!this.run && name !== 'layout' && 'layout' in this.marks) this.loadRun()
    this.publishFilm()
  }
  requiredDrawings() {
    if (!this.run || this.run.script.mode === 'problem') return []
    const { geometry } = withTools(this.run.script, this.run.rawGeometry, this.run.cutSizes, {})
    return requiredDrawingKeys(this.run.layout, geometry)
  }
  missingDrawings() { return this.requiredDrawings().filter(key => !usableDrawing(this.vectors[key])) }
  get playable() {
    return !!this.run && !this.missingDrawings().length &&
      (!this.requiredDrawings().length || 'drawings: all' in this.marks)
  }
  publishFilm() {
    if (this.events.some(e => e.type === 'film') || !this.playable) return
    this.admission?.releaseOwner()
    const { screens, times } = this.run
    this.send('film', { duration: times.duration, starts: times.starts, finale: times.finale,
      steps: stepsOf(this.run.script),
      screens: Object.fromEntries(Object.entries(screens).map(([k, s]) => [k, { width: s.width, height: s.height, regions: s.regions || [], url: `/api/films/${this.id}/screens/${encodeURIComponent(k)}.png` }])) })
  }
  maybe(path) { try { return this.read(path) } catch { return null } }
  // The program for the player at film time t (or the replay: everything from the start).
  program(name, t) {
    if (!this.run) throw Object.assign(new Error('The layout is not ready yet.'), { status: 409 })
    if (!this.playable) throw Object.assign(new Error('The object drawings are not ready. Wait for generation to finish or retry if it fails.'), { status: 409 })
    for (const p of this.pending) if (!(p in this.filmAt)) this.filmAt[p] = name === 'live' && !p.startsWith('drawing:') ? t : 0
    this.pending.clear()
    const at = (what, key) => name === 'replay' || what === 'drawing' ? 0 : this.filmAt[`${what}:${key ?? ''}`] ?? 0
    const { times } = this.run
    // A face that comes in while its part is on screen waits for the next step.
    const faceAt = (k) => {
      const arrived = at('face', k), on = times.acts.find((a) => a.v === 'place' && a.k === k)?.at ?? 0
      return arrived <= on ? 0 : times.starts.find((s) => s >= arrived) ?? arrived
    }
    this.queueCheckpoint()
    const run = { ...this.run, panel: this.panel, finale: this.finale }
    return filmProgram(run, { name, vectors: this.vectors, drawingAt: (k) => (k in this.vectors ? at('drawing', k) : Infinity),
      faces: this.faces, faceAt, finaleAt: this.finale ? at('finale') : Infinity, panelAt: this.panel ? at('panel') : Infinity })
  }
}

// Rehydrate durable films on demand; a restart never replays paid pipeline work.
async function getJob(id) {
  let job = jobs.get(id)
  if (job) { await archive.ensure(id); return job }
  const record = repository.get(id)
  if (!record) return null
  const dir = await archive.ensure(id)
  if (jobs.has(id)) return jobs.get(id)
  const state = record.state
  job = new Job(dir, { ...state, ownerId: repository.owner(id) }, record)
  Object.assign(job, { events: record.events, finished: state.finished, status: record.status,
    marks: state.marks || {}, projects: state.projects || [], objects: state.objects, catalogueDone: state.catalogueDone,
    filmAt: state.filmAt || {}, pending: new Set(state.pending || []) })
  if (state.ready) {
    job.run = readRun(dir)
    for (const key of state.drawingKeys || []) {
      const value = job.maybe(`draw/${key}/drawing.json`) || job.run.vectors[key]
      if (value) job.vectors[key] = value
    }
    for (const key of state.faceKeys || []) {
      const value = job.maybe(`faces/${key}/face.json`) || job.run.faces[key]
      if (value) job.faces[key] = value
    }
    job.panel = state.panelReady ? job.run.panel : null
    job.finale = state.finaleReady ? job.run.finale : null
  }
  if (state.rootId) { job.root = await getJob(state.rootId); job.root?.children.add(job) }
  // Older runs may have released a traced film before their drawings failed.
  if (job.run && !job.playable) {
    job.events = job.events.filter(e => e.type !== 'film' && e.type !== 'done' && e.type !== 'failed')
    if (job.finished) job.events.push({ type: 'failed', message: drawingFailure(job.missingDrawings()) })
  }
  return job
}

// An example: the fixture copied (filmDrawings may trace into it) and laid out again, its recorded marks played back
// at their times.
async function startExample(name, ownerId, admission) {
  const job = new Job(null, { example: name, ownerId, admission }), runDir = job.runDir
  cpSync(join(fixtures, name), runDir, { recursive: true })
  relayout(runDir) // (laid out by today's solvers, as a fresh run would be)
  const full = readRun(runDir)
  job.saved = { ...full, marks: { ...full.timings.marks } }
  // (a problem film saved before its layout was marked in time loads where its plan was done, or it never plays)
  if (full.script.mode === 'problem' && !('layout' in job.saved.marks) && 'script: done' in job.saved.marks) job.saved.marks.layout = job.saved.marks['script: done']
  await job.persist()
  const marks = Object.entries(job.saved.marks).sort((a, b) => a[1] - b[1])
  const last = marks.at(-1)?.[1] ?? 0
  job.exampleTimers = marks.map(([mark, at]) => setTimeout(() => { if (!job.finished && !job.finishing) job.mark(mark, at) }, (at * 1000) / SPEED))
  job.exampleTimers.push(setTimeout(() => job.finish(), (last * 1000) / SPEED + 50),
    setTimeout(() => job.finish('This manual exceeded the job time limit.'), jobLimits.timeoutMs))
  return job
}

// A child process (run.mjs) whose marks ("  12.34s  name") are the stream's marks, as they happen.
function follow(stream, script, argv) {
  if (stopping) { stream.finish('Generation was interrupted by server shutdown.'); return stream }
  const child = spawnWorker(process.execPath, [join(pipeline, script), ...argv], { cwd: pipeline, timeoutMs: jobLimits.timeoutMs, env: workerEnv(process.env) })
  stream.child = child
  child.on('error', () => stream.finish('Could not start the generation process.'))
  let out = '', log = ''
  child.stdout.on('data', (chunk) => {
    out = (out + chunk).slice(-65536); log = (log + chunk).slice(-1000000)
    let line
    while ((line = out.indexOf('\n')) >= 0) {
      const text = out.slice(0, line); out = out.slice(line + 1)
      const m = /^\s*([\d.]+)s {2}(.+)$/.exec(text)
      if (m && !stream.finishing && !stream.finished) { try { stream.mark(m[2].trim(), +m[1]) } catch (error) { console.error(`Could not process the mark "${m[2].trim()}":`, error) } }
    }
  })
  child.stderr.on('data', (chunk) => { log = (log + chunk).slice(-1000000) })
  child.on('close', (code) => {
    if (stream.finished || stream.finishing) return
    writeFileSync(join(stream.runDir, 'server.log'), log)
    let failure
    try { failure = JSON.parse(readFileSync(join(stream.runDir, 'failure.json'), 'utf8')).message } catch {}
    stream.finish(child.timedOut ? 'This manual exceeded the job time limit.' : stopping ? 'Generation was interrupted by server shutdown. No model calls were retried.' : code === 0 ? null : (failure || log.trim().split('\n').at(-1) || `${script} exited ${code}`).slice(0, 300))
  })
  return stream
}
const upload = (runDir, photoBytes, type) => {
  mkdirSync(runDir, { recursive: true })
  const photo = join(runDir, `upload${{ 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic' }[type] || '.jpg'}`)
  writeFileSync(photo, photoBytes)
  return photo
}

// A photo straight to a film: the whole pipeline (run.mjs), the planner choosing the project.
function guidanceArgs(runDir, guidance) {
  if (!guidance) return []
  const file = join(runDir, 'guidance.json')
  writeFileSync(file, JSON.stringify(guidance, null, 1))
  return ['--guidance', file]
}
async function startLive(photoBytes, type, guidance, ownerId, admission, authorize) {
  authorize()
  const job = new Job(null, { guidance, ownerId, admission }), runDir = job.runDir, photo = upload(runDir, photoBytes, type)
  try { await job.persist() } catch { await job.finish('Could not save the upload.'); throw Error('Could not save the upload.') }
  authorize()
  return follow(job, 'run.mjs', [photo, runDir, '--effort', EFFORT, ...effortArgs(STAGE_EFFORTS), '--drawing-style', DRAWING_STYLE, ...guidanceArgs(runDir, guidance)])
}

// A correction gets a separate film so the original stays available. Re-read the photo: the feedback may correct
// the very inventory segmentation relied on. The pipeline reuses cut-outs only if perception is unchanged.
function startRefinement(source, message, admission) {
  const messages = addGuidance(source.guidance?.messages, message)
  const photo = join(source.runDir, source.example ? 'screens/photo.png' : 'script/photo.png')
  if (!existsSync(photo)) throw Object.assign(new Error('The photo is not ready yet. Try again in a moment.'), { status: 409 })
  const guidance = { messages, previousPlan: source.maybe('script.json') || source.guidance?.previousPlan || null }
  const job = new Job(null, { previous: source.id, guidance, ownerId: repository.owner(source.id), admission }), runDir = job.runDir
  archive.pin(source.id); job.releaseSource = () => archive.unpin(source.id)
  return follow(job, 'run.mjs', [photo, runDir, '--effort', EFFORT, ...effortArgs(STAGE_EFFORTS), '--drawing-style', DRAWING_STYLE, '--reuse-from', source.runDir, ...guidanceArgs(runDir, guidance)])
}

function startRetry(source, admission) {
  // Before a plan and its cut-outs exist, retry through the normal planning path.
  if (!source.maybe('script.json') || !existsSync(join(source.runDir, 'screens/screens.json')) ||
      !existsSync(join(source.runDir, 'screens/geometry.json')))
    return startRefinement(source, 'Retry this manual with the same project and steps. Finish all required object drawings.', admission)
  const photo = join(source.runDir, source.example ? 'screens/photo.png' : 'script/photo.png')
  const job = new Job(null, { previous: source.id, guidance: source.guidance, ownerId: repository.owner(source.id), admission })
  const style = source.maybe('run-config.json')?.drawingStyle || 'classic'
  archive.pin(source.id); job.releaseSource = () => archive.unpin(source.id)
  return follow(job, 'run.mjs', [photo, job.runDir, '--effort', EFFORT, ...effortArgs(STAGE_EFFORTS),
    '--drawing-style', style, '--resume-from', source.runDir])
}

// A project picked from a film's catalogue: its own run, from that film's normalized photo, objects and cut-outs
// (run.mjs uses cut-outs it finds; if the first film's are not in yet, it makes its own).
function startPick(root, i, admission) {
  const job = new Job(null, { root, pick: i, guidance: root.guidance, ownerId: repository.owner(root.id), admission }), runDir = job.runDir
  archive.pin(root.id); job.releaseSource = () => archive.unpin(root.id)
  mkdirSync(join(runDir, 'script'), { recursive: true })
  for (const f of ['photo.png', 'photo.jpg']) cpSync(join(root.runDir, 'script', f), join(runDir, 'script', f))
  if (existsSync(join(root.runDir, 'screens/geometry.json'))) cpSync(join(root.runDir, 'screens'), join(runDir, 'screens'), { recursive: true })
  writeFileSync(join(runDir, 'idea.json'), JSON.stringify({ objects: root.objects, project: root.projects[i] }))
  root.children.add(job)
  for (const [k, project] of root.projects.entries()) if (project) job.send('project', { i: k, project })
  if (root.catalogueDone) job.send('catalogue', { done: true, empty: !root.projects.some(Boolean), failed: Object.keys(root.marks).some(name => name.startsWith('catalogue: FAILED')) })
  // (the first film's drawings of the same cut-outs are this one's: --drawings-from)
  return follow(job, 'run.mjs', [join(runDir, 'script/photo.png'), runDir, '--effort', EFFORT, ...effortArgs(STAGE_EFFORTS), '--drawing-style', DRAWING_STYLE, '--idea', join(runDir, 'idea.json'), '--drawings-from', root.runDir, ...guidanceArgs(runDir, root.guidance)])
}

// ---- HTTP ----
const sendFile = (res, file, headers = {}) => new Promise((done, fail) => {
  res.sendFile(file, { headers: { 'Cache-Control': 'no-cache', ...headers }, etag: false, lastModified: false }, error => {
    if (!error) return done()
    if ([403, 404].includes(error.status) && !res.headersSent) { res.status(404).send('Not found'); return done() }
    fail(error)
  })
})
const sendStored = async (res, job, path, authorize) => {
  const bytes = await archive.read(job.id, path)
  authorize()
  if (!bytes) { res.writeHead(404); return res.end('Not found') }
  res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream', 'Cache-Control': 'private, no-store' })
  res.end(bytes)
}
const sendJson = (res, data, status = 200) => {
  // A rejected request must refund its unused lease before the client can retry.
  // Attached jobs own their lease until completion; release() is idempotent.
  const admission = res.locals.context?.admission
  if (admission && !admission.job) admission.release()
  return res.status(status).json(data)
}
// Parse only after authorization/admission. Keep the upload deadline independent
// of Node's socket inactivity timeout, and reject compressed request bodies.
const body = (req, res, limit = 25e6, json = false) => new Promise((done, fail) => {
  const timer = setTimeout(() => { fail(new Error('Upload timed out.')); req.destroy() }, 30000)
  const parse = json ? express.json : express.raw
  parse({ type: () => true, limit, inflate: false, strict: false })(req, res, error => {
    clearTimeout(timer)
    if (error) fail(error)
    else done(req.body ?? (json ? undefined : Buffer.alloc(0)))
  })
})

// A stream's events, server-sent: everything so far, then each as it happens.
const openStreams = new Map()
let openStreamCount = 0
function listen(req, res, stream, authorize, userId) {
  authorize()
  const mine = openStreams.get(userId) || 0
  if (openStreamCount >= MAX_STREAMS || mine >= MAX_STREAMS_PER_USER) {
    res.setHeader('Retry-After', 30)
    return sendJson(res, { error: 'Too many open connections. Close another tab and try again.' }, 429)
  }
  openStreams.set(userId, mine + 1); openStreamCount++
  res.authorize = authorize
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'private, no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
  // Tell a returning page what is already available before replaying the event history.
  res.write(`data: ${JSON.stringify({ type: 'state', ready: stream.playable, finished: stream.finished })}\n\n`)
  for (const event of stream.events) res.write(`data: ${JSON.stringify(event)}\n\n`)
  stream.clients.add(res)
  authentication.watch(req, res, authorize)
  // A comment line keeps idle connections open through proxies; the page's EventSource ignores it.
  const heartbeat = setInterval(() => { if (res.writableLength > MAX_STREAM_BUFFER) res.destroy(); else res.write(': ping\n\n') }, STREAM_HEARTBEAT_MS)
  heartbeat.unref()
  res.on('close', () => {
    clearInterval(heartbeat); stream.clients.delete(res); openStreamCount--
    const left = openStreams.get(userId) - 1
    if (left > 0) openStreams.set(userId, left); else openStreams.delete(userId)
  })
}

const app = express()
app.disable('x-powered-by')
app.disable('etag')
app.enable('case sensitive routing')
app.enable('strict routing')
app.use((req, res, next) => {
  if (stopping) return sendJson(res, { error: 'Server shutting down.' }, 503)
  // Set first so every response has them; the player and comparison pages replace the CSP with their own.
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'same-origin')
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Content-Security-Policy', APP_POLICY)
  // For the service manager and reverse proxy: the process serves requests and its database answers.
  if (req.url === '/healthz' && ['GET', 'HEAD'].includes(req.method)) {
    repository.db.prepare('SELECT 1').get()
    res.setHeader('Cache-Control', 'no-store')
    return res.json({ ok: true })
  }
  let url, path
  try { url = new URL(req.url, 'http://localhost'); path = decodeURIComponent(url.pathname) }
  catch { return sendJson(res, { error: 'Invalid request URL.' }, 400) }
  if (serveBenchmarkPage(req, res, path)) return
  const isAPI = path === '/api' || path.startsWith('/api/')
  if (isAPI) {
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('Vary', 'Cookie')
  }
  const route = apiAccess(path)
  if (isAPI && !route) return sendJson(res, { error: 'No such API endpoint.' }, 404)
  const user = authentication.user(req)
  const authorize = () => {
    if (!route || route.access === 'public') return
    const current = authentication.user(req)
    if (!current || current.id !== user?.id) throw Object.assign(Error('Please sign in to create projects or open your saved films.'), { status: 401 })
    if (route.access === 'owner' && !repository.ownsFilm(route.filmId, current.id))
      throw Object.assign(Error('No such film.'), { status: 404 })
  }
  authorize()
  const methods = route?.methods || ['GET', 'HEAD']
  if (!methods.includes(req.method)) {
    res.setHeader('Allow', methods.join(', '))
    return sendJson(res, { error: 'Method not allowed.' }, 405)
  }
  const readBody = async limit => { const bytes = await body(req, res, limit); authorize(); return bytes }
  const readJson = async limit => { const value = await body(req, res, limit, true); authorize(); return value }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !authentication.validOrigin(req)) return sendJson(res, { error: 'Please use the app from its own address.' }, 403)
  // Route matching uses the same decoded path as the access policy, including
  // encoded aliases of player.html. Preserve literal reserved characters as data.
  req.url = path.split('/').map(encodeURIComponent).join('/') + url.search
  res.locals.context = { url, path, user, authorize, readBody, readJson }
  next()
})

// Every endpoint has the same admission cleanup, including parse errors and
// failed starts. Running jobs retain their lease until their own finish path.
const handle = handler => async (req, res) => {
  const context = res.locals.context
  const admission = context.admission
  try { await handler(req, res, context) }
  finally {
    if (admission && !admission.job) admission.release()
    else if (admission?.job && !admission.job.child && !admission.job.exampleTimers && !admission.job.finishPromise)
      await admission.job.finish('Could not start this manual.')
  }
}

app.get('/api/session', handle(async (req, res, { user }) => {
  return sendJson(res, { mode: authentication.mode, user })
}))

app.post('/api/login', handle(async (req, res) => {
  if (authentication.mode !== 'password') return sendJson(res, { error: 'Local development signs in automatically.' }, 400)
  let input
  try { input = await body(req, res, 4096, true) } catch { return sendJson(res, { error: 'Enter your username and password.' }, 400) }
  const result = await authentication.login(input?.username, input?.password)
  if (result.error) return sendJson(res, { error: result.error }, result.status)
  authentication.logout(req)
  res.setHeader('Set-Cookie', authentication.cookie(result.token))
  return sendJson(res, { ok: true })
}))

app.post('/api/logout', handle(async (req, res) => {
  authentication.logout(req)
  res.setHeader('Set-Cookie', authentication.cookie('', 0))
  return sendJson(res, { ok: true })
}))

app.use((req, res, next) => {
  const { path, url, user } = res.locals.context
  if (req.method === 'POST' && user) {
    const childRoute = /^\/api\/films\/(\w+)\/(retry|refine|films)$/.exec(path)
    if (childRoute && repository.owner(childRoute[1]) !== user.id) return sendJson(res, { error: 'No such film.' }, 404)
    const example = path === '/api/films' && url.searchParams.get('example')
    if (example && !examples().some(item => item.name === example)) return sendJson(res, { error: 'No such example.' }, 404)
    if (example || (LIVE && (path === '/api/films' || childRoute))) res.locals.context.admission = jobLimits.reserve(user.id, example ? 'example' : 'live')
  }
  next()
})

app.get('/api/films', handle(async (req, res, { url, user }) => {
  const offset = Number(url.searchParams.get('offset') || 0)
  if (!Number.isSafeInteger(offset) || offset < 0) return sendJson(res, { error: 'Invalid library page.' }, 400)
  return sendJson(res, repository.list(user.id, { offset }))
}))

app.get(['/', '/examples', '/examples/', '/terms', '/terms/', '/privacy', '/privacy/', /^\/films\/\w+\/?$/], handle(async (req, res) => {
  return sendFile(res, join(web, 'index.html'))
}))

app.get('/player.html', handle(async (req, res) => {
  return sendFile(res, join(web, 'player.html'), { 'Content-Security-Policy': PLAYER_POLICY })
}))

app.get('/api/config', handle(async (req, res) => {
  return sendJson(res, { live: LIVE, fonts: FONTS })
}))

app.get('/assets/kit.js', handle(async (req, res) => {
  return sendFile(res, join(here, '../kit/kit.js'))
}))

app.get('/drawing-format.mjs', handle(async (req, res) => {
  return sendFile(res, join(here, '../pipeline/drawing-format.mjs'))
}))

app.get('/thumbs.js', handle(async (req, res) => {
  return sendFile(res, join(here, '../film/thumbs.mjs'))
}))

app.use('/assets/fonts', express.static(join(assets, 'fonts'), { index: false, redirect: false, etag: false, lastModified: false, maxAge: 0, setHeaders: res => res.setHeader('Cache-Control', 'no-cache') }))

app.get('/api/examples', handle(async (req, res) => {
  return sendJson(res, examples())
}))

app.get('/api/examples/:name/photo.png', handle(async (req, res) => {
  const name = req.params.name
  if (!examples().some(item => item.name === name)) return sendJson(res, { error: 'No such example.' }, 404)
  return sendFile(res, join(fixtures, name, 'screens/photo.png'))
}))

app.post('/api/films', handle(async (req, res, { url, user, authorize, readBody, admission }) => {
  const example = url.searchParams.get('example')
  if (example) {
    if (!examples().some(item => item.name === example)) return sendJson(res, { error: 'No such example.' }, 404)
    return sendJson(res, { id: (await startExample(example, user.id, admission)).id })
  }
  if (!LIVE) return sendJson(res, { error: 'This server plays the examples only (start it with --live to make films from photos).' }, 403)
  const type = (req.headers['content-type'] || '').split(';')[0]
  if (type === 'multipart/form-data') {
    let form, guidance = null
    try {
      form = await new Response(await readBody(), { headers: { 'Content-Type': req.headers['content-type'] } }).formData()
      const message = form.get('message')
      if (message) guidance = { messages: addGuidance([], message) }
    } catch (error) { return sendJson(res, { error: error.message }, error.status || 400) }
    const photo = form.get('photo')
    if (!photo || typeof photo === 'string' || !photo.type.startsWith('image/')) return sendJson(res, { error: 'Choose a photo to make a manual.' }, 400)
    return sendJson(res, { id: (await startLive(Buffer.from(await photo.arrayBuffer()), photo.type, guidance, user.id, admission, authorize)).id })
  }
  if (!type.startsWith('image/')) return sendJson(res, { error: 'Send the photo as an image.' }, 400)
  return sendJson(res, { id: (await startLive(await readBody(), type, null, user.id, admission, authorize)).id })
}))

app.use('/api/films/:id', async (req, res, next) => {
  const context = res.locals.context
  const job = await getJob(req.params.id)
  if (!job) {
    context.admission?.release()
    return sendJson(res, { error: 'No such film.' }, 404)
  }
  context.authorize()
  context.job = job
  next()
})

app.get('/api/films/:id/artwork', handle(async (req, res, { job }) => {
  if (!job.finished || !job.playable) return sendJson(res, { error: 'Artwork is available after the film finishes.' }, 409)
  return sendJson(res, { objects: (job.run.script.objects || []).filter(o => job.vectors[o.k]).map(o => ({ key: o.k, name: o.n, drawing: namedDrawing(job.vectors[o.k]) })) })
}))

app.post('/api/films/:id/artwork', handle(async (req, res, { readJson, job }) => {
  if (!job.finished || !job.playable || job.editingArtwork) return sendJson(res, { error: 'Wait for the film or current edit to finish.' }, 409)
  let request, drawing, revisions, prior
  try {
    request = await readJson(16000)
    if (!/^[\w-]+$/.test(request.key || '') || !Object.hasOwn(job.vectors, request.key)) throw new Error('No such object artwork')
    // Recheck after reading the asynchronous request body: edits cannot overlap.
    if (job.editingArtwork) return sendJson(res, { error: 'Another artwork edit is being saved.' }, 409)
    revisions = job.maybe('artwork-undo.json') || {}
    prior = revisions[request.key] || []
    if (request.undo) {
      if (!prior.length) throw new Error('No earlier drawing to restore')
      drawing = prior.at(-1)
    } else {
      drawing = editDrawing(job.vectors[request.key], request.edit || {})
      if (prior.length >= 20) throw new Error('Undo history is full; undo an edit before making another')
    }
  } catch (error) { return sendJson(res, { error: error.message }, error.status || 400) }
  job.editingArtwork = true
  const key = request.key, old = job.vectors[key], oldRun = job.run.vectors[key], oldHistory = structuredClone(revisions)
  const saveArtwork = () => {
    mkdirSync(join(job.runDir, 'draw', key), { recursive: true })
    writeFileSync(join(job.runDir, 'draw', key, 'drawing.json'), JSON.stringify(job.vectors[key]))
    writeFileSync(join(job.runDir, 'draw', key, 'drawing-metrics.json'), JSON.stringify(drawingMetrics(job.vectors[key])))
    writeFileSync(join(job.runDir, 'vectors.json'), JSON.stringify(job.run.vectors))
    writeFileSync(join(job.runDir, 'artwork-undo.json'), JSON.stringify(revisions))
  }
  try {
    revisions[key] = request.undo ? prior.slice(0, -1) : [...prior, old]
    job.vectors[key] = drawing; job.run.vectors[key] = drawing
    saveArtwork(); await job.persist()
    job.send('update', { what: 'drawing', key })
    return sendJson(res, { drawing: namedDrawing(drawing), undoAvailable: revisions[key].length > 0 })
  } catch (error) {
    job.vectors[key] = old; job.run.vectors[key] = oldRun; revisions = oldHistory
    saveArtwork()
    throw error
  } finally { job.editingArtwork = false }
}))

app.get('/api/films/:id/events', handle(async (req, res, { authorize, job, user }) => {
  return listen(req, res, job, authorize, user?.id)
}))

app.get('/api/films/:id/about', handle(async (req, res, { job }) => {
  return sendJson(res, { root: job.root?.id ?? null, pick: job.pick, previous: job.previous,
    messages: job.guidance?.messages || [] })
}))

app.post('/api/films/:id/retry', handle(async (req, res, { admission, job }) => {
  if (!LIVE) return sendJson(res, { error: 'Retries are unavailable on this examples-only server.' }, 403)
  if (!job.finished || job.playable) return sendJson(res, { error: 'This film does not need a retry.' }, 409)
  return sendJson(res, { id: startRetry(job, admission).id })
}))

app.post('/api/films/:id/refine', handle(async (req, res, { readJson, admission, job }) => {
  if (!LIVE) return sendJson(res, { error: 'Revisions are unavailable on this examples-only server.' }, 403)
  let request
  try {
    request = await readJson(16000)
    const revised = startRefinement(job, request?.message, admission)
    return sendJson(res, { id: revised.id })
  } catch (error) { return sendJson(res, { error: error.message }, error.status || 400) }
}))

app.post('/api/films/:id/films', handle(async (req, res, { url, authorize, admission, job }) => {
  if (!LIVE) return sendJson(res, { error: 'Making another film needs the server started with --live.' }, 403)
  const root = job.root || job
  await archive.ensure(root.id)
  authorize()
  const i = Number(url.searchParams.get('i'))
  if (!root.objects || !Number.isInteger(i) || !root.projects[i]) return sendJson(res, { error: 'No such project in this catalogue (yet).' }, 409)
  return sendJson(res, { id: startPick(root, i, admission).id })
}))

app.get('/api/films/:id/program', handle(async (req, res, { url, job }) => {
  const name = url.searchParams.get('name') === 'replay' ? 'replay' : 'live'
  const requested = Number(url.searchParams.get('t'))
  const at = Number.isFinite(requested) ? Math.max(0, Math.min(requested, job.run?.times.duration || 0)) : 0
  return sendJson(res, job.program(name, at))
}))

app.get('/api/films/:id/photo', handle(async (req, res, { authorize, job }) => {
  return await sendStored(res, job, job.example ? 'screens/photo.png' : 'script/photo.png', authorize)
}))

app.get('/api/films/:id/prelude', handle(async (req, res, { job }) => {
  if (!existsSync(join(job.runDir, 'screens/boxes.json'))) return sendJson(res, { error: 'The object list is not in yet.' }, 409)
  const png = readFileSync(join(job.runDir, job.example ? 'screens/photo.png' : 'script/photo.png'))
  const script = existsSync(join(job.runDir, 'script.json')) && 'script: done' in job.marks ? job.read('script.json') : null
  return sendJson(res, prelude({ photo: { width: png.readUInt32BE(16), height: png.readUInt32BE(20) },
    objects: job.read('screens/boxes.json').objects, recipe: script ? (script.ideas || [])[script.pick || 0]?.kind === 'recipe' : null }))
}))

app.get('/api/films/:id/screens/:screen', handle(async (req, res, { authorize, job }) => {
  return await sendStored(res, job, `screens/${req.params.screen}`, authorize)
}))

// Apply the player policy here too, so no static-file alias can bypass it.
app.use(express.static(web, { index: false, redirect: false, etag: false, lastModified: false, maxAge: 0,
  setHeaders: (res, file) => {
    res.setHeader('Cache-Control', 'no-cache')
    if (file === join(web, 'player.html')) res.setHeader('Content-Security-Policy', PLAYER_POLICY)
  } }))
app.use((req, res) => res.status(404).send('Not found'))
app.use(async (error, req, res, next) => {
  const admission = res.locals.context?.admission
  if (admission?.job && !admission.job.child && !admission.job.finished) await admission.job.finish('Could not start this manual.')
  if (admission && !admission.job) admission.release()
  const expected = [400, 401, 403, 404, 409, 413, 415, 429].includes(error.status)
  if (!expected) console.error(error)
  if (res.headersSent) return res.destroy()
  if (error.retryAfter) res.setHeader('Retry-After', error.retryAfter)
  sendJson(res, { error: expected ? error.message : 'Could not load or save this film. Please try again.' }, expected ? error.status : 500)
})
const server = app.listen(PORT, HOST, () => console.log(`http://localhost:${server.address().port}  (${LIVE ? `examples and photos: photos run the pipeline and call the models, effort ${EFFORT}, plan ${PLAN_EFFORT}` : 'examples only'}${SPEED !== 1 ? `, examples at ${SPEED}×` : ''})`))

// A single app process owns this database and its paid jobs. Stop work before closing SQLite.
const cleanup = setInterval(async () => {
  try {
    await archive.prune()
    for (const [id, job] of jobs) if (job.finished && !archive.work.has(id) && (!job.root || job.root.finished)) {
      job.root?.children.delete(job); jobs.delete(id)
    }
  } catch { console.error('Could not prune the file cache') }
}, 60000)
cleanup.unref()
let stopping = false
async function shutdown() {
  if (stopping) return
  stopping = true; clearInterval(cleanup); server.close()
  const deadline = setTimeout(() => process.exit(1), 30000); deadline.unref()
  const children = []
  for (const job of jobs.values()) {
    clearTimeout(job.checkpointTimer)
    if (job.child && job.child.exitCode === null && job.child.signalCode === null) children.push(new Promise(resolve => {
      job.child.once('close', resolve)
      job.child.stopWorker()
    }))
    for (const client of job.clients) client.end()
  }
  await Promise.all(children)
  await Promise.allSettled([...jobs.values()].filter(j => !j.finished).map(j => j.finish('Generation was interrupted by a server shutdown. No model calls were retried.')))
  await archive.close(); repository.close(); clearTimeout(deadline)
  process.exit(0)
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
