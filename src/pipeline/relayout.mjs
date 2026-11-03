// Solves a run's layout again from what it saved (after a change to layout.mjs or tools.mjs), without the models:
//   node relayout.mjs <run dir>
// relayout(dir) does the same from code: the frame checks and the web app's examples use it, so a saved run is laid out
// by today's solvers, as a fresh run would be.
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { solveBuild as solve } from '../solvers/layout.mjs'
import { withTools } from '../solvers/tools.mjs'
import { plain } from './script.mjs'

export function relayout(dir) {
  const read = (p) => JSON.parse(readFileSync(join(dir, p), 'utf8'))
  // (a written problem has no build to lay out: its film is drawn from the problem alone. Laying it out as one made
  // every saved problem fail to open as an example.)
  const saved = read('script.json')
  if (saved.mode === 'problem') return
  const script = plain(saved), screens = read('screens/screens.json')
  delete screens.photo
  const { geometry, sizes } = withTools(script, read('screens/geometry.json'),
    Object.fromEntries(Object.entries(screens).map(([k, s]) => [k, { width: s.width, height: s.height }])), {})
  writeFileSync(join(dir, 'layout.json'), JSON.stringify(solve(script, geometry, sizes), null, 1))
}

if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))) relayout(process.argv[2])
