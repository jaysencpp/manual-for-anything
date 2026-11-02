import { fileURLToPath } from 'node:url'
import { validateDiagrams, compileDiagrams } from '../film/diagram.mjs'
// The reference panel: the craft's own diagram beside a step (a crochet chart, a fold diagram, a cutting diagram…),
// written by the model as structured diagrams for every step that has one, or none at all. It needs only the script,
// so run.mjs asks for it as soon as the script is in. The diagrams are validated as data and compiled here (diagram.mjs);
// a panel that throws in the film only blanks itself (the engine calls it inside a try).
//
//   node panel.mjs <run dir> [--effort low]    — writes a panel for a saved run (one model call), then re-film it
// Writes <run dir>/panel/: prompt.txt, out.json, panel.js (as answered) and panel.ok.json ({steps, labels, draw}) if
// it passed.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { generate, json } from './model.mjs'
import { plain } from './script.mjs'
import { operationFacts } from '../solvers/operations.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
export const SIZE = 400

// What is wrong with an answer's panels, or null. Panels are structured data compiled by us: JavaScript from the model
// is never evaluated here, and saved panels from older runs only ever execute in the browser's sandboxed player.
export function check(answer) {
  const p = answer.panels
  if (p == null) return null
  if (p.format !== 'diagram/v1') return 'not a compiled diagram'
  return p.draw === compileDiagrams(p.diagrams).draw ? null : 'Untrusted compiled diagram'
}

// Asks for the panels and checks them: {steps, labels, draw}, or null (none wanted, or refused — the reason in call.problem).
export async function writePanel(runDir, script, { effort = 'low', noThinking = false, signal, references = null, ...callOptions } = {}) {
  const dir = join(runDir, 'panel')
  mkdirSync(dir, { recursive: true })
  const idea = (script.ideas || [])[script.pick || 0] || {}
  const fill = (template, values) => template.replace(/\{\{(\w+)\}\}/g, (_, k) => values[k])
  const prompt = fill(readFileSync(join(here, '../../prompts/panel-prompt.txt'), 'utf8'), {
    title: script.title, sub: script.sub, kind: idea.kind || 'build', size: SIZE, script: JSON.stringify(script),
    steps: script.steps.map((s, i) => `${i}. ${s.t}: ${s.c}`).join('\n'), facts: JSON.stringify(operationFacts(script)),
    references: JSON.stringify(references?.manifest || []),
    rules: readFileSync(join(here, '../../prompts/program-rules.txt'), 'utf8').trim() })
  writeFileSync(join(dir, 'prompt.txt'), prompt)
  const call = await generate(dir, prompt, { ...callOptions, effort, noThinking, signal, images: references?.images || [] })
  let answer = null
  try {
    answer = json(call.text)
    if (answer.panels != null) {
      validateDiagrams(answer.panels.diagrams, operationFacts(script), { stepCount: script.steps.length, objectKeys: (references?.manifest || []).map(o => o.key) })
      answer.panels = compileDiagrams(answer.panels.diagrams)
    }
    call.problem = check(answer)
  } catch (error) { call.problem = `not JSON: ${error.message}` }
  writeFileSync(join(dir, 'panel.js'), answer?.panels?.draw ?? call.text)
  const panels = call.problem ? null : answer.panels
  if (panels) writeFileSync(join(dir, 'panel.ok.json'), JSON.stringify(panels, null, 1))
  return { panels, call }
}

if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2), runDir = resolve(args[0])
  const effort = args.includes('--effort') ? args[args.indexOf('--effort') + 1] : 'low'
  const script = plain(JSON.parse(readFileSync(join(runDir, 'script.json'), 'utf8')))
  const { panels, call } = await writePanel(runDir, script, { effort })
  console.log(call.problem ? `refused: ${call.problem}` : panels ? `panels for steps ${panels.steps.join(', ')}` : 'no panel wanted',
    `(${call.seconds}s, $${call.cost.toFixed(3)})`)
}
