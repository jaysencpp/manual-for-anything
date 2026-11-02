// Film artwork: traced vectors while model artwork is pending, except repairs,
// which retain their photographed detail so a damaged seam is not lost in tracing.
// Ready artwork replaces either stand-in at a step boundary, or immediately when
// it arrives after the last step has started. Replay uses all available model art.
// Older saved runs may carry tracings (screens/traced.json); new runs use model artwork alone.
//   filmDrawings(runDir, modelVectors, arrivedAt, starts) → {live: {vectors, look, upgrades}, replay: {vectors, look, upgrades}}
// arrivedAt(key): the film time the model's drawing of key came in (Infinity: not in time); starts: the steps' start
// times. upgrades: {key: film time}; the model's drawing of an upgraded key is in vectors as key + "@drawn".
//   arrivals(marks, times) → arrivedAt, from a run's timings.marks, for browser playback
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { familyDrawings } from '../solvers/families.mjs'
import { plain } from './script.mjs'
import { completeIllustration } from './illustration.mjs'

export function traced(runDir) {
  const file = join(runDir, 'screens/traced.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}

// Historical earliest-start timing for recorded-run benchmarks. Browser playback now waits for required artwork.
export const filmStart = (marks, times) => Math.max(marks['script: object list'], marks['SAM: cut-outs'] - 1.0, marks.layout - times.steps0)
export const arrivals = (marks, times) => {
  const start = filmStart(marks, times)
  return (key) => (marks[`drawing: ${key}`] != null ? +(marks[`drawing: ${key}`] - start).toFixed(2) : Infinity)
}

export function filmDrawings(runDir, modelVectors = {}, arrivedAt = () => Infinity, starts = []) {
  const t = traced(runDir)
  if (!t) return { live: { vectors: modelVectors, look: Object.keys(modelVectors).length ? 'drawn' : 'photo', upgrades: {} }, replay: { vectors: modelVectors, look: 'drawn', upgrades: {} } }
  // Everyday-family shapes remain stand-ins for historical recordings. Finished model artwork takes precedence.
  const script = existsSync(join(runDir, 'script.json')) ? plain(JSON.parse(readFileSync(join(runDir, 'script.json'), 'utf8'))) : {}
  // A normalized illustration has a different coordinate frame from its tracing.
  // Playback already waits for it; never cross-fade mismatched artwork frames.
  const complete = Object.fromEntries((script.objects || []).filter(o => completeIllustration(script, o) && modelVectors[o.k]).map(o => [o.k, modelVectors[o.k]]))
  // Repair close-ups need the photographed damage: a colour-region tracing can
  // erase a torn edge or seam entirely. Keep that detail until its artwork arrives.
  const repair = /\b(repair|fix|mend|reattach|restitch)\b/i.test([script.title, script.design?.purpose, ...((script.steps || []).map(s => s.c))].join(' '))
  const targets = new Set(repair ? (script.steps || []).flatMap(s => s.do || []).filter(a => a.v !== 'place').map(a => a.k) : [])
  const standby = Object.fromEntries([...targets].filter(k => t[k]).map(k => [k, { width: t[k].width, height: t[k].height,
    cutOut: true, parts: [{ id: k, parent: null, pivot: [t[k].width / 2, t[k].height], shapes: [] }] }]))
  const family = Object.fromEntries(Object.entries(familyDrawings(script, t)).filter(([k]) => !targets.has(k)))
  const drawn = Object.keys(t).filter((k) => !complete[k] && modelVectors[k] && Number.isFinite(arrivedAt(k)))
  const early = Object.fromEntries(drawn.filter((k) => arrivedAt(k) <= 0).map((k) => [k, modelVectors[k]]))
  // Prefer the next step boundary; late artwork still replaces its tracing immediately.
  const upgrades = Object.fromEntries(drawn.filter((k) => !early[k]).map((k) => [k, starts.find((s) => s >= arrivedAt(k)) ?? arrivedAt(k)]))
  const late = Object.fromEntries(Object.keys(upgrades).map((k) => [`${k}@drawn`, modelVectors[k]]))
  return { live: { vectors: { ...modelVectors, ...t, ...standby, ...family, ...early, ...late, ...complete }, look: 'drawn', upgrades },
    replay: { vectors: { ...t, ...standby, ...family, ...modelVectors }, look: 'drawn', upgrades: {} } }
}
