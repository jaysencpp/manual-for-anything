// The phone page: a photo (or an example) in, the film playing as it is made. The server streams the pipeline's
// progress (server.mjs); the film plays in a sandboxed player (player.html) from the moment the layout is in, and each
// drawing, face, panel or finale that comes in afterwards is a new program the player takes over where it is.
import { drawThumb, dimensionLabel } from '/thumbs.js'
import { preparePhoto, uploadPhoto } from '/photo.mjs'
import { setupAccount, loadFilms, selectProject, refreshProjects, updateProject } from '/library.mjs'
import { readPlayback, savePlayback, initialPlayback, makingStatus } from '/playback.mjs'
const $ = (id) => document.getElementById(id)
const fetch = async (...args) => {
  const response = await window.fetch(...args)
  if (response.status === 401) location.reload()
  return response
}
const [config, session] = await Promise.all([
  fetch('/api/config').then(r => r.json()),
  fetch('/api/session').then(r => r.json()),
])
setupAccount(session)


// ---- home ----
let selectedPhoto = null, previewURL = null
if (!config.live) {
  for (const id of ['shoot', 'photo', 'photo-guidance']) $(id).disabled = true
  $('live-note').hidden = false
}
fetch('/api/examples').then((r) => { if (!r.ok) throw new Error(); return r.json() }).then((list) => {
  $('examples-status').textContent = list.length ? '' : 'No examples are available yet.'
  $('examples-status').hidden = !!list.length
  for (const e of list) {
    const li = document.createElement('li'), b = document.createElement('button')
    b.innerHTML = `<img alt="" loading="lazy"><span></span>`
    b.querySelector('img').src = e.photo
    b.querySelector('span').append(e.title, Object.assign(document.createElement('small'), { textContent: e.sub || '' }))
    b.onclick = () => start(fetch(`/api/films?example=${encodeURIComponent(e.name)}`, { method: 'POST' }), e.photo)
    li.append(b); $('examples').append(li)
  }
}).catch(() => { $('examples-status').hidden = false; $('examples-status').textContent = 'Could not load examples. Refresh to try again.' })
function selectPhoto(file) {
  if (previewURL) URL.revokeObjectURL(previewURL)
  selectedPhoto = file || null
  previewURL = file ? URL.createObjectURL(file) : null
  if (previewURL) $('preview-image').src = previewURL
  else $('preview-image').removeAttribute('src')
  $('photo-preview').hidden = !file
  $('photo-form').classList.toggle('has-photo', !!file)
  $('photo-button-label').textContent = file ? 'Change photo' : 'Add a photo'
  $('make-manual').disabled = !file || !config.live
  $('upload-status').hidden = true
}
$('shoot').onclick = () => $('photo').click()
for (const id of ['photo']) $(id).onchange = () => {
  const file = $(id).files[0]
  if (file) selectPhoto(file)
  $(id).value = ''
}
$('remove-photo').onclick = () => selectPhoto(null)
$('photo-form').onsubmit = async (event) => {
  event.preventDefault()
  if (!selectedPhoto || $('make-manual').disabled) return
  $('make-manual').disabled = true
  for (const id of ['shoot', 'remove-photo', 'photo', 'photo-guidance']) $(id).disabled = true
  const photo = selectedPhoto
  const message = $('photo-guidance').value.trim()
  $('upload-status').textContent = 'Preparing photo…'
  $('upload-status').hidden = false
  try {
    const compressed = await preparePhoto(photo)
    const body = new FormData()
    body.append('photo', compressed, compressed.name)
    body.append('message', message)
    $('upload-status').textContent = 'Uploading photo…'
    const answer = await uploadPhoto(body, () => {
      $('upload-status').textContent = 'Photo uploaded. Starting your manual…'
    })
    $('upload-status').hidden = true
    $('upload-status').textContent = ''
    teardown(); showMaking(previewURL)
    history.pushState(null, '', `/films/${answer.id}`)
    connect(answer.id)
  } catch (error) {
    $('upload-status').textContent = error.message || 'Could not reach the server. Try again.'
    $('upload-status').hidden = false
  } finally {
    $('make-manual').disabled = !selectedPhoto || !config.live
    for (const id of ['shoot', 'remove-photo', 'photo', 'photo-guidance']) $(id).disabled = !config.live
  }
}

