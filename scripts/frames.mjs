// The frame checker: what a viewer would see, measured without the critic or the renderer. Runs a run's live film
// program in Node on a stand-in canvas that keeps the transform and notes where each thing, each label and each work
// site lands on the frame, and lists what is wrong.
//
// Composition, at the middle of every action (only for what the action involves) and at the end of every step (for
// everything on the stage), counted per moment as before:
//   cut off      — more than 8% of a thing outside the frame;
//   under tray / under caption / under panel — more than 10% of it behind the parts column, the caption band or the
//                  reference panel's card;
//   (for what an action is done to and with; anything else — a strand's source, the stage at a step's end, where a
//   close-up may hold — counts only when it is cut in two, partly in the shot: wholly out of it is fine)
//   covered      — more than 40% of it behind a thing drawn after it (not boards, not tools);
//   floating     — side on, at a step's end: its lower edge more than 30 px above the surface and above anything under it.
// Readability, every 0.2 s, counted once per step and subject (the critic's most frequent notes, as numbers):
//   label cut off    — more than 10% of a label outside the frame or outside what clips it (the panel's card);
//   lens crops label — the same, for the stage's labels drawn again inside the magnifier;
//   labels overlap   — two labels sharing more than 20% of the smaller one;
//   label under lens — a label of the stage behind the magnifier drawn over it;
//   label on work    — a label over the spot a tool is working at;
//   label small      — text under 14 px on the 1600 × 900 frame;
//   tool small       — a tool at work whose longest side is under 120 px (7.5% of the width; a
//                      quarter of that on a phone), with no magnifier on it;
//   work small       — the part a tool works on under 120 px, with no magnifier on it;
//   tiny             — at a step's end, a thing on the stage under 40 px.
// And a word in the engine's program that the renderer's validator refuses (it would not draw the film at all).
// What the caption claims, per step:
//   tool not shown   — a tool an action uses is never out of the tray while it works;
//   caption tool     — a tool the caption names is never on the stage in the step;
//   caption number   — a number the caption gives a unit (80 cm, 20 minutes, 12 sts) is in no label in the step.
// Each thing is seen by the box it is drawn in: the program calls ctx.mark(key, x, y, w, h) where the canvas has one
// (the renderer's has none: these calls cost the film nothing), and ctx.mark("@site:" + part, …) where a tool works.
//
//   node frames.mjs <run dir> [--quiet] [--engine other-engine.mjs]
//   node frames.mjs --all [--json out.json] [--engine …]    every fixture (in temporary copies), a table of counts
//   node frames.mjs --all --baseline   …and writes them to benchmarks/frames-baseline.json, which frames.test.mjs holds every
//                                       fixture to (no kind may get worse): run it after a fix lowers a count
import { fileURLToPath } from 'node:url'
import { readFileSync, existsSync, cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { withUp } from '../src/film/helper.mjs'
import { withTools } from '../src/solvers/tools.mjs'
import { plain } from '../src/pipeline/script.mjs'
import { filmDrawings, arrivals } from '../src/pipeline/drawings.mjs'
import { timeline as timelineOf } from '../src/film/engine.mjs'
import { relayout } from '../src/pipeline/relayout.mjs'
import { refusedIn } from '../src/pipeline/words.mjs'

const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]]
const clamp = (u) => Math.min(1, Math.max(0, u))
const area = (r) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1])
const meet = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]
const overlap = (a, b) => area(meet(a, b))
const longest = (r) => Math.max(r[2] - r[0], r[3] - r[1])
const union = (a, b) => (a ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : b)
const TRAY = [28, 70, 162, 860], CAPTION = [180, 52, 1580, 176], PANEL = [1130, 196, 1570, 696], FRAME = [0, 0, 1600, 900]

