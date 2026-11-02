import { fileURLToPath } from 'node:url'
import { drawingStyle as selectDrawingStyle } from './drawing-style.mjs'
import { artworkReferences } from './artwork-references.mjs'
import { drawingMetrics } from './drawing-format.mjs'
// Photo-to-instructions pipeline: script (streamed) → SAM cut-outs as soon as the object list is in → layout →
// the finale, all in parallel, and one complete illustration per everyday object → the engine's film. Every step is stamped in wall-clock
// seconds from the start, and set against when the film, had it started playing as soon as it could, would need it.
//
//   node run.mjs <photo.png> <run dir> [--effort minimal] [--plan-effort minimal] [--drawing-style layered] [--no-thinking] [--no-finale] [--idea idea.json] [--drawings-from <run dir>]
// --idea: a project picked from the catalogue (catalogue.mjs), as {objects, project}: the plan makes that project, on
// the catalogue's objects, and segmentation starts at once instead of waiting for the plan's object list; cut-outs
// already in <run dir>/screens (copied from the film the project was picked beside) are used as they are.
// --drawings-from: that film's run dir: its drawings of the same cut-outs are this film's, with no model call.
// Without --idea (and without --no-catalogue), the catalogue (catalogue.mjs) is written alongside the film, on the
// planner's object list: catalogue/objects.json, then "project: <i>" marks, "catalogue: done".
// Generation uses the Meta Model API. SAM runs in
// Writes <run dir>/timings.json and
// the browser player needs for live and replay playback.
import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { solveBuild, geometryReview } from '../solvers/layout.mjs'
import { timeline, TIMES } from '../film/engine.mjs'
import { refusedIn, repair } from './words.mjs'
import { withTools } from '../solvers/tools.mjs'
import { generate as call, configuration, json } from './model.mjs'
import { preparePhoto, writePlan } from './plan.mjs'
import { referenceImage } from './images.mjs'
import { segmentPhoto } from './segment.mjs'
import { writePanel } from './panel.mjs'
import { writeFaces } from './faces.mjs'
import { fixedReveal } from './reveal.mjs'
import { auditInstruction } from './evaluation.mjs'
import { problemTimeline, validateProblem } from './problem.mjs'
import { writeCatalogue } from './catalogue.mjs'
import { sameInventory } from './guidance.mjs'
import { stageEfforts } from './efforts.mjs'
import { drawingQueue, drawingReference, requiredDrawingKeys, drawingFailure, checkedArtwork, suppliedDrawingPrompt } from './artwork.mjs'
import { completeIllustration } from './illustration.mjs'
import { vesselPrompt } from '../solvers/vessels.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const args = process.argv.slice(2)
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const [photoPath, runDir] = args.filter((a, i) => !a.startsWith('--') && !['--effort', '--plan-effort', '--perception-effort', '--repair-effort', '--drawing-effort', '--catalogue-effort', '--drawing-style', '--idea', '--drawings-from', '--guidance', '--reuse-from', '--resume-from'].includes(args[i - 1])).map((p) => resolve(p))
const idea = flag('--idea', null) ? JSON.parse(readFileSync(resolve(flag('--idea')), 'utf8')) : null
const guidance = flag('--guidance', null) ? JSON.parse(readFileSync(resolve(flag('--guidance')), 'utf8')) : null
const resumeFrom = flag('--resume-from', null)
const reuseFrom = resumeFrom || flag('--reuse-from', null)
const resumedScript = resumeFrom ? JSON.parse(readFileSync(join(resumeFrom, 'script.json'), 'utf8')) : null
const efforts = stageEfforts(args), effort = efforts.base, drawingStyle = selectDrawingStyle(args)
// (the plan's own, to try more thought on the design alone; server.mjs: the same as the rest unless told)
const planEffort = efforts.plan
const noThinking = args.includes('--no-thinking')
const withFinale = !args.includes('--no-finale')
const runAbort = new AbortController()
process.once('SIGTERM', () => runAbort.abort(new Error('Generation stopped')))
process.once('SIGINT', () => runAbort.abort(new Error('Generation stopped')))