// Keep the current film and the request on screen if a revision cannot be started.
$('refine-form').onsubmit = async (event) => {
  event.preventDefault()
  const from = opened, message = $('refine-message').value.trim()
  if (!from || !message || $('refine-submit').disabled) return
  $('refine-submit').disabled = true
  $('refine-status').textContent = 'Starting your revision…'; $('refine-status').hidden = false
  const answer = await fetch(`/api/films/${from}/refine`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) })
    .then((r) => r.json()).catch(() => ({ error: 'Could not reach the server. Your request is still here; try again.' }))
  if (from !== opened) return
  $('refine-submit').disabled = false
  if (answer.error) { $('refine-status').textContent = answer.error; return }
  teardown(); showMaking(`/api/films/${from}/photo`)
  $('kicker').textContent = 'Revising your manual…'
  history.pushState(null, '', `/films/${answer.id}`)
  connect(answer.id)
}

$('retry-film').onclick = async () => {
  const from = opened
  if (!from || $('retry-film').disabled) return
  $('retry-film').disabled = true
  $('retry-status').hidden = false; $('retry-status').textContent = 'Starting your retry…'
  const answer = await fetch(`/api/films/${from}/retry`, { method: 'POST' })
    .then(r => r.json()).catch(() => ({ error: 'Could not reach the server. Try again.' }))
  if (from !== opened) return
  $('retry-film').disabled = false
  if (answer.error) { $('retry-status').textContent = answer.error; return }
  teardown(); showMaking(`/api/films/${from}/photo`)
  history.pushState(null, '', `/films/${answer.id}`)
  connect(answer.id)
}

// ---- where the page is: the browser's own history ----
// "/" is the home page; "/films/<id>" one film, being made or made. Starting a film pushes its address, so Back comes
// home and Forward goes back to it; a reload or a shared link opens the film again (the server replays everything it
// has sent for it). Leaving a film closes its stream and its player.
const filmPath = (path) => /^\/films\/(\w+)\/?$/.exec(path)?.[1] ?? null
function route() {
  selectProject()
  if (!session.user && !['/terms', '/privacy'].includes(location.pathname.replace(/\/$/, ''))) {
    teardown()
    for (const main of document.querySelectorAll('main')) main.hidden = main.id !== 'sign-in'
    return
  }
  $('sign-in').hidden = true
  const id = filmPath(location.pathname)
  if (id) { if (film?.id !== id && opened !== id) openFilm(id) } else showHome(location.pathname)
}
window.addEventListener('popstate', route)
document.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-page], #home-link')
  if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button) return
  event.preventDefault()
  if (location.pathname !== link.pathname) history.pushState(null, '', link.pathname)
  route()
})

// ---- the player ----
let frame = null, playerReady = null
const player = { t: 0, duration: 0, playing: false, name: 'live' }
const post = (message, transfer = []) => frame.contentWindow.postMessage(message, '*', transfer)
function makePlayer() {
  frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-scripts')
  frame.title = 'Instruction film'
  frame.src = '/player.html'
  $('screen').append(frame)
  const loaded = new Promise((done) => { frame.onload = done })
  playerReady = (async () => {
    // The kit and the fonts, fetched here (the sandboxed player fetches nothing) and handed over.
    const [kit, fonts] = await Promise.all([fetch('/assets/kit.js').then((r) => r.text()),
      Promise.all(config.fonts.map(async (f) => ({ family: f.family, weight: f.weight, data: await fetch(f.url).then((r) => r.arrayBuffer()) })))])
    await loaded
    const ready = new Promise((done) => { waiting.ready = done })
    post({ type: 'assets', kit, fonts }, fonts.map((f) => f.data))
    await ready
  })()
}
const waiting = {}
window.addEventListener('message', (event) => {
  if (!frame || event.source !== frame.contentWindow) return
  const m = event.data || {}
  if (m.type === 'ready') waiting.ready?.()
  else if (m.type === 'time') {
    Object.assign(player, { t: m.t, duration: m.duration, playing: m.playing }); showTime()
    rememberPlayback()
  }
  else if (m.type === 'error') { console.error('film', m.message, m.stack); log(`The film stopped: ${m.message}`, true, lastAt) }
})

// ---- a film being made ----
let film = null, names = {}, began = 0, lastAt = 0
const LABELS = { start: null, 'script: first object': null, 'script: object list': null, 'script: done': 'Wrote the steps', 'SAM: cut-outs': 'Cut each thing out of the photo',
  'perception: physical': 'Identified the materials', 'perception: problem': 'Read the written problem', 'script: repair rejected': ['The revision introduced new problems; kept the previous plan for repair', true],
  'perception: repair': 'Checking the materials in your photo again',
  traced: 'Traced each one into a drawing', layout: 'Worked out where everything goes: the film starts', 'drawings: all': 'Every drawing is in',
  'finale: written': null, 'finale: checked': 'The ending is ready', 'panel: checked': 'The reference diagram is ready', 'panel: none wanted': null }