// The stand-in canvas: the transform and its stack, the current path's box, the clip (a box; inside the magnifier the
// stage is drawn again, so what is drawn there is noted apart), the text state; marks, labels and sites as drawn.
function canvas() {
  let st = { m: [1, 0, 0, 1, 0, 0], clip: null, lens: null, font: 16, align: 'left', baseline: 'alphabetic', alpha: 1 }, path = null
  const stack = [], drawn = [], lensDrawn = [], texts = [], sites = [], floors = [], lenses = []
  // (each solid polygon filled on the stage, in order, and the thing last marked before it: what owns it — a board's
  // faces follow its mark — for whether a spot being worked lies under another thing's face)
  const faces = []
  let poly = [], polygonal = true, owner = null
  const pt = (x, y) => [st.m[0] * x + st.m[2] * y + st.m[4], st.m[1] * x + st.m[3] * y + st.m[5]]
  const grow = (pts) => { for (const [x, y] of pts) { poly.push([x, y]); path = path ? [Math.min(path[0], x), Math.min(path[1], y), Math.max(path[2], x), Math.max(path[3], y)] : [x, y, x, y] } }
  const rect = (x, y, w, h) => { const p = [pt(x, y), pt(x + w, y), pt(x, y + h), pt(x + w, y + h)]; return [Math.min(...p.map((q) => q[0])), Math.min(...p.map((q) => q[1])), Math.max(...p.map((q) => q[0])), Math.max(...p.map((q) => q[1]))] }
  const clipped = (r) => (st.clip ? meet(r, st.clip) : r)
  const ctx = {
    save: () => stack.push({ ...st }), restore: () => { st = stack.pop() || st },
    translate: (x, y) => { st.m = mul(st.m, [1, 0, 0, 1, x, y]) }, scale: (x, y) => { st.m = mul(st.m, [x, 0, 0, y, 0, 0]) },
    rotate: (a) => { st.m = mul(st.m, [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]) },
    transform: (a, b, c, d, e, f) => { st.m = mul(st.m, [a, b, c, d, e, f]) }, setTransform: (a, b, c, d, e, f) => { st.m = [a, b, c, d, e, f] },
    resetTransform: () => { st.m = [1, 0, 0, 1, 0, 0] },
    getTransform: () => ({ a: st.m[0], b: st.m[1], c: st.m[2], d: st.m[3], e: st.m[4], f: st.m[5] }),
    beginPath: () => { path = null; st.arc = false; poly = []; polygonal = true }, moveTo: (x, y) => { if (poly.length) polygonal = false; grow([pt(x, y)]) }, lineTo: (x, y) => grow([pt(x, y)]),
    quadraticCurveTo: (a, b, x, y) => { polygonal = false; grow([pt(a, b), pt(x, y)]) }, bezierCurveTo: (a, b, c, d, x, y) => { polygonal = false; grow([pt(a, b), pt(c, d), pt(x, y)]) },
    fill: (p) => { if (!p && polygonal && poly.length >= 3 && owner && !st.lens && st.alpha >= 0.5) faces.push({ owner, pts: poly.slice() }) },
    rect: (x, y, w, h) => { const r = rect(x, y, w, h); if (poly.length) polygonal = false; grow([[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]]) }, roundRect: (x, y, w, h) => ctx.rect(x, y, w, h),
    arc: (x, y, r) => { st.arc = true; polygonal = false; ctx.rect(x - r, y - r, 2 * r, 2 * r) }, ellipse: (x, y, rx, ry) => { polygonal = false; ctx.rect(x - rx, y - ry, 2 * rx, 2 * ry) },
    // (a round clip on the stage is the magnifier: from then on what is drawn is its close-up, not the stage)
    clip: () => {
      if (!path) return
      if (st.arc && !st.lens && path[2] - path[0] > 200) { st.lens = path; lenses.push(path) }
      st.clip = st.clip ? meet(st.clip, path) : path
    },
    mark: (key, x, y, w, h) => note(key, x, y, w, h),
    fillRect: (x, y, w, h) => { if (w > 3000) floors.push(rect(x, y, w, h)[1]) },
    measureText: (s) => ({ width: String(s).length * st.font * 0.58 }),
    fillText: (s, x, y) => {
      s = String(s); if (!s.trim() || st.alpha < 0.3) return
      const w = s.length * st.font * 0.58, h = st.font
      const x0 = ['center'].includes(st.align) ? x - w / 2 : ['right', 'end'].includes(st.align) ? x - w : x
      const y0 = st.baseline === 'middle' ? y - h / 2 : ['top', 'hanging'].includes(st.baseline) ? y : y - 0.75 * h
      const r = rect(x0, y0, w, h), k = Math.sqrt(Math.abs(st.m[0] * st.m[3] - st.m[1] * st.m[2]))
      texts.push({ s, r, px: st.font * k, clip: st.clip, lens: !!st.lens })
    },
    createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }),
  }
  const proxy = new Proxy(ctx, {
    get: (o, k) => (k in o ? o[k] : k === 'globalAlpha' ? st.alpha : () => {}),
    set: (o, k, v) => {
      if (k === 'font') st.font = +(String(v).match(/([\d.]+)px/) || [, 16])[1]
      if (k === 'textAlign') st.align = v
      if (k === 'textBaseline') st.baseline = v
      if (k === 'globalAlpha') st.alpha = +v
      return true
    },
  })
  const note = (key, x, y, w, h) => {
    const r = clipped(rect(x, y, w, h))
    if (!(r[2] > r[0] && r[3] > r[1])) return
    if (key.startsWith('@site:')) { if (!st.lens) sites.push({ key: key.slice(6), x: (r[0] + r[2]) / 2, y: (r[1] + r[3]) / 2 }); return }
    if (!st.lens) owner = key
    ;(st.lens ? lensDrawn : drawn).push({ key, r, alpha: st.alpha })
  }
  return { proxy, drawn, lensDrawn, texts, sites, floors, lenses, faces }
}

