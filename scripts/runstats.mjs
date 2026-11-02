// How fast and how sound the planner was, run by run and per prompt version: to compare a new prompt or effort with
// the runs before it. Reads only what each run saved (timings.json, script/planning.json, script/validation-*.json,
// server.log — a run that failed has no timings, and counts as failed);
// no models. Runs made with a stand-in model (tests, the stub) are left out: their prompts are a few tokens.
//   node runstats.mjs [runs dir, default runs/web] [--last N]
import { fileURLToPath } from 'node:url'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const root = resolve(args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--last') || fileURLToPath(new URL('../runs/web', import.meta.url)))
const last = args.includes('--last') ? +args[args.indexOf('--last') + 1] : 30
const read = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
const median = (xs) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? +(v.length % 2 ? v[v.length >> 1] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2).toFixed(1) : null }

const rows = readdirSync(root).map((name) => join(root, name)).filter((dir) => existsSync(join(dir, 'script/planning.json'))).map((dir) => {
  const t = read(join(dir, 'timings.json')) || {}, p = read(join(dir, 'script/planning.json')), s = read(join(dir, 'script.json'))
  if (!p || !((p.usage?.prompt_tokens ?? 0) > 2000)) return null
  const log = existsSync(join(dir, 'server.log')) ? readFileSync(join(dir, 'server.log'), 'utf8') : ''
  const m = t.marks || {}, attempts = readdirSync(join(dir, 'script')).filter((f) => /^validation-\d+\.json$/.test(f)).length
  const first = read(join(dir, 'script/validation-0.json')), kept = Object.keys(m).find((k) => k.startsWith('script: kept with'))
  return { run: basename(dir), at: statSync(join(dir, 'script/planning.json')).mtime, title: s?.title || '?', failed: !existsSync(join(dir, 'timings.json')) || /^Invalid |^Error/m.test(log), prompt: p.promptVersion || 'before',
    effort: p.effort || t.planEffort || t.effort || '?', planS: +(p.seconds ?? NaN).toFixed(1), firstTokenS: +(p.firstTokenSeconds ?? NaN).toFixed(1),
    thinking: p.thinking ?? null, output: p.output ?? null, attempts: p.planAttempts ?? attempts, firstProblems: first ? first.errors.length : null,
    kept: kept ? +kept.match(/\d+/)[0] : 0,
    filmStartsS: m.layout ?? null, design: !!s?.design }
}).filter(Boolean).sort((a, b) => a.at - b.at)
  // (a run copied to try something on it is the same plan: counted once)
  .filter((r, i, all) => all.findIndex((o) => o.planS === r.planS && o.output === r.output && o.thinking === r.thinking) === i).slice(-last)

if (!rows.length) { console.log(`no real runs in ${root}`); process.exit(0) }
console.table(rows.map(({ at, ...r }) => ({ ...r, run: r.run.slice(0, 26), title: r.title.slice(0, 22) })))
// Per prompt version and plan effort: the medians, and how often a plan needed its repair or was kept with problems.
const groups = Map.groupBy(rows, (r) => `${r.prompt} · ${r.effort}`)
console.table([...groups].map(([group, rs]) => ({ group, runs: rs.length, planS: median(rs.map((r) => r.planS)), firstTokenS: median(rs.map((r) => r.firstTokenS)),
  failed: `${rs.filter((r) => r.failed).length}/${rs.length}`, filmStartsS: median(rs.map((r) => r.filmStartsS)), thinking: median(rs.map((r) => r.thinking)), repaired: `${rs.filter((r) => r.attempts > 1).length}/${rs.length}`,
  keptWithProblems: `${rs.filter((r) => r.kept).length}/${rs.length}` })))