function label(name) {
  if (name in LABELS) return LABELS[name]
  if (/^project: \d+$/.test(name)) return null
  if (name === 'catalogue: empty') return 'No additional ideas generated'
  if (name === 'catalogue: done') return cat.projects.some(Boolean) ? `Wrote ${cat.projects.filter(Boolean).length} more things to make` : 'No additional ideas generated'
  if (name.startsWith('catalogue: FAILED')) return ['Could not write the other ideas', true]
  let m
  if ((m = /^drawing: (.+?)( FAILED)?$/.exec(name))) return m[2] ? [`Could not draw ${names[m[1]] || m[1]}`, true] : `Drew ${names[m[1]] || m[1]}`
  if (name.startsWith('perception: boxes corrected')) return 'Corrected where the model placed the things in your photo'
  if ((m = /^SAM: colour mismatch (.+)$/.exec(name))) return [`The cut-out of ${names[m[1]] || m[1]} does not look that colour: check this one`, true]
  if ((m = /^face: (.+)$/.exec(name))) return `Drew the faces of ${names[m[1]] || m[1]}`
  if ((m = /^script: kept with (\d+) problems?, repairing$/.exec(name))) return [`The plan has ${m[1]} ${+m[1] === 1 ? 'problem' : 'problems'}: the film starts with it while it is fixed`, true]
  if ((m = /^script: kept with (\d+) problems?$/.exec(name))) return [`The plan still has ${m[1]} ${+m[1] === 1 ? 'problem' : 'problems'} after its repair; made anyway`, true]
  if (/^script: repair \d+$/.test(name)) return ['The plan did not pass its checks: asked for a corrected one', true]
  if (/^script: patch \d+$/.test(name)) return ['Part of the plan did not pass its checks: asked for those steps again', true]
  if (name === 'script: revised') return 'The fixed plan came in: the film follows it'
  if (name === 'script: revision too late') return ['The fix came after the first step: the film keeps its plan', true]
  if (name === 'script: revision failed') return ['The plan could not be fixed: the film keeps it as it is', true]
  if (/refused|FAILED/.test(name)) return [name, true]
  return name
}
function log(text, warn = false, at = (performance.now() - began) / 1000) {
  const li = document.createElement('li')
  li.innerHTML = '<time></time><span></span>'
  li.querySelector('time').textContent = `${at.toFixed(1)}s`
  li.querySelector('span').textContent = text
  if (warn) li.className = 'warn'
  $('log').append(li)
}

