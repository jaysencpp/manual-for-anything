// Offline imports never instantiate a production server or change its database.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync, renameSync } from 'node:fs'
import { join, resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { gradePlan, issue } from './planning-grade.mjs'
import { openPlanningBrowser } from './planning-browser.mjs'
import { PROMPT_VERSION } from '../src/pipeline/plan.mjs'

export const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '..')
export const read = path => JSON.parse(readFileSync(path, 'utf8'))
export const safe = id => typeof id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(id)
export function save(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2)); renameSync(`${path}.tmp`, path) }
export function fresh(out) { if (existsSync(out)) throw new Error('Output already exists; choose a fresh --out directory'); mkdirSync(out, { recursive: true }) }
export function readCase(out, id) { if (!safe(id)) throw new Error('Invalid case id'); return read(join(out, 'cases', id, 'case.json')) }
export function fromRaw(file) {
  if (!existsSync(file)) return null
  const data = read(file)
  return { ...data, text: data.result ?? data.text ?? '', seconds: data.seconds ?? data.duration_ms / 1000, cost: data.cost ?? data.total_cost_usd ?? null }
}
const cutSizes = screens => Object.fromEntries(Object.entries(screens).filter(([k]) => k !== 'photo').map(([k, s]) => [k, { width: s.width, height: s.height }]))
const fixtures = [
  ['wood8', 'Wood build', 'Build a useful planter from the available boards, keeping cuts within stock and every joint executable.', ['cut', 'place']],
  ['lego-pile', 'LEGO build', 'Make a useful connected LEGO build with the photographed bricks and plate, without inventing pieces.', ['place']],
  ['groceries', 'Groceries', 'Make a meal with these groceries, declaring ordinary cooking tools and useful quantities and times.', ['heat', 'pour']],
  ['yarn', 'Yarn', 'Make a useful crochet piece with the photographed yarn and tools, with consistent counts and complete steps.', ['work']],
  ['paper-plane', 'Paper folds', 'Make a paper dart from the photographed sheet, showing the folds and resulting shape.', ['fold']],
  ['wire-bracelet', 'Wire shaping', 'Make a bracelet from this wire with supported strand operations and declared supplies.', ['strand']],
]
function baseCase(out, id, photo, inventory, cut, extra) {
  const folder = join(out, 'cases', id); mkdirSync(folder, { recursive: true }); copyFileSync(photo, join(folder, 'photo.png'))
  const png = readFileSync(join(folder, 'photo.png'))
  if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Expected normalized PNG photo')
  const c = { id, photo: { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }, inventory, cut, confirmedMeasurements: {}, assertions: {},
    reviewQuestions: ['Does this fulfill the request?', 'Are materials grounded and quantities sufficient?', 'Are steps complete and captions faithful?', 'Does the final result follow from shown operations?'], ...extra }
  save(join(folder, 'case.json'), c); return c
}
export async function auditSavedPlans(out, { database = join(root, 'data/app.sqlite'), filesRoot = join(root, 'data/files'), films, browserFactory = openPlanningBrowser, includeFixtures = true } = {}) {
  fresh(out)
  const browser = await browserFactory(), rows = [], cases = []
  const manifest = { version: 1, mode: 'saved-replay', created: new Date().toISOString(), promptVersion: PROMPT_VERSION,
    note: 'Offline replay of saved artifacts under current checks. Not a randomized model comparison or fresh provider evidence.', cases: [] }
  save(join(out, 'manifest.json'), manifest); save(join(out, 'reviews.json'), {})
  try {
    if (includeFixtures) for (const [id, title, request, requiredVerbs] of fixtures) {
      const source = join(here, '../examples/fixtures', id), witness = read(join(source, 'script.json')), screens = read(join(source, 'screens/screens.json'))
      const inventory = structuredClone(witness.objects)
      for (const o of inventory) if (!o.segment) o.segment = o.part?.family === 'brick' ? 'toy brick' : /board|batten/.test(o.n) ? 'wooden board' : o.n
      const candidate = structuredClone(witness)
      for (const o of candidate.objects) o.segment ||= inventory.find(x => x.k === o.k).segment
      const c = baseCase(out, id, join(source, 'screens/photo.png'), inventory, { geometry: read(join(source, 'screens/geometry.json')), sizes: cutSizes(screens) },
        { title, source: 'saved-fixture', diagnostic: false, request, guidance: { messages: [request] },
          assertions: { requiredObjects: inventory.map(o => o.k), requiredVerbs, minSteps: 2 },
          notes: ['Historical fixture: missing segment labels explicitly added in the benchmark copy.', 'Estimated dimensions remain estimates, not confirmed measurements.'] })
      save(join(out, 'cases', id, 'witness.json'), candidate)
      const grade = await gradePlan({ candidate, ...c, smoke: browser.smoke })
      c.qualification = { machine: grade.machine, eligibleForPilot: grade.machine === 'pass', taskReview: 'pending', reason: grade.machine === 'pass'
        ? 'Saved witness passes current machine gates; human task review remains pending.' : 'Saved witness rejected: investigate the task/engine contract before ranking models on this case.' }
      save(join(out, 'cases', id, 'case.json'), c); cases.push(c)
      rows.push({ id: `${id}-witness`, caseId: id, attemptIndex: 0, first: true, selected: true, model: 'saved-fixture', effort: 'not-recorded', status: 'graded', grade,
        candidateFile: `cases/${id}/witness.json`, rawFile: null, cost: null, requestKind: 'saved witness', sourceMode: 'saved-replay' })
    }
    if (existsSync(database)) {
      const db = new DatabaseSync(database, { readOnly: true })
      try {
        if (db.prepare("SELECT value FROM settings WHERE key='storage'").get()?.value !== 'local') throw new Error('Audit reads local film blobs only. Export Azure artifacts locally first; no storage credentials are used.')
        const ids = films || db.prepare("SELECT id FROM films WHERE status='failed' ORDER BY created_at DESC LIMIT 10").all().map(r => r.id)
        for (const filmId of ids) {
          if (!safe(filmId)) throw new Error('Invalid film id')
          const row = db.prepare('SELECT state,events,status FROM films WHERE id=?').get(filmId)
          if (!row) throw new Error(`Saved film not found: ${filmId}`)
          const state = JSON.parse(row.state), events = JSON.parse(row.events), id = `film-${filmId}`, folder = join(out, 'cases', id, 'saved')
          const allowed = /^(?:script\/(?:candidate-\d+\.json|out-\d+(?:\.partial)?\.json|validation(?:-\d+)?\.json|repair-\d+\.json|patch-\d+\.json|request-\d+\.json|selected-attempt\.json|planning\.json|perception\.json|photo\.png|prompt\.txt)|screens\/(?:photo\.png|screens\.json|geometry\.json|boxes\.json)|failure\.json|run-config\.json)$/
          for (const f of db.prepare('SELECT path,hash FROM files WHERE film_id=?').all(filmId).filter(f => allowed.test(f.path))) {
            if (!/^[a-f0-9]{64}$/.test(f.hash)) throw new Error('Invalid saved file hash')
            const target = join(folder, f.path); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(filesRoot, 'objects', f.hash), target)
          }
          const photoFile = existsSync(join(folder, 'script/photo.png')) ? join(folder, 'script/photo.png') : join(folder, 'screens/photo.png')
          if (!existsSync(photoFile)) continue
          let inventory = state.objects || []
          const perception = fromRaw(join(folder, 'script/perception.json'))
          if (perception?.text) { try { inventory = JSON.parse(perception.text).objects || inventory } catch {} }
          const screens = existsSync(join(folder, 'screens/screens.json')) ? read(join(folder, 'screens/screens.json')) : {}
          const cut = existsSync(join(folder, 'screens/geometry.json')) ? { geometry: read(join(folder, 'screens/geometry.json')), sizes: cutSizes(screens) } : null
          const c = baseCase(out, id, photoFile, inventory, cut, { title: inventory.map(o => o.n).join(', ') || 'Saved failed film', source: 'saved-film', filmId, diagnostic: true,
            request: 'Exact original upload/revision context retained in saved artifacts.', guidance: state.guidance || null, recordedStatus: row.status,
            recordedFailure: events.findLast(e => e.type === 'failed')?.message || null,
            qualification: { machine: 'unqualified', eligibleForPilot: false, taskReview: 'pending', reason: 'Failure diagnostic: specify a feasible task and expected outcome before model ranking.' } })
          cases.push(c)
          const selectedFile = join(folder, 'script/selected-attempt.json'), selected = existsSync(selectedFile) ? read(selectedFile).attempt : null
          const scriptFiles = existsSync(join(folder, 'script')) ? readdirSync(join(folder, 'script')) : []
          const attempts = [...new Set(scriptFiles.flatMap(f => { const m = /^(?:candidate|request|out)-(\d+)(?:\.partial)?\.json$/.exec(f); return m ? [Number(m[1])] : [] }))].sort((a, b) => a - b)
          for (const attempt of attempts) {
            const candidateFile = join(folder, 'script', `candidate-${attempt}.json`), rawFile = join(folder, 'script', `out-${attempt}.json`)
            const raw = fromRaw(rawFile), partial = fromRaw(join(folder, 'script', `out-${attempt}.partial.json`)), requestFile = join(folder, 'script', `request-${attempt}.json`), request = existsSync(requestFile) ? read(requestFile) : null
            const isPatch = request?.name === 'InstructionPlanPatch'
            const candidate = existsSync(candidateFile) ? read(candidateFile) : null
            const grade = await gradePlan({ ...c, candidate, rawText: raw?.text ?? partial?.text ?? '', rawSchema: request?.schema, isPatch, smoke: browser.smoke })
            if (!raw && !candidate) grade.findings.push(issue('provider', 'No complete saved response; partial usage may be unavailable'))
            const repairFile = join(folder, 'script', `repair-${attempt}.json`)
            rows.push({ id: `${id}-${attempt}`, caseId: id, attemptIndex: attempt, first: attempt === 0, selected: selected === attempt,
              model: raw?.model || 'not-recorded', effort: request?.effort || 'not-recorded', status: raw || candidate ? 'graded' : 'provider-failure', grade,
              candidateFile: candidate ? relative(out, candidateFile) : null, rawFile: raw ? relative(out, rawFile) : null, cost: raw?.cost ?? partial?.cost ?? null, usage: raw?.usage ?? partial?.usage ?? null, responseSeconds: raw?.seconds ?? partial?.seconds ?? null,
              requestKind: isPatch ? 'patch' : attempt ? 'full repair' : 'initial plan', repairDecision: existsSync(repairFile) ? read(repairFile) : null, sourceMode: 'saved-replay' })
          }
        }
      } finally { db.close() }
    }
    manifest.cases = cases.map(c => ({ id: c.id, title: c.title, diagnostic: c.diagnostic, qualification: c.qualification }))
    manifest.finished = new Date().toISOString(); save(join(out, 'manifest.json'), manifest); save(join(out, 'results.json'), rows)
    return { manifest, rows }
  } finally { await browser.close() }
}