// One box per thing: all it was drawn as, together (a thing cut in two is drawn twice), and the first time it was.
const boxes = (list) => {
  const things = new Map()
  list.forEach((d, i) => { const v = things.get(d.key); things.set(d.key, { r: union(v?.r, d.r), order: v?.order ?? i, alpha: Math.max(v?.alpha ?? 0, d.alpha) }) })
  return things
}
// Whether a point lies in a polygon (even-odd).
const inside = ([x, y], P) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) if ((P[i][1] > y) !== (P[j][1] > y) && x < (P[j][0] - P[i][0]) * (y - P[i][1]) / (P[j][1] - P[i][1]) + P[i][0]) c = !c; return c }
const inTray = (r) => r[0] >= TRAY[0] - 2 && r[2] <= TRAY[2] + 2

// The numbers a caption gives a unit: "80, 96 and 112 cm" → 80, 96, 112.
const UNITS = 'cm|mm|m|in|inch|inches|g|kg|ml|l|cups?|min|mins|minutes?|hours?|h|s|sec|seconds?|sts?|sc|studs?|°'
export const claimedNumbers = (caption) => {
  const out = new Set()
  for (const m of String(caption || '').matchAll(new RegExp(`((?:\\d+(?:\\.\\d+)?\\s*(?:,|and|or|to|–|-|×|x|\\+)?\\s*)+)(${UNITS})(?![a-z])`, 'gi')))
    for (const n of m[1].match(/\d+(?:\.\d+)?/g)) out.add(n)
  return [...out]
}