async function mainRun() {
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, 'run-config.json'), JSON.stringify({ ...configuration(), efforts, drawingStyle, perception: true, playback: 'browser' }, null, 1))
  const started = performance.now()
  const now = () => +((performance.now() - started) / 1000).toFixed(2)
  const marks = {}, calls = {}
  const mark = (name) => { marks[name] = now(); console.log(`${String(marks[name]).padStart(7)}s  ${name}`) }

  const modelCall = (dir, prompt, options = {}) => call(dir, prompt, { effort: efforts.drawing, noThinking, signal: runAbort.signal, ...options })
  const fill = (template, values) => template.replace(/\{\{(\w+)\}\}/g, (_, k) => values[k])
  // 1. The script, streamed. SAM starts the moment the object list is complete.
  const scriptDir = join(runDir, 'script'), samDir = join(runDir, 'screens')
  const writeBoxes = (objects) => {
    mkdirSync(samDir, { recursive: true })
    writeFileSync(join(samDir, 'boxes.json'), JSON.stringify({ objects: objects.map((o) => ({ key: o.k, name: o.n, segment: o.segment, box: o.b })) }))
  }
  const photo = await preparePhoto(photoPath, scriptDir)
  let resolveObjects, rejectObjects
  const objectsIn = new Promise((r, reject) => { resolveObjects = r; rejectObjects = reject })
  mark('start')
  // The plan laid out on the cut-outs: what the film is drawn from, and the check that its joints meet their parts.
  const fit = (script, cut) => withTools({ ...script, artworkMode: 'complete' }, cut.geometry, Object.fromEntries(Object.entries(cut.screens).filter(([k]) => k !== 'photo').map(([k, s]) => [k, { width: s.width, height: s.height }])), {})
  const checkPlan = async (script) => {
    const cut = await sam, { geometry, sizes } = fit(script, cut)
    try { const copy = structuredClone(script); return geometryReview(copy, solveBuild(copy, geometry, sizes)) } catch (error) {
      if (!error.diagnostics) throw error
      return error.diagnostics.map((d) => `${d.joint ? `joint ${d.joint}: ` : ''}${d.message}${d.details ? ` Measured geometry: ${JSON.stringify(d.details)}` : ''}`)
    }
  }
  // The plan the steps' own calls (the panel, the finale) are made for: the first, unless it is being repaired in the
  // background (writePlan's revision); then whichever the film keeps.
  let planSettled, revision = null, revisedIn = null, problemMode = false, planningFailure = null
  const plan = new Promise((done) => { planSettled = done })
  const scriptCall = (resumedScript ? Promise.resolve().then(() => {
    // Resume the exact saved instructions; no perception or planning call.
    const objects = resumedScript.objects.filter(o => o.source !== 'additional-supply' && !o.toolKind)
    writeBoxes(objects); resolveObjects(objects); mark('script: object list')
    return { script: resumedScript, validation: { valid: true }, call: { provider: 'reused', cost: 0 } }
  }) : writePlan(scriptDir, photo, { effort: planEffort, noThinking, checkPlan, background: true, guidance,
    perception: true, perceptionEffort: efforts.perception, repairEffort: efforts.repair, signal: runAbort.signal,
    onMode: (mode) => { problemMode = mode === 'problem'; mark(`perception: ${mode}`) },
    onPerceptionRepair: () => mark('perception: repair'),
    onPerceptionText: (text) => { if (!marks['script: first object'] && /"b"\s*:\s*\[[^\]]*\]/.test(text)) mark('script: first object') },
    onRepairRejected: () => mark('script: repair rejected'),
    onPlanAttempt: ({ attempt, patch }) => { if (attempt) mark(`script: ${patch ? 'patch' : 'repair'} ${attempt}`) },
    ...(idea ? { idea: idea.project, inventory: idea.objects } : {}),
    onText: (text) => { if (!marks['script: first object'] && /"b"\s*:\s*\[[^\]]*\]/.test(text)) mark('script: first object') },
    // (the boxes are on disk before the mark: server.mjs reads them when it sees it)
    onObjects: (objects) => { writeBoxes(objects); mark('script: object list'); resolveObjects(objects) },
  })).then((r) => {
    if (r.script.mode === 'problem') { problemMode = true; resolveObjects([]) }
    // (written now, not with the layout: server.mjs shows the steps as soon as they are in)
    writeFileSync(join(runDir, 'script.json'), JSON.stringify(r.script, null, 1))
    // (a plan kept with problems its repair did not fix: said, and in script/validation.json)
    if (!r.validation.valid) mark(`script: kept with ${r.validation.errors.length} problems${r.revision ? ', repairing' : ''}`)
    mark('script: done'); calls.script = r.call
    if (r.revision) {
      revision = r.revision
      revision.then((v) => { revisedIn = v || false; if (!v) mark('script: revision failed') })
    } else planSettled(r.script)
    return r.script
  })
    .catch((error) => { planningFailure = error; rejectObjects(error); throw error })

  // The catalogue: twenty other things to make from the same objects, written while the film is made. Never fails the film.
  const catalogueCall = resumeFrom ? objectsIn.then(() => {
    const source = join(resumeFrom, 'catalogue')
    if (existsSync(source)) {
      cpSync(source, join(runDir, 'catalogue'), { recursive: true })
      const projects = join(source, 'projects')
      if (existsSync(projects)) for (const file of readdirSync(projects).filter(f => /^\d+\.json$/.test(f)).sort((a, b) => parseInt(a) - parseInt(b))) mark(`project: ${parseInt(file)}`)
    }
    mark('catalogue: done'); return null
  }) : idea || args.includes('--no-catalogue') ? Promise.resolve(null) : objectsIn.then((objects) => {
    if (problemMode) return null
    mkdirSync(join(runDir, 'catalogue', 'projects'), { recursive: true })
    writeFileSync(join(runDir, 'catalogue', 'objects.json'), JSON.stringify(objects))
    return writeCatalogue(runDir, photo, { effort: efforts.catalogue, noThinking, inventory: objects, guidance, signal: runAbort.signal,
      onProject: (i, project) => { writeFileSync(join(runDir, 'catalogue', 'projects', `${i}.json`), JSON.stringify(project)); mark(`project: ${i}`) } })
      .then((c) => { calls.catalogue = c.call; mark(c.projects.length ? 'catalogue: done' : 'catalogue: empty'); return c })
  }).catch((error) => { if (error !== planningFailure) mark(`catalogue: FAILED (${error.message.slice(0, 80)})`); return null })

  let reused = (idea || resumeFrom) && existsSync(join(samDir, 'screens.json')) && existsSync(join(samDir, 'geometry.json'))
  const sam = objectsIn.then(async (objects) => {
    if (resumeFrom) {
      cpSync(join(resumeFrom, 'screens'), samDir, { recursive: true }); reused = true
    }
    if (problemMode) return null
    if (!reused && reuseFrom && existsSync(join(reuseFrom, 'screens/screens.json')) && existsSync(join(reuseFrom, 'screens/geometry.json')) && existsSync(join(reuseFrom, 'script.json'))) {
      const previous = JSON.parse(readFileSync(join(reuseFrom, 'script.json'), 'utf8'))
      if (sameInventory(previous.objects, objects)) {
        cpSync(join(reuseFrom, 'screens'), samDir, { recursive: true })
        writeBoxes(objects)
        reused = true
      }
    }
    if (reused) {
      // (picked beside another film: its cut-outs and tracings are this film's)
      mark('SAM: cut-outs')
      return { screens: JSON.parse(readFileSync(join(samDir, 'screens.json'), 'utf8')), geometry: JSON.parse(readFileSync(join(samDir, 'geometry.json'), 'utf8')), boxes: Object.fromEntries(objects.map((o) => [o.k, o.b])) }
    }
    // (tests stand in saved cut-outs for the API; never in production)
    const standIn = process.env.NODE_ENV !== 'production' && process.env.SAM_FIXTURE
    if (standIn) cpSync(standIn, samDir, { recursive: true, force: true })
    const sam = standIn ? { segment: 0, scores: {}, log: 'saved cut-outs' } : await segmentPhoto(photo.path, JSON.parse(readFileSync(join(samDir, 'boxes.json'), 'utf8')), samDir, { signal: runAbort.signal })
    writeFileSync(join(samDir, 'sam.log'), sam.log)
    mark('SAM: cut-outs')
    calls.sam = { segment: sam.segment, scores: sam.scores }
    copyFileSync(photo.path, join(samDir, 'photo.png'))
    const screens = JSON.parse(readFileSync(join(samDir, 'screens.json'), 'utf8'))
    screens.photo = { ...photo, regions: [] }
    writeFileSync(join(samDir, 'screens.json'), JSON.stringify(screens, null, 1))
    return { screens, geometry: JSON.parse(readFileSync(join(samDir, 'geometry.json'), 'utf8')), boxes: Object.fromEntries(objects.map((o) => [o.k, o.b])) }
  })

  // Select artwork after the plan: repair and construction operations determine whether
  // the object must retain its photographed frame. Only used objects enter the bounded queue.
  let drawingsFrom = resumeFrom || flag('--drawings-from', null)
  if (drawingsFrom) {
    let sourceStyle = 'classic'
    try { sourceStyle = JSON.parse(readFileSync(join(drawingsFrom, 'run-config.json'), 'utf8')).drawingStyle || 'classic' } catch {}
    if (sourceStyle !== drawingStyle) drawingsFrom = null
  }
  const drawingCalls = {}
  const queueDrawing = drawingQueue({ signal: runAbort.signal })
  let named = {}, drawingObjects = []
  objectsIn.then((objects) => { drawingObjects = objects; named = Object.fromEntries(objects.map((o) => [o.k, o.n])) }, () => {})
  const drawingFor = (key, cut, rig = null, supply = null) => drawingCalls[rig ? `${key} rig` : key] ??= queueDrawing(async () => {
    if (rig && drawingCalls[key]) await drawingCalls[key]
    const dir = join(runDir, 'draw', key)
    mkdirSync(dir, { recursive: true })
    // Three retries for invalid or incomplete drawings. The API client handles transport retries and backoff.
    let previousError = null
    for (let attempt = 0; attempt <= 3; attempt++) {
      const callKey = `draw ${key}${attempt ? ` retry ${attempt}` : ''}`
      const options = { out: attempt ? `out-retry-${attempt}.json` : 'out.json' }
      const correction = previousError ? `\nThe previous drawing attempt failed validation or generation: ${previousError.message}. Return a complete drawing that satisfies all requirements above.` : ''
      try {
        let r
        const parent = !rig && drawingsFrom && (!supply || resumeFrom) ? join(drawingsFrom, 'draw', key, 'drawing.json') : null
        if (parent && existsSync(parent)) {
          try {
            const checked = checkedArtwork(JSON.parse(readFileSync(parent, 'utf8')), {
              width: supply ? Math.round(supply.size.width * 4) : cut.screens[key].width * 4,
              height: supply ? Math.round(supply.size.height * 4) : cut.screens[key].height * 4,
              observed: supply?.observed, script: supply?.script, key,
            })
            writeFileSync(join(dir, 'drawing.json'), JSON.stringify(checked))
            writeFileSync(join(dir, 'drawing-metrics.json'), JSON.stringify(drawingMetrics(checked)))
            calls[callKey] = { provider: 'reused', cost: 0 }
            mark(`drawing: ${key}`); return checked
          } catch { /* An incompatible or invalid saved drawing needs a fresh response. */ }
        }
        if (supply) {
          const prompt = suppliedDrawingPrompt(supply.script, supply.object, supply.size, { observed: supply.observed, layered: drawingStyle === 'layered' })
          writeFileSync(join(dir, 'prompt.txt'), prompt)
          if (supply.observed) copyFileSync(photo.path, join(dir, 'photo.png'))
          r = await modelCall(dir, prompt + correction, { ...options, ...(supply.observed ? { images: ['photo.png'] } : {}) })
        } else {
          copyFileSync(join(samDir, `${key}.png`), join(dir, `${key}.png`))
          await referenceImage(join(dir, `${key}.png`), join(dir, `${key}-x4.png`))
          const s = cut.screens[key], pivotOf = (r) => [(r.pivot[0] - cut.geometry[key].origin[0]) * 4, (r.pivot[1] - cut.geometry[key].origin[1]) * 4].map(Math.round)
          const parts = rig
            ? `two parts. "${key}", the main body (parent null, its pivot the middle of its underside), and "moving", the piece on the ${rig.split} side of the point [${pivotOf(rig)}] (parent "${key}", pivot [${pivotOf(rig)}]): the film turns it about that point.`
            : `one part, id "${key}", parent null, its pivot the middle of its underside.`
          r = await modelCall(dir, fill(readFileSync(join(here, '../../prompts', drawingStyle === 'layered' ? 'drawing-layered-prompt.txt' : 'drawing-prompt.txt'), 'utf8'), {
            name: named[key] || key, key, width: s.width, height: s.height, width4: s.width * 4, height4: s.height * 4, parts,
            reference: drawingReference(key, drawingObjects, cut.geometry[key], s) }) + '\n' + vesselPrompt() + correction, { ...options, effort: efforts.drawing, images: [`${key}.png`, `${key}-x4.png`] })
        }
        calls[callKey] = r
        const drawing = json(r.text)
        const checked = checkedArtwork(drawing, {
          width: supply ? Math.round(supply.size.width * 4) : cut.screens[key].width * 4,
          height: supply ? Math.round(supply.size.height * 4) : cut.screens[key].height * 4,
          observed: supply?.observed, script: supply?.script, key,
        })
        writeFileSync(join(dir, 'drawing-metrics.json'), JSON.stringify(drawingMetrics(checked), null, 2))
        writeFileSync(join(dir, 'drawing.json'), JSON.stringify(checked))
        mark(`drawing: ${key}`)
        return checked
      } catch (error) {
        calls[callKey] = { ...calls[callKey], problem: error.message }
        writeFileSync(join(dir, `failure-attempt-${attempt + 1}.json`), JSON.stringify({ message: error.message }, null, 1))
        const permanent = typeof error.code === 'string' || error.status || error instanceof TypeError
        if (attempt < 3 && !runAbort.signal.aborted && !permanent) {
          previousError = error
          mark(`drawing: ${key} retry ${attempt + 1}`)
          continue
        }
        writeFileSync(join(dir, 'failure.json'), JSON.stringify({ message: error.message }, null, 1))
        mark(`drawing: ${key} FAILED`)
        return null
      }
    }
  })

  // A part the scene draws from numbers gets face drawings (faces.mjs) instead of a drawing: asked for as soon as the
  // script is in, from the photo cropped to each part's box, so they arrive before most of the film.
  const facesCall = scriptCall.then((script) => script.mode === 'problem' ? {} : writeFaces(runDir, script, null, { layered: drawingStyle === 'layered', effort: efforts.drawing, noThinking, photo: photo.path, signal: runAbort.signal,
    onFace: (k, f) => { if (f) { const { faces, ...call } = f; calls[`face ${k}`] = call; writeFileSync(join(runDir, 'faces', k, 'face.json'), JSON.stringify(faces)); mark(`face: ${k}`) } } }))
    .then((done) => { const faces = Object.fromEntries(Object.entries(done).map(([k, f]) => [k, f.faces])); writeFileSync(join(runDir, 'faces.json'), JSON.stringify(faces)); return faces })
    .catch((error) => { if (error !== planningFailure) mark(`faces: FAILED (${error.message.slice(0, 80)})`); return {} })

  let [script, cut] = await Promise.all([scriptCall, sam])
  if (script.mode === 'problem') {
    mkdirSync(samDir, { recursive: true })
    copyFileSync(photo.path, join(samDir, 'photo.png'))
    writeFileSync(join(samDir, 'screens.json'), JSON.stringify({ photo: { width: photo.width, height: photo.height, regions: [] } }))
    const times = problemTimeline(script.problem), audit = validateProblem(script.problem)
    writeFileSync(join(runDir, 'problem-audit.json'), JSON.stringify(audit, null, 1))
    calls.script ||= {}
    writeFileSync(join(runDir, 'timings.json'), JSON.stringify({ ...configuration(), mode: 'problem', efforts, photo, begin: marks['script: done'], marks, calls: { script: { ...calls.script, text: undefined } }, cost: calls.script.cost ?? calls.script.knownCost ?? 0, costIncomplete: !!calls.script.costIncomplete, filmSeconds: times.duration }, null, 1))
    mark('layout')
    return
  }
  // The plan laid out on the cut-outs, with the tools it asks for (drawn by tools.mjs, not by a model).
  const layOut = (script) => {
    script.artworkMode = 'complete'
    const { sizes, geometry } = fit(script, cut)
    const layout = solveBuild(script, geometry, sizes)
    writeFileSync(join(runDir, 'script.json'), JSON.stringify(script, null, 1))
    writeFileSync(join(runDir, 'layout.json'), JSON.stringify(layout, null, 1))
    const perception = existsSync(join(samDir, 'perception.json')) ? JSON.parse(readFileSync(join(samDir, 'perception.json'), 'utf8')) : null
    writeFileSync(join(runDir, 'instruction-audit.json'), JSON.stringify(auditInstruction(script, layout, photo, perception), null, 1))
    return { layout, geometry, sizes }
  }
  // (a repair that passed while SAM was still cutting out is the film's plan from the start)
  if (revisedIn) { script = revisedIn.script; calls.script = revisedIn.call; mark('script: revised') }
  let { layout, geometry, sizes } = layOut(script)
  mark('layout')
  // A repair still under way is taken if it passes before the film reaches its first step (less a second for the page
  // to swap programs), laid out and written as the film's plan; the page is told (server.mjs). Later, the film keeps
  // the plan it started with.
  if (!revision || revisedIn !== null) planSettled(script)
  else {
    const left = Math.max(0, timeline(script).starts[0] - 1)
    let timer
    Promise.race([revision, new Promise((ok) => { timer = setTimeout(() => ok('late'), left * 1000) })]).then((r) => {
      clearTimeout(timer)
      if (r === 'late') mark('script: revision too late')
      else if (r) {
        script = r.script; calls.script = r.call
        ;({ layout, geometry, sizes } = layOut(script))
        mark('script: revised')
      }
      planSettled(script)
    })
  }
  const pivotOf = (r) => [(r.pivot[0] - cut.geometry[r.k].origin[0]) * 4, (r.pivot[1] - cut.geometry[r.k].origin[1]) * 4].map(Math.round)

  // 2. In parallel: the finale, and one drawing per object (a cut part is a slice of its object's drawing: none of its own).
  // (the finale is the plan's: made once the film's plan is settled, which is at once unless it is being repaired)
  const finaleCall = plan.then(() => {
    const rigs = Object.fromEntries((script.rigs || []).filter((r) => cut.geometry[r.k]).map((r) => [r.k, r]))
    const reveal = fixedReveal(script, layout)
    return !withFinale ? Promise.resolve(null) : reveal ? Promise.resolve().then(() => {
      mkdirSync(join(runDir, 'finale'), { recursive: true })
      calls.finale = { provider: 'deterministic', seconds: 0, cost: 0 }
      mark('finale: checked'); return reveal
    }) : (async () => {
      const dir = join(runDir, 'finale')
      mkdirSync(dir, { recursive: true })
      const round = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'number' ? +v.toFixed(2) : v)))
      const drawn = (k) => (layout.boards || {})[k] ? { width: layout.boards[k].w, height: layout.boards[k].h } : { width: sizes[k].width * 4, height: sizes[k].height * 4 }
      const objects = Object.fromEntries([...layout.order, ...layout.extras].map((k) => [k, { ...drawn(k),
        parts: rigs[k] ? [{ id: k, up: null }, { id: 'moving', up: k, pivot: pivotOf(rigs[k]), moves: `the ${rigs[k].split} side` }] : [{ id: k, up: null }],
        seat: geometry[k].seat.map((v) => v * 4), base: geometry[k].base.map((v) => v * 4) }]))
      const prompt = fill(readFileSync(join(here, '../../prompts/finale-prompt.txt'), 'utf8'), {
        view: { side: 'side', plan: 'plan (looking down)', front: 'front (against a wall)', iso: 'isometric' }[layout.view || 'side'], title: script.title, sub: script.sub, kind: ((script.ideas || [])[script.pick || 0] || {}).kind || 'build', seconds: TIMES.finale, floorY: layout.floorY,
        script: JSON.stringify(script), layout: JSON.stringify(round(layout.order.map((k) => ({ key: k, ...layout.poses[k] })))),
        objects: JSON.stringify(round(objects)), rules: readFileSync(join(here, '../../prompts/program-rules.txt'), 'utf8').trim() })
      writeFileSync(join(dir, 'prompt.txt'), prompt)
      const references = artworkReferences(dir, script, await drawings, samDir)
      const r = await modelCall(dir, prompt + '\nApproved object reference manifest (reuse objects.draw for these identities; geometry is the original state, not a transformed result):\n' + JSON.stringify(references.manifest), { images: references.images })
      calls.finale = r
      mark('finale: written')
      let source = null, problem = null
      try {
        source = json(r.text).finale
        if (refusedIn(source).length && !refusedIn(repair(source)).length) { calls.finale.repaired = refusedIn(source); source = repair(source) }
        const words = refusedIn(source)
        if (words.length) problem = `refused words: ${words.join(', ')}`
        else new Function(`return (${source})`)
      } catch (error) { problem = `does not parse: ${error.message}` }
      calls.finale.problem = problem
      writeFileSync(join(dir, 'finale.js'), source ?? r.text)
      if (!problem) writeFileSync(join(dir, 'finale.ok.js'), source)
      mark(problem ? `finale: refused (${problem})` : 'finale: checked')
      return problem ? null : source
    })().catch((error) => { calls.finale = { problem: error.message }; mark(`finale: FAILED (${error.message.slice(0, 80)})`); return null })
  })

  const drawings = plan.then(() => Promise.all(requiredDrawingKeys(layout, geometry)
    .map(async (key) => {
      const object = script.objects.find(o => o.k === key)
      const observed = completeIllustration(script, object)
      return [key, await drawingFor(key, cut, (script.rigs || []).find((r) => r.k === key),
        object && (observed || object.source === 'additional-supply') ? { object, observed, size: sizes[key], script: { ...script, view: layout.view || script.view } } : null)]
    })))
    .then((all) => {
      const missing = all.filter(([, v]) => !v).map(([key]) => key)
      if (missing.length) throw new Error(drawingFailure(missing))
      mark('drawings: all'); return Object.fromEntries(all)
    })

  // Panels reuse approved artwork; generation waits for drawings so identity cannot drift.
  const panelCall = plan.then(async (script) => script.mode === 'problem' ? { panels: null, call: {} } : writePanel(runDir, script, { effort: efforts.drawing, noThinking, signal: runAbort.signal,
    references: artworkReferences(join(runDir, 'panel'), script, await drawings, samDir) })).then(({ panels, call }) => {
    calls.panel = call
    mark(call.problem ? `panel: refused (${call.problem})` : panels ? 'panel: checked' : 'panel: none wanted')
    return panels
  }).catch((error) => { mark(`panel: FAILED (${error.message.slice(0, 80)})`); return null })

  const [finale, vectors, panels] = await Promise.all([finaleCall, drawings, panelCall, facesCall, catalogueCall])
  // Include any earlier rig drawing in timing/cost accounting.
  await Promise.allSettled(Object.values(drawingCalls))
  writeFileSync(join(runDir, 'vectors.json'), JSON.stringify(vectors))

  // 3. Save the completed assets and timing for browser playback.
  if (finale) writeFileSync(join(runDir, 'finale', 'finale.ok.js'), finale)
  const times = timeline(script)

  // When each thing is ready, against when the film needs it had it begun playing the moment the object list was in.
  const begin = marks['script: object list']
  const needs = [
    ['cut-outs (lift off the photo)', marks['SAM: cut-outs'], 1.0],
    ['drawings (turn into drawings)', marks['drawings: all'], 1.3],
    ['steps + layout (first step)', marks.layout, times.steps0],
    ['finale', marks['finale: checked'] ?? marks['finale: written'] ?? null, times.finale],
    ...(panels ? [['panel', marks['panel: checked'], Math.min(...panels.steps.map((i) => times.starts[i] ?? Infinity))]] : []),
  ].map(([what, ready, at]) => ({ what, ready, neededAt: +(begin + at).toFixed(2), slack: ready == null ? null : +(begin + at - ready).toFixed(2) }))
  const latest = Math.max(...needs.filter((n) => n.ready != null).map((n) => n.ready - (n.neededAt - begin)))
  const cost = Object.values(calls).reduce((sum, c) => sum + (c?.cost ?? c?.knownCost ?? 0), 0)
  const costIncomplete = Object.values(calls).some((c) => c?.costIncomplete)
  const summary = { ...configuration(), sam: 'api', effort, planEffort, efforts, drawingStyle, noThinking, finaleEnabled: withFinale, photo, begin, costEstimated: Object.values(calls).some((c) => c.costEstimated), firstFrameIfWaitingForAll: +Math.max(begin, latest).toFixed(2), filmSeconds: +times.duration.toFixed(2),
    needs, marks, calls: Object.fromEntries(Object.entries(calls).map(([k, c]) => [k, { ...c, text: undefined }])), cost: +cost.toFixed(3), costIncomplete }
  writeFileSync(join(runDir, 'timings.json'), JSON.stringify(summary, null, 1))
  console.table(needs)
  console.log(`first frame at ${begin}s; to play through without stalling it would start at ${summary.firstFrameIfWaitingForAll}s; film ${summary.filmSeconds}s; ${costIncomplete ? 'known model cost (incomplete)' : 'models'} $${summary.cost}`)

}

mainRun().catch((error) => {
  runAbort.abort()
  try { writeFileSync(join(runDir, 'failure.json'), JSON.stringify({ message: error.message, validation: error.validation ?? null, efforts }, null, 1)) } catch {}
  console.error(error.message); process.exitCode = 1
})
