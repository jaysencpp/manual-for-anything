// A film's program from what a run has so far. server.mjs sends it to the browser player,
// rebuilding it each time a drawing, face, panel or finale comes in.
//   readRun(runDir) → everything the film is made of, read once
//   filmProgram(run, {name, drawingAt, faceAt, finaleAt, panelAt}) → {source, duration}
// name: 'live' or 'replay' (drawings.mjs). The …At arguments are film times something came in (Infinity: not yet);
// faceAt(k) is when face k shows, based on its arrival during browser playback.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { program, timeline } from './engine.mjs'
import { withUp } from './helper.mjs'
import { withTools } from '../solvers/tools.mjs'
import { filmDrawings } from '../pipeline/drawings.mjs'
import { plain } from '../pipeline/script.mjs'
import { fixedReveal } from '../pipeline/reveal.mjs'
import { solveBuild } from '../solvers/layout.mjs'
import { problemScript, problemTimeline, problemProgram } from '../pipeline/problem.mjs'
import { settleWorkTargets } from '../solvers/contracts.mjs'

export function readRun(runDir, { finaleEnabled = true } = {}) {
  const read = (path) => JSON.parse(readFileSync(join(runDir, path), 'utf8'))
  const saved = read('script.json')
  if (saved.mode === 'problem') return { runDir, script: problemScript(saved.problem), times: problemTimeline(saved.problem),
    timings: existsSync(join(runDir, 'timings.json')) ? read('timings.json') : { marks: {} }, screens: read('screens/screens.json'), vectors: {}, faces: {}, panel: null, finale: null, reveal: null }
  const prepared = structuredClone(saved)
  settleWorkTargets(prepared)
  const script = plain(prepared), layout = read('layout.json')
  const workTargets = (s) => (s.steps || []).flatMap((step) => step.do || []).filter((a) => a.v === 'work').map((a) => [a.k, a.to])
  const needsLayout = JSON.stringify(workTargets(script)) !== JSON.stringify(workTargets(saved))
  const timings = existsSync(join(runDir, 'timings.json')) ? read('timings.json') : { marks: {} }
  const screens = read('screens/screens.json')
  const cutSizes = Object.fromEntries(Object.entries(screens).filter(([k]) => k !== 'photo').map(([k, s]) => [k, { width: s.width, height: s.height }]))
  const enabled = finaleEnabled && timings.finaleEnabled !== false
  const reveal = !enabled ? null : fixedReveal(script, layout)
  const finale = !enabled ? null : reveal || (existsSync(join(runDir, 'finale/finale.ok.js')) ? readFileSync(join(runDir, 'finale/finale.ok.js'), 'utf8') : null)
  return {
    runDir, script, layout, needsLayout, timings, screens, cutSizes, times: timeline(script),
    rawGeometry: read('screens/geometry.json'), boxList: read('screens/boxes.json').objects,
    vectors: existsSync(join(runDir, 'vectors.json')) ? read('vectors.json') : {},
    // The parts' face drawings (faces.mjs) and the reference panel (panel.mjs), if any were written and checked.
    faces: existsSync(join(runDir, 'faces.json')) ? read('faces.json') : {},
    panel: existsSync(join(runDir, 'panel/panel.ok.json')) ? read('panel/panel.ok.json') : null,
    finale, reveal,
  }
}

// The panel from the first of its steps that starts once it is in (all of them, if it came in time).
export const panelFrom = (run, arrived) => {
  const steps = run.panel ? run.panel.steps.filter((i) => (run.times.starts[i] ?? -1) >= arrived) : []
  return steps.length ? { ...run.panel, steps } : null
}

export function filmProgram(run, { name = 'live', vectors = run.vectors, drawingAt = () => Infinity, faces = run.faces, faceAt = () => 0, finaleAt = 0, panelAt = 0 } = {}) {
  if (run.script.mode === 'problem') return problemProgram(run.script.problem)
  const { script, times, finale, rawGeometry, cutSizes, screens } = run
  let layout = run.layout
  // Browser playback waits for the model drawings and gives them arrival time zero in both modes.
  // Historical timing benchmarks can still request the transitional artwork in drawings.mjs.
  const all = filmDrawings(run.runDir, vectors, drawingAt, run.times.starts), d = all[name]
  const fitted = withTools(script, rawGeometry, cutSizes, d.vectors)
  // (both films take the object sizes and geometry the live film's drawings give)
  const { geometry, sizes } = name === 'live' ? fitted : withTools(script, rawGeometry, cutSizes, all.live.vectors)
  // A saved plan may now use an existing photographed utensil that its old layout omitted.
  // Re-solve in memory; preserve the original saved run and do not make provider calls.
  if (run.needsLayout || script.steps.some((s) => s.do.some((a) => [a.k, a.to, a.with].some((k) => typeof k === 'string' && geometry[k] && !layout.poses[k])))) layout = solveBuild(script, geometry, sizes)
  const photo = { width: screens.photo.width, height: screens.photo.height }
  // Each object's box in the photo: its mask's (segment.mjs), else the model's.
  const boxes = Object.fromEntries(run.boxList.map((o) => [o.key, geometry[o.key]?.box ?? o.box]))
  const source = program({ script, vectors: withUp(fitted.vectors), boxes, geometry, sizes, layout, photo, look: d.look, upgrades: d.upgrades,
    finale: finaleAt <= times.finale ? finale : null,
    faces: Object.fromEntries(Object.entries(faces).map(([k, f]) => [k, { ...f, at: faceAt(k) }])),
    panel: panelFrom(run, panelAt) })
  return { source, duration: times.duration }
}