export async function checkFrames(runDir, { engine = '../src/film/engine.mjs' } = {}) {
  const { program, timeline } = await import(engine.startsWith('.') ? new URL(engine, import.meta.url) : resolve(engine))
  const read = (p) => JSON.parse(readFileSync(join(runDir, p), 'utf8'))
  const script = plain(read('script.json')), layout = read('layout.json'), screens = read('screens/screens.json')
  // (the live film's drawings, as the browser plays them: every object traced, drawings.mjs)
  const drawn = filmDrawings(runDir, read('vectors.json'), arrivals(read('timings.json').marks, timelineOf(script)), timelineOf(script).starts).live
  const { geometry, sizes, vectors } = withTools(script, read('screens/geometry.json'),
    Object.fromEntries(Object.entries(screens).filter(([k]) => k !== 'photo').map(([k, s]) => [k, { width: s.width, height: s.height }])), drawn.vectors)
  const photoBoxes = Object.fromEntries(read('screens/boxes.json').objects.map((o) => [o.key, geometry[o.key]?.box ?? o.box]))
  const panel = existsSync(join(runDir, 'panel/panel.ok.json')) ? read('panel/panel.ok.json') : null
  const source = program({ script, vectors: withUp(vectors), boxes: photoBoxes, geometry, sizes, layout, look: drawn.look, upgrades: drawn.upgrades, panel,
    photo: { width: screens.photo.width, height: screens.photo.height } })
  const film = new Function(`return (${source})`)()
  // (a word the renderer's validator refuses anywhere in a program, even a comment, stops the whole film there)
  const refused = refusedIn(source.replace(panel?.draw ?? '', ''))
  const env = {
    width: 1600, height: 900, duration: 60, font: 'Inter', mono: 'JetBrains Mono',
    palette: { background: '#f3efe6', accent: '#ffcc00', ink: '#1d2b4f', second: '#ffcc00', muted: '#1d2b4f' },
    ease: { linear: (u) => clamp(u), in: (u) => clamp(u) ** 3, out: (u) => 1 - (1 - clamp(u)) ** 3, inOut: (u) => { u = clamp(u); return u < 0.5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2 },
      expoOut: (u) => (clamp(u) >= 1 ? 1 : 1 - 2 ** (-10 * clamp(u))), back: (u) => { u = clamp(u); return 1 + 2.70158 * (u - 1) ** 3 + 1.70158 * (u - 1) ** 2 } },
    random: (i) => { const v = Math.sin(1 * 12.9898 + Math.floor(i) * 78.233) * 43758.5453; return v - Math.floor(v) },
    kit: { spring: (u, o = {}) => { u = clamp(u); if (u >= 1) return 1; const b = Math.min(0.9, Math.max(0, o.bounce ?? 0.3)); if (b <= 0.001) return 1 - (1 - u) ** 3; const w = (o.swings ?? 2) * Math.PI, d = -Math.log(b) * w / Math.PI; return 1 - Math.exp(-d * u) * Math.cos(w * u) * (1 - u ** 3) } },
    screens: Object.fromEntries(Object.entries(screens).map(([k, s]) => [k, { width: s.width, height: s.height, regions: [] }])),
    drawScreen: () => {},
  }
  const old = globalThis.Path2D
  globalThis.Path2D = class { constructor() {} }
  const frame = (t) => { const c = canvas(); film(c.proxy, t, env); return c }
  const times = timeline(script), panelled = new Set(panel ? panel.steps : [])
  const isTool = (k) => !!geometry[k]?.tool
  const loose = (k) => !isTool(k) && !(layout.boards || {})[k]

  // ---- composition, as before ----
  const samples = []
  times.starts.forEach((start, i) => {
    const end = times.starts[i + 1] ?? times.finale
    for (const a of times.acts.filter((a) => a.step === i && a.v !== 'place'))
      samples.push({ t: a.at + a.len / 2, step: i, what: `${a.v} ${a.k}`, involved: new Set([a.k, a.to, a.with, a.part].flat().filter(Boolean)),
        // (what a piece is worked from may lie outside a close-up, the strand coming in from it: in or out, not cut)
        source: a.v === 'work' ? a.to : null })
    samples.push({ t: end - 0.3, step: i, what: 'end', end: true })
  })
  const composition = [], readability = []
  try {
    for (const s of samples) {
      const c = frame(s.t)
      // (what is in the tray is drawn there: a thing whose whole box lies inside it is waiting, not on the stage)
      const stage = [...boxes(c.drawn)].filter(([, v]) => !inTray(v.r))
      for (const [key, v] of stage) {
        // (mid-action, only what the action involves: a close-up may crop a bystander, as any close-up does)
        if (s.involved && !s.involved.has(key)) continue
        const a = area(v.r) || 1, add = (kind) => composition.push({ t: s.t, step: s.step, what: s.what, kind, subject: key })
        // What the action is done to and with must be whole; anything else (a source, the stage at a step's end, where a
        // close-up may hold) only must not be cut in two: wholly out of the shot, or behind the tray, is fine.
        const outside = (a - overlap(v.r, FRAME)) / a, behind = overlap(v.r, TRAY) / a
        const whole = s.involved && key !== s.source, seen = 1 - outside - behind
        if (outside > 0.08 && (whole || seen > 0.08)) add('cut off')
        if (behind > 0.1 && (whole || seen > 0.08)) add('under tray')
        if (overlap(v.r, CAPTION) / a > 0.1) add('under caption')
        if (panelled.has(s.step) && overlap(v.r, PANEL) / a > 0.1) add('under panel')
        // (boards in an assembly overlap by design, and a tool at work covers what it works on: neither counts)
        const over = loose(key) ? stage.filter(([k, w]) => k !== key && loose(k) && w.order > v.order).reduce((sum, [, w]) => sum + overlap(v.r, w.r), 0) : 0
        if (over / a > 0.4) add('covered')
        if (s.end && (layout.view || 'side') === 'side' && c.floors.length) {
          const floor = Math.min(...c.floors), bottom = v.r[3]
          const under = stage.some(([k, w]) => k !== key && w.r[1] <= bottom + 30 && w.r[3] > bottom && w.r[0] < v.r[2] && w.r[2] > v.r[0])
          if (bottom < floor - 30 && !under) add('floating')
        }
        if (s.end && !isTool(key) && longest(v.r) < 40) readability.push({ t: s.t, step: s.step, kind: 'tiny', subject: key })
      }
    }

    // ---- readability and claims, every 0.2 s from the first step to the finale ----
    const stepOf = (t) => times.starts.findLastIndex((s) => s <= t)
    const seen = times.starts.map(() => ({ tools: new Set(), texts: new Set() }))
    // The tool an action works with (a stir's spoon may be the action's own thing), if it is drawn at all; a made piece
    // is never one (withTools marks those as tools so they stay out of the tray's count).
    const made = new Set((script.makes || []).map((m) => m.k))
    const toolOf = (a) => [a.with, a.v === 'stir' ? a.k : null].find((k) => k && geometry[k] && !made.has(k))
    const working = (a) => (a.v === 'use' || a.v === 'measure' || a.v === 'cut' || a.v === 'stir' || a.v === 'work')
    const captionText = new Set((script.steps || []).flatMap((s) => [s.c, s.t].map((x) => (typeof x === 'string' ? x : x?.template)).filter(Boolean)))
    for (let t = times.starts[0]; t < times.finale; t += 0.2) {
      const step = stepOf(t), c = frame(t), add = (kind, subject) => readability.push({ t, step, kind, subject })
      const main = boxes(c.drawn), lens = boxes(c.lensDrawn)
      for (const [k, v] of main) if (!inTray(v.r) && v.alpha >= 0.5) seen[step].tools.add(k)
      for (const x of c.texts) if (!captionText.has(x.s)) seen[step].texts.add(x.s)
      // Labels.
      const labels = c.texts.filter((x) => !captionText.has(x.s))
      for (const x of c.texts) {
        const a = area(x.r) || 1
        const out = (a - overlap(x.r, FRAME)) / a > 0.1 || (x.clip && (a - overlap(x.r, x.clip)) / a > 0.1)
        if (out) add(x.lens ? 'lens crops label' : 'label cut off', x.s)
        if (x.px < 14 && !x.lens) add('label small', x.s)
      }
      for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
        const p = labels[i], q = labels[j]
        if (p.lens !== q.lens) continue
        if (overlap(p.r, q.r) > 0.2 * Math.min(area(p.r), area(q.r))) add('labels overlap', `${p.s} / ${q.s}`)
      }
      // A spot being worked that lies under another thing's face, drawn after the worked part's own faces and not
      // see-through (a board over the spot is drawn faint while it is worked): the tool is seen working on nothing.
      for (const p of c.sites) {
        const last = c.faces.findLastIndex((f) => f.owner === p.key); if (last < 0) continue
        const over = c.faces.slice(last + 1).find((f) => f.owner !== p.key && !isTool(f.owner) && inside([p.x, p.y], f.pts))
        if (over) add('work hidden', `${p.key} under ${over.owner}`)
      }
      for (const x of labels) if (!x.lens) {
        if (c.lenses.some((l) => overlap(x.r, l) > 0.3 * area(x.r))) add('label under lens', x.s)
        if (c.sites.some((p) => p.x > x.r[0] && p.x < x.r[2] && p.y > x.r[1] && p.y < x.r[3])) add('label on work', x.s)
      }
      // Tools at work and what they work on, big enough to see (or magnified).
      for (const a of times.acts) {
        if (!working(a) || t < a.at + a.len * 0.22 || t > a.at + a.len * 0.88) continue
        const tool = toolOf(a)
        if (tool && main.has(tool) && !lens.has(tool) && longest(main.get(tool).r) < 120) add('tool small', tool)
        const part = a.v === 'stir' ? a.to : a.k
        if (tool && part && main.has(part) && !lens.has(part) && longest(main.get(part).r) < 120) add('work small', part)
      }
    }
    // What the caption claims, against what the step showed.
    const claims = []
    ;(script.steps || []).forEach((s, i) => {
      if (i >= times.starts.length) return
      const caption = typeof s.c === 'string' ? s.c : s.c?.template ?? ''
      const add = (kind, subject) => claims.push({ t: times.starts[i], step: i, kind, subject })
      for (const a of times.acts.filter((a) => a.step === i && working(a)))
        if (toolOf(a) && !seen[i].tools.has(toolOf(a))) add('tool not shown', toolOf(a))
      for (const tool of script.tools || []) {
        const words = [tool.k, tool.use].filter((w) => w && /^[a-z]+$/i.test(w))
        if (words.some((w) => new RegExp(`\\b${w}\\b`, 'i').test(caption)) && geometry[tool.k] && !seen[i].tools.has(tool.k)) add('caption tool', tool.k)
      }
      const shown = new Set([...seen[i].texts].flatMap((x) => x.match(/\d+(?:\.\d+)?/g) || []))
      for (const n of claimedNumbers(caption)) if (!shown.has(n)) add('caption number', n)
    })
    // Readability problems once per step and subject (the first time each is seen).
    const once = new Map()
    for (const p of [...readability, ...claims]) { const k = `${p.step}|${p.kind}|${p.subject}`; if (!once.has(k)) once.set(k, p) }
    for (const w of refused) once.set(`refused|${w}`, { t: 0, step: 0, kind: 'refused word', subject: w })
    return { moments: samples.length, composition, problems: [...once.values()].sort((a, b) => a.t - b.t) }
  } finally { globalThis.Path2D = old }
}