// A new film: the making view at once (the photo shown while the server takes it), then its own address.
async function start(request, photo) {
  teardown(); showMaking(photo)
  const answer = await request.then((r) => r.json()).catch(() => ({ error: 'Could not reach the server.' }))
  if (answer.error) { $('kicker').textContent = answer.error; return }
  history.pushState(null, '', `/films/${answer.id}`)
  connect(answer.id)
}
// A film by its address: restore the saved position and skip the prelude if its layout already exists.
let opened = null
function openFilm(id) {
  teardown(); showMaking(`/api/films/${id}/photo`)
  connect(id, true)
}
let events = null
let opening = null, savedSecond = null
function rememberPlayback() {
  if (!film?.started) return
  const second = Math.floor(player.t)
  if (player.playing && second === savedSecond) return
  savedSecond = second
  try { savePlayback(localStorage, film.id, player) } catch {}
}
window.addEventListener('pagehide', () => { savedSecond = null; rememberPlayback() })
function connect(id, restore = false) {
  selectProject()
  if (!restore) refreshProjects()
  opened = id
  let saved = null
  try { saved = restore ? readPlayback(localStorage, id) : null } catch {}
  opening = { restore, saved, ready: false, finished: false }
  cat.root = id
  makePlayer()
  // (a film picked from the catalogue: which card it is, and a link back to the first film; Back does the same)
  fetch(`/api/films/${id}/about`).then((r) => r.json()).then((about) => {
    if (id !== opened) return
    const historyList = $('guidance-history')
    for (const message of about.messages || []) historyList.append(Object.assign(document.createElement('li'), { textContent: message }))
    historyList.hidden = !historyList.children.length
    if (about.previous) {
      const previous = $('previous-film')
      previous.href = `/films/${about.previous}`; previous.hidden = false
      previous.onclick = (event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return
        event.preventDefault(); history.pushState(null, '', previous.href); route()
      }
      $('refine-form').hidden = !config.live
    }
    cat.root = about.root || id
    if (about.pick == null) return
    cat.playing = about.pick; showProjects()
    const link = $('back-first')
    link.href = `/films/${about.root}`; link.hidden = false
    link.onclick = (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return
      event.preventDefault(); history.pushState(null, '', link.href); route()
    }
  }).catch(() => {})
  let heard = false
  events = new EventSource(`/api/films/${id}/events`)
  events.onmessage = (e) => { heard = true; handle(id, JSON.parse(e.data)).catch((error) => log(error.message, true)) }
  events.onerror = () => {
    fetch('/api/session').then(r => r.json()).then(value => { if (!value.user) location.reload() }).catch(() => {})
    // (a film the server no longer has — it was restarted — answers 404: say so, rather than wait)
    if (!heard && events?.readyState === EventSource.CLOSED) { $('kicker').textContent = 'This film is unavailable or belongs to another account. Open your films from the home page.'; events.close() }
    else if (film?.done) events.close()
  }
}
function showMaking(photo) {
  // (on a phone the log folds away, so the other ideas come right after the steps)
  document.querySelector('.made').open = !matchMedia('(max-width: 899px)').matches
  for (const id of ['home', 'examples-page', 'terms-page', 'privacy-page']) $(id).hidden = true
  $('making').hidden = false
  $('snap').src = photo
  scrollTo(0, 0)
  began = performance.now()
  now('Reading your photo')
}
function showHome(path = "/") {
  teardown()
  $('making').hidden = true
  const page = ({ '/examples': 'examples-page', '/terms': 'terms-page', '/privacy': 'privacy-page' })[path.replace(/\/$/, '')] || 'home'
  for (const id of ['home', 'examples-page', 'terms-page', 'privacy-page']) $(id).hidden = id !== page
  document.querySelectorAll('a[data-page]').forEach((link) => {
    if (link.pathname === path) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  })
  if (page === 'home' && session.user) loadFilms()
  scrollTo(0, 0)
}
// ---- what is being done now, over the picture, until the film starts (the log is folded away on a phone) ----
let nowTimer = null, stages = new Set()
function status() { now(film ? null : makingStatus(stages)) }
function now(text) {
  const el = $('now'); clearInterval(nowTimer)
  el.hidden = !text; if (!text) return
  el.querySelector('span').textContent = text
  const tick = () => { el.querySelector('time').textContent = `${Math.round((performance.now() - began) / 1000)} s` }
  tick(); nowTimer = setInterval(tick, 1000)
}

// Everything one film left behind: its stream, its player, what it wrote on the page.
function teardown() {
  savedSecond = null; rememberPlayback()
  events?.close(); events = null; opened = null
  opening = null
  clearTimeout(refresh)
  frame?.remove(); frame = null; playerReady = null
  Object.assign(player, { t: 0, duration: 0, playing: false, name: 'live' })
  film = null; names = {}; lastAt = 0; shownStep = -2; shown = Promise.resolve(); preluding = false
  for (const id of ['log', 'chips', 'steps', 'ideas', 'ticks']) $(id).replaceChildren()
  $('kicker').textContent = 'Reading your photo…'; $('title').textContent = ''; $('sub').textContent = ''
  now(null); stages = new Set()
  $('ideas-box').hidden = true; $('replay').hidden = true; $('controls').hidden = true; $('back-first').hidden = true
  resetCatalogue()
  $('screen').classList.remove('playing')
  $('edit-artwork').hidden = true
  $('refine-form').hidden = true; $('refine-message').value = ''; $('refine-submit').disabled = false
  $('refine-status').hidden = true; $('previous-film').hidden = true
  $('retry-film').hidden = true; $('retry-film').disabled = false; $('retry-status').hidden = true
  $('guidance-history').replaceChildren(); $('guidance-history').hidden = true
}

// ---- the prelude: the photo, what was found lit up by name, from the object list on (engine.mjs: prelude) ----
let shown = Promise.resolve(), preluding = false, hold = 0
const preludeProgram = (id) => fetch(`/api/films/${id}/prelude`).then((r) => (r.ok ? r.json() : null))
async function showPrelude(id) {
  await playerReady
  const [bitmap, program] = await Promise.all([fetch(`/api/films/${id}/photo`).then((r) => r.blob()).then(createImageBitmap), preludeProgram(id)])
  if (id !== opened || film?.started || !program) return
  post({ type: 'screens', screens: { photo: { width: bitmap.width, height: bitmap.height, regions: [], bitmap } } }, [bitmap])
  hold = program.hold; preluding = true
  post({ type: 'program', ...program, at: 0, play: true })
  $('screen').classList.add('playing')
}