export const counts = (r) => count([...r.composition, ...r.problems])
export async function checkFixtures({ engine = '../src/film/engine.mjs' } = {}) {
  // Every fixture, in a temporary copy (a fixture without tracings would be traced into), laid out by today's solvers.
  const here = fileURLToPath(new URL('.', import.meta.url)), all = {}
  for (const name of readdirSync(join(here, '../examples/fixtures'))) {
    const dir = mkdtempSync(join(tmpdir(), `frames-${name}-`))
    try { cpSync(join(here, '../examples/fixtures', name), dir, { recursive: true }); relayout(dir); all[name] = await checkFrames(dir, { engine }) } finally { rmSync(dir, { recursive: true, force: true }) }
  }
  return all
}
const count = (list) => list.reduce((c, p) => ((c[p.kind] = (c[p.kind] || 0) + 1), c), {})

if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2), flag = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null)
  const engine = flag('--engine') ? resolve(flag('--engine')) : '../src/film/engine.mjs'
  if (args.includes('--all')) {
    const all = await checkFixtures({ engine })
    const kinds = [...new Set(Object.values(all).flatMap((r) => [...r.composition, ...r.problems].map((p) => p.kind)))]
    const rows = Object.entries(all).map(([name, r]) => ({ fixture: name, ...Object.fromEntries(kinds.map((k) => [k, count([...r.composition, ...r.problems])[k] || 0])) }))
    rows.push({ fixture: 'total', ...Object.fromEntries(kinds.map((k) => [k, rows.reduce((s, r) => s + r[k], 0)])) })
    console.table(rows)
    if (flag('--json')) writeFileSync(flag('--json'), JSON.stringify(all, null, 1))
    if (args.includes('--baseline')) {
      writeFileSync(new URL('../benchmarks/frames-baseline.json', import.meta.url), JSON.stringify(Object.fromEntries(Object.entries(all).map(([n, r]) => [n, counts(r)])), null, 1) + '\n')
      console.log('benchmarks/frames-baseline.json written')
    }
  } else {
    const r = await checkFrames(resolve(args[0]), { engine })
    const line = (p) => `${p.t.toFixed(2).padStart(6)}s  step ${p.step + 1}  ${(p.what ?? '').padEnd(22)}  ${p.kind.padEnd(16)} ${p.subject}`
    if (!args.includes('--quiet')) console.log([...r.composition.map(line), '', ...r.problems.map(line)].join('\n'))
    const said = (c) => Object.entries(c).map(([k, n]) => `${n} ${k}`).join(', ')
    console.log(`${r.moments} moments, ${r.composition.length} composition problems${r.composition.length ? ': ' + said(count(r.composition)) : ''}`)
    console.log(`${r.problems.length} readability and caption problems (once per step)${r.problems.length ? ': ' + said(count(r.problems)) : ''}`)
  }
}