let refresh = null
async function handle(id, e) {
  if (e.type === 'script' || e.type === 'revised') updateProject(id, { title: e.title })
  if (e.type === 'done' || e.type === 'failed') updateProject(id, { status: e.type === 'done' ? 'completed' : 'failed' })
  if (id !== opened) return // (a film left behind while one of its events was on its way)
  if (e.type === 'state') {
    Object.assign(opening, { ready: e.ready, finished: e.finished })
    if (opening.restore && e.ready) now('Loading your film')
  } else if (e.type === 'stage') {
    lastAt = e.at
    const said = label(e.name)
    if (said) Array.isArray(said) ? log(said[0], said[1], e.at) : log(said, false, e.at)
    stages.add(e.name)
    if (!(opening.restore && opening.ready)) status()
  } else if (e.type === 'objects') {
    if (!(opening.restore && opening.ready)) shown = showPrelude(id).catch((error) => console.warn("prelude", error))
    names = Object.fromEntries(e.objects.map((o) => [o.key, o.name]))
    $('kicker').textContent = `Found ${e.objects.length} ${e.objects.length === 1 ? 'thing' : 'things'}`
    for (const o of e.objects) $('chips').append(Object.assign(document.createElement('li'), { textContent: o.name }))
    log(`Found ${e.objects.map((o) => o.name).join(', ')}`, false, lastAt)
  } else if (e.type === 'project' || e.type === 'catalogue') {
    catalogueEvent(id, e)
  } else if (e.type === 'script') {
    $('refine-form').hidden = !config.live
    if (e.mode === 'problem') {
      $('kicker').textContent = e.problem.status === 'solved' ? 'Read the problem' : 'The reading needs clarification'
      $('chips').replaceChildren(); $('ideas-box').hidden = true; $('more').hidden = true; cat.done = true
    }
    // (the prelude again, its tray headed as the plan says: taken over at the same moment, so nothing moves)
    if (preluding) shown = shown.then(() => preludeProgram(id)).then((p) => { if (p && preluding && id === opened) post({ type: 'program', ...p }) })
    $('title').textContent = e.title; $('sub').textContent = e.sub || ''
    cat.problem = e.mode === 'problem'
    cat.title = e.title
    cat.fallback = (e.ideas || []).filter((_, i) => i !== e.pick)
    showSteps(e.steps)
    if (e.mode !== 'problem') showProjects()
  } else if (e.type === 'film') {
    film = { id, ...e, done: false }
    now(null)
    showSteps(e.steps)
    await playerReady
    await shown.catch(() => {})
    if (id !== opened) return
    // The pictures the film draws (the photo; the cut-outs, for a film drawn from them) as bitmaps for the player.
    const screens = Object.fromEntries(await Promise.all(Object.entries(e.screens).map(async ([k, s]) => {
      const bitmap = await fetch(s.url).then((r) => r.blob()).then(createImageBitmap)
      return [k, { width: s.width, height: s.height, regions: s.regions, bitmap }]
    })))
    if (id !== opened) return
    post({ type: 'screens', screens }, Object.values(screens).map((s) => s.bitmap))
    const playback = initialPlayback({ ...opening, duration: film.duration, preludeAt: preluding ? Math.min(player.t, hold) : 0 })
    player.name = playback.name
    const program = await fetch(`/api/films/${id}/program?name=${playback.name}&t=${playback.at}`).then((r) => r.json())
    if (id !== opened) return
    // (from the prelude, the film takes over where the prelude holds — the things lit, about to lift off — or, if the
    // film came before the prelude got there, at the prelude's own moment: the two draw the same up to then)
    preluding = false
    post({ type: 'program', ...program, at: playback.at, play: playback.play })
    film.started = true
    handle(id, { type: 'update' }) // (anything that came in while the first program was on its way)
    $('screen').classList.add('playing'); $('controls').hidden = false
    showTicks(e.starts, e.duration)
  } else if (e.type === 'revised') {
    // (the plan's repair, taken before the film's first step: its steps, its times, then its program from the update)
    $('title').textContent = e.title; $('sub').textContent = e.sub || ''
    cat.title = e.title; showProjects()
    showSteps(e.steps)
    if (film && e.starts) { Object.assign(film, { duration: e.duration, starts: e.starts, finale: e.finale, steps: e.steps }); showTicks(e.starts, e.duration) }
  } else if (e.type === 'update') {
    // Several things often come in together: one new program for them all. (Before the first program, the first ask
    // takes in whatever has come in.)
    if (!film?.started || player.name !== 'live') return
    clearTimeout(refresh)
    refresh = setTimeout(async () => {
      const program = await fetch(`/api/films/${id}/program?name=live&t=${player.t.toFixed(2)}`).then((r) => r.json())
      if (id === opened && player.name === 'live') post({ type: 'program', ...program })
    }, 120)
  } else if (e.type === 'done') {
    $('edit-artwork').href = `/artwork.html?film=${encodeURIComponent(id)}`
    $('edit-artwork').hidden = !film || !!cat.problem
    if (film) film.done = true
    $('kicker').textContent = `Made in ${Math.round(lastAt)} s`
    $('replay').hidden = !film
  } else if (e.type === 'failed') {
    $('refine-form').hidden = !config.live
    $('retry-film').hidden = !config.live || !!film
    // (a project picked from a catalogue that could not be planned: say so plainly; the link back is above)
    const fromCatalogue = !$('back-first').hidden
    $('kicker').textContent = /Invalid photo perception/.test(e.message)
      ? 'We could not finish identifying the materials. Describe what is in the photo below to try again.'
      : /Invalid instruction plan/.test(e.message)
      ? `The generated plan was incomplete or could not pass its checks.${config.live ? ' Tell us what to change below to try again with this photo.' : fromCatalogue ? ' Pick another below.' : ''}`
      : /object drawings/i.test(e.message) ? 'The object drawings could not be finished. Retry generation to make the film.'
      : 'Something went wrong'
    now(null)
    log(e.message, true)
  }
}

// ---- the steps, the scrubber ----
// Each step's start, marked on the film's time bar.
function showTicks(starts, duration) {
  $('ticks').replaceChildren(...starts.map((s) => Object.assign(document.createElement('i'), { style: `left:${(100 * s) / duration}%` })))
}

function showSteps(steps) {
  $('steps').replaceChildren(...steps.map((s, i) => {
    const li = document.createElement('li'), b = document.createElement('button')
    b.innerHTML = '<span><b></b><small></small></span>'
    b.querySelector('b').textContent = s.t; b.querySelector('small').textContent = s.c
    b.onclick = () => { if (film) { post({ type: 'seek', t: film.starts[i] }); post({ type: 'play' }) } }
    li.append(b); return li
  }))
}
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
let shownStep = -2
function showTime() {
  const { t, duration, playing } = player
  $('fill').style.width = `${duration ? (100 * t) / duration : 0}%`
  if (document.activeElement !== $('scrub')) $('scrub').value = duration ? Math.round((1000 * t) / duration) : 0
  $('clock').textContent = clock(t)
  $('play').classList.toggle('paused', !playing)
  $('play').setAttribute('aria-label', playing ? 'Pause' : 'Play')
  if (!film) return
  const step = t >= film.finale ? -1 : film.starts.findLastIndex((s) => s <= t)
  if (step !== shownStep) {
    shownStep = step
    ;[...$('steps').children].forEach((li, i) => li.classList.toggle('on', i === step))
    // Only when the steps sit beside the film. Stacked below it, scrolling would push the player off-screen, and
    // browsers pause animation in an off-screen sandboxed frame.
    const row = $('steps').children[step], stage = document.querySelector('.stage')
    if (row && stage && row.getBoundingClientRect().left >= stage.getBoundingClientRect().right) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }
}
$('play').onclick = () => post({ type: player.playing ? 'pause' : 'play' })
$('scrub').oninput = () => post({ type: 'seek', t: ($('scrub').value / 1000) * player.duration })
$('replay').onclick = async () => {
  player.name = 'replay'
  const program = await fetch(`/api/films/${film.id}/program?name=replay&t=0`).then((r) => r.json())
  post({ type: 'program', ...program, at: 0, play: true })
  $('replay').hidden = true
  scrollTo({ top: 0, behavior: 'smooth' })
}

// ---- the catalogue: more things to make from the same photo, under the film (run.mjs writes it beside a photo's
// film). Each card is drawn from its look (thumbs.js); picking one makes its film on the same objects and cut-outs. ----
const EXPECTED = 20
const KIND_NAMES = { recipe: 'Recipes', build: 'Builds', craft: 'Crafts', outfit: 'Outfits', other: 'Other' }
const TOOL_NAMES = { board: 'cutting board', tape: 'tape measure', screw: 'screws', nail: 'nails', dowel: 'dowels', bolt: 'bolts' }
const LEVEL_RANK = { easy: 0, medium: 1, hard: 2 }
const filters = { kind: 'all', quick: false, nothing: false, sort: 'best' }
const minutes = (m) => (m == null ? '' : m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60}` : `${m / 60} h`)
// this film's catalogue: whose it is (the first film's id), its projects, whether it is complete, which one is playing
let cat = null
const cards = new Map()
function resetCatalogue() {
  cat = { root: null, projects: [], fallback: [], failed: false, done: false, playing: null, title: '' }
  $('more').hidden = true; $('cat-grid').replaceChildren(); $('cat-kinds').replaceChildren(); $('cat-note').hidden = true
}
function catalogueEvent(id, e) {
  // (the catalogue replaces the planner's two other ideas: the same kind of list, with more in it)
  if (e.type === 'project') { cat.projects[e.i] = e.project; $('more').hidden = false; $('ideas-box').hidden = true; showProjects() }
  else if (e.type === 'catalogue') {
    cat.done = true; cat.failed = !!e.failed; ghosts(0)
    showProjects()
  }
}
// Placeholders for the projects still being written, after the cards.
// (only as many added or taken away as the count changes by: one rebuilt restarts its shimmer, and they all flicker)
function ghosts(n) {
  const have = [...$('cat-grid').querySelectorAll('.ghost')], missing = Math.max(0, n - cat.projects.filter(Boolean).length)
  for (const g of have.slice(missing)) g.remove()
  for (let i = have.length; i < missing; i++) { const g = Object.assign(document.createElement('li'), { className: 'ghost' }); g.setAttribute('aria-hidden', 'true'); $('cat-grid').append(g) }
}
// The project this film is: the one it was picked as, or (the first film) the one whose title the planner chose.
function playingIndex() {
  if (cat.playing != null) return cat.playing
  // (the planner names it in its own words: "Rustic Planter Box" is the catalogue's "Planter Box")
  const words = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const title = words(cat.title)
  if (!title) return -1
  const exact = cat.projects.findIndex((p) => p && words(p.title) === title)
  return exact >= 0 ? exact : cat.projects.findIndex((p) => p && (title.includes(words(p.title)) || words(p.title).includes(title)))
}
// The cards, filtered and sorted, the one playing first. A card is made (and drawn) once, then only moved.
function showFallbackIdeas() {
  $('ideas-box').hidden = true
  $('cat-tools').hidden = true
  const ideas = cat.fallback || []
  $('more').hidden = !ideas.length && !cat.done
  $('cat-grid').replaceChildren(...ideas.map(idea => {
    const li = document.createElement('li'), article = document.createElement('article'), body = document.createElement('div')
    article.className = 'card idea-card'; body.className = 'body'
    body.append(Object.assign(document.createElement('b'), { textContent: idea.title }), Object.assign(document.createElement('span'), { className: 'pitch', textContent: idea.pitch || '' }))
    article.append(body); li.append(article); return li
  }))
  $('cat-note').textContent = cat.failed ? 'Additional ideas could not be generated.' : cat.done ? 'No additional ideas were generated.' : 'More ideas are being generated…'
  $('cat-note').hidden = ideas.length > 0 || !cat.done
}
function showProjects() {
  if (!cat || cat.problem) return
  if (!cat.projects.some(Boolean)) { showFallbackIdeas(); return }
  $('more').hidden = false; $('cat-tools').hidden = false
  const kinds = [...new Set(cat.projects.filter(Boolean).map((p) => p.kind))]
  if (kinds.length > 1 && $('cat-kinds').children.length !== kinds.length + 1) {
    $('cat-kinds').replaceChildren(...['all', ...Object.keys(KIND_NAMES).filter((k) => kinds.includes(k))].map((k) => {
      const b = Object.assign(document.createElement('button'), { textContent: k === 'all' ? 'All' : KIND_NAMES[k] })
      b.setAttribute('aria-pressed', String(filters.kind === k))
      b.onclick = () => { filters.kind = k; [...$('cat-kinds').children].forEach((x) => x.setAttribute('aria-pressed', String(x === b))); showProjects() }
      return b
    }))
  }
  const now = playingIndex()
  let list = cat.projects.map((p, i) => ({ p, i })).filter(({ p }) => p)
  list = list.filter(({ p, i }) => i === now || ((filters.kind === 'all' || p.kind === filters.kind) && (!filters.quick || (p.minutes ?? Infinity) <= 30) && (!filters.nothing || !p.needs.length && !(p.supplies || []).length)))
  if (filters.sort === 'quick') list.sort((a, b) => (a.p.minutes ?? Infinity) - (b.p.minutes ?? Infinity))
  if (filters.sort === 'easy') list.sort((a, b) => (LEVEL_RANK[a.p.level] ?? 3) - (LEVEL_RANK[b.p.level] ?? 3) || (a.p.minutes ?? Infinity) - (b.p.minutes ?? Infinity))
  list.sort((a, b) => (b.i === now) - (a.i === now))
  // The cards in that order, each moved only if it is not already where it goes: a card taken out and put back starts
  // its pop again, so rebuilding the grid for every new project made every card on it blink.
  const grid = $('cat-grid'), wanted = list.map(({ p, i }) => card(p, i)), keep = new Set(wanted)
  for (const li of [...grid.children]) if (!li.classList.contains('ghost') && !keep.has(li)) li.remove()
  let at = grid.firstChild
  for (const [j, li] of wanted.entries()) {
    const { i } = list[j], b = li.firstChild
    b.classList.toggle('playing', i === now); li.querySelector('.now').hidden = i !== now
    if (li === at) { at = at.nextSibling; continue }
    grid.insertBefore(li, at)
  }
  $('cat-note').hidden = list.length > (now >= 0 ? 1 : 0) || !cat.projects.some(Boolean)
  if (!$('cat-note').hidden) $('cat-note').textContent = 'Nothing else matches these filters.'
  if (!cat.done) ghosts(EXPECTED)
}
function card(p, i) {
  const key = `${cat.root}:${i}`
  if (cards.has(key)) return cards.get(key)
  const li = document.createElement('li'), b = document.createElement('button')
  b.className = 'card'
  const things = Object.keys(names).length
  const size = p.kind === 'recipe' ? (p.serves ? `Serves ${p.serves}` : '') : dimensionLabel(p.look)
  b.innerHTML = '<canvas></canvas><div class="body"><span class="now" hidden>Now playing</span><div class="tag"><span class="time"></span><span class="meta"></span></div><b></b><span class="pitch"></span><div class="list"></div></div>'
  b.querySelector('.time').textContent = minutes(p.minutes) || '—'
  b.querySelector('.meta').textContent = [p.level && p.level[0].toUpperCase() + p.level.slice(1), size].filter(Boolean).join(' · ')
  b.querySelector('b').textContent = p.title
  b.querySelector('.pitch').textContent = p.pitch
  const list = b.querySelector('.list')
  const line = (label, items) => { const d = document.createElement('div'); d.className = label.toLowerCase(); d.append(Object.assign(document.createElement('span'), { textContent: `${label} ` }), items.join(', ')); list.append(d) }
  if (p.uses.length) line('Uses', p.uses.length === things && things > 2 ? [`all ${things} things in your photo`] : p.uses.map((k) => names[k] || k))
  const extra = [...p.needs.map((k) => TOOL_NAMES[k] || k), ...(p.supplies || [])]
  line('Needs', extra.length ? extra : ['nothing else'])
  if (p.confirmations?.length) line('Check first', p.confirmations)
  b.setAttribute('aria-label', `${p.title}, ${minutes(p.minutes)}. ${p.pitch}`)
  b.onclick = () => { if (i === playingIndex()) scrollTo({ top: 0, behavior: 'smooth' }); else pick(i, b) }
  li.append(b)
  cards.set(key, li)
  // drawn at the card's own size, sharp on the screen it is on, again whenever that changes
  const canvas = b.querySelector('canvas')
  const draw = () => {
    const w = canvas.clientWidth; if (!w) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(w * 0.75 * dpr)
    drawThumb(canvas.getContext('2d'), p.look, { width: canvas.width, height: canvas.height, pad: 0.1 })
  }
  new ResizeObserver(draw).observe(canvas)
  return li
}
// A card picked: its film, beside this one (the first film's catalogue stays under it). Back returns here.
async function pick(i, button) {
  const from = opened; if (!from) return
  button.setAttribute('aria-busy', 'true')
  const title = cat.projects[i]?.title ?? ''
  const answer = await fetch(`/api/films/${from}/films?i=${i}`, { method: 'POST' }).then((r) => r.json()).catch(() => ({ error: 'Could not reach the server.' }))
  button.removeAttribute('aria-busy')
  if (answer.error) { $('cat-note').textContent = answer.error; $('cat-note').hidden = false; return }
  const photo = `/api/films/${from}/photo`
  teardown(); showMaking(photo)
  $('title').textContent = title
  history.pushState(null, '', `/films/${answer.id}`)
  connect(answer.id)
}
$('cat-quick').onclick = () => { filters.quick = !filters.quick; $('cat-quick').setAttribute('aria-pressed', String(filters.quick)); showProjects() }
$('cat-nothing').onclick = () => { filters.nothing = !filters.nothing; $('cat-nothing').setAttribute('aria-pressed', String(filters.nothing)); showProjects() }
$('cat-sort').onchange = () => { filters.sort = $('cat-sort').value; showProjects() }

route()
