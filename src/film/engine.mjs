// The instruction-film engine: one film program which plays any script — the photo, its objects lifting off into a
// tray, the title card, the steps (each a few verbs the engine animates itself: place, pour, sprinkle, cut, stir, heat,
// and work — a piece the script makes, crocheted stitch by stitch from its yarn)
// on the solved layout, the finale, the end card. Only the finale may be the model's: a (ctx, u, env, objects, stage)
// function, called inside a try; when there is none, or it throws, the engine plays the script's finale beats itself.
// A film has one look throughout: "photo" (every object its cut-out, for historical recordings)
// or "drawn" (every object its drawing, turned into it as it lands in the tray, for browser playback).
//
//   timeline(script) → when each part of the film starts, and each step's verbs
//   program({script, vectors, boxes, geometry, sizes, layout, photo, finale, look}) → the (ctx, t, env) source
import { helperFor } from './helper.mjs'
import { data } from '../pipeline/words.mjs'
import { SIZE } from '../pipeline/panel.mjs'
import { operationSites, operationFacts, entities } from '../solvers/operations.mjs'
import { demonstrationSources, checkDemonstration, drawingContext, demonstrationFrame, paleOn, demoPoint, demoPose } from './demonstrations.mjs'
import { morph } from '../solvers/reshape.mjs'
import { runFolds, foldLength, foldKind, openLength, transforms } from '../solvers/fold.mjs'
import { runStrands, strandLength, strandKit } from '../solvers/strand.mjs'
import { workingRegion } from './framing.mjs'
import { validatePlan } from '../pipeline/validate.mjs'
import { sheetParts, pathPoint } from '../solvers/sheets.mjs'
import { mixtureColor, stirOffset } from '../solvers/processes.mjs'
import { liquidLevel, ingredientPose } from '../solvers/vessels.mjs'

export const TIMES = { intro: 3.4, title: 2.2, finale: 6, end: 2.6 }

// Include the inputs actually used by the instructions, whether photographed or
// supplied separately. Finished pieces and unrelated objects are not inputs.
export function usedRequirements(script, cast = []) {
  const acts = (script.steps || []).flatMap(s => s.do || [])
  const used = new Set([...cast, ...acts.flatMap(a => [a.k, a.to, a.with, a.part, ...(a.demo?.actors || [])])].filter(Boolean))
  const normal = value => String(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    .replace(/\b(?:cocktail glass|tumbler)\b/g, 'glass')
  const readable = (value, fallback) => /[\p{L}\p{N}]/u.test(value || '') ? value.trim() : fallback.replace(/-/g, ' ')
  const needs = [], add = value => { if (value && !needs.some(n => normal(n) === normal(value))) needs.push(value) }
  for (const supply of script.supplies || []) add(supply)
  // A supply may already name an object ("400 g chopped tomatoes" for tomatoes). Objects are only compared whole: "green
  // brick" is not "lime green brick", and two things with one name are counted.
  const supplies = [...needs], counted = new Map()
  for (const object of [...(script.objects || []), ...(script.materials || [])]) {
    if (!used.has(object.k)) continue
    const name = readable(object.n, object.k), aliases = [name, object.k.replace(/-/g, ' ')].map(normal)
    if (supplies.some(n => aliases.some(alias => ` ${normal(n)} `.includes(` ${alias} `)))) continue
    const same = [...counted.keys()].find(n => normal(n) === normal(name))
    if (same) counted.set(same, counted.get(same) + 1)
    else counted.set(name, 1)
  }
  for (const [name, count] of counted) add(count > 1 ? `${count} × ${name}` : name)
  const facts = operationFacts(script)
  for (const tool of script.tools || []) {
    if (!used.has(tool.k)) continue
    const count = facts.filter(f => f.part === tool.k).reduce((sum, f) => sum + f.count, 0)
    const name = ({ tape: 'tape measure', board: 'cutting board', square: 'try square', level: 'spirit level' })[tool.k] || tool.k.replace(/-/g, ' ')
    // An observed tool may already have supplied its readable name above.
    if (needs.some(n => normal(n) === normal(name)) && !count) continue
    add(count ? count + ' ' + (count > 1 && !/s$/.test(name) ? name + 's' : name) + (+tool.cm > 0 ? ' · ' + Math.round(tool.cm * 10) + ' mm' : '') : name)
  }
  return needs
}
// How long each verb takes; a step lasts its verbs one after another, and at least STEP.
const LENGTH = { place: 0.55, pour: 1.7, sprinkle: 1.5, cut: 1.2, stir: 1.5, heat: 1.6, work: 3.2, use: 2.2, measure: 1.8, demonstrate: 3.2, reshape: 2.4, fold: 2.6, strand: 2.4 }
// A use that puts in several fasteners, and a cut into several parts, take longer — a board's cut most: it is marked,
// sawn joint by joint and comes apart.
const lengthOf = (a, v, boards) => v === 'fold' ? foldLength(a) : v === 'strand' ? strandLength(a) : v === 'use' && +a.n > 1 ? 1.4 + 0.55 * Math.min(6, +a.n)
  : v === 'cut' && Array.isArray(a.into) && a.into.length > 1 ? (boards ? 2.0 + 1.1 * (a.into.length - 1) : 1.0 + 0.9 * (a.into.length - 1)) : LENGTH[v]
const STEP = 2.3

// How long turning the work over takes, each way.
export const TURN = 0.9

// What is inside a thing cut into pieces, when the plan does not say: its name's usual colour.
const FOOD_COLORS = [[/carrot/, '#e8873a'], [/onion|shallot|garlic/, '#efe3c8'], [/pepper|chil[ie]/, '#d9472b'], [/celery|cucumber|zucchini|courgette|lettuce|cabbage|herb|parsley|basil|broccoli/, '#8fbf5a'],
  [/tomato/, '#d23c2a'], [/potato|turnip|parsnip/, '#e6d3a0'], [/cheese|cheddar/, '#f0c24a'], [/mushroom/, '#c9b49a'], [/lemon|banana|corn/, '#f2d64b'], [/apple|pear/, '#efe3a8'], [/bread|toast/, '#d8a868'],
  [/chicken|turkey|pork/, '#eed4b0'], [/beef|steak|ham|sausage|bacon/, '#b5604c']]
export const foodColor = (name) => FOOD_COLORS.find(([words]) => words.test(String(name).toLowerCase()))?.[1]

// Packaged food put into a cooking vessel is opened and emptied in. The package itself does not go in the pot.
const PACKAGING = /\b(package|packet|pack|bag|box|carton|tub|tray|wrapper|sachet|pouch|tin|can|jar|bottle)\b/i
const COOKWARE = /\b(pot|pan|saucepan|skillet|wok|bowl|casserole|stockpot)\b/i
const words = (value) => String(value ?? '').replace(/[-_]/g, ' ')
export const unpacksInto = (object, to, targetName) => !!object && PACKAGING.test(words(`${object.n ?? ''} ${object.k ?? ''}`)) && COOKWARE.test(words(`${targetName ?? ''} ${to ?? ''}`))

// Things cut up on one support share it: each gets an even slot within its width, its pieces resting on its top. Left
// alone, the layout spreads things as wide as they are, which puts a row of them past the edge of a cutting board.
// Returns {key: {x, width, scale}}, world units. sizes are in cut-out pixels; drawings are four times that.
export function heapSlots(acts, poses, sizes) {
  const groups = new Map(), placedOn = {}
  for (const a of acts) {
    if (a.v === 'place' && placedOn[a.k] == null) placedOn[a.k] = a.rel === 'on' ? a.to : null
    if (a.v === 'cut' && typeof a.into === 'string' && a.into !== 'snip' && placedOn[a.k] && poses[placedOn[a.k]] && poses[a.k] && sizes[placedOn[a.k]]) {
      const keys = groups.get(placedOn[a.k]) || []
      if (!keys.includes(a.k)) groups.set(placedOn[a.k], [...keys, a.k])
    }
  }
  const slots = {}
  for (const [support, keys] of groups) {
    const P = poses[support], width = sizes[support].width * 4 * P.scale, left = P.x - (P.anchor?.[0] ?? sizes[support].width * 2) * P.scale, margin = width * 0.04, slot = (width - 2 * margin) / keys.length
    keys.forEach((key, i) => {
      const own = (sizes[key]?.width || 1) * 4
      slots[key] = { x: left + margin + slot * (i + 0.5), width: slot, scale: Math.min(poses[key].scale, (slot * 0.95) / own) }
    })
  }
  return slots
}

export function timeline(script) {
  const steps0 = TIMES.intro + TIMES.title, acts = [], starts = [], turns = []
  let at = steps0, over = null
  // Work on the underside: turned over before it (once, for a run of such acts) and the right way up again before the
  // next act that is not — or, the step ending turned, at the start of the next step, so a step ends on its work as
  // done (the screws in the base), the way a manual leaves it until the next picture turns it back.
  const back = (clock) => { turns.push({ from: +over.toFixed(3), to: +(clock + TURN).toFixed(3) }); over = null; return clock + TURN }
  // (a sheet opened out turns back every fold since it was last flat, one after another: so many, so long)
  const folded = {}
  // Placed, then cut into pieces, then placed again ("add the onions to the pot"): the pieces go over by the handful.
  const placed = new Set(), cutUp = new Set(), named = Object.fromEntries((script.objects || []).map((o) => [o.k, o]))
  script.steps.forEach((step, i) => {
    starts.push(at)
    let clock = at + 0.4
    if (over != null && !(step.do || [])[0]?.turn) clock = back(clock)
    for (const act of step.do || []) {
      if (!LENGTH[act.v]) throw new Error(`Unsupported operation: ${act.v}`)
      // (a cut with a shape is through a folded sheet: one of its folds' acts, fold.mjs, as the plan's settling makes it)
      const object = named[act.k], handful = act.v === 'place' && act.to && cutUp.has(act.k)
      const unpacked = act.v === 'place' && act.rel === 'in' && !handful && !placed.has(act.k) && unpacksInto(object, act.to, named[act.to]?.n)
      const v = act.v === 'cut' && act.shape ? 'fold' : handful ? 'pour' : unpacked ? 'sprinkle' : act.v
      const color = handful || unpacked ? act.color || object?.contents?.color || foodColor(object?.n ?? act.k) : undefined
      if (act.v === 'place') placed.add(act.k)
      if (act.v === 'cut' && typeof act.into === 'string' && act.into !== 'snip' && placed.has(act.k)) cutUp.add(act.k)
      let len = lengthOf(act, v, ['plan', 'front', 'iso'].includes(script.view))
      if (v === 'fold' && foldKind(act) === 'spread') { len = openLength(folded[act.k] || 0); folded[act.k] = 0 }
      else if (v === 'fold' && transforms(act)) folded[act.k] = (folded[act.k] || 0) + 1
      if (act.turn && over == null) { over = clock; clock += TURN }
      if (!act.turn && over != null) clock = back(clock)
      acts.push({ ...act, v, ...(handful ? { handful } : {}), ...(unpacked ? { unpacked } : {}), ...(color ? { color } : {}), step: i, at: +clock.toFixed(3), len })
      clock += len
    }
    at = Math.max(at + STEP, clock + 0.9)
  })
  // (the last step ending turned: it turns back as the finale opens, so the step still ends on its work)
  if (over != null) back(at)
  const finale = at
  return { steps0, starts, acts, turns, finale, end: finale + TIMES.finale, duration: finale + TIMES.finale + TIMES.end }
}

export function program({ script, vectors, boxes, geometry, sizes, layout, photo, finale, panel, look = 'drawn', upgrades = {}, faces = {} }) {
  const validation = validatePlan(script)
  if (validation.errors.length) throw new Error(`Invalid film instructions: ${validation.errors.join('; ')}`)
  if ((layout.diagnostics || []).length || (script.joints || []).some((j) => !layout.connections?.some((c) => c.id === j.id)))
    throw new Error('Instruction geometry has unresolved connection errors')
  for (const a of script.steps.flatMap((s) => s.do || [])) if (a.demo) {
    const error = checkDemonstration(a.demo); if (error) throw new Error(error)
  }
  // Folded sheets (fold.mjs), folded exactly from the plan's references. One the joint solver laid out as a board (the
  // plan view) lies the way round its folds are named, w across the frame and d up it, its middle where the board's was:
  // a dart folded from a portrait sheet is not shown on its side.
  const folds = runFolds(script)
  if (folds.errors.length) throw new Error(`Invalid folds: ${folds.errors.join('; ')}`)
  for (const [k, s] of Object.entries(folds.sheets)) {
    const b = (layout.boards || {})[k], p = layout.poses[k]
    if (!b || !p) continue
    // (and on the cutting mat, whose far edge is at y 190: a portrait sheet where a landscape board lay can reach past it)
    const w = s.w * 4, h = s.d * 4, anchor = [(p.anchor[0] / b.w) * w, (p.anchor[1] / b.h) * h], y = Math.max(p.y, 240 + anchor[1] * p.scale)
    layout = { ...layout, boards: { ...layout.boards, [k]: { ...b, w, h, faces: [{ kind: 'upper', pts: [[0, h], [w, h], [w, 0], [0, 0]] }], line: [[0, h / 2], [w, h / 2]] } },
      poses: { ...layout.poses, [k]: { ...p, anchor, y } } }
  }
  // Strands (strand.mjs), worked out exactly from the plan's operations. Each lies in a board of its own (the joint solver laid
  // it out as a thin rod): the box all its shapes fit in, at 4 drawing units a cm, its middle where the rod's was, as large
  // on the stage as the frame holds. The strand's own coordinates (cm, y down the frame) become that board's.
  const strandRun = runStrands(script)
  if (strandRun.errors.length) throw new Error(`Invalid strands: ${strandRun.errors.join('; ')}`)
  const strandFrames = {}
  for (const [k, S] of Object.entries(strandRun.strands)) {
    const b = (layout.boards || {})[k], p = layout.poses[k]
    const box = [0, 0, S.L, 0, ...Object.values(S.ops).flatMap((o) => o.bounds.flat())]
    const xs = box.filter((_, i) => i % 2 === 0), ys = box.filter((_, i) => i % 2 === 1)
    const m = S.W * 1.5 + Math.max(0, ...S.states.flatMap((st) => st.beads.map((x) => x.r))), x0 = Math.min(...xs) - m, y0 = Math.min(...ys) - m
    const w = (Math.max(...xs) + m - x0) * 4, h = (Math.max(...ys) + m - y0) * 4
    strandFrames[k] = { x0, y0, w, h }
    if (!b || !p) continue
    const scale = Math.min(p.scale, 1000 / w, 470 / h), anchor = [w / 2, h / 2]
    layout = { ...layout, boards: { ...layout.boards, [k]: { ...b, w, h, faces: [{ kind: 'upper', pts: [[0, h], [w, h], [w, 0], [0, 0]] }], line: [[0, h / 2], [w, h / 2]] } },
      poses: { ...layout.poses, [k]: { ...p, anchor, scale, y: Math.min(Math.max(p.y, 250 + anchor[1] * scale), 800 - anchor[1] * scale) } } }
  }
  const cast = [...layout.order, ...layout.extras]
  // An object without a drawing is drawn as its cut-out: a drawing with no shapes, the photo under it at full strength.
  // Every part a cut makes is drawn as a slice of its object, used later or not.
  const sliced = Object.values(geometry).length ? Object.keys(geometry).filter((k) => geometry[k].sliceOf && cast.includes(geometry[k].sliceOf)) : []
  // (and the model's drawing of each thing it will be upgraded to, drawings.mjs: key@drawn)
  const later = Object.keys(upgrades).filter((k) => cast.includes(k) && vectors[`${k}@drawn`])
  const drawn = Object.fromEntries([...new Set([...cast, ...sliced, ...later.map((k) => `${k}@drawn`)])].map((key) => [key, vectors[key]
    ?? { width: sizes[key].width * 4, height: sizes[key].height * 4, parts: [{ id: key, up: null, pivot: [0, 0], shapes: [] }], cutOut: true }]))
  const times = timeline(script), known = (k) => !!layout.poses[k]
  const slots = heapSlots(times.acts, layout.poses, sizes)
  layout = { ...layout, poses: { ...layout.poses, ...Object.fromEntries(Object.entries(slots).map(([k, s]) => [k, { ...layout.poses[k], x: s.x, scale: s.scale }])) } }
  // A package emptied into a pot waits in the tray and is used up, as a can is; it never stands on the stage.
  const unpacked = new Set(times.acts.filter((a) => a.unpacked).map((a) => a.k))
  if (unpacked.size) layout = { ...layout, order: layout.order.filter((k) => !unpacked.has(k)), extras: [...new Set([...(layout.extras || []), ...unpacked])] }
  const acts = times.acts.map((a, demoIndex) => ({ ...a, demoIndex, ...(a.demo ? { demo: { actors: a.demo.actors } } : {}) }))
    .filter((a) => known(a.k) && (!a.to || known(a.to)))
  // When each placed thing lands: its "place" verb, or — standing there without one — the first verb that needs it.
  const placedAt = {}
  for (const a of acts) if (a.v === 'place' && placedAt[a.k] == null) placedAt[a.k] = a.at
  for (const a of acts) for (const k of [a.k, a.to]) if (k && layout.order.includes(k) && placedAt[k] == null) placedAt[k] = a.at - 0.6
  for (const k of layout.order) if (placedAt[k] == null) placedAt[k] = times.steps0 + 0.4
  // Each folded sheet in its drawing's units: a board's 4 a cm; else as large as its drawing holds, in its middle. Its
  // front in the photo's colour, its back a shade off it (white paper's back a pale grey), so the side that faces up
  // always shows. Each fold with the times of its act; each step of folds with the sheet before and after it (the panel).
  const sheets = Object.fromEntries(Object.entries(folds.sheets).filter(([k]) => (cast.includes(k) || sliced.includes(k)) && (layout.poses[k] || geometry[k]?.sheet)).map(([k, s]) => {
    const board = (layout.boards || {})[k], dw = board ? board.w : drawn[k].width, dh = board ? board.h : drawn[k].height
    const U = board ? 4 : Math.min(dw / s.w, dh / s.d), ox = (dw - s.w * U) / 2, oy = (dh - s.d * U) / 2
    const P = (q) => [Math.round((ox + q[0] * U) * 10) / 10, Math.round((oy + q[1] * U) * 10) / 10]
    const F = (facets) => facets.map((f) => ({ p: f.p.map(P), b: f.b, s: f.s.map((L) => typeof L === 'number' ? L : L.map(P)), l: f.l.map((L) => L.map(P)) }))
    // (white paper photographed indoors comes out grey: a pale colourless one is taken back most of the way to white)
    const seen = /^#[0-9a-f]{6}$/i.test(geometry[k]?.color || '') ? [1, 3, 5].map((i) => parseInt(geometry[k].color.slice(i, i + 2), 16)) : [244, 242, 236]
    const grey = Math.max(...seen) - Math.min(...seen) < 24 && 0.299 * seen[0] + 0.587 * seen[1] + 0.114 * seen[2] > 140
    const rgb = grey ? seen.map((v) => Math.round(v + (250 - v) * 0.75)) : seen, light = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] > 170
    const front = '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('')
    const back = '#' + rgb.map((v) => Math.round(light ? v * 0.86 : v + (255 - v) * 0.45).toString(16).padStart(2, '0')).join('')
    const mine = acts.filter((a) => a.v === 'fold' && a.k === k && s.folds[a.id])
    const list = mine.map((a) => {
      const f = s.folds[a.id]
      return { at: a.at, len: a.len, step: a.step, kind: f.kind, mountain: f.mountain, still: F(f.still), moving: F(f.moving), after: F(f.after),
        axis: f.axis && { p: P(f.axis.p), n: f.axis.n }, centre: f.centre && P(f.centre), deg: f.deg,
        line: f.line && f.line.map(P), from: f.from && P(f.from), to: f.to && P(f.to), label: a.label || null,
        shape: f.shape && f.shape.map(P),
        subs: f.subs && f.subs.map((x) => ({ kind: x.kind, mountain: x.mountain, still: F(x.still), moving: F(x.moving),
          axis: x.axis && { p: P(x.axis.p), n: x.axis.n }, centre: x.centre && P(x.centre), deg: x.deg })) }
    })
    // (a step's panel: the sheet before its first fold and after its last, by fold number, -1 the flat sheet)
    const steps = {}
    // (the before card marks the step's fold lines up to its first turn: after a turn they lie elsewhere on it)
    list.forEach((f, i) => {
      const g = steps[f.step] || (steps[f.step] = { before: i - 1, lines: [], cuts: [], turned: false })
      g.after = i
      if (f.kind === 'over' || f.kind === 'rotate' || f.kind === 'spread') g.turned = true
      else if (f.kind === 'cut' && !g.turned) g.cuts.push(f.shape)
      else if (f.line && !g.turned) g.lines.push({ line: f.line, mountain: f.mountain })
    })
    return [k, { front, back, unit: U, offset: [ox, oy], initial: F(s.initial), folds: list, steps }]
  }))
  // The sheets as the film's program carries them, nothing twice (a program is bounded): a cut's sheet after it is what
  // it leaves (its still), an opening starts from the sheet as the fold before left it, and its turns back need only
  // what stays and what moves. The runtime fills them in again (sheetOf).
  const sheetsData = Object.fromEntries(Object.entries(sheets).map(([k, S]) => [k, { ...S,
    folds: S.folds.map((f) => ({ ...f, after: f.kind === 'cut' ? null : f.after, moving: f.kind === 'spread' ? null : f.moving,
      subs: f.subs && f.subs.map(({ after, ...x }) => x) })) }]))
  // Each strand's states as the film carries them, in drawing units (4 a cm, the board's corner the origin): its heading
  // profile (s along it, heading), the passes drawn over, its beads, the join of a ring, the twist of a cord; the node each
  // operation holds still; each operation with the times of its act.
  const strands = Object.fromEntries(Object.entries(strandRun.strands).filter(([k]) => cast.includes(k) && layout.poses[k]).map(([k, S]) => {
    const f = strandFrames[k], P = (x, y) => [Math.round((x - f.x0) * 40) / 10, Math.round((y - f.y0) * 40) / 10], q = (v) => Math.round(v * 40) / 10
    const states = S.states.map((st) => ({ k: st.k.map(([s0, h]) => [q(s0), h]), over: st.over.map((o) => [q(o[0]), q(o[1])]), beads: st.beads.map((b) => [q(b.s), q(b.r), b.c]),
      join: st.join == null ? null : q(st.join), twist: st.look?.twist ? { n: st.look.twist.n, w: q(st.look.twist.w), c: q(st.look.twist.c) } : null }))
    const anchors = S.anchors.map((a) => [q(a.s), ...P(a.x, a.y)])
    const mine = acts.filter((a) => a.v === 'strand' && a.k === k && S.ops[a.id])
    const ops = mine.map((a) => {
      const o = S.ops[a.id], from = states[o.state - 1]
      // (a cord: the doubled strand it is twisted from, where it starts and which way it runs, drawing units)
      const cord = o.cord ? { ...S.states[o.state].meta.from } : null
      return { at: a.at, len: a.len, step: a.step, state: o.state, from: o.state - 1, kind: o.op, cord: !!o.cord, label: a.label || null,
        mark: q(o.mark?.[0] ?? 0), angle: o.angle, turns: o.turns, diameter: o.diameter, size: o.size, knot: o.knot, circumference: o.circumference, fresh: o.fresh, length: o.length, bead: o.bead, dist: o.dist, wound: o.wound, overlap: o.overlap,
        twist: cord ? { tip: P(...cord.tip), dir: cord.dir, ell: q(cord.ell), c: q(o.length), n: o.turns } : null, bounds: o.bounds.map((b) => [P(b[0], b[1]), P(b[2], b[3])]),
        closeup: o.closeup ? [P(o.closeup[0], o.closeup[1]), P(o.closeup[2], o.closeup[3])] : null, hold: anchors[o.state], hold0: [q(o.hold0.s), ...P(o.hold0.x, o.hold0.y)], hasFrom: !!from }
    })
    const steps = {}
    ops.forEach((o, i) => { const g = steps[o.step] || (steps[o.step] = { before: o.from, after: o.state }); g.after = o.state })
    return [k, { W: q(S.W), L: q(S.L), cm: Math.round(S.L * 10) / 10, placed: placedAt[k] ?? null, N: Math.min(900, Math.max(40, Math.ceil(S.L * 4 / 2))), fill: /^#[0-9a-f]{6}$/i.test(geometry[k]?.color || '') ? geometry[k].color : '#c8a15a', states, anchors, ops, steps }]
  }))
  // (where a sheet's facets lie on the stage, at its pose)
  const onStage = (k, q) => {
    const p = layout.poses[k], c = Math.cos(p.angle || 0), sn = Math.sin(p.angle || 0), dx = (q[0] - p.anchor[0]) * p.scale, dy = (q[1] - p.anchor[1]) * p.scale
    return [p.x + c * dx - sn * dy, p.y + sn * dx + c * dy]
  }
  // The camera: wide at each step's start, then pushed in on whatever each pour, sprinkle, cut, stir or heat happens
  // to — framed so it fills about half the frame's height, just below the step's caption — and wide again before
  // the next step. Placing stays wide: it is the assembly growing that matters there.
  const WIDE = { x: 800, y: 450, zoom: 1 }
  // The piece each yarn (or thread) is worked into: a snip of the yarn happens at that piece's edge.
  const madeFrom = {}
  for (const a of acts) if (a.v === 'work' && a.to && madeFrom[a.to] == null) madeFrom[a.to] = a.k
  // A cut part that is spare stock: called an offcut (or scrap, or waste), or used by nothing after its cut (no later
  // act, nor the finale). It falls off the bench, labelled "offcut", instead of crowding it with a length.
  const spare = (p, cut) => /offcut|scrap|waste/i.test(`${p.k} ${p.label || ''}`)
    || ![...acts.slice(acts.indexOf(cut) + 1), ...(script.finale || [])].some((b) => [b.k, b.to, b.with, b.part, b.and].flat().includes(p.k))
  // A pour served with a ladle (script.mjs) from something standing on the stage, which stays where it stands.
  const served = (a) => !!(a.with && layout.poses[a.with] && layout.poses[a.k])
  // (turned: where it is while the work is turned over)
  const box = (k, turned) => {
    const F = turned && layout.flip && layout.flip.poses[k]
    const p = F ? layout.flip.poses[k] : layout.poses[k], b = F ? layout.flip.boards[k] : (layout.boards || {})[k], w = (b ? b.w : sizes[k].width * 4) * p.scale, h = (b ? b.h : sizes[k].height * 4) * p.scale
    if (!b && geometry[k]?.vessel) {
      const [x, y, vw, vh] = geometry[k].vessel.bounds
      return { x0: p.x + (x - p.anchor[0]) * p.scale, y0: p.y + (y - p.anchor[1]) * p.scale, x1: p.x + (x + vw - p.anchor[0]) * p.scale, y1: p.y + (y + vh - p.anchor[1]) * p.scale }
    }
    return { x0: p.x - p.anchor[0] * p.scale, y0: p.y - p.anchor[1] * p.scale, x1: p.x - p.anchor[0] * p.scale + w, y1: p.y - p.anchor[1] * p.scale + h }
  }
  // (plain: framed as before a face that looks down got its room below — what decides when the camera moves)
  const focus = (a, plain) => {
    // A step of folds: one framing for all of them — the sheet before and after each, and room for the arrows — so the
    // camera holds through the step instead of moving between its folds.
    if (a.v === 'fold' && sheets[a.k]) {
      const pts = sheets[a.k].folds.filter((f) => f.step === a.step).flatMap((f) => [...f.still, ...f.moving, ...f.after, ...(f.subs || []).flatMap((x) => [...x.still, ...x.moving])].flatMap((x) => x.p)).map((q) => onStage(a.k, q))
      if (pts.length) {
        const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1])
        return { x0: Math.min(...xs) - 60, y0: Math.min(...ys) - 80, x1: Math.max(...xs) + 60, y1: Math.max(...ys) + 40 }
      }
    }
    // A step of strand operations: the strand through all of them (its boxes as it moves), so the camera holds.
    if (a.v === 'strand' && strands[a.k]) {
      // (a step that only ties a knot is framed on the knot, close enough to see each pass go over and under)
      const mine = strands[a.k].ops.filter((o) => o.step === a.step)
      const pts = (mine.every((o) => o.closeup) ? mine.flatMap((o) => o.closeup) : mine.flatMap((o) => o.bounds.flat())).map((q) => onStage(a.k, q))
      if (pts.length) {
        const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1])
        return { x0: Math.min(...xs) - 60, y0: Math.min(...ys) - 80, x1: Math.max(...xs) + 60, y1: Math.max(...ys) + 40 }
      }
    }
    const precise = workingRegion(a, layout, sizes)
    if (precise) return precise
    const k = a.v === 'cut' && a.into === 'snip' && madeFrom[a.k] ? madeFrom[a.k] : ['cut', 'work', 'use', 'measure'].includes(a.v) ? a.k : a.to || a.k
    if (!layout.order.includes(k) || !layout.poses[k]) return null
    let { x0, y0, x1, y1 } = box(k, a.turn)
    // A serving with a ladle: what it is served from and into, both where they stand, and the ladle's arc over them.
    if (['pour', 'sprinkle'].includes(a.v) && served(a)) {
      if (!layout.order.includes(a.k)) {
        const sourceWidth = sizes[a.k].width * 4 * layout.poses[a.k].scale
        return { x0: x0 - sourceWidth * 1.2 - 70, y0: y0 - 160, x1: x1 + 120, y1: y1 + 30 }
      }
      // (and its handle, which runs out past the bowl while it tips the ladleful in)
      const b = box(a.k), handle = sizes[a.with] ? sizes[a.with].width * 4 * layout.poses[a.with].scale * 0.85 : 0
      return { x0: Math.min(x0, b.x0), y0: Math.min(y0, b.y0) - Math.max(140, (b.y1 - b.y0) * 0.6), x1: Math.max(x1 + handle, b.x1), y1: Math.max(y1, b.y1) }
    }
    const h = y1 - y0, w = x1 - x0
    // Frame the active work, not every ball of source material. Strands can enter from outside the close-up.
    if (a.v === 'pour' || a.v === 'sprinkle') { y0 -= h * 1.1 + 80; x1 += w * 0.6 }
    if (a.v === 'cut') y0 -= 70
    if (a.v === 'work') { y0 -= h * 0.5 + 40; x1 += w * 0.4 }
    if (a.v === 'use' || a.v === 'measure' || (a.v === 'cut' && a.with)) {
      // Room for the tool too: its length beside the part, and the glyph over it.
      const tool = a.with && layout.poses[a.with] && sizes[a.with] ? sizes[a.with].width * 4 * layout.poses[a.with].scale : 0
      // (above the part — or below it, for a face that looks down the frame: a front or lower face, worked from beneath)
      const room = Math.max(160, h * 0.6, tool * 0.5)
      if (!plain && (a.face === 'front' || a.face === 'lower')) y1 += room; else y0 -= room
      x0 -= tool * 0.3; x1 += tool * 0.5
    }
    if (a.v === 'heat' || a.v === 'stir') { y0 -= 90; y1 += 30 }
    // (room round a reshaping for its arrow and the angle or size it names)
    if (a.v === 'reshape') { y0 -= 110; x0 -= 50; x1 += 50 }
    // ...and never so close that the region reaches up under the caption band (its top stays below y 190).
    return { x0, y0, x1, y1 }
  }
  // The steps with a reference panel (panel.mjs) and when each one's work runs: the panel builds up over it.
  // A step that reshapes something gets the engine's own panel, drawn from the same before and after drawings as the
  // stage (a model's panel of it, drawn from the caption alone, showed a different bend than the stage did).
  const drawnState = (k, state) => !!entities(script).find((o) => o.k === k)?.states?.find((s) => s.id === state)?.appearance
  // (and a step of folds, the sheet before and after them, from the solver's facets)
  const ownPanel = Object.fromEntries([...acts.filter((a) => a.v === 'reshape' && drawn[a.k] && (a.effects || []).some((e) => e.k === a.k && drawnState(a.k, e.state))),
    ...acts.filter((a) => a.v === 'fold' && sheets[a.k]?.steps[a.step]).reverse(),
    ...acts.filter((a) => a.v === 'strand' && strands[a.k]?.steps[a.step]).reverse()].map((a) => [a.step, a.at]))
  const foldPanels = Object.fromEntries(acts.filter((a) => a.v === 'fold' && sheets[a.k]?.steps[a.step]).map((a) => [a.step, { k: a.k, ...sheets[a.k].steps[a.step] }]))
  const strandPanels = Object.fromEntries(acts.filter((a) => a.v === 'strand' && strands[a.k]?.steps[a.step]).map((a) => [a.step, { k: a.k, ...strands[a.k].steps[a.step] }]))
  const panelled = new Set([...(panel ? panel.steps.filter((i) => Number.isInteger(i) && i >= 0 && i < times.starts.length) : []), ...Object.keys(ownPanel).map(Number)])
  const view = (r, narrow) => {
    const { x0, y0, x1, y1 } = r
    // (pulled back below the wide view's 1 if that is what it takes for everything the action involves to be in it)
    // (up to 3.2: a thin batten or a small piece still fills the close-up)
    const zoom = Math.min(3.2, 620 / Math.max(1, y1 - y0), (narrow ? 0.42 : 0.62) * 1600 / (x1 - x0), Math.max(1, Math.min((narrow ? 0.42 : 0.62) * 1600 / (x1 - x0), 0.5 * 900 / (y1 - y0))))
    // The region's middle lands at (880, 500) on the frame: right of the tray, under the caption; with a panel on the
    // right, at (640, 500).
    return { x: (x0 + x1) / 2 - (narrow ? -160 : 80) / zoom, y: (y0 + y1) / 2 - 50 / zoom, zoom }
  }
  // A close-up slid sideways, if that is all it takes, so that nothing standing beside the work is cut in two at the
  // frame's left, where the tray stands: each thing then is wholly in the shot (right of the tray) or wholly out of it
  // (past the frame's edge; a ball is wider than the tray, which hides only what fits behind it). The smaller slide that
  // does it wins, as long as the work's own region r stays in view (right of the tray, and of a panel's card); else
  // the framing is left as it was. (Only where it points changes, never when the camera moves: no frame moves that
  // did not.)
  // keep: what the action holds or works (never slid out); whole: what it works where it stands, slid wholly in when it
  // fits — not a poured thing, which is lifted over its target, away from where it stands.
  const worked = (a) => ((a.v === 'pour' || a.v === 'sprinkle') && !served(a) ? [] : [a.k])
  const clearOfTray = (f, r, keep, narrow, whole) => {
    const at = (x, g) => (x - g.x) * g.zoom + 800, fits = (g) => at(r.x0, g) >= 190 && at(r.x1, g) <= (narrow ? 1110 : 1580)
    const beside = layout.order.filter((k) => layout.poses[k] && !keep.includes(k)).map((k) => box(k))
    // (what the work is done to may be cropped by a close-up, but not hidden in part by the tray: it is slid wholly
    // right of it, when it fits)
    const own = whole.filter((k) => layout.order.includes(k) && layout.poses[k]).map((k) => box(k))
    const room = (narrow ? 1110 : 1580) - 172
    const sliced = (g) => [...beside.filter((b) => at(b.x1, g) > 0 && at(b.x0, g) < 170),
      ...own.filter((b) => (b.x1 - b.x0) * g.zoom <= room && at(b.x1, g) > 0 && at(b.x0, g) < 170)]
    if (!sliced(f).length) return f
    // (each thing wholly out, or wholly in: the nearest of those framings that cuts nothing and keeps the work in view,
    // at the close-up's own zoom if one does, else pulled back a little — never below 0.7 of it — around the same middle)
    for (const k of [1, 0.9, 0.8, 0.7]) {
      const z = f.zoom * k, base = { ...f, zoom: z, x: f.x + (narrow ? -160 : 80) * (1 / f.zoom - 1 / z), y: f.y + 50 * (1 / f.zoom - 1 / z) }
      const tries = [base, ...beside.flatMap((b) => [{ ...base, x: b.x1 + 800 / z + 1 }, { ...base, x: b.x0 - (172 - 800) / z }]),
        ...own.map((b) => ({ ...base, x: b.x0 - (172 - 800) / z }))]
      const best = tries.filter((g) => fits(g) && !sliced(g).length).sort((a, b) => Math.abs(a.x - base.x) - Math.abs(b.x - base.x))[0]
      if (best) return best
    }
    return f
  }
  // Wide: everything that will stand on the stage, framed in what the frame leaves free (right of the tray, under the
  // caption, left of a panel: frame x 200 to 1560, or to 1110 beside a panel; y 200 to 870), its middle there. One
  // framing for the film (one more beside a panel), not one a step: a change of framing between steps is a camera
  // move; stable framing keeps the instructions easier to follow.
  const fitted = (narrow) => {
    const on = layout.order.filter((k) => layout.poses[k])
    if (!on.length) return WIDE
    const all = on.map((k) => box(k)), x0 = Math.min(...all.map((r) => r.x0)), x1 = Math.max(...all.map((r) => r.x1)), y0 = Math.min(...all.map((r) => r.y0)), y1 = Math.max(...all.map((r) => r.y1))
    // (above a recipe's time bar, along the frame's foot; and closer than the usual wide view, up to 1.6, when the
    // work is small: a frame of thin battens filling a fifth of an empty stage reads as nothing being made)
    const ax0 = 200, ax1 = narrow ? 1110 : 1560, ay0 = 200, ay1 = acts.some((a) => a.v === 'heat') ? 810 : 870
    const zoom = Math.min(1.6, (ax1 - ax0) / Math.max(1, x1 - x0), (ay1 - ay0) / Math.max(1, y1 - y0))
    return { x: (x0 + x1) / 2 + (800 - (ax0 + ax1) / 2) / zoom, y: (y0 + y1) / 2 + (450 - (ay0 + ay1) / 2) / zoom, zoom }
  }
  const WIDES = [fitted(false), fitted(true)], wide = (i) => WIDES[panelled.has(i) ? 1 : 0]
  // The camera flows from one action to the next. It pulls back between steps only when it must: when a step puts
  // something on the stage (the build has grown and is shown whole), or when the next step's work is somewhere else
  // or at another size. Each push starts 0.35 s ahead of its action.
  const cam = [], places = (i) => acts.some((a) => a.step === i && a.v === 'place')
  // (whether the camera stays in between steps is decided on the framings as made, before clearOfTray slides them:
  // a slide or pull-back changes where the camera points, never when it moves)
  const firstFraming = (i) => {
    const mine = acts.filter((a) => a.step === i && a.v !== 'place').map((a) => focus(a, true)).filter(Boolean)
    if (!mine.length) return null
    if (mine.length >= 3) return view({ x0: Math.min(...mine.map((r) => r.x0)), y0: Math.min(...mine.map((r) => r.y0)), x1: Math.max(...mine.map((r) => r.x1)), y1: Math.max(...mine.map((r) => r.y1)) }, panelled.has(i))
    return view(mine[0], panelled.has(i))
  }
  const near = (f, g) => f && g && Math.abs(f.x - g.x) * f.zoom < 260 && Math.abs(f.y - g.y) * f.zoom < 200 && f.zoom / g.zoom > 0.75 && f.zoom / g.zoom < 1.33
  const stays = (i) => i + 1 < times.starts.length && !places(i) && !places(i + 1) && panelled.has(i) === panelled.has(i + 1) && near(lastRaw[i], firstFraming(i + 1))
  const lastFraming = [], lastRaw = []
  // (when the action before is still running then, a cut on its last key, as before: a short move there would cost
  // moving frames the cut does not)
  const lead = (at) => { const prev = cam.length ? cam[cam.length - 1].at : -1; return at - 0.35 >= prev + 0.2 ? at - 0.35 : prev + 0.001 }
  times.starts.forEach((start, i) => {
    const end = times.starts[i + 1] ?? times.finale, mine = acts.filter((a) => a.step === i && a.v !== 'place')
    // (held where the last step left it, if it stayed pushed in)
    if (!(i > 0 && stays(i - 1))) cam.push({ at: start, ...wide(i) })
    const regions = mine.map((a) => [a, focus(a)]).filter(([, r]) => r)
    if (regions.length >= 3) {
      // A busy step (glue at four joints, two clamps…): one framing that takes in all its work, held through it, rather
      // than a push in and out for each.
      const all = regions.map(([, r]) => r), u = { x0: Math.min(...all.map((r) => r.x0)), y0: Math.min(...all.map((r) => r.y0)), x1: Math.max(...all.map((r) => r.x1)), y1: Math.max(...all.map((r) => r.y1)) }
      const keep = regions.flatMap(([a]) => [a.k, a.with, a.part].filter(Boolean))
      const plain = regions.map(([a]) => focus(a, true))
      lastRaw[i] = view({ x0: Math.min(...plain.map((r) => r.x0)), y0: Math.min(...plain.map((r) => r.y0)), x1: Math.max(...plain.map((r) => r.x1)), y1: Math.max(...plain.map((r) => r.y1)) }, panelled.has(i))
      const f = clearOfTray(view(u, panelled.has(i)), u, keep, panelled.has(i), regions.flatMap(([a]) => worked(a))), first = regions[0][0], last = regions[regions.length - 1][0]
      cam.push({ at: lead(first.at), ...f }, { at: last.at + last.len - 0.05, ...f })
    } else {
      // (actions in a row that share a framing keep sharing it once it is cleared of the tray: cleared as one, so the
      // camera holds between them as it did, rather than moving for a different slide or pull-back each)
      const runs = []
      for (const [a, r] of regions) {
        const v = view(r, panelled.has(i)), last = runs[runs.length - 1]
        if (last && JSON.stringify(last.v) === JSON.stringify(v)) last.acts.push([a, r]); else runs.push({ v, acts: [[a, r]] })
      }
      lastRaw[i] = regions.length ? view(focus(regions[regions.length - 1][0], true), panelled.has(i)) : null
      for (const { v, acts: group } of runs) {
        const all = group.map(([, r]) => r), u = { x0: Math.min(...all.map((r) => r.x0)), y0: Math.min(...all.map((r) => r.y0)), x1: Math.max(...all.map((r) => r.x1)), y1: Math.max(...all.map((r) => r.y1)) }
        const f = clearOfTray(v, u, group.flatMap(([a]) => [a.k, a.with, a.part].filter(Boolean)), panelled.has(i), group.flatMap(([a]) => worked(a)))
        for (const [a] of group) cam.push({ at: lead(a.at), ...f }, { at: a.at + a.len - 0.05, ...f })
      }
    }
    lastFraming[i] = regions.length ? { ...cam[cam.length - 1] } : null
    // (staying in, it holds until then and moves on in the same short window: a slow glide across the gap would keep
    // the view moving even while the work holds still)
    if (mine.length) cam.push({ ...(stays(i) ? lastFraming[i] : wide(i)), at: Math.max(cam[cam.length - 1].at + 0.3, end - 0.45) })
  })
  const idea = (script.ideas || [])[script.pick || 0] || {}
  // Explicit containment applies to individual solids too (e.g. box-shaped ice).
  // Tools, structural parts and vessels retain their own drawing/placement paths.
  const contained = new Set(acts.filter(a => a.v === 'place' && a.rel === 'in' && geometry[a.to]?.vessel?.interior).map(a => a.k))
  const D = {
    title: script.title, sub: script.sub, tag: script.tag, end: script.end, recipe: idea.kind === 'recipe',
    facts: operationFacts(script),
    stateEvents: acts.filter((a) => a.effects?.length).map((a) => ({ at: a.at + a.len, effects: a.effects })),
    demoSpans: acts.filter((a) => a.v === 'demonstrate'),
    // Each reshaping: the thing's drawing before and after, matched point for point (reshape.mjs). Before: the state
    // it is required in, or the one it has reached; no drawing of it, and the film cross-fades from the thing as drawn.
    reshapes: (() => {
      const now = Object.fromEntries(entities(script).filter((o) => o.state).map((o) => [o.k, o.state])), out = []
      const art = (k, state) => entities(script).find((o) => o.k === k)?.states?.find((s) => s.id === state)?.appearance || null
      const size = (k) => (layout.boards || {})[k] ? { width: layout.boards[k].w, height: layout.boards[k].h } : { width: drawn[k].width, height: drawn[k].height }
      for (const a of [...acts].sort((x, y) => x.at - y.at)) {
        const end = (a.effects || []).find((e) => e.k === a.k)
        if (a.v === 'reshape' && end && drawn[a.k] && art(a.k, end.state)) {
          const before = (a.requires || []).find((r) => r.k === a.k)?.state ?? now[a.k]
          out.push({ k: a.k, at: a.at, len: a.len, label: a.label || null, ...morph(before ? art(a.k, before) : null, art(a.k, end.state), size(a.k)) })
        }
        for (const e of a.effects || []) now[e.k] = e.state
      }
      return out
    })(),
    // Each folded sheet: its facets as it lies before its first fold, and each fold (fold.mjs, in drawing units).
    sheets: sheetsData, strands,
    vessels: Object.fromEntries(cast.filter((k) => geometry[k]?.vessel).map((k) => [k, geometry[k].vessel])),
    contentSpec: Object.fromEntries((script.objects || []).filter((o) => o.contents).map((o) => [o.k, o.contents])),
    toolAxis: Object.fromEntries((script.objects || []).filter((o) => o.toolKind && geometry[o.k]?.tip && sizes[o.k]).map((o) => {
      const tip = geometry[o.k].tip, far = (geometry[o.k].ends || []).map((p) => p.map((v) => v * 4)).sort((a, b) => Math.hypot(b[0] - tip[0], b[1] - tip[1]) - Math.hypot(a[0] - tip[0], a[1] - tip[1]))[0] || [sizes[o.k].width * 2, sizes[o.k].height * 2]
      return [o.k, Math.atan2(far[1] - tip[1], far[0] - tip[0])]
    })),
    flatParts: Object.fromEntries([...sheetParts(script)].filter(([k]) => sheets[k]).map(([k, p]) => [k, p])),
    sheetCuts: acts.filter((a) => a.v === 'cut' && Array.isArray(a.into) && a.into.some((p) => p.size)),
    initialStates: Object.fromEntries(entities(script).filter((o) => o.state).map((o) => [o.k, o.state])),
    appearances: Object.fromEntries(entities(script).filter((o) => o.states).map((o) => [o.k,
      Object.fromEntries(o.states.filter((s) => s.appearance).map((s) => [s.id, s.appearance]))])),
    steps: script.steps.map((s) => ({ t: s.t, c: s.c })), starts: times.starts, acts, placedAt,
    // The end card's lists: all inputs the film used (including photographed stock), and the cut
    // list (each length a cut makes, with how many; spare stock left out).
    need: usedRequirements(script, cast),
    cutList: Object.entries(acts.filter((a) => a.v === 'cut' && Array.isArray(a.into)).flatMap((a) => a.into.filter((p) => !spare(p, a)).map((p) => String(p.label || (p.cm ? p.cm + ' cm' : p.k))))
      .reduce((all, l) => ({ ...all, [l]: (all[l] || 0) + 1 }), {})).map(([l, n]) => (n > 1 ? n + " × " : "") + l),
    // A recipe cooked on heat gets its own reference: a time bar, a segment a step, coloured by the heat it is on then
    // (the last level set, from the first heat on), with how long where the step says, and what goes in.
    timebar: acts.some((a) => a.v === 'heat') ? (() => {
      // (what goes in: what is poured or sprinkled into what is on the heat; a ladle taking from it serves)
      let level = null
      const hot = new Set(acts.filter((a) => a.v === 'heat').flatMap((a) => [a.k, a.to]).filter(Boolean))
      return script.steps.map((st, i) => {
        const mine = acts.filter((a) => a.step === i), heat = mine.filter((a) => a.v === 'heat').pop()
        if (heat) level = heat.level || level || 'medium'
        const adds = [...new Set(mine.filter((a) => (a.v === 'pour' || a.v === 'sprinkle') && hot.has(a.to)).map((a) => a.k.replace(/-/g, ' ')))]
        const serves = mine.some((a) => a.v === 'pour' && a.with && hot.has(a.k))
        return { level, time: heat && heat.label || '', adds: [adds.length ? '+ ' + adds.join(', ') : '', serves ? 'serve' : ''].filter(Boolean).join('  ') }
      })
    })() : null,
    raise: layout.raise && placedAt[layout.raise.at] != null ? { keys: layout.raise.keys, dy: layout.raise.dy, at: placedAt[layout.raise.at] } : null,
    // (a beat that would move one brick out of a brick build is left out: the build stays together)
    beats: (script.finale || []).filter((b) => known(b.k) && !(layout.boards || {})[b.k]?.brick),
    order: layout.order, extras: layout.extras, cast, poses: layout.poses, floorY: layout.floorY,
    supplied: Object.fromEntries(cast.filter(k => geometry[k]?.supplied && !geometry[k]?.sliceOf).map(k => [k, true])),
    illustrations: Object.fromEntries(cast.filter(k => geometry[k]?.completeIllustration).map(k => [k, geometry[k].photoBox])),
    // Each object's cut-out middle in the photo, in photo pixels, and the photo's size.
    // ...or, for one straightened to lie level (segment.mjs), its middle, its slant there and that middle in its cut-out.
    middles: Object.fromEntries(cast.map((k) => [k, geometry[k].turn ? geometry[k].center : [geometry[k].origin[0] + sizes[k].width / 2, geometry[k].origin[1] + sizes[k].height / 2]])),
    turns: Object.fromEntries(cast.filter((k) => geometry[k].turn).map((k) => [k, geometry[k].turn])),
    pivots: Object.fromEntries(cast.filter((k) => geometry[k].turn).map((k) => [k, [(geometry[k].center[0] - geometry[k].origin[0]) * 4, (geometry[k].center[1] - geometry[k].origin[1]) * 4]])),
    // Where on a thing its spot for a tool is: its upper face; in the plan view, a board's centre line.
    seats: Object.fromEntries(cast.map((k) => { const b = (layout.boards || {})[k]; return [k, b ? [(b.line[0][0] + b.line[1][0]) / 2, (b.line[0][1] + b.line[1][1]) / 2] : geometry[k].seat.map((v) => v * 4)] })),
    // An outlet differs from the receiving opening; preserve both for vessels used in either role.
    outlets: Object.fromEntries(cast.filter(k => Array.isArray(drawn[k].outlet) && drawn[k].outlet.length === 2 &&
      drawn[k].outlet.every((n, i) => Number.isFinite(n) && n >= 0 && n <= [drawn[k].width, drawn[k].height][i]))
      .map(k => [k, drawn[k].outlet])),
    ingredients: Object.fromEntries((script.objects || []).filter(o => (o.part?.family === 'loose' || contained.has(o.k)) &&
      !o.toolKind && !geometry[o.k]?.tool && !geometry[o.k]?.vessel && !layout.boards?.[o.k])
      .map(o => [o.k, { floating: /\bice\b/i.test(o.n || o.k) }])),
    view: layout.view || 'side',
    // In the plan, front and iso views each board (a long thing, or a part cut from one) is drawn from its faces as the
    // joint solver (joints.mjs) projected them — a clean box its real size, in its wood's colour, its grain along it,
    // the photo's perspective left behind; and its colour.
    boards: layout.boards || {},
    // When the work is turned over, and how it lies then (joints.mjs).
    turns: layout.flip ? times.turns : [], flip: layout.flip || null,
    board: Object.fromEntries(Object.keys(layout.boards || {}).filter((k) => geometry[k])
      .map((k) => [k, (geometry[k].sliceOf ? geometry[geometry[k].sliceOf].color : geometry[k].color) || '#d9b48a'])),
    // Real lengths in cm (a mark "cm" along a part becomes a fraction of it).
    lengthCm: Object.fromEntries([...(script.objects || []).filter((o) => +o.cm > 0).map((o) => [o.k, +o.cm]),
      ...Object.keys(geometry).filter((k) => geometry[k].sliceOf && parseFloat(geometry[k].label) > 0).map((k) => [k, parseFloat(geometry[k].label)])]),
    // A cut part's place in the thing it was cut from: it stays there, on the bench, until it is placed.
    home: Object.fromEntries(Object.keys(geometry).filter((k) => geometry[k].sliceOf && cast.includes(geometry[k].sliceOf)).map((k) => [k, { of: geometry[k].sliceOf, x0: geometry[k].slice[0] * 4 }])),
    // Tools (tools.mjs) have no photo: always their drawing.
    tool: Object.fromEntries(cast.map((k) => [k, !!geometry[k].tool])),
    piece: Object.fromEntries(cast.filter((k) => geometry[k].piece).map((k) => [k, geometry[k].piece])),
    // The tools' tips (drawing coordinates) and motions, from tools.mjs; the pieces each cut makes, as stretches of
    // the cut object's drawing with their labels, and when they appear in the tray.
    toolTip: Object.fromEntries(cast.filter((k) => geometry[k].motion).map((k) => [k, geometry[k].tip])),
    motion: Object.fromEntries(cast.filter((k) => geometry[k].motion).map((k) => [k, geometry[k].motion])),
    slices: Object.fromEntries(acts.filter((a) => a.v === 'cut' && Array.isArray(a.into) && !a.into.some((p) => p.size)).map((a) => [a.k,
      a.into.filter((p) => geometry[p.k]).map((p) => ({ k: p.k, x0: geometry[p.k].slice[0] * 4, x1: geometry[p.k].slice[1] * 4, label: geometry[p.k].label }))])),
    // (a board's parts as it comes apart, near the end of its cut; others once it is done)
    appearAt: Object.fromEntries(acts.filter((a) => a.v === 'cut' && Array.isArray(a.into)).flatMap((a) => a.into.map((p) => [p.k, (layout.boards || {})[a.k] ? a.at + a.len * 0.82 : a.at + a.len + 0.4]))),
    // A cut part lies where it was cut until the next cut starts (then it waits in the tray); an offcut falls away.
    // A board's parts stay until the step ends: boards are cut where each lies on the bench, so the step ends on every
    // part it made, laid out together.
    homeUntil: Object.fromEntries(acts.filter((a) => a.v === 'cut' && Array.isArray(a.into)).flatMap((a) => {
      // ...or its step ends, whichever comes first: the bench is cleared before the assembly starts.
      const next = !(layout.boards || {})[a.k] && acts.find((b) => b !== a && b.v === 'cut' && Array.isArray(b.into) && b.at > a.at)
      const stepEnd = times.starts[a.step + 1] ?? times.finale
      return a.into.map((p) => [p.k, Math.min(next ? next.at : 1e9, stepEnd - 0.2)])
    })),
    offcut: Object.fromEntries(acts.filter((a) => a.v === 'cut' && Array.isArray(a.into)).flatMap((a) => a.into
      .filter((p) => spare(p, a)).map((p) => {
        // (it falls 0.3 to 1.1 s after this; a fall that would run into the bench being cleared goes with the clearing)
        const at = (layout.boards || {})[a.k] ? a.at + a.len * 0.82 + 0.9 : a.at + a.len + 0.4, cleared = (times.starts[a.step + 1] ?? times.finale) - 0.2
        return [p.k, at + 1.1 > cleared ? cleared - 0.3 : at]
      }))),
    // A cut part's label, shown on it while it lies on the bench.
    partLabel: Object.fromEntries(acts.filter((a) => a.v === 'cut' && Array.isArray(a.into)).flatMap((a) => a.into
      .map((p) => [p.k, spare(p, a) ? 'offcut' : String(p.label || (p.cm ? p.cm + ' cm' : ''))]))),
    // A pointed tool's working end, in its drawing's coordinates: the hook a piece is worked with. It is the end of the
    // tool's mask (segment.mjs) nearer the script's rough tip, or the tip itself where the mask gave no ends.
    // Without a rough tip, a tool held for work takes its thinner end (segment.mjs lists it first).
    tips: Object.fromEntries((script.objects || []).filter((o) => cast.includes(o.k) && geometry[o.k] && !geometry[o.k].tool
        && (Array.isArray(o.tip) || (acts.some((a) => a.with === o.k) && geometry[o.k].ends)))
      .map((o) => {
        const g = geometry[o.k]
        if (!Array.isArray(o.tip)) return [o.k, g.ends[0].map((v) => v * 4)]
        // The rough tip, from the photo into the cut-out (turned with it, if it was straightened).
        const c = g.center || [0, 0], dx = o.tip[0] - c[0], dy = o.tip[1] - c[1], tn = -(g.turn || 0)
        const rough = [dx * Math.cos(tn) - dy * Math.sin(tn) + c[0] - g.origin[0], dx * Math.sin(tn) + dy * Math.cos(tn) + c[1] - g.origin[1]]
        const end = (g.ends || [rough]).reduce((a, b) => Math.hypot(a[0] - rough[0], a[1] - rough[1]) <= Math.hypot(b[0] - rough[0], b[1] - rough[1]) ? a : b)
        return [o.k, [end[0] * 4, end[1] * 4]]
      })),
    // Each round or row of a piece in the colour of the yarn its work step uses: the piece's colours, given to its yarns
    // in the order they are first worked.
    rowColors: Object.fromEntries(cast.filter((k) => geometry[k].piece).map((k) => {
      const spec = geometry[k].piece, yarns = [], rows = []
      let done = 0
      for (const a of acts.filter((a) => a.v === 'work' && a.k === k)) {
        if (!yarns.includes(a.to)) yarns.push(a.to)
        const color = spec.colors[yarns.indexOf(a.to) % Math.max(1, spec.colors.length)] || '#d9b8a0', upto = Math.ceil(Math.min(1, +a.p || 1) * spec.rows - 1e-6)
        for (let r = Math.round(done * spec.rows); r < upto; r++) rows[r] = color
        done = Math.max(done, Math.min(1, +a.p || 1))
      }
      return [k, rows]
    })),
    // A cut that makes pieces ("cubes", "slices", "bits", "wedges", "strips") or snips a strand (script.mjs): what it
    // makes, in the colour of what is inside (a later pour or sprinkle of it says; a strand, its piece's colour for
    // it), the tool, and — a strand — the piece it was worked into.
    chop: Object.fromEntries(acts.filter((a) => a.v === 'cut' && typeof a.into === 'string').map((a) => {
      const made = madeFrom[a.k] && cast.includes(madeFrom[a.k]) ? madeFrom[a.k] : null, spec = made && geometry[made].piece
      const yarns = [...new Set(acts.filter((b) => b.v === 'work' && b.k === made).map((b) => b.to))]
      const color = a.color || acts.find((b) => (b.v === 'pour' || b.v === 'sprinkle') && b.k === a.k && b.color)?.color
        || (spec && spec.colors[yarns.indexOf(a.k) % Math.max(1, spec.colors.length)])
        || foodColor((script.objects || []).find((o) => o.k === a.k)?.n ?? a.k) || '#e9d3a6'
      return [a.k, { kind: a.into, at: a.at, len: a.len, color, made, with: a.with && layout.poses[a.with] ? a.with : null, label: a.label || null, slot: slots[a.k]?.width || null }]
    })),
    // Where a tool's working end is, in its drawing: a photo tool's from its mask, a drawn one's from tools.mjs.
    toolTip: Object.fromEntries(cast.filter((k) => geometry[k].tool && geometry[k].tip).map((k) => [k, geometry[k].tip])),
    cutOut: Object.fromEntries(cast.map((k) => [k, !geometry[k].tool && (look === 'photo' || !!drawn[k].cutOut)])),
    // A packaged thing drawn as its family (families.mjs): the face its name is written on, in its drawing's units.
    named: Object.fromEntries(cast.filter((k) => drawn[k] && drawn[k].label && look !== 'photo').map((k) => [k, drawn[k].label])),
    upgrade: Object.fromEntries(later.map((k) => [k, upgrades[k]])),
    // What stands in a container with no lid (scene.mjs: pens in a cup): the container's front is drawn again over it.
    inside: layout.inside || {},
    table: layout.table || null,
    // A part's face drawings (faces.mjs: the model's, in a box the face's shape), and from when they show.
    // (a log's — its bark and end grain — are its pieces' too, once it is cut)
    faces: { ...Object.fromEntries(Object.entries(faces).filter(([k]) => (layout.boards || {})[k]?.brick)),
      ...Object.fromEntries(Object.entries(layout.boards || {}).filter(([k, b]) => b.log && faces[geometry[k]?.sliceOf || k]).map(([k]) => [k, faces[geometry[k]?.sliceOf || k]])) },
    // Things moved (scene.mjs): where each ends up, and when — when what it travels with (by) is placed again.
    moves: Object.fromEntries(Object.entries(layout.moves || {}).map(([k, m]) => {
      const placings = acts.filter((a) => a.v === 'place' && a.k === m.by)
      return placings.length > 1 ? [k, { pose: m.pose, at: placings[placings.length - 1].at }] : null
    }).filter(Boolean)),
    // A measured gap (bricks.mjs: a brick set on the table so many studs from another), shown from when the brick has
    // landed until its step ends; it grows while the brick's highlight fades (1.1-1.7 s after it is placed), frames that
    // already contain motion, keeping the finished step still.
    dims: (layout.dims || []).filter((d) => placedAt[d.k] != null).map((d) => {
      // (it goes when the next step's first thing starts moving, not on a still frame of its own)
      const a = acts.find((x) => x.v === 'place' && x.k === d.k), next = a ? acts.filter((x) => x.step === a.step + 1).map((x) => x.at) : []
      return { ...d, at: placedAt[d.k] + 1.1, until: next.length ? Math.min(...next) : times.finale }
    }),
    panel: panelled.size ? { structured: panel?.format === 'diagram/v1', labels: Object.fromEntries([...panelled].map((i) => [i, i in ownPanel ? script.steps[i].t : String((panel?.labels || {})[i] ?? '')])),
      // (the reshape each engine-drawn panel shows, by when it starts)
      own: ownPanel, folds: foldPanels, strands: strandPanels,
      // each step's work: from its first act (not a place) to the end of its last, else the whole step
      spans: Object.fromEntries([...panelled].map((i) => {
        const mine = acts.filter((a) => a.step === i && a.v !== 'place'), end = times.starts[i + 1] ?? times.finale
        return [i, mine.length ? [mine[0].at, Math.max(...mine.map((a) => a.at + a.len))] : [times.starts[i] + 0.4, end - 0.8]]
      })) } : null,
    cam, look, photo, times: { steps0: times.steps0, finale: times.finale, end: times.end }, T: TIMES,
  }
  return `(ctx, t, env) => {${helperFor(drawn, boxes)}
  const D = ${data(D)};
  const finale = ${finale || 'null'};
  const panel = ${(panel && panel.draw) || 'null'};
  const clips = [${demonstrationSources(script).map((s) => s || 'null').join(',')}];
  const siteList = ${operationSites.toString()};
  const pointAlong = ${pathPoint.toString()};
  const blendContents = ${mixtureColor.toString()};
  const containerLevel = ${liquidLevel.toString()};
  const containedIngredientPose = ${ingredientPose.toString()};
  const stirMove = ${stirOffset.toString()};
  const drawingContext = ${drawingContext.toString()};
  const demoPosition = ${demoPoint.toString()};
  const demoDrawingPose = ${demoPose.toString()};
  const demoFrame = ${demonstrationFrame.toString()};
  const activeDemo = D.demoSpans.find((a) => t >= a.at && t < a.at + a.len);
  const stateNow = { ...D.initialStates };
  for (const a of D.stateEvents) if (t >= a.at) for (const e of a.effects) stateNow[e.k] = e.state;
  const W = env.width, H = env.height, PAPER = env.palette.background, kit = env.kit, ease = env.ease;
  const paleOn = ${paleOn.toString()}, paleTest = paleOn(PAPER), paleSeen = new Map();
  const paleHere = (c) => { if (!paleSeen.has(c)) paleSeen.set(c, paleTest(c)); return paleSeen.get(c); };
  const span = (u, a, b) => Math.min(1, Math.max(0, (u - a) / (b - a)));
  const lerp = (a, b, u) => a + (b - a) * u;
  // Turned over for work on its underside: the work squashes to an edge and opens out upside down (the first and last
  // ${TURN} s of the turn), and meanwhile every board lies as turned — its pose, faces and draw order — and the faces
  // acts name are swapped, so what was its lower face is the one worked on, facing up. D is this frame's own copy.
  const turnNow = D.turns.find((w) => t >= w.from && t < w.to);
  let squash = 1, turned = false;
  if (turnNow) {
    const c = t < turnNow.from + ${TURN} ? Math.cos(Math.PI * span(t, turnNow.from, turnNow.from + ${TURN}))
      : t > turnNow.to - ${TURN} ? -Math.cos(Math.PI * span(t, turnNow.to - ${TURN}, turnNow.to)) : -1;
    turned = c < 0; squash = Math.max(0.04, Math.abs(c));
    if (turned) {
      for (const k of Object.keys(D.flip.boards)) { D.boards[k] = Object.assign({}, D.boards[k], D.flip.boards[k]); D.poses[k] = D.flip.poses[k]; }
      D.order = [...D.flip.order, ...D.order.filter((k) => !D.flip.boards[k])];
      for (const a of D.acts) if (D.flip.boards[a.k]) a.face = a.face === "lower" ? "upper" : !a.face || a.face === "upper" ? "lower" : a.face;
    }
  }
  const paper = () => { ctx.globalAlpha = 1; ctx.fillStyle = PAPER; ctx.fillRect(0, 0, W, H); };
  const text = (s, x, y, size, weight, color, align) => {
    ctx.font = weight + " " + size + "px " + env.font; ctx.fillStyle = color || INK; ctx.textAlign = align || "left"; ctx.textBaseline = "alphabetic";
    ctx.fillText(s, x, y);
  };
  // Shrinks a size until the text fits the width.
  const fit = (s, size, weight, width) => { ctx.font = weight + " " + size + "px " + env.font; const w = ctx.measureText(s).width; return w > width ? size * width / w : size; };
  // A boxed label (a length, a cut part's name), placed where it was asked for unless another label already holds
  // that spot this frame: then the nearest free spot above, beside or below, a leader back to the mark. Cut lists
  // with short parts and labels on parts lying side by side stacked into one unreadable pile.
  const taken = [];
  // While the magnifier draws the stage again, no labels: its circle would cut them in half, and each is already on
  // the stage beside it.
  let lensed = false;
  // Where each label went on the frame (the stage's through the camera, while it is drawn: staged), for the magnifier
  // to keep clear of.
  const labelled = [];
  let staged = null, unstaged = null;
  // A point moved, if it must be, so that a box of w × h around it lies on the frame: inside its edges, below the
  // caption band and clear of the parts tray (the stage's points through the camera and back).
  const onFrame = (x, y, w, h) => {
    const f = staged ? staged({ x, y }) : { x, y }, k = staged ? staged({ x: 1, y: 0 }).x - staged({ x: 0, y: 0 }).x : 1;
    const hw = w * k / 2 + 8, hh = h * k / 2 + 8;
    const g = { x: Math.min(W - hw, Math.max(176 + hw, f.x)), y: Math.min(H - hh, Math.max(184 + hh, f.y)) };
    if (g.x === f.x && g.y === f.y) return { x, y };
    return unstaged ? unstaged(g) : g;
  };
  const tag = (label, x, y, o) => {
    if (lensed) return;
    o = o || {};
    const size = o.size || 24, pad = o.pad || 8, h = o.h || size + 10;
    ctx.font = "700 " + size + "px " + env.mono; const w = ctx.measureText(label).width + 2 * pad;
    const free = (cx, cy) => taken.every((r) => cx + w / 2 + 4 <= r.x0 || cx - w / 2 - 4 >= r.x1 || cy + h / 2 + 4 <= r.y0 || cy - h / 2 - 4 >= r.y1);
    let px = x, py = y;
    { const q = onFrame(px, py, w, h); px = q.x; py = q.y; }
    if (!free(px, py)) {
      for (let i = 1, found = false; i <= 6 && !found; i++)
        for (const [cx, cy] of [[x, y - i * (h + 6)], [x - i * (w / 2 + 6), y], [x + i * (w / 2 + 6), y], [x, y + i * (h + 6)]])
          if (free(cx, cy)) { const q = onFrame(cx, cy, w, h); px = q.x; py = q.y; found = true; break; }
    }
    const alpha = o.alpha == null ? 1 : o.alpha; if (alpha <= 0.05) return;
    taken.push({ x0: px - w / 2, x1: px + w / 2, y0: py - h / 2, y1: py + h / 2 });
    { const a = staged ? staged({ x: px - w / 2, y: py - h / 2 }) : { x: px - w / 2, y: py - h / 2 }, b = staged ? staged({ x: px + w / 2, y: py + h / 2 }) : { x: px + w / 2, y: py + h / 2 };
      labelled.push({ x0: a.x, y0: a.y, x1: b.x, y1: b.y }); }
    ctx.globalAlpha = alpha; ctx.strokeStyle = INK; ctx.setLineDash([]);
    if (px !== x || py !== y) {
      const ey = Math.abs(py - y) < h / 2 ? py : py + (py < y ? h / 2 : -h / 2), ex = Math.abs(py - y) < h / 2 ? px + (px < x ? w / 2 : -w / 2) : px;
      ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.fillStyle = INK; ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = o.fill || PAPER; ctx.lineWidth = o.line || 2;
    ctx.fillRect(px - w / 2, py - h / 2, w, h); ctx.strokeRect(px - w / 2, py - h / 2, w, h);
    ctx.fillStyle = INK; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(label, px, py + 1); ctx.textBaseline = "alphabetic";
    ctx.globalAlpha = 1;
  };
  // The average of some #rrggbb colours: what stirred contents become.
  const mix = (colors) => "#" + [1, 3, 5].map((i) => Math.round(colors.reduce((s, c) => s + parseInt(c.slice(i, i + 2), 16), 0) / colors.length).toString(16).padStart(2, "0")).join("");
  const cutAt = {}, contents = {}, stirs = {}, heats = {}, goneAt = {};
  for (const [key, c] of Object.entries(D.contentSpec)) contents[key] = [{ at: -1, color: c.color, opacity: c.opacity ?? 1, form: c.form }];
  for (const a of D.acts) {
    if (a.v === "cut" && !Array.isArray(a.into) && !D.chop[a.k] && cutAt[a.k] == null) cutAt[a.k] = a.at + 0.55;
    if (a.v === "stir" && a.to) (stirs[a.to] = stirs[a.to] || []).push(a);
    if (a.v === "heat" && a.to) (heats[a.to] = heats[a.to] || []).push(a);
  }
  // What each pour puts in its target: its own colour, or — a container poured out — what was in it by then.
  const inside = (key, at) => {
    const now = (contents[key] || []).filter((c) => c.at <= at);
    return !now.length ? null : (stirs[key] || []).some((s) => s.at + s.len * 0.5 <= at) ? blendContents(now) : now[now.length - 1].color;
  };
  for (const a of D.acts) {
    if ((a.v !== "pour" && a.v !== "sprinkle") || !a.to) continue;
    a.color = a.color || inside(a.k, a.at) || "#c8a165";
    (contents[a.to] = contents[a.to] || []).push({ at: a.at + a.len * (a.with ? 0.76 : 0.55), settled: a.with ? a.at + a.len * 0.88 : null,
      fillAt: a.at + a.len * (a.with ? 0.68 : 0.35), fillEnd: a.at + a.len * (a.with ? 0.84 : 0.8), color: a.color, opacity: a.opacity, form: a.form });
  }
  // A placed thing poured into something goes into it, and is gone; a container poured out goes back to its place.
  for (const a of D.acts)
    if ((a.v === "pour" || a.v === "sprinkle") && D.order.includes(a.k) && !contents[a.k] && !D.vessels[a.k] && !D.outlets[a.k] && goneAt[a.k] == null) goneAt[a.k] = a.at + a.len * 0.85;
  const gone = (key) => goneAt[key] != null && t >= goneAt[key];

  // Where on a part a use or a measure happens: a fraction along it, from "at" (or x), on its upper face.
  const AT = { left: 0.15, start: 0.15, middle: 0.5, center: 0.5, right: 0.85, end: 0.85 };
  const along = (a) => typeof a.x === "number" ? Math.min(1, Math.max(0, a.x)) : AT[a.at] ?? 0.5;
  const onTop = (key, fx, pose, face, lat) => {
    pose = pose || atPose(key);
    // A worked strand's sites travel with its curve, rather than the rod it started as.
    if (D.strands[key]) {
      const S = D.strands[key], nd = strandWorkNodes(key), f = Math.min(1, Math.max(0, fx)) * (nd.x.length - 1), i = Math.min(nd.x.length - 2, Math.floor(f)), u = f - i;
      const dx = nd.x[i + 1] - nd.x[i], dy = nd.y[i + 1] - nd.y[i], len = Math.hypot(dx, dy) || 1, offset = (lat || 0) * S.W;
      return objects.point(key, [lerp(nd.x[i], nd.x[i + 1], u) - dy / len * offset, lerp(nd.y[i], nd.y[i + 1], u) + dx / len * offset], pose);
    }
    // A board: along the line down the middle of its upper face — or of the face named (front, right, the end grain at
    // its start…) — of the board it lies as (at home, the board it was cut from).
    const g = D.boards[key] && (pose.home && D.boards[key].homeBoard ? D.boards[key].homeBoard : D.boards[key]);
    const ln = g && (face && g.faceLines && g.faceLines[face] ? g.faceLines[face].line : g && g.line);
    if (g) {
      const basis = g.faceLines && g.faceLines[face || "upper"] && g.faceLines[face || "upper"].basis;
      if (basis) return objects.point(key, [basis[0][0] + (basis[1][0] - basis[0][0]) * fx + (basis[2][0] - basis[0][0]) * (0.5 + (lat || 0)),
        basis[0][1] + (basis[1][1] - basis[0][1]) * fx + (basis[2][1] - basis[0][1]) * (0.5 + (lat || 0))], pose);
      let x = lerp(ln[0][0], ln[1][0], fx), y = lerp(ln[0][1], ln[1][1], fx);
      // ...and lat of the way across the face, where the face is one drawn: along its edge most square to the line.
      const quad = lat && g.faces.find((f) => f.kind === ({ upper: "upper", front: "front", right: "side" })[face || "upper"]);
      if (quad) {
        const ux = ln[1][0] - ln[0][0], uy = ln[1][1] - ln[0][1];
        const edges = quad.pts.map((p, i) => [quad.pts[(i + 1) % 4][0] - p[0], quad.pts[(i + 1) % 4][1] - p[1]]);
        const e = edges.reduce((b, v) => Math.abs(v[0] * ux + v[1] * uy) / (Math.hypot(v[0], v[1]) || 1) < Math.abs(b[0] * ux + b[1] * uy) / (Math.hypot(b[0], b[1]) || 1) ? v : b);
        x += lat * e[0]; y += lat * e[1];
      }
      return objects.point(key, [x, y], pose);
    }
    return objects.point(key, [fx * sizeOf(key).width, D.seats[key][1]], pose);
  };
  // Which way a face of a board faces on the frame (a unit vector); up the frame for anything else, or no face named.
  const faceNormal = (key, face, pose) => {
    const g = D.boards[key] && (pose && pose.home && D.boards[key].homeBoard ? D.boards[key].homeBoard : D.boards[key]);
    const n = g && face && g.faceLines && g.faceLines[face] ? g.faceLines[face].n : [0, -1], a = (pose && pose.angle) || 0;
    return [n[0] * Math.cos(a) - n[1] * Math.sin(a), n[0] * Math.sin(a) + n[1] * Math.cos(a)];
  };
  // The points a use works at: its spot, or — several fasteners — spread along the part.
  // Several measured points ("cm": [50, 100] along a part of known length, or "x": [0.2, 0.8]) are each one spot.
  // More fasteners than spots along ("n": 6 at "x": [0.1, 0.5, 0.9]: six screws up through a base into two sides) go in
  // rows across the face, a row for each: the spots repeated, with how far across each is (lat, -0.5..0.5 of its width).
  const spotsCache = new Map();
  const spots = (a) => {
    if (spotsCache.has(a)) return spotsCache.get(a);
    const sites = siteList(a, D.lengthCm[a.k]), all = sites.map((s) => s.x);
    all.lat = sites.map((s) => s.lat); spotsCache.set(a, all); return all;
  };
  // The marks uses leave on a part, there for the rest of the film: fastener heads, drilled holes, pencil lines,
  // glue or paint along it, saw kerfs.
  const marks = {};
  for (const a of D.acts) {
    if (a.v !== "use" || !a.with || a.path) continue;
    const m = D.motion[a.with], kind = a.part ? "head" : m === "turn" ? "hole" : m === "mark" ? "line" : m === "stroke" ? "bead" : m === "saw" ? "kerf" : null;
    if (!kind) continue;
    const pts = spots(a);
    // (a pencil mark at a length the script gave keeps that length beside it until its step ends)
    const cm = kind === "line" && Array.isArray(a.cm) && a.cm.length === pts.length ? a.cm : null;
    pts.forEach((fx, i) => (marks[a.k] = marks[a.k] || []).push({ kind, fx, lat: pts.lat && pts.lat[i], face: a.face, at: a.at + a.len * (0.22 + 0.66 * (i + 1) / pts.length), color: a.color,
      from: a.at + a.len * (0.22 + 0.66 * i / pts.length),
      cm: cm && cm[i], until: D.starts[a.step + 1] ?? D.times.finale }));
  }
  const markLayer = (key, pose) => {
    for (const m of marks[key] || []) {
      // (a mark on the face that faces down is out of sight: screws driven from below, the work turned back; a bead of
      // glue is laid as the nozzle runs along, the rest once their work is done)
      if ((m.kind === "bead" ? t < m.from : t < m.at) || m.face === "lower") continue;
      const p = onTop(key, m.fx, pose, m.face, m.lat), h = sizeOf(key).height * (pose.scale || 1);
      // A head lies flat on its face: the ellipse's long axis across the face's normal.
      const nm = faceNormal(key, m.face, pose), rot = Math.atan2(nm[1], nm[0]) + Math.PI / 2;
      ctx.lineCap = "round";
      if (m.kind === "head") {
        ctx.fillStyle = "#c9cfd9"; ctx.strokeStyle = INK; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.ellipse(p.x, p.y, 11, 5, rot, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(p.x - 6 * Math.cos(rot), p.y - 6 * Math.sin(rot)); ctx.lineTo(p.x + 6 * Math.cos(rot), p.y + 6 * Math.sin(rot)); ctx.stroke();
      }
      // A drilled hole lies in the face as a head does, but reads as a bore, not a screw: a pale rim of cut fibres round
      // a dark hole, where a head is grey and slotted.
      if (m.kind === "hole") {
        ctx.fillStyle = "#f6e7c8"; ctx.beginPath(); ctx.ellipse(p.x, p.y, 10, 4.6, rot, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = INK; ctx.beginPath(); ctx.ellipse(p.x, p.y, 6.5, 2.9, rot, 0, Math.PI * 2); ctx.fill();
      }
      if (m.kind === "line") {
        ctx.strokeStyle = INK; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(p.x, p.y - 4); ctx.lineTo(p.x, p.y + Math.min(40, h * 0.5)); ctx.stroke();
        if (m.cm != null && t < m.until) tag(String(m.cm), p.x, p.y - 34, { size: 20, h: 28, pad: 6 });
      }
      if (m.kind === "kerf") { ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x, p.y + h * 0.7); ctx.stroke(); }
      if (m.kind === "bead") {
        // Along the part, whichever way it lies.
        if (D.strands[key]) {
          const g = span(t, m.from, m.at), start = Math.max(0, m.fx - 0.15), end = lerp(start, Math.min(1, m.fx + 0.15), g), steps = Math.max(1, Math.ceil((end - start) * D.strands[key].N));
          ctx.strokeStyle = m.color || "#f3e3a0"; ctx.lineWidth = 7; ctx.beginPath();
          for (let i = 0; i <= steps; i++) { const q = onTop(key, lerp(start, end, i / steps), pose, m.face, m.lat); if (i === 0) ctx.moveTo(q.x, q.y - 2); else ctx.lineTo(q.x, q.y - 2); }
          ctx.stroke(); continue;
        }
        const q0 = onTop(key, Math.max(0, m.fx - 0.15), pose), q1 = onTop(key, Math.min(1, m.fx + 0.15), pose), g = span(t, m.from, m.at);
        ctx.strokeStyle = m.color || "#f3e3a0"; ctx.lineWidth = 7; ctx.beginPath(); ctx.moveTo(q0.x, q0.y - 2); ctx.lineTo(lerp(q0.x, q1.x, g), lerp(q0.y, q1.y, g) - 2); ctx.stroke();
      }
    }
  };
  // A manual's arrow: a bold line with a head (and a tail head, both ways).
  const arrow = (x0, y0, x1, y1, both) => {
    ctx.strokeStyle = INK; ctx.fillStyle = INK; ctx.lineWidth = 6; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    for (const [x, y, fx, fy] of both ? [[x1, y1, x0, y0], [x0, y0, x1, y1]] : [[x1, y1, x0, y0]]) {
      const a = Math.atan2(y - fy, x - fx);
      ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * 8, y + Math.sin(a) * 8);
      ctx.lineTo(x - Math.cos(a - 0.5) * 24, y - Math.sin(a - 0.5) * 24); ctx.lineTo(x - Math.cos(a + 0.5) * 24, y - Math.sin(a + 0.5) * 24); ctx.closePath(); ctx.fill();
    }
  };
  const badge = (x, y, text_) => {
    if (lensed) return;
    ({ x, y } = onFrame(x, y, 68, 68));
    ctx.fillStyle = ACCENT; ctx.strokeStyle = INK; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x, y, 34, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    text(text_, x, y + 12, 34, "800", INK, "center");
    // (a label placed after it keeps clear of it)
    taken.push({ x0: x - 36, x1: x + 36, y0: y - 36, y1: y + 36 });
    return { x, y };
  };
  // A part worked on before it has a place on the stage (sanded before assembly) is brought out for its act: out of the
  // tray meanwhile, not in both.
  const broughtOut = (key) => !D.tool[key] && D.acts.some((a) => (a.v === "use" || a.v === "measure") && a.k === key && t >= a.at && t < a.at + a.len
    && !(D.placedAt[key] != null && t >= D.placedAt[key]));
  // A tool held for a use, a measure or a cut, or the fasteners it puts in, is out of the tray meanwhile.
  const holding = (key) => D.acts.some((a) => (["use", "measure", "cut", "stir", "pour", "sprinkle"].includes(a.v) && (a.with === key || a.part === key)
    || (["pour", "sprinkle"].includes(a.v) && a.with && a.k === key && !D.order.includes(key))
    || (a.v === "stir" && a.k === key && D.motion[key])) && t >= a.at && t < a.at + a.len);
  // A line across a board at fraction f of its length, over the face you see it by (its upper face; in the front view,
  // its front): from one long edge to the other.
  const crossLine = (key, f, pose) => {
    const g = pose.home && D.boards[key].homeBoard ? D.boards[key].homeBoard : D.boards[key];
    const face = g.faces.find((x) => x.kind === (D.view === "front" ? "front" : "upper")) || g.faces[g.faces.length - 1], P = face.pts;
    const lv = [g.line[1][0] - g.line[0][0], g.line[1][1] - g.line[0][1]], ab = [P[1][0] - P[0][0], P[1][1] - P[0][1]], ad = [P[3][0] - P[0][0], P[3][1] - P[0][1]];
    const cosOf = (v) => Math.abs(v[0] * lv[0] + v[1] * lv[1]) / ((Math.hypot(v[0], v[1]) || 1) * (Math.hypot(lv[0], lv[1]) || 1));
    // Which pair of edges runs along it, and which end its start is at (nearer the line's start).
    const alongAB = cosOf(ab) >= cosOf(ad), e0 = alongAB ? [P[0], P[1]] : [P[0], P[3]], e1 = alongAB ? [P[3], P[2]] : [P[1], P[2]];
    const flip = Math.hypot(e0[0][0] - g.line[0][0], e0[0][1] - g.line[0][1]) > Math.hypot(e0[1][0] - g.line[0][0], e0[1][1] - g.line[0][1]);
    const at = (e) => { const ff = flip ? 1 - f : f; return [lerp(e[0][0], e[1][0], ff), lerp(e[0][1], e[1][1], ff)]; };
    return [objects.point(key, at(e0), pose), objects.point(key, at(e1), pose)];
  };
  // A cut list, as a manual draws it: a chain of dimensions along the board, over it, a tick at every joint, each
  // part's length in a box.
  const chain = (key, parts, pose, alpha) => {
    if (alpha <= 0) return;
    ctx.globalAlpha = alpha; ctx.strokeStyle = INK; ctx.lineWidth = 2.5; ctx.setLineDash([]);
    const lift = (q) => ({ x: q.x, y: q.y - 70 });
    for (const p of parts) {
      const A = lift(onTop(key, p.f0, pose)), B = lift(onTop(key, p.f1, pose));
      ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
      for (const q of [A, B]) { ctx.beginPath(); ctx.moveTo(q.x, q.y - 14); ctx.lineTo(q.x, q.y + 14); ctx.stroke(); }
      const label = D.partLabel[p.k] || ""; if (!label) continue;
      tag(label, (A.x + B.x) / 2, (A.y + B.y) / 2, { size: 24, h: 34, alpha });
      ctx.globalAlpha = alpha; ctx.strokeStyle = INK; ctx.lineWidth = 2.5;
    }
    ctx.globalAlpha = 1;
  };
  // An F-clamp, drawn where it works: across the part at P along its face's normal, its fixed jaw on the far side of
  // what it holds and its sliding jaw on the near face, a steel bar between them, the screw and its red handle out
  // from the sliding jaw; the jaws close as it is tightened (k, 0..1), arrows pressing in at both.
  const fClamp = (key, pose, P, n, k, poses) => {
    const tg = [-n[1], n[0]];
    // How deep what it holds is along n, either side of P: every board on the stage that lies across its line (the
    // whole box, when it clamps across one), from their drawn faces; else the part's own box.
    // Where the clamp's line (through P along n) crosses each board's outline: every crossing widens what it holds.
    let d0 = Infinity, d1 = -Infinity;
    for (const [other, op] of Object.entries(poses || {})) {
      if (!D.boards[other] || !op) continue;
      const g = op.home && D.boards[other].homeBoard ? D.boards[other].homeBoard : D.boards[other];
      for (const f of g.faces) {
        const W = f.pts.map((q) => objects.point(other, q, op));
        W.forEach((A, i) => {
          const B = W[(i + 1) % W.length], sa = (A.x - P.x) * tg[0] + (A.y - P.y) * tg[1], sb = (B.x - P.x) * tg[0] + (B.y - P.y) * tg[1];
          if ((sa > 0) === (sb > 0) && sa !== 0) return;
          const r = sa === sb ? 0 : sa / (sa - sb), X = A.x + (B.x - A.x) * r, Y = A.y + (B.y - A.y) * r, d = (X - P.x) * n[0] + (Y - P.y) * n[1];
          d0 = Math.min(d0, d); d1 = Math.max(d1, d);
        });
      }
    }
    if (d0 === Infinity) { d0 = -20; d1 = 20; }
    const pt = (d, side) => [P.x + n[0] * d + tg[0] * side, P.y + n[1] * d + tg[1] * side];
    const gape = 46 * (1 - ease.inOut(span(k, 0, 0.55))), near = d1 + 6 + gape, far = d0 - 6;
    const quad = (A, B, C, Dd, fill) => { ctx.fillStyle = fill; ctx.beginPath(); ctx.moveTo(...A); ctx.lineTo(...B); ctx.lineTo(...C); ctx.lineTo(...Dd); ctx.closePath(); ctx.fill(); ctx.stroke(); };
    ctx.strokeStyle = INK; ctx.lineWidth = 2.5; ctx.lineJoin = "round";
    // The bar, off to one side; the fixed jaw at its far end, the sliding jaw near.
    quad(pt(far - 22, 46), pt(near + 120, 46), pt(near + 120, 60), pt(far - 22, 60), "#c9cfd9");
    quad(pt(far - 22, -22), pt(far, -22), pt(far, 60), pt(far - 22, 60), "#c9cfd9");
    quad(pt(near, -22), pt(near + 20, -22), pt(near + 20, 60), pt(near, 60), "#c9cfd9");
    // The screw through the sliding jaw, and the handle on it.
    ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(...pt(near + 20, 19)); ctx.lineTo(...pt(near + 70, 19)); ctx.stroke(); ctx.lineWidth = 2.5;
    quad(pt(near + 70, 2), pt(near + 112, 2), pt(near + 112, 36), pt(near + 70, 36), "#e8524a");
    ctx.lineWidth = 6 * 0.5;
    arrow(...pt(near + 150, 19), ...pt(near + 128, 19)); arrow(...pt(far - 70, 19), ...pt(far - 36, 19));
  };
  // A tool at work on a part: in from the tray, its tip at the spot (or on the fastener it drives), making its
  // motion, with the glyph a manual draws for it; then back. Returns where it works, on the stage, while it works.
  const useTool = (a, poses, toStage) => {
    const tk = a.with, target = poses[a.k] || atPose(a.k), p = span(t, a.at, a.at + a.len), pts = spots(a), n = pts.length;
    const work = span(p, 0.22, 0.88), idx = Math.min(n - 1, Math.floor(work * n)), sub = work * n - idx;
    // Drawn true to size unless that would dwarf the work: at most about 40% of the part it works on (a drill at 60%
    // hid the box it drilled), and never taller than the room under the caption
    const ts = sizeOf(a.k), reach = Math.max(ts.width, ts.height) * (target.scale || 1);
    const P = a.path && D.sheets[a.k] ? flatPoint(a.k, pointAlong(a.path, a.pathProgress ?? work), target) : onTop(a.k, pts[idx], target, a.face, pts.lat && pts.lat[idx]), m = D.motion[tk] || "press", s = sizeOf(tk);
    // (and never so small on the frame it cannot be made out: 135 px along its longest side through the camera's zoom,
    // a little over readable for one held at a slant — a glue bottle or a spoon included)
    const perZoom = toStage({ x: 0, y: 0, scale: 1 }).scale;
    const sc = Math.min(300 / s.width, Math.max((a.path ? 180 : 135) * perZoom / Math.max(s.width, s.height), Math.min(D.poses[tk].scale, Math.max(100, reach * 0.4) / s.width))), L = s.width * sc, f = (t * 2.2) % 1;
    // Every motion is drawn as if working down onto an upper face, then turned onto the face it works on: d turns up
    // the frame onto the face's outward normal, R turns a vector by d.
    const nm = faceNormal(a.k, a.face, target), d = Math.atan2(nm[1], nm[0]) + Math.PI / 2;
    const R = (x, y) => [x * Math.cos(d) - y * Math.sin(d), x * Math.sin(d) + y * Math.cos(d)];
    let head = P;
    // (the spot worked at, for a canvas that keeps track: frames.mjs's)
    if (ctx.mark && work > 0 && work < 1) ctx.mark("@site:" + a.k, P.x - 2, P.y - 2, 4, 4);
    if (a.part && D.poses[a.part] && work > 0 && work < 1) {
      // The fastener: point first, square to the face, sinking in as it is driven; what is in the part is hidden by it.
      const fs = sizeOf(a.part), fsc = D.poses[a.part].scale, flen = fs.width * fsc, sink = ease.inOut(span(sub, 0.15, 0.85));
      head = { x: P.x + nm[0] * flen * (1 - sink), y: P.y + nm[1] * flen * (1 - sink) };
      const tg = [-nm[1], nm[0]];
      ctx.save(); ctx.beginPath();
      ctx.moveTo(P.x + tg[0] * 600, P.y + tg[1] * 600); ctx.lineTo(P.x + tg[0] * 600 + nm[0] * 2000, P.y + tg[1] * 600 + nm[1] * 2000);
      ctx.lineTo(P.x - tg[0] * 600 + nm[0] * 2000, P.y - tg[1] * 600 + nm[1] * 2000); ctx.lineTo(P.x - tg[0] * 600, P.y - tg[1] * 600); ctx.closePath(); ctx.clip();
      plain(a.part, { x: P.x - nm[0] * flen * sink, y: P.y - nm[1] * flen * sink, scale: fsc, angle: -Math.PI / 2 + d, anchor: D.toolTip[a.part] }); ctx.restore();
    }
    // A glue bottle or a brush runs along the part, its nozzle where the bead it lays has got to (markLayer).
    if (m === "stroke" && !a.path && work > 0 && work < 1) {
      const q0 = onTop(a.k, Math.max(0, pts[idx] - 0.15), target), q1 = onTop(a.k, Math.min(1, pts[idx] + 0.15), target);
      const q = D.strands[a.k] ? onTop(a.k, lerp(Math.max(0, pts[idx] - 0.15), Math.min(1, pts[idx] + 0.15), sub), target, a.face, pts.lat && pts.lat[idx]) : { x: lerp(q0.x, q1.x, sub), y: lerp(q0.y, q1.y, sub) };
      head = { x: q.x, y: q.y - 2 };
    }
    // A sander scrubs along the part's own length, whichever way it lies on the frame.
    const fx = pts[idx], q0 = onTop(a.k, Math.max(0, fx - 0.05), target, a.face, pts.lat && pts.lat[idx]), q1 = onTop(a.k, Math.min(1, fx + 0.05), target, a.face, pts.lat && pts.lat[idx]);
    const ql = Math.hypot(q1.x - q0.x, q1.y - q0.y) || 1, along = [(q1.x - q0.x) / ql, (q1.y - q0.y) / ql];
    if (m === "rub" && work > 0 && work < 1) head = { x: head.x + along[0] * Math.sin(t * 12) * L * 0.3, y: head.y + along[1] * Math.sin(t * 12) * L * 0.3 };
    const tip = D.toolTip[tk];
    let at = { x: head.x, y: head.y, scale: sc, angle: 0, anchor: tip };
    if (m === "saw") at = { ...at, angle: -0.35, x: head.x + Math.sin(t * 9) * L * 0.15 };
    if (m === "turn") at = { ...at, angle: -Math.PI / 2 };
    if (m === "stroke" || m === "mark") at = { ...at, angle: -Math.PI / 4 };
    if (m === "stir") {
      const move = stirMove(a.pattern, a.pace, t), width = D.vessels[a.k] ? D.vessels[a.k].rx * (target.scale || 1) : 100, radius = Math.min(20, width * 0.3);
      at = { ...at, angle: D.toolAxis[tk] == null ? -Math.PI / 3 : -1.35 - D.toolAxis[tk], x: head.x + move[0] * radius, y: head.y + move[1] * radius };
    }
    if (m === "snip") at = { ...at, angle: -0.2 + 0.15 * Math.sin(t * 14) };
    if (m === "squeeze") at = { ...at, scale: sc * (1 - 0.04 * Math.sin(t * 10)) };
    if (m === "tap") {
      // Swung about its grip: the head lifts, comes down, strikes the spot.
      const lift = f < 0.65 ? ease.out(f / 0.65) : f < 0.8 ? 1 - ease.in((f - 0.65) / 0.15) : 0, grip = [s.width * 0.95, s.height * 0.52];
      // Turning clockwise about the grip lifts the head (it is to the grip's left).
      at = { ...at, anchor: grip, angle: 0.9 * lift, x: head.x + (grip[0] - tip[0]) * sc, y: head.y + (grip[1] - tip[1]) * sc };
    }
    // Onto the face.
    const off = R(at.x - head.x, at.y - head.y);
    at = { ...at, x: head.x + off[0], y: head.y + off[1], angle: at.angle + d };
    const from = toStage(tray(tk)), there = ease.inOut(span(p, 0, 0.22)), back = ease.inOut(span(p, 0.88, 1));
    if (m === "squeeze" && there >= 1 && back <= 0) fClamp(a.k, target, P, nm, sub, poses);
    else {
      const dipping = m === "stir" && D.vessels[a.k] && there >= 1 && back <= 0;
      if (dipping) { const rim = seatOf(a.k, target); ctx.save(); ctx.beginPath(); ctx.rect(rim.x - 2000, rim.y - 2000, 4000, 2000 + D.vessels[a.k].ry * target.scale); ctx.clip(); }
      plain(tk, { ...at, x: lerp(lerp(from.x, at.x, there), from.x, back), y: lerp(lerp(from.y, at.y, there), from.y, back),
        scale: lerp(lerp(from.scale, at.scale, there), from.scale, back), angle: at.angle * there * (1 - back) });
      if (dipping) ctx.restore();
    }
    if (work <= 0 || work >= 1) return null;
    // The glyph, out from the face over the spot.
    const at_ = (x, y) => { const v = R(x, y); return [P.x + v[0], P.y + v[1]]; };
    if (m === "saw") { const [ax, ay] = at_(-70, -Math.max(90, L * 0.35)), [bx, by] = at_(70, -Math.max(90, L * 0.35)); arrow(ax, ay, bx, by, true); }
    if (m === "rub") { const [cx, cy] = at_(0, -Math.max(90, L * 0.35)); arrow(cx - along[0] * 70, cy - along[1] * 70, cx + along[0] * 70, cy + along[1] * 70, true); }
    if (m === "turn") {
      const c = at_(60, -Math.max(90, L * 0.35));
      ctx.strokeStyle = INK; ctx.lineWidth = 6; ctx.beginPath(); ctx.arc(c[0], c[1], 34, 0.3 + t * 3, 0.3 + t * 3 + 4.6); ctx.stroke();
      const e = 0.3 + t * 3 + 4.6, ex = c[0] + Math.cos(e) * 34, ey = c[1] + Math.sin(e) * 34;
      arrow(ex - Math.cos(e + Math.PI / 2) * 2, ey - Math.sin(e + Math.PI / 2) * 2, ex + Math.cos(e + Math.PI / 2) * 6, ey + Math.sin(e + Math.PI / 2) * 6);
    }
    if (m === "tap" && f >= 0.78 && f < 0.95) {
      ctx.strokeStyle = INK; ctx.lineWidth = 5;
      for (const k of [-0.9, -0.45, 0, 0.45, 0.9]) { const [x0, y0] = at_(Math.sin(k) * 30, -Math.cos(k) * 30), [x1, y1] = at_(Math.sin(k) * 60, -Math.cos(k) * 60); ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); }
    }
    // (a clamp's own jaws show the squeeze; its arrows are drawn with it)
    if (m === "press") arrow(...at_(0, -170), ...at_(0, -70));
    const counted = n > 1 && !a.quiet ? badge(...at_(110, -150), n + "×") : null;
    // Its quantity (the bit's size, the screw's, an amount), under the count while the tool works.
    if (a.label && !a.quiet) counted ? tag(a.label, counted.x, counted.y + 58, { size: 22, h: 30 }) : tag(a.label, ...at_(110, -150), { size: 22, h: 30 });
    return P;
  };
  // A measure: a dimension line along the part's upper edge, ticked at both ends, with its length in a box.
  // The length a measure's label gives ("80 cm", "30 + 30 cm"), as a share of its part's length: the dimension and the
  // tape end there, not at the part's far end (the whole part when either length is unknown).
  const measured = (a) => {
    const m = /((?:[\\d.]+\\s*\\+\\s*)*[\\d.]+)\\s*(mm|cm|m)\\b/.exec(a.label || ""), whole = D.lengthCm[a.k];
    if (!m || !whole) return 1;
    const cm = m[1].split("+").reduce((sum, n) => sum + +n, 0) * (m[2] === "mm" ? 0.1 : m[2] === "m" ? 100 : 1);
    return cm > 0 && cm < whole ? cm / whole : 1;
  };
  const dimension = (a, pose, step) => {
    const g = ease.out(span(t, a.at, a.at + 0.7)); if (g <= 0) return;
    const f = measured(a), w = sizeOf(a.k).width, L = onTop(a.k, 0, pose), R = onTop(a.k, f, pose), y = Math.min(L.y, R.y) - 60, mx = (L.x + R.x) / 2, half = (R.x - L.x) / 2 * g;
    // The tape, while it measures: hooked over the part's start, its blade along the part out to the length (a tick
    // every 10 cm), its case there. It is out of the tray for just this act, so it comes and goes when the tray changes.
    if (a.with && D.poses[a.with] && t < a.at + a.len) {
      const E = onTop(a.k, f * g, pose), angle = Math.atan2(E.y - L.y, E.x - L.x), whole = D.lengthCm[a.k];
      ctx.lineCap = "butt"; ctx.setLineDash([]);
      ctx.strokeStyle = INK; ctx.lineWidth = 12; ctx.beginPath(); ctx.moveTo(L.x - 8 * Math.cos(angle), L.y - 8 * Math.sin(angle)); ctx.lineTo(E.x, E.y); ctx.stroke();
      ctx.strokeStyle = "#ffcc00"; ctx.lineWidth = 7; ctx.beginPath(); ctx.moveTo(L.x - 6 * Math.cos(angle), L.y - 6 * Math.sin(angle)); ctx.lineTo(E.x, E.y); ctx.stroke();
      if (whole) {
        ctx.strokeStyle = INK; ctx.lineWidth = 1.5;
        for (let c = 10; c < whole * f * g; c += 10) { const q = onTop(a.k, c / whole, pose); ctx.beginPath(); ctx.moveTo(q.x - 3 * Math.sin(angle), q.y + 3 * Math.cos(angle)); ctx.lineTo(q.x + 3 * Math.sin(angle), q.y - 3 * Math.cos(angle)); ctx.stroke(); }
      }
      const s = sizeOf(a.with), big = Math.max(D.poses[a.with].scale, 160 / Math.max(s.width, s.height));
      plain(a.with, { x: E.x, y: E.y, scale: big, angle, anchor: D.toolTip[a.with] || [0, s.height * 0.88] });
    }
    ctx.strokeStyle = INK; ctx.lineWidth = 3; ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(mx - half, y); ctx.lineTo(mx + half, y); ctx.stroke();
    for (const x of [mx - half, mx + half]) { ctx.beginPath(); ctx.moveTo(x, y - 16); ctx.lineTo(x, y + 16); ctx.stroke(); }
    if (g > 0.8 && a.label) tag(a.label, mx, y, { size: 30, pad: 12, h: 44, line: 3 });
  };
  // A cut into named parts: the cut at each joint in turn (the saw if one is named, else the knife's line), the parts
  // drawn apart once cut, each labelled with its length.
  const cutInto = {};
  for (const a of D.acts) if (a.v === "cut" && D.slices[a.k] && !cutInto[a.k]) cutInto[a.k] = a;
  // When joint j of a cut is through; the cut thing is gone once its parts are in the tray.
  const jointAt = (a, j, n) => a.at + a.len * (0.15 + 0.7 * (j + 1) / Math.max(1, n - 1));
  for (const key of Object.keys(cutInto)) goneAt[key] = cutInto[key].at + cutInto[key].len * (D.boards[key] ? 0.82 : 1) + (D.boards[key] ? 0 : 0.4);
  for (const a of D.sheetCuts) goneAt[a.k] = a.at + a.len * 0.82;
  // A cut part where it was cut: in its object's pose, the parts drawn apart as the cut left them.
  const homeOf = (key) => {
    const flat = D.flatParts[key];
    if (flat && flat.from && D.poses[flat.from]) {
      const of = D.poses[flat.from], S = D.sheets[key], P = flatPoint(flat.from, flat.origin, of);
      return { ...of, x: P.x, y: P.y, scale: of.scale * D.sheets[flat.from].unit / S.unit, anchor: S.offset, home: true };
    }
    if (D.boards[key]?.home) return { ...D.boards[key].home, home: true };
    const h = D.home[key]; if (!h || !D.poses[h.of]) return null;
    const of = { ...D.poses[h.of] }, s = sizeOf(h.of), an = of.anchor || [s.width / 2, s.height], sl = D.slices[h.of], j = sl.findIndex((p) => p.k === key);
    const shift = (j - (sl.length - 1) / 2) * 26, a = of.angle || 0;
    return { ...of, anchor: [an[0] - h.x0, an[1]], x: of.x + shift * Math.cos(a), y: of.y + shift * Math.sin(a) };
  };

  // A piece being made: how far along it is (each "work" step takes it from where it was to its p), and its drawing —
  // rounds (round) or rows (flat, tube, ball) of stitches as its pattern counts them, each stitch the two loops of a
  // real one in its yarn's colours, worked in order. Returns the stitch being made, on the frame — where it is, the
  // ways into the fabric and along it, the stitch's size, and how far through it the hook is — or null.
  const works = D.acts.filter((a) => a.v === "work");
  const progress = (key) => {
    if (t >= D.times.finale) return 1;
    let done = 0;
    for (const a of works) {
      if (a.k !== key) continue;
      const p = Math.min(1, Math.max(done, +a.p || 1));
      if (t < a.at) return done;
      if (t < a.at + a.len) return lerp(done, p, span(t, a.at + 0.2, a.at + a.len - 0.2));
      done = p;
    }
    return done;
  };
  const shade = (c) => mix([c, c, INK]), light = (c) => mix([c, c, c, "#ffffff"]);
  // One stitch: two loops leaning apart from its middle, opening away from the fabric below it (out, a unit vector).
  const stitch = (x, y, out, size, color) => {
    const along = [-out[1], out[0]], tilt = Math.atan2(out[1], out[0]);
    ctx.fillStyle = light(color); ctx.strokeStyle = shade(color); ctx.lineWidth = Math.max(0.6, size * 0.07);
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(x + along[0] * side * size * 0.22, y + along[1] * side * size * 0.22, size * 0.42, size * 0.2, tilt + side * 0.5, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
    }
  };
  const piece = (key, o) => {
    const spec = D.piece[key], prog = progress(key); if (prog <= 0) return null;
    const s = sizeOf(key), w = s.width, h = s.height, sc = o.scale || 1, an = o.anchor || [w / 2, h];
    const cs = spec.colors.length ? spec.colors : ["#d9b8a0"], R = spec.rows;
    const colorOf = (r) => D.rowColors[key][r] || cs[Math.floor(r / Math.max(1, Math.ceil(R / cs.length))) % cs.length];
    const total = prog * R, full = Math.min(Math.floor(total), R), frac = total - Math.floor(total), last = Math.min(full, R - 1);
    let at = null;
    ctx.save(); ctx.globalAlpha = o.alpha ?? 1; ctx.translate(o.x, o.y); ctx.rotate(o.angle || 0); ctx.scale(sc, sc); ctx.translate(-an[0], -an[1]);
    if (["round", "square", "hexagon", "flower"].includes(spec.shape)) {
      // A motif worked in rounds from its middle: a circle, a square (a granny square), a hexagon, or a flower — rounds
      // with petals worked in its last. Round r (from 0) has start × (r + 1) stitches. A piece of several motifs works
      // them one after another, laid out "cols" across from the lowest row up, and joins them when all are made.
      const n = spec.motifs || 1, cols = spec.cols || 1, lines = Math.ceil(n / cols), cw = w / cols, ch = h / lines, each = prog * n;
      // (a round's edge at angle a, its apothem rad: a circle, else the polygon's sides — a square's flat at its foot)
      const sides = spec.shape === "square" ? 4 : spec.shape === "hexagon" ? 6 : 0, turn0 = sides === 4 ? Math.PI / 4 : sides === 6 ? Math.PI / 6 : 0;
      const edge = (a, rad) => { if (!sides) return rad; const k = (2 * Math.PI) / sides, f = ((((a - turn0) % k) + k) % k) - k / 2; return rad / Math.cos(f); };
      const ring = (cx, cy, rad, a0, a1) => { if (!sides) { ctx.arc(cx, cy, rad, a0, a1); return; } const steps = Math.max(6, Math.ceil((Math.abs(a1 - a0) / (Math.PI * 2)) * 72)); for (let i = 0; i <= steps; i++) { const a = a0 + ((a1 - a0) * i) / steps, r = edge(a, rad); ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); } };
      const motif = (x0, y0, mw, mh, mp, alone) => {
        const total = mp * R, full = Math.min(Math.floor(total), R), frac = total - Math.floor(total), last = Math.min(full, R - 1);
        const petals = spec.shape === "flower", body = petals ? R - 1 : R, reach = Math.min(mw, mh) / 2;
        // (its rounds' spacing: the finished motif fills its cell; a flower's petals reach out 1.6 rounds)
        const rr = reach / (petals ? body + 1.6 : R), cx = x0 + mw / 2;
        // (one alone grows up from what it rests on; one of several sits in its cell's middle)
        const low = petals && last >= body ? rr * (body + 1.6) : edge(Math.PI / 2, rr * (Math.min(last, body - 1) + 1)), cy = alone ? y0 + mh - low : y0 + mh / 2;
        let got = null;
        if (ctx.mark) ctx.mark(key, cx - reach, cy - reach, 2 * reach, 2 * reach);
        if (petals && last >= body) {
          // The petals: the last round, each a loop of stitches worked into the body's edge (tucked under it), made one
          // after another.
          const P = spec.petals || spec.start, part = full >= R ? 1 : frac, made = P * part, base = rr * body * 0.8, len = rr * (1.6 + body * 0.2);
          for (let j = 0; j < Math.ceil(made); j++) {
            const a = -Math.PI / 2 + ((j + 0.5) / P) * Math.PI * 2, grow = Math.min(1, made - j), c = colorOf(R - 1);
            ctx.fillStyle = c; ctx.strokeStyle = shade(c); ctx.lineWidth = Math.max(0.8, rr * 0.08);
            ctx.beginPath(); ctx.ellipse(cx + Math.cos(a) * (base + (len * grow) / 2), cy + Math.sin(a) * (base + (len * grow) / 2), (len * grow) / 2, Math.min(len * 0.42, (Math.PI * base) / P), a, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          }
          if (part < 1) { const a = -Math.PI / 2 + (Math.PI * 2 * made) / P; got = { lx: cx + Math.cos(a) * (base + len), ly: cy + Math.sin(a) * (base + len), into: [-Math.cos(a), -Math.sin(a)], along: [-Math.sin(a), Math.cos(a)], size: rr, phase: made % 1 }; }
        }
        for (let r = Math.min(last, body - 1); r >= 0; r--) {
          const part = r < full ? 1 : frac; if (part <= 0) continue;
          ctx.fillStyle = colorOf(r); ctx.beginPath(); ctx.moveTo(cx, cy); ring(cx, cy, rr * (r + 1), -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * part); ctx.closePath(); ctx.fill();
        }
        for (let r = 0; r <= Math.min(last, body - 1); r++) {
          const part = r < full ? 1 : frac, cnt = spec.start * (r + 1), rad = rr * (r + 0.5), made = cnt * part, size = Math.min(rr * 1.1, (Math.PI * 2 * rad) / cnt * 1.15);
          for (let j = 0; j < Math.floor(made); j++) {
            const a = -Math.PI / 2 + ((j + 0.5) / cnt) * Math.PI * 2, e = edge(a, rad);
            stitch(cx + Math.cos(a) * e, cy + Math.sin(a) * e, [Math.cos(a), Math.sin(a)], size, colorOf(r));
          }
          if (r === last && part < 1) {
            const a = -Math.PI / 2 + (Math.PI * 2 * made) / cnt, e = edge(a, rr * (r + 1));
            got = { lx: cx + Math.cos(a) * e, ly: cy + Math.sin(a) * e, into: [-Math.cos(a), -Math.sin(a)], along: [-Math.sin(a), Math.cos(a)], size, phase: made % 1 };
          }
        }
        if (mp >= 1) {
          ctx.strokeStyle = INK; ctx.lineWidth = 3 / sc; ctx.beginPath();
          if (!petals) { ring(cx, cy, rr * R, -Math.PI / 2, (Math.PI * 3) / 2); ctx.closePath(); } else ctx.arc(cx, cy, rr * body, 0, Math.PI * 2);
          ctx.stroke();
        }
        return got;
      };
      for (let m = 0; m < n; m++) {
        const mp = Math.min(1, Math.max(0, each - m)); if (mp <= 0) break;
        const got = motif((m % cols) * cw, h - (Math.floor(m / cols) + 1) * ch, cw, ch, mp, n === 1);
        if (got) at = got;
      }
      if (prog >= 1 && n > 1) {
        // Joined: the seams between the motifs, a row of slip stitches along each.
        ctx.strokeStyle = shade(cs[0]); ctx.lineWidth = Math.max(1.2, Math.min(cw, ch) * 0.025); ctx.setLineDash([Math.min(cw, ch) * 0.05, Math.min(cw, ch) * 0.04]);
        ctx.beginPath();
        for (let c = 1; c < cols; c++) { ctx.moveTo(c * cw, h - lines * ch); ctx.lineTo(c * cw, h); }
        for (let l = 1; l < lines; l++) { ctx.moveTo(0, h - l * ch); ctx.lineTo(w, h - l * ch); }
        ctx.stroke(); ctx.setLineDash([]);
      }
    } else {
      if (ctx.mark) ctx.mark(key, 0, h - (last + 1) * (h / R), w, (last + 1) * (h / R));
      const rh = h / R, S = spec.stitches, sw = w / S, size = Math.min(rh * 1.15, sw * 1.3);
      if (spec.shape === "ball") { ctx.beginPath(); ctx.arc(w / 2, h / 2, w / 2, 0, Math.PI * 2); ctx.clip(); }
      for (let r = 0; r <= last; r++) {
        const made = (r < full ? 1 : frac) * S, count = Math.floor(made), y = h - (r + 1) * rh; if (made <= 0) continue;
        // Crochet turns at each row's end: odd rows run right to left.
        const dir = r % 2 ? -1 : 1, x0 = dir > 0 ? 0 : w - count * sw;
        ctx.fillStyle = colorOf(r); ctx.fillRect(x0, y, count * sw, rh + 0.5);
        for (let j = 0; j < count; j++) stitch(x0 + (j + 0.5) * sw, y + rh / 2, [0, -1], size, colorOf(r));
        if (r === last && made < S) at = { lx: dir > 0 ? count * sw : w - count * sw, ly: y + rh * 0.5, into: [0, 1], along: [dir, 0], size, phase: made % 1 };
      }
      if (prog >= 1) { ctx.strokeStyle = INK; ctx.lineWidth = 3 / sc; ctx.beginPath(); spec.shape === "ball" ? ctx.arc(w / 2, h / 2, w / 2 - 1, 0, Math.PI * 2) : ctx.rect(0, 0, w, h); ctx.stroke(); }
    }
    ctx.restore();
    if (!at) return null;
    const a = o.angle || 0, turn = (v) => [v[0] * Math.cos(a) - v[1] * Math.sin(a), v[0] * Math.sin(a) + v[1] * Math.cos(a)];
    const d = turn([(at.lx - an[0]) * sc, (at.ly - an[1]) * sc]);
    return { x: o.x + d[0], y: o.y + d[1], into: turn(at.into), along: turn(at.along), size: at.size * sc, phase: at.phase,
      color: colorOf(last), strand: spec.strand };
  };
  // Crocheting: the hook strokes at the edge of the work, two and a half times a second whatever the pattern's pace (a
  // stroke per stitch would blur) — in through the fabric (0–0.35), a yarn over, the strand wrapped round its head
  // (0.35–0.55), and back out through, carrying the loop (0.55–1) — following the edge as the stitches appear. The hook is
  // the photo's own (with), its tip at the stitch and its handle up and away, else a plain one drawn here; the strand
  // runs from the yarn it is worked from, as thick as the yarn's weight; a working loop sits on the shaft.
  const inHand = (key) => works.some((w) => w.with === key && D.tips[key] && t >= w.at && t < w.at + w.len);
  const hook = (a, at) => {
    if (!at || !D.poses[a.to]) return;
    const f = (t * 2.5) % 1, k = at.size;
    const push = f < 0.35 ? ease.inOut(f / 0.35) : f < 0.55 ? 1 : 1 - ease.inOut((f - 0.55) / 0.45);
    // Pulling out, it draws back a little along the row, the way the loop comes through.
    const slide = f < 0.55 ? 0 : -0.35 * Math.sin(Math.PI * (f - 0.55) / 0.45);
    const twist = f >= 0.35 && f < 0.55 ? 0.35 * Math.sin(Math.PI * (f - 0.35) / 0.2) : 0;
    const tx = at.x + at.into[0] * push * k * 0.7 + at.along[0] * slide * k, ty = at.y + at.into[1] * push * k * 0.7 + at.along[1] * slide * k;
    const yarn = seatOf(a.to), thick = Math.max(2, at.strand);
    ctx.strokeStyle = at.color; ctx.lineWidth = thick; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(yarn.x, yarn.y); ctx.quadraticCurveTo((yarn.x + tx) / 2, Math.max(yarn.y, ty) + 60, tx, ty); ctx.stroke();
    // The hook's way up its shaft, from the tip: up and away from the fabric.
    const angle = -0.95 + twist, shaft = [Math.cos(angle), Math.sin(angle)];
    const own = a.with && D.tips[a.with];
    if (own) {
      const s = sizeOf(a.with), tip = D.tips[a.with], toward = Math.atan2(s.height / 2 - tip[1], s.width / 2 - tip[0]);
      plain(a.with, { x: tx, y: ty, scale: (D.poses[a.with] || D.poses[a.k]).scale, angle: angle - toward, anchor: tip });
    } else {
      ctx.strokeStyle = INK; ctx.lineWidth = 13; ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(tx + shaft[0] * 200, ty + shaft[1] * 200); ctx.stroke();
      ctx.strokeStyle = "#c9cfd9"; ctx.lineWidth = 8; ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(tx + shaft[0] * 200, ty + shaft[1] * 200); ctx.stroke();
    }
    // The working loop on the shaft, and — during the yarn over — the strand wrapped round the hook's head.
    ctx.strokeStyle = at.color; ctx.lineWidth = thick;
    const lx = tx + shaft[0] * Math.max(18, k * 0.9), ly = ty + shaft[1] * Math.max(18, k * 0.9);
    ctx.beginPath(); ctx.ellipse(lx, ly, Math.max(6, thick * 1.3), Math.max(10, thick * 2.2), angle, 0, Math.PI * 2); ctx.stroke();
    if (f >= 0.3 && f < 0.75) {
      ctx.globalAlpha = Math.sin(Math.PI * span(f, 0.3, 0.75));
      ctx.beginPath(); ctx.ellipse(tx + shaft[0] * 6, ty + shaft[1] * 6, Math.max(7, thick * 1.5), Math.max(5, thick), angle + Math.PI / 2, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }
  };

  // A thing's size: a board's is its projected drawing's box (joints.mjs); anything else's, its drawing's.
  const sizeOf = (key) => D.boards[key] ? { width: D.boards[key].w, height: D.boards[key].h } : objects.size(key);
  // A log (joints.mjs: isLog), in its board's box: its body in its bark's colour, streaks along it, and its end grain —
  // rings round the pith — at the end facing the viewer; the model's bark and end grain over them once in (faces.mjs:
  // "side" mapped along the body, "end" onto the ellipse). Flat fills and a few strokes: no dearer than a board.
  const logOf = (key, g, o, c, sc) => {
    const L = g.log, path = () => { ctx.beginPath(); L.body.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); };
    if (o.outline) { ctx.fillStyle = o.outline; path(); ctx.fill(); return; }
    const fd = D.faces[key] && t >= D.faces[key].at ? D.faces[key] : null, fade = (o.alpha ?? 1) * (fd ? span(t, fd.at, fd.at + 0.6) : 0);
    const [e0, e1] = L.ends, ac = L.across, bark = c;
    ctx.fillStyle = bark; path(); ctx.fill();
    ctx.strokeStyle = mix([bark, INK]); ctx.lineWidth = 1.8 / sc;
    for (const f of [-0.62, -0.24, 0.14, 0.52]) {
      const w = Math.sin(f * 13 + key.length) * 0.05;
      ctx.beginPath(); ctx.moveTo(e0[0] + ac[0] * f, e0[1] + ac[1] * f);
      ctx.quadraticCurveTo((e0[0] + e1[0]) / 2 + ac[0] * (f + w), (e0[1] + e1[1]) / 2 + ac[1] * (f + w), e1[0] + ac[0] * f, e1[1] + ac[1] * f); ctx.stroke();
    }
    const art = (a, place) => {
      ctx.save(); ctx.globalAlpha = fade; ctx.clip(); place(); ctx.lineJoin = "round"; ctx.lineWidth = 2;
      for (const sh of a.shapes) { if (sh.hidden) continue; ctx.lineWidth = sh.weight == null ? 2 : ({ none: 0, detail: 1.25, edge: 2, silhouette: 3 })[sh.weight]; const p2 = new Path2D(sh.d); if (sh.fill !== "none") { ctx.fillStyle = sh.fill; ctx.fill(p2, sh.fillRule || "nonzero"); } if (sh.stroke !== "none" && sh.weight !== "none") { ctx.strokeStyle = sh.stroke; ctx.stroke(p2); } }
      ctx.restore();
    };
    // (the bark's box: its length from end to end, its height across the body)
    if (fd && fd.side) { path(); art(fd.side, () => ctx.transform((e1[0] - e0[0]) / fd.side.width, (e1[1] - e0[1]) / fd.side.width, 2 * ac[0] / fd.side.height, 2 * ac[1] / fd.side.height, e0[0] - ac[0], e0[1] - ac[1])); }
    const E = L.end;
    if (E) {
      const ring = (r) => { ctx.save(); ctx.transform(E.u[0], E.u[1], E.v[0], E.v[1], E.c[0], E.c[1]); ctx.beginPath(); ctx.ellipse(0, 0, r, r, 0, 0, Math.PI * 2); ctx.restore(); };
      const grain = mix([c, "#f1dcb8", "#f1dcb8"]);
      ring(1); ctx.fillStyle = grain; ctx.fill();
      ctx.strokeStyle = mix([grain, c]); ctx.lineWidth = 1.4 / sc;
      for (const r of [0.72, 0.46, 0.22]) { ring(r); ctx.stroke(); }
      ring(0.05); ctx.fillStyle = mix([grain, c]); ctx.fill();
      if (fd && fd.end) { ring(1); art(fd.end, () => { ctx.transform(E.u[0], E.u[1], E.v[0], E.v[1], E.c[0], E.c[1]); ctx.translate(-1, -1); ctx.scale(2 / fd.end.width, 2 / fd.end.height); }); }
      ring(1); ctx.strokeStyle = INK; ctx.lineWidth = 2.2 / sc; ctx.stroke();
    }
    path(); ctx.strokeStyle = INK; ctx.lineWidth = 2.2 / sc; ctx.stroke();
    if (o.highlight) { ctx.globalAlpha = (o.alpha ?? 1) * o.highlight; ctx.strokeStyle = ACCENT; ctx.lineWidth = 9 / sc; ctx.stroke(); ctx.globalAlpha = o.alpha ?? 1; }
  };
  // A board, as a plan draws it: its faces (the upper lightest, the front and sides darker), its grain along its
  // upper face, its edges in ink. At home (a cut part where it was cut) it lies as the board it came from lay.
  const boardOf = (key, o) => {
    const g = o.home && D.boards[key].homeBoard ? D.boards[key].homeBoard : D.boards[key], c = D.board[key] || "#d9b48a";
    const an = o.anchor || [g.w / 2, g.h / 2], sc = o.scale || 1;
    ctx.save(); ctx.globalAlpha = o.alpha ?? 1; ctx.translate(o.x, o.y); ctx.rotate(o.angle || 0); ctx.scale(sc, sc); ctx.translate(-an[0], -an[1]);
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    if (ctx.mark) { const P = g.faces.flatMap((f) => f.pts), x0 = Math.min(...P.map((q) => q[0])), y0 = Math.min(...P.map((q) => q[1])); ctx.mark(key, x0, y0, Math.max(...P.map((q) => q[0])) - x0, Math.max(...P.map((q) => q[1])) - y0); }
    if (g.brick) { brick(key, g, o); ctx.restore(); return; }
    if (g.log) { logOf(key, g, o, c, sc); ctx.restore(); return; }
    if (o.outline) {
      // (its outline alone, in that colour, as one path: a shadow)
      ctx.fillStyle = o.outline; ctx.beginPath();
      for (const f of g.faces) { f.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); }
      ctx.fill(); ctx.restore(); return;
    }
    const [l0, l1] = g.line, lv = [l1[0] - l0[0], l1[1] - l0[1]];
    for (const f of g.faces) {
      const P = f.pts;
      ctx.fillStyle = f.kind === "upper" ? c : f.kind === "front" ? mix([c, c, c, INK]) : mix([c, c, INK]);
      ctx.beginPath(); P.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.fill();
      if ((f.kind === "upper" || D.view === "front") && (!f.shaped || f.box)) {
        // Grain: lines between the two edges that run along the board. (A shaped face: in its own frame, f.box, and
        // kept inside its outline.)
        const G = f.box || P;
        if (f.box) { ctx.save(); ctx.clip(); }
        const ab = [G[1][0] - G[0][0], G[1][1] - G[0][1]], ad = [G[3][0] - G[0][0], G[3][1] - G[0][1]];
        const cosOf = (v) => Math.abs(v[0] * lv[0] + v[1] * lv[1]) / ((Math.hypot(v[0], v[1]) || 1) * (Math.hypot(lv[0], lv[1]) || 1));
        const alongAB = cosOf(ab) >= cosOf(ad);
        ctx.strokeStyle = shade(c); ctx.lineWidth = 1.6 / sc;
        for (const fr of [0.22, 0.45, 0.68, 0.86]) {
          const s0 = alongAB ? [G[0][0] + ad[0] * fr, G[0][1] + ad[1] * fr] : [G[0][0] + ab[0] * fr, G[0][1] + ab[1] * fr];
          const s1 = alongAB ? [s0[0] + ab[0], s0[1] + ab[1]] : [s0[0] + ad[0], s0[1] + ad[1]];
          const wob = Math.sin(fr * 17 + key.length) * 0.03, side = alongAB ? ad : ab;
          ctx.beginPath(); ctx.moveTo(s0[0], s0[1]);
          ctx.quadraticCurveTo((s0[0] + s1[0]) / 2 + side[0] * wob, (s0[1] + s1[1]) / 2 + side[1] * wob, s1[0], s1[1]); ctx.stroke();
        }
        if (f.box) ctx.restore();
      }
      ctx.strokeStyle = INK; ctx.lineWidth = 2.2 / sc;
      ctx.beginPath(); P.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.stroke();
      if (o.highlight) { ctx.globalAlpha = (o.alpha ?? 1) * o.highlight; ctx.strokeStyle = ACCENT; ctx.lineWidth = 9 / sc; ctx.stroke(); ctx.globalAlpha = o.alpha ?? 1; }
    }
    ctx.restore();
  };
  // The light, from the upper left: each thing standing on the stage casts a soft shadow, fainter, narrower and
  // further off the higher it is (lift, stage px: how far it is above where it rests, as it is set down). Measured:
  // a filter, a gradient, a second pass over the stage or painting under it each made films slower to render, so
  // the shadows are flat ellipses, drawn first, from where things stand, in one cheap loop.
  const pool = (x, y, rx, ry, strength) => {
    // (two flat ellipses, a wide faint one and a narrow darker one in it: soft enough, and cheaper than a gradient)
    ctx.fillStyle = "rgba(70,52,30," + (0.1 * strength).toFixed(3) + ")";
    ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(x - rx * 0.04, y, rx * 0.72, ry * 0.6, 0, 0, Math.PI * 2); ctx.fill();
  };
  const castShadow = (key, o) => {
    if ((o.alpha ?? 1) < 0.5) return;
    const lift = Math.max(0, o.lift || 0);
    // (a board casts none: its shadow, a polygon as big as the board, cost more to draw than the board itself)
    if (D.boards[key] && D.view !== "side" && !D.boards[key].brick) return;
    // Anything else: a pool under it (side on, on the floor line; else under its lower edge), as wide as it is.
    const s = sizeOf(key), at = [[0, 0], [s.width, 0], [0, s.height], [s.width, s.height]].map((q) => objects.point(key, q, o));
    const x0 = Math.min(...at.map((q) => q.x)), x1 = Math.max(...at.map((q) => q.x)), y1 = Math.max(...at.map((q) => q.y));
    const side = D.view === "side" || !D.view, d = side ? Math.max(0, D.floorY - y1) + lift : lift, j = Math.min(1, d / 600);
    if (side && (y1 > D.floorY + 40 || d > 900)) return;
    // (none for a small thing, a screw or a nail: too small to see, and they come by the dozen)
    if (x1 - x0 < 40) return;
    const rx = (x1 - x0) * 0.56 * (1 - 0.45 * j);
    pool((x0 + x1) / 2 + 12 + 50 * j, (side ? D.floorY : y1 + lift) + 2, rx, Math.max(6, rx * (side ? 0.12 : 0.22)), 1 - 0.75 * j);
  };
  // A toy brick (bricks.mjs), drawn from its numbers in its box (the transform already set): its faces shaded as a
  // board's, in its colour from the photo; a log's ridges, a grille's slots or side studs down its face; a round brick
  // a cylinder; then its studs, each a short cylinder. Bricks drawn later (higher, nearer) cover the studs under them.
  const brick = (key, g, o) => {
    const b = g.brick, c = b.color, sc = o.scale || 1;
    ctx.strokeStyle = INK; ctx.lineWidth = 2.2 / sc;
    // (its front only, drawn again over what stands in it: a cylinder's near side, a block's front and side)
    if (o.frontOnly) {
      if (b.round) {
        const { c0, c1, rx, ry } = b.round, r = b.round.rot || 0, ex = rx * Math.cos(r), ey = rx * Math.sin(r);
        ctx.fillStyle = mix([c, c, c, INK]); ctx.beginPath(); ctx.ellipse(c0[0], c0[1], rx, ry, r, 0, Math.PI); ctx.lineTo(c1[0] - ex, c1[1] - ey); ctx.ellipse(c1[0], c1[1], rx, ry, r, Math.PI, 0, true); ctx.closePath(); ctx.fill(); ctx.stroke();
      } else for (const f of g.faces) if (f.kind !== "upper") { ctx.fillStyle = f.kind === "front" ? mix([c, c, c, INK]) : mix([c, c, INK]); ctx.beginPath(); f.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.fill(); ctx.stroke(); }
      return;
    }
    // (a stud is three draws: its side band, filled; its upper face, filled and outlined. None where it would be under
    // 2.5 px on the frame — the tray, a wide shot of a big build — where it reads as nothing.)
    const studAt = ([x, y]) => {
      const { rx, ry, h } = b.stud, r = b.stud.rot || 0, ex = rx * Math.cos(r), ey = rx * Math.sin(r);
      ctx.fillStyle = mix([c, c, INK]); ctx.beginPath(); ctx.ellipse(x, y, rx, ry, r, 0, Math.PI); ctx.lineTo(x - ex, y - ey - h); ctx.lineTo(x + ex, y + ey - h); ctx.closePath(); ctx.fill();
      ctx.fillStyle = mix([c, c, c, "#ffffff"]); ctx.beginPath(); ctx.ellipse(x, y - h, rx, ry, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    };
    if (b.round) {
      const { c0, c1, rx, ry } = b.round, r = b.round.rot || 0, ex = rx * Math.cos(r), ey = rx * Math.sin(r);
      ctx.fillStyle = mix([c, c, c, INK]); ctx.beginPath(); ctx.ellipse(c0[0], c0[1], rx, ry, r, 0, Math.PI); ctx.lineTo(c1[0] - ex, c1[1] - ey); ctx.ellipse(c1[0], c1[1], rx, ry, r, Math.PI, 0, true); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = c; ctx.beginPath(); ctx.ellipse(c1[0], c1[1], rx, ry, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.globalAlpha = (o.alpha ?? 1) * 0.3; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = rx * 0.12;
      ctx.beginPath(); ctx.moveTo(c0[0] - rx * 0.55, c0[1] + ry * 0.5); ctx.lineTo(c1[0] - rx * 0.55, c1[1] + ry * 0.5); ctx.stroke();
      ctx.globalAlpha = o.alpha ?? 1; ctx.strokeStyle = INK; ctx.lineWidth = 2.2 / sc;
    } else {
      for (const f of g.faces) {
        ctx.fillStyle = f.kind === "upper" ? c : f.kind === "front" ? mix([c, c, c, INK]) : mix([c, c, INK]);
        ctx.beginPath(); f.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.fill(); ctx.stroke();
      }
      const cols = b.columns, step = cols.length > 1 ? [cols[1][0][0] - cols[0][0][0], cols[1][0][1] - cols[0][0][1]] : [0, 0];
      if (b.shape === "log") for (const [foot, head] of cols) {
        // a rounded ridge down the face under each stud: a light band, and the groove at its side
        ctx.globalAlpha = (o.alpha ?? 1) * 0.3; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = Math.hypot(...step) * 0.2;
        const up = [(head[0] - foot[0]) * 0.12, (head[1] - foot[1]) * 0.12];
        ctx.beginPath(); ctx.moveTo(foot[0] - step[0] * 0.15 + up[0], foot[1] - step[1] * 0.15 + up[1]); ctx.lineTo(head[0] - step[0] * 0.15 - up[0], head[1] - step[1] * 0.15 - up[1]); ctx.stroke();
        ctx.globalAlpha = o.alpha ?? 1; ctx.strokeStyle = INK; ctx.lineWidth = 2.2 / sc;
        ctx.beginPath(); ctx.moveTo(foot[0] + step[0] * 0.5, foot[1] + step[1] * 0.5); ctx.lineTo(head[0] + step[0] * 0.5, head[1] + step[1] * 0.5); ctx.stroke();
      }
      if (b.shape === "grille") {
        // (slots inset an eighth of the face's height at each end, never past its edges)
        ctx.lineWidth = 1.4 / sc; const n = cols.length * 5, f0 = cols[0][0], h0 = cols[0][1], up = [(h0[0] - f0[0]) / 8, (h0[1] - f0[1]) / 8];
        for (let i = 1; i < n; i++) {
          const dx = step[0] * (i / 5 - 0.5), dy = step[1] * (i / 5 - 0.5);
          ctx.beginPath(); ctx.moveTo(f0[0] + dx + up[0], f0[1] + dy + up[1]); ctx.lineTo(h0[0] + dx - up[0], h0[1] + dy - up[1]); ctx.stroke();
        }
        ctx.lineWidth = 2.2 / sc;
      }
      if (b.sideStuds) for (const [foot, head] of cols) {
        const x = (foot[0] + head[0]) / 2, y = (foot[1] + head[1]) / 2, r = Math.hypot(...step) * 0.3;
        ctx.fillStyle = mix([c, c, c, "#ffffff"]); ctx.beginPath(); ctx.ellipse(x, y, r * 0.75, r, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
    }
    // Its face drawings, once in: each box mapped onto its face (its upper left corner to the face's, its sides along
    // the face's edges), clipped to it, fading in.
    const fd = D.faces[key];
    if (fd && t >= fd.at && !b.round) for (const f of g.faces) {
      const art = fd[f.kind]; if (!art) continue;
      const P = f.pts, tl = P[3], tr = P[2], bl = P[0];
      ctx.save(); ctx.globalAlpha = (o.alpha ?? 1) * span(t, fd.at, fd.at + 0.6);
      ctx.beginPath(); P.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.clip();
      ctx.transform((tr[0] - tl[0]) / art.width, (tr[1] - tl[1]) / art.width, (bl[0] - tl[0]) / art.height, (bl[1] - tl[1]) / art.height, tl[0], tl[1]);
      ctx.lineJoin = "round"; ctx.lineWidth = 2;
      for (const sh of art.shapes) { if (sh.hidden) continue; ctx.lineWidth = sh.weight == null ? 2 : ({ none: 0, detail: 1.25, edge: 2, silhouette: 3 })[sh.weight]; const path = new Path2D(sh.d); if (sh.fill !== "none") { ctx.fillStyle = sh.fill; ctx.fill(path, sh.fillRule || "nonzero"); } if (sh.stroke !== "none" && sh.weight !== "none") { ctx.strokeStyle = sh.stroke; ctx.stroke(path); } }
      ctx.restore();
      ctx.strokeStyle = INK; ctx.lineWidth = 2.2 / sc; ctx.beginPath(); P.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.stroke();
    }
    if (b.stud.rx * sc * (ctx.getTransform ? Math.abs(ctx.getTransform().a) / sc : 1) >= 2.5) for (const s of b.studs) studAt(s);
    if (o.highlight) {
      ctx.globalAlpha = (o.alpha ?? 1) * o.highlight; ctx.strokeStyle = ACCENT; ctx.lineWidth = 7 / sc;
      // (a round brick's outline is its cylinder's, not its box's)
      if (b.round) {
        const { c0, c1, rx, ry } = b.round, r = b.round.rot || 0, ex = rx * Math.cos(r), ey = rx * Math.sin(r);
        ctx.beginPath(); ctx.ellipse(c0[0], c0[1], rx, ry, r, 0, Math.PI); ctx.lineTo(c1[0] - ex, c1[1] - ey); ctx.ellipse(c1[0], c1[1], rx, ry, r, Math.PI, Math.PI * 2); ctx.closePath(); ctx.stroke();
      } else for (const f of g.faces) { ctx.beginPath(); f.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.stroke(); }
      ctx.globalAlpha = o.alpha ?? 1;
    }
  };
  // One object: its cut-out or its drawing, as the film's look says (a board in the plan or front view, but for the
  // photo it lifts off); split in two once it has been cut.
  const stateDraw = (key, o) => {
    const art = D.appearances[key][stateNow[key]], s = sizeOf(key), an = o.anchor || [s.width / 2, s.height];
    ctx.save(); ctx.globalAlpha = o.alpha ?? 1; ctx.translate(o.x, o.y); ctx.rotate(o.angle || 0); ctx.scale(o.scale || 1, o.scale || 1);
    ctx.translate(-an[0], -an[1]); ctx.beginPath(); ctx.rect(0, 0, s.width, s.height); ctx.clip(); ctx.scale(s.width / art.width, s.height / art.height);
    for (const sh of art.shapes) { if (sh.hidden) continue; ctx.lineWidth = sh.weight == null ? 2 : ({ none: 0, detail: 1.25, edge: 2, silhouette: 3 })[sh.weight]; const path = new Path2D(sh.d); if (sh.fill !== "none") { ctx.fillStyle = sh.fill; ctx.fill(path, sh.fillRule || "nonzero"); }
      // (a pale outline gets an ink casing, a pale shape an ink edge: white things stay visible on the paper)
      const fillPale = sh.fill !== "none" && paleHere(sh.fill), strokePale = sh.stroke !== "none" && paleHere(sh.stroke);
      if (strokePale) { ctx.strokeStyle = INK; ctx.lineWidth = 5; ctx.stroke(path); }
      if (sh.stroke !== "none" && sh.weight !== "none") { ctx.strokeStyle = sh.stroke; ctx.lineWidth = 2; ctx.stroke(path); }
      else if (fillPale) { ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.stroke(path); } }
    ctx.restore();
  };
  // A thing being reshaped: every point moving from its drawing before to its drawing after (D.reshapes), the manual's
  // arrow along the biggest move, and the angle or size it names. With no drawing before, the thing as it was drawn
  // fades into the new shape.
  const reshapeDraw = (key, o, r) => {
    const u = ease.inOut(span(t, r.at + 0.3, r.at + r.len - 0.35)), s = sizeOf(key), an = o.anchor || [s.width / 2, s.height], alpha = o.alpha ?? 1;
    if (!r.pairs.length && !r.fadeOut.length && u < 1) plain(key, { ...o, still: true, alpha: alpha * (1 - u) });
    ctx.save(); ctx.translate(o.x, o.y); ctx.rotate(o.angle || 0); ctx.scale(o.scale || 1, o.scale || 1); ctx.translate(-an[0], -an[1]);
    const line = (pts, closed, fill, stroke, a) => {
      if (a <= 0.01) return;
      ctx.globalAlpha = alpha * a; ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); if (closed) ctx.closePath();
      const filled = fill && fill !== "none" && closed, stroked = stroke && stroke !== "none";
      if (filled) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroked && paleHere(stroke)) { ctx.strokeStyle = INK; ctx.lineWidth = r.lineWidth * 2.5; ctx.stroke(); }
      if (stroked) { ctx.strokeStyle = stroke; ctx.lineWidth = r.lineWidth; ctx.stroke(); }
      else if (filled && paleHere(fill)) { ctx.strokeStyle = INK; ctx.lineWidth = r.lineWidth; ctx.stroke(); }
    };
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    for (const f of r.fadeOut) line(f.pts, f.closed, f.fill, f.stroke, 1 - u);
    for (const p of r.pairs) line(p.a.map((q, i) => [lerp(q[0], p.b[i][0], u), lerp(q[1], p.b[i][1], u)]), p.closed,
      u < 0.5 ? (p.fill[0] && p.fill[0] !== "none" ? p.fill[0] : p.fill[1]) : p.fill[1], u < 0.5 ? (p.stroke[0] || p.stroke[1]) : p.stroke[1], 1);
    for (const f of r.fadeIn) line(f.pts, f.closed, f.fill, f.stroke, u);
    ctx.restore(); ctx.globalAlpha = 1;
    // the arrow (while it moves) and the label (as it arrives), in stage space
    if (o.still) return;
    const at = ([x, y]) => { const c = Math.cos(o.angle || 0), sn = Math.sin(o.angle || 0), k = o.scale || 1, dx = (x - an[0]) * k, dy = (y - an[1]) * k; return [o.x + c * dx - sn * dy, o.y + sn * dx + c * dy]; };
    const labelAlpha = span(t, r.at + r.len * 0.55, r.at + r.len * 0.75) * alpha;
    if (r.moved) {
      // a curved arrow from where the moving part starts to where it ends, bowed away from the thing's middle
      const [x0, y0] = at(r.moved.from), [x1, y1] = at(r.moved.to), [mx, my] = at([s.width / 2, s.height / 2]);
      const show = span(t, r.at, r.at + 0.3) * (1 - span(t, r.at + r.len - 0.5, r.at + r.len)), L = Math.hypot(x1 - x0, y1 - y0);
      if (show > 0.01 && L > 30) {
        let nx = -(y1 - y0) / L, ny = (x1 - x0) / L;
        if ((nx * ((x0 + x1) / 2 - mx) + ny * ((y0 + y1) / 2 - my)) < 0) { nx = -nx; ny = -ny; }
        const off = 30 + L * 0.25, cx = (x0 + x1) / 2 + nx * off, cy = (y0 + y1) / 2 + ny * off;
        const q = (u) => [(1 - u) * (1 - u) * x0 + 2 * (1 - u) * u * cx + u * u * x1 + nx * 18, (1 - u) * (1 - u) * y0 + 2 * (1 - u) * u * cy + u * u * y1 + ny * 18];
        const [ax, ay] = q(0.1), [bx, by] = q(0.86), [hx, hy] = q(0.8), head = Math.atan2(by - hy, bx - hx);
        ctx.save(); ctx.globalAlpha = show * alpha; ctx.strokeStyle = INK; ctx.fillStyle = INK; ctx.lineWidth = 6; ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(ax, ay); for (let i = 1; i <= 12; i++) ctx.lineTo(...q(0.1 + (0.76 * i) / 12)); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(bx + Math.cos(head) * 8, by + Math.sin(head) * 8);
        ctx.lineTo(bx - Math.cos(head - 0.5) * 24, by - Math.sin(head - 0.5) * 24); ctx.lineTo(bx - Math.cos(head + 0.5) * 24, by - Math.sin(head + 0.5) * 24); ctx.closePath(); ctx.fill();
        ctx.restore();
      }
      if (r.label) { const [nx, ny] = nxOf(x0, y0, x1, y1, mx, my); readableTag(r.label, x1 + nx * 60, y1 + ny * 60, labelAlpha); }
    } else if (r.label) { const [x, y] = at([s.width / 2, 0]); readableTag(r.label, x, y - 40, labelAlpha); }
  };
  // A folded sheet (fold.mjs, D.sheets): its facets in stack order, each in its front's or its back's colour, its
  // creases faint. While a fold runs, the flap turns about the fold line: foreshortened, edge-on half way, its other side
  // showing past that, lifted a little up the frame as it rises (its footprint a faint shadow under it); over the rest
  // (a valley fold) or under it (a mountain fold). First the manual's marks come in — the fold line dashed (valley) or
  // dash-dotted (mountain), the arrow from what moves to where it lands — then the fold, then a still beat on the
  // result. Turning over is the same turn about the middle, unlifted; a rotation turns it flat on the table.
  const FOLD_IN = 0.22, FOLD_DONE = 0.8;
  const darker = (c, k) => k <= 0.004 ? c : "#" + [1, 3, 5].map((i) => Math.round(parseInt(c.slice(i, i + 2), 16) * (1 - k)).toString(16).padStart(2, "0")).join("");
  // (an edge stroked whole is its corner's index; part of one, its two ends)
  const edgeOf = (x, e, map) => { const [a, b] = typeof e === "number" ? [x.p[e], x.p[(e + 1) % x.p.length]] : e; return map ? [map(a), map(b)] : [a, b]; };
  // A sheet's folds filled in again from the program's data, which carries nothing twice (engine.mjs: sheetsData).
  const sheetOf = (key) => {
    const S = D.sheets[key];
    if (!S.whole) {
      S.folds.forEach((f, i) => { if (!f.after) f.after = f.still; if (!f.moving) f.moving = i ? S.folds[i - 1].after : S.initial; });
      S.whole = true;
    }
    return S;
  };
  const facetPath = (c, pts) => { c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath(); };
  // (each facet filled, its seams with the layer beside it closed in its own colour, then only its real edges inked: a cut
  // splits a layer into pieces whose shared edges are not edges of the paper)
  const facetsDraw = (c, S, list, map, flipped, shade, k, alpha) => {
    for (const x of list) {
      const pts = map ? x.p.map(map) : x.p, fill = darker(x.b ^ flipped ? S.back : S.front, shade);
      facetPath(c, pts); c.fillStyle = fill; c.fill(); c.strokeStyle = fill; c.lineWidth = 1.2 / k; c.stroke();
      c.strokeStyle = INK; c.lineWidth = 2 / k; c.beginPath();
      for (const e of x.s) { const [p, q] = edgeOf(x, e, map); c.moveTo(p[0], p[1]); c.lineTo(q[0], q[1]); }
      c.stroke();
      if (x.l.length) {
        c.globalAlpha = alpha * 0.4; c.lineWidth = 1.4 / k; c.beginPath();
        for (const [a, b] of x.l) { const p = map ? map(a) : a, q = map ? map(b) : b; c.moveTo(p[0], p[1]); c.lineTo(q[0], q[1]); }
        c.stroke(); c.globalAlpha = alpha;
      }
    }
  };
  const cutLineDraw = (c, shape, k) => {
    c.strokeStyle = INK; c.lineWidth = 3 / k; c.setLineDash([10 / k, 7 / k]); facetPath(c, shape); c.stroke(); c.setLineDash([]);
  };
  const foldLineDraw = (c, line, mountain, k) => {
    const [[ax, ay], [bx, by]] = line, ex = (bx - ax) * 0.06, ey = (by - ay) * 0.06;
    c.strokeStyle = INK; c.lineWidth = 3 / k; c.setLineDash(mountain ? [16 / k, 7 / k, 3 / k, 7 / k] : [14 / k, 9 / k]);
    c.beginPath(); c.moveTo(ax - ex, ay - ey); c.lineTo(bx + ex, by + ey); c.stroke(); c.setLineDash([]);
  };
  // The manual's curved arrow, in stage space: from (x0, y0) to (x1, y1), bowed away from (mx, my).
  const bowArrow = (x0, y0, x1, y1, mx, my, alpha) => {
    const L = Math.hypot(x1 - x0, y1 - y0); if (alpha <= 0.01 || L < 30) return;
    const [nx, ny] = nxOf(x0, y0, x1, y1, mx, my), off = 30 + L * 0.25, cx = (x0 + x1) / 2 + nx * off, cy = (y0 + y1) / 2 + ny * off;
    const q = (u) => [(1 - u) * (1 - u) * x0 + 2 * (1 - u) * u * cx + u * u * x1, (1 - u) * (1 - u) * y0 + 2 * (1 - u) * u * cy + u * u * y1];
    const [bx, by] = q(0.9), [hx, hy] = q(0.84), head = Math.atan2(by - hy, bx - hx);
    ctx.save(); ctx.globalAlpha = alpha; ctx.strokeStyle = INK; ctx.fillStyle = INK; ctx.lineWidth = 6; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(...q(0.08)); for (let i = 1; i <= 12; i++) ctx.lineTo(...q(0.08 + (0.8 * i) / 12)); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(bx + Math.cos(head) * 8, by + Math.sin(head) * 8);
    ctx.lineTo(bx - Math.cos(head - 0.5) * 24, by - Math.sin(head - 0.5) * 24); ctx.lineTo(bx - Math.cos(head + 0.5) * 24, by - Math.sin(head + 0.5) * 24); ctx.closePath(); ctx.fill();
    ctx.restore();
  };
  // The manual's turn mark beside the sheet: a circling arrow (turned over, or round on the table).
  const turnMark = (x, y, alpha) => {
    if (alpha <= 0.01) return;
    ctx.save(); ctx.globalAlpha = alpha; ctx.strokeStyle = INK; ctx.fillStyle = INK; ctx.lineWidth = 6; ctx.lineCap = "round";
    ctx.beginPath(); ctx.arc(x, y, 34, -2.6, 1.9); ctx.stroke();
    const hx = x + 34 * Math.cos(1.9), hy = y + 34 * Math.sin(1.9), d = 1.9 + Math.PI / 2;
    ctx.beginPath(); ctx.moveTo(hx + Math.cos(d) * 10, hy + Math.sin(d) * 10); ctx.lineTo(hx + Math.cos(d + 2.6) * 20, hy + Math.sin(d + 2.6) * 20); ctx.lineTo(hx + Math.cos(d - 2.6) * 20, hy + Math.sin(d - 2.6) * 20); ctx.closePath(); ctx.fill();
    ctx.restore();
  };
  // One turn of a sheet, done to the fraction g (0 flat as it was, 1 done): flat round on the table (a rotation), or about
  // a line — the flap foreshortened, edge-on half way, its other side past that, lifted a little up the frame (its
  // footprint a faint shadow), over the rest (valley) or under it (mountain). An opening plays its folds' turns backwards.
  const turnDraw = (S, f, g, sc, alpha) => {
    if (f.kind === "rotate") {
      const a = (f.deg * Math.PI / 180) * g, c = Math.cos(a), sn = Math.sin(a), [cx, cy] = f.centre;
      facetsDraw(ctx, S, f.moving, (q) => [cx + c * (q[0] - cx) - sn * (q[1] - cy), cy + sn * (q[0] - cx) + c * (q[1] - cy)], 0, 0, sc, alpha);
      return;
    }
    const th = Math.PI * g, cs = Math.cos(th), sn = Math.sin(th), [px, py] = f.axis.p, [nx, ny] = f.axis.n, lift = f.kind === "over" ? 0 : f.mountain ? -0.22 : 0.22;
    const flat = (q) => { const d = (q[0] - px) * nx + (q[1] - py) * ny, k = d * (cs - 1); return [q[0] + nx * k, q[1] + ny * k]; };
    const hinge = (q) => { const d = (q[0] - px) * nx + (q[1] - py) * ny, k = d * (cs - 1); return [q[0] + nx * k, q[1] + ny * k - d * sn * lift]; };
    const flipped = cs < 0 ? 1 : 0, order = flipped ? [...f.moving].reverse() : f.moving;
    if (!f.mountain) facetsDraw(ctx, S, f.still, null, 0, 0, sc, alpha);
    if (!f.mountain && lift && sn > 0.05) {
      ctx.globalAlpha = alpha * 0.12 * sn; ctx.fillStyle = INK;
      for (const x of f.moving) { facetPath(ctx, x.p.map(flat)); ctx.fill(); }
      ctx.globalAlpha = alpha;
    }
    facetsDraw(ctx, S, order, hinge, flipped, 0.16 * Math.abs(sn), sc, alpha);
    if (f.mountain) facetsDraw(ctx, S, f.still, null, 0, 0, sc, alpha);
  };
  const flatPoint = (key, q, o) => {
    const S = D.sheets[key], s = sizeOf(key), an = o.anchor || [s.width / 2, s.height / 2], sc = o.scale || 1;
    const dx = (S.offset[0] + q[0] * S.unit - an[0]) * sc, dy = (S.offset[1] + q[1] * S.unit - an[1]) * sc, c = Math.cos(o.angle || 0), sn = Math.sin(o.angle || 0);
    return { x: o.x + c * dx - sn * dy, y: o.y + sn * dx + c * dy };
  };
  const sheetDraw = (key, o) => {
    const S = sheetOf(key), f = S.folds.find((x) => t >= x.at && t < x.at + x.len);
    let rest = S.initial;
    for (const x of S.folds) if (t >= x.at + x.len) rest = x.after;
    const s = sizeOf(key), an = o.anchor || [s.width / 2, s.height / 2], sc = o.scale || 1, alpha = o.alpha ?? 1, u = f ? (t - f.at) / f.len : 1;
    ctx.save(); ctx.globalAlpha = alpha; ctx.translate(o.x, o.y); ctx.rotate(o.angle || 0); ctx.scale(sc, sc); ctx.translate(-an[0], -an[1]);
    ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.setLineDash([]);
    const shown = !f || u >= FOLD_DONE ? (f ? f.after : rest) : [...f.still, ...f.moving];
    if (o.outline) { ctx.fillStyle = o.outline; for (const x of shown) { facetPath(ctx, x.p); ctx.fill(); } ctx.restore(); return; }
    if (ctx.mark) { const P = shown.flatMap((x) => x.p), x0 = Math.min(...P.map((q) => q[0])), y0 = Math.min(...P.map((q) => q[1])); ctx.mark(key, x0, y0, Math.max(...P.map((q) => q[0])) - x0, Math.max(...P.map((q) => q[1])) - y0); }
    const v = span(u, FOLD_IN, FOLD_DONE);
    if (!f || u >= FOLD_DONE) facetsDraw(ctx, S, shown, null, 0, 0, sc, alpha);
    else if (f.kind === "cut") {
      // what the cut takes out of every layer drops away and fades
      facetsDraw(ctx, S, f.still, null, 0, 0, sc, alpha);
      const e = ease.in(v), drop = (q) => [q[0], q[1] + (90 / sc) * e];
      if (e < 0.99) { ctx.globalAlpha = alpha * (1 - e); facetsDraw(ctx, S, f.moving, drop, 0, 0, sc, alpha * (1 - e)); ctx.globalAlpha = alpha; }
    } else if (f.kind === "spread") {
      // every fold since it was flat turned back, last first, one after another
      const n = f.subs.length, i = Math.min(n - 1, Math.floor(v * n)), w = v * n - i;
      turnDraw(S, f.subs[i], 1 - ease.inOut(w), sc, alpha);
    } else turnDraw(S, f, f.kind === "unfold" ? 0.92 * Math.sin(Math.PI * v) : ease.inOut(v), sc, alpha);
    const marks = f ? span(u, 0.02, FOLD_IN * 0.8) * (1 - span(u, FOLD_DONE - 0.04, FOLD_DONE + 0.06)) : 0;
    if (f && f.line && marks > 0.01 && !o.still) { ctx.globalAlpha = alpha * marks; foldLineDraw(ctx, f.line, f.mountain, sc); ctx.globalAlpha = alpha; }
    if (f && f.shape && !o.still) { const m2 = span(u, 0.02, FOLD_IN * 0.8) * (1 - span(u, FOLD_IN + 0.1, FOLD_IN + 0.25)); if (m2 > 0.01) { ctx.globalAlpha = alpha * m2; cutLineDraw(ctx, f.shape, sc); ctx.globalAlpha = alpha; } }
    // Path work leaves a persistent line on both declared actors. Stitching is dashed; marking/gluing is solid.
    if (!o.still) for (const a of D.acts) {
      const path = a.k === key ? a.path : a.to === key ? a.otherPath : null;
      if (!path || t < a.at) continue;
      const progress = span(t, a.at + a.len * 0.22, a.at + a.len * 0.88), end = pointAlong(path, progress);
      const lengths = path.slice(1).map((q, i) => Math.hypot(q[0] - path[i][0], q[1] - path[i][1]));
      const total = lengths.reduce((x, y) => x + y, 0); let passed = 0;
      const Q = (q) => [S.offset[0] + q[0] * S.unit, S.offset[1] + q[1] * S.unit];
      ctx.strokeStyle = INK; ctx.lineWidth = 2 / sc; ctx.setLineDash(a.intent === "stitch" ? [5 / sc, 4 / sc] : []);
      ctx.beginPath(); ctx.moveTo(...Q(path[0]));
      for (let j = 0; j < lengths.length; j++) { passed += lengths[j]; if (passed > total * progress) break; ctx.lineTo(...Q(path[j + 1])); }
      ctx.lineTo(...Q(end)); ctx.stroke(); ctx.setLineDash([]);
    }
    // (lit along its real edges only: its outline and its cuts, not the seams between pieces of one layer)
    if (o.highlight) { ctx.globalAlpha = alpha * o.highlight; ctx.strokeStyle = ACCENT; ctx.lineWidth = 7 / sc; ctx.beginPath(); for (const x of shown) for (const e of x.s) { const [a, b] = edgeOf(x, e); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); } ctx.stroke(); }
    ctx.restore(); ctx.globalAlpha = 1;
    if (!f || o.still) return;
    // the arrow (while it is announced and folds) and the label (as it lands), in stage space
    const at = (q) => { const c = Math.cos(o.angle || 0), sn = Math.sin(o.angle || 0), dx = (q[0] - an[0]) * sc, dy = (q[1] - an[1]) * sc; return [o.x + c * dx - sn * dy, o.y + sn * dx + c * dy]; };
    const P = f.after.flatMap((x) => x.p), x0 = Math.min(...P.map((q) => q[0])), x1 = Math.max(...P.map((q) => q[0])), y0 = Math.min(...P.map((q) => q[1])), y1 = Math.max(...P.map((q) => q[1]));
    const [mx, my] = at([(x0 + x1) / 2, (y0 + y1) / 2]), labelAlpha = span(u, 0.55, 0.7) * alpha;
    if (f.kind === "cut" || f.kind === "spread") {
      const word = f.label || (f.kind === "spread" ? "unfold" : "");
      if (word) { const [rx, ry] = at([x1, y0]); readableTag(word, rx + 60, ry + 20, span(u, 0.05, FOLD_IN) * alpha); }
    } else if (f.from && f.to) {
      const [ax, ay] = at(f.from), [bx, by] = at(f.to);
      bowArrow(ax, ay, bx, by, mx, my, marks * alpha);
      if (f.label) { const [nx, ny] = nxOf(ax, ay, bx, by, mx, my); readableTag(f.label, bx + nx * 60, by + ny * 60, labelAlpha); }
    } else {
      const [rx, ry] = at([x1, (y0 + y1) / 2]);
      turnMark(rx + 70, ry, marks * alpha);
      const word = f.label || (f.kind === "over" ? "turn over" : Math.round(Math.abs(f.deg)) + "°");
      readableTag(word, rx + 70, ry + 70, span(u, 0.05, FOLD_IN) * alpha);
    }
  };
  // The engine's panel of a step of folds (in the card's 400 × 400): the sheet before, its fold lines marked; the
  // manual's arrow down; the sheet after, coming in as the folds run. The solver's facets, so the card and the stage agree.
  const foldPanel = (c, F, p) => {
    const S = sheetOf(F.k), state = (i) => (i < 0 ? S.initial : S.folds[i].after);
    const fit = (list, y0, y1, alpha, lines) => {
      if (alpha <= 0.01) return;
      const P = list.flatMap((x) => x.p), a = Math.min(...P.map((q) => q[0])), b = Math.min(...P.map((q) => q[1])), cc = Math.max(...P.map((q) => q[0])), d = Math.max(...P.map((q) => q[1]));
      const k = Math.min(340 / Math.max(1, cc - a), (y1 - y0) / Math.max(1, d - b));
      c.save(); c.globalAlpha = alpha; c.translate(200 - ((a + cc) / 2) * k, (y0 + y1) / 2 - ((b + d) / 2) * k); c.scale(k, k); c.lineJoin = "round"; c.lineCap = "round";
      facetsDraw(c, S, list, null, 0, 0, k, alpha);
      for (const L of (lines && lines.folds) || []) foldLineDraw(c, L.line, L.mountain, k * 0.75);
      for (const C of (lines && lines.cuts) || []) cutLineDraw(c, C, k * 0.75);
      c.restore();
    };
    fit(state(F.before), 14, 150, 1, { folds: F.lines, cuts: F.cuts });
    const g = span(p, 0.1, 0.45);
    if (g > 0.01) {
      c.save(); c.globalAlpha = g; c.strokeStyle = INK; c.fillStyle = INK; c.lineWidth = 6; c.lineCap = "round";
      c.beginPath(); c.moveTo(200, 168); c.lineTo(200, 210); c.stroke();
      c.beginPath(); c.moveTo(200, 232); c.lineTo(186, 206); c.lineTo(214, 206); c.closePath(); c.fill();
      c.restore();
    }
    fit(state(F.after), 248, 390, span(p, 0.35, 0.8), null);
  };
  // The engine's panel of a reshape (in the card's 400 × 400): the thing before, above; the manual's arrow down, with
  // the label; the thing after, below, coming in as the move runs. The same drawings as the stage, so the two agree.
  const reshapePanel = (c, r, p) => {
    const before = [...r.pairs.map((x) => ({ pts: x.a, closed: x.closed, fill: x.fill[0], stroke: x.stroke[0] })), ...r.fadeOut];
    const after = [...r.pairs.map((x) => ({ pts: x.b, closed: x.closed, fill: x.fill[1], stroke: x.stroke[1] })), ...r.fadeIn];
    const box = (lines) => { const q = lines.flatMap((l) => l.pts); return [Math.min(...q.map((v) => v[0])), Math.min(...q.map((v) => v[1])), Math.max(...q.map((v) => v[0])), Math.max(...q.map((v) => v[1]))]; };
    const fit = (lines, y0, y1, alpha) => {
      if (!lines.length || alpha <= 0.01) return;
      const [a, b, cc, d] = box(lines), k = Math.min(340 / Math.max(1, cc - a), (y1 - y0) / Math.max(1, d - b));
      c.save(); c.globalAlpha = alpha; c.translate(200 - ((a + cc) / 2) * k, (y0 + y1) / 2 - ((b + d) / 2) * k); c.scale(k, k);
      c.lineJoin = "round"; c.lineCap = "round";
      for (const l of lines) {
        c.beginPath(); l.pts.forEach(([x, y], j) => (j ? c.lineTo(x, y) : c.moveTo(x, y))); if (l.closed) c.closePath();
        const filled = l.fill && l.fill !== "none" && l.closed, stroked = l.stroke && l.stroke !== "none";
        if (filled) { c.fillStyle = l.fill; c.fill(); }
        if (stroked && paleHere(l.stroke)) { c.strokeStyle = INK; c.lineWidth = 7 / k; c.stroke(); }
        if (stroked) { c.strokeStyle = l.stroke; c.lineWidth = 3.5 / k; c.stroke(); }
        if (!stroked || (filled && paleHere(l.fill))) { c.strokeStyle = INK; c.lineWidth = 2 / k; c.stroke(); }
      }
      c.restore();
    };
    fit(before, 14, 150, 1);
    const g = span(p, 0.1, 0.45);
    if (g > 0.01) {
      c.save(); c.globalAlpha = g; c.strokeStyle = INK; c.fillStyle = INK; c.lineWidth = 6; c.lineCap = "round";
      c.beginPath(); c.moveTo(200, 168); c.lineTo(200, 210); c.stroke();
      c.beginPath(); c.moveTo(200, 232); c.lineTo(186, 206); c.lineTo(214, 206); c.closePath(); c.fill();
      if (r.label) { c.font = "700 24px " + env.mono; c.textAlign = "left"; c.textBaseline = "middle"; c.fillText(r.label, 228, 200); c.textBaseline = "alphabetic"; }
      c.restore();
    }
    fit(after, 248, 390, span(p, 0.35, 0.8));
  };
  // Strands (strand.mjs, D.strands): a wire, rope or ribbon drawn as a tube from its heading profile. The profile of one state
  // blends into the next (a bend swings its far part round, a coil winds up) about the node the operation holds still, so the
  // strand keeps its length throughout. The passes a knot or loop takes over are drawn again over the rest; beads ride on it;
  // a twisted cord is its two strands seen from above. First the manual's marks (the strand as it was, dashed; the arrow
  // from where the free end was to where it lands), then the move, then a still beat on the result.
  const SK = (${strandKit.toString()})();
  const lighter = (c, k) => "#" + [1, 3, 5].map((i) => { const v = parseInt(c.slice(i, i + 2), 16); return Math.round(v + (255 - v) * k).toString(16).padStart(2, "0"); }).join("");
  // (the strand's nodes for a blend of state a into state b, done to the fraction v, about its hold [s, x, y])
  const strandNodes = (S, a, b, hold, v, hold0) => SK.nodes(S.L, S.N, S.states[a].k, S.states[b].k, v, hold[0],
    hold0 ? hold0[1] + (hold[1] - hold0[1]) * v : hold[1], hold0 ? hold0[2] + (hold[2] - hold0[2]) * v : hold[2]);
  const tube = (c, nd, i0, i1, W, fill, sc, cap) => {
    const trace = () => { c.beginPath(); c.moveTo(nd.x[i0], nd.y[i0]); for (let i = i0 + 1; i <= i1; i++) c.lineTo(nd.x[i], nd.y[i]); };
    c.lineCap = cap; c.lineJoin = "round";
    trace(); c.strokeStyle = INK; c.lineWidth = W + 4 / sc; c.stroke();
    trace(); c.strokeStyle = fill; c.lineWidth = W; c.stroke();
    trace(); c.strokeStyle = lighter(fill, 0.45); c.lineWidth = Math.max(1 / sc, W * 0.26); c.stroke();
  };
  // A twisted cord: two strands round each other along its middle line, each crossing the other in turn, closed by the cap
  // of the fold at its start.
  const cordDraw = (c, nd, tw, fill, sc) => {
    const n = nd.x.length - 1, amp = tw.w / 2, A = { x: [], y: [] }, B = { x: [], y: [] };
    for (let i = 0; i <= n; i++) {
      const h = nd.h[Math.min(n - 1, i)], nx = -Math.sin(h), ny = Math.cos(h), off = amp * Math.cos(Math.PI * 2 * tw.n * (i / n));
      A.x.push(nd.x[i] + nx * off); A.y.push(nd.y[i] + ny * off); B.x.push(nd.x[i] - nx * off); B.y.push(nd.y[i] - ny * off);
    }
    const h0 = nd.h[0];
    c.lineCap = "round"; c.beginPath(); c.arc(nd.x[0], nd.y[0], amp, h0 + Math.PI / 2, h0 + Math.PI * 1.5);
    c.strokeStyle = INK; c.lineWidth = tw.w + 4 / sc; c.stroke(); c.strokeStyle = fill; c.lineWidth = tw.w; c.stroke();
    tube(c, B, 0, n, tw.w, darker(fill, 0.1), sc, "round");
    tube(c, A, 0, n, tw.w, fill, sc, "round");
    // each crossing of the pair: the strand that is over drawn again across it
    const per = Math.max(1, Math.round(tw.w * 0.7 / (tw.c / Math.max(1, n))));
    for (let k = 0; k < 2 * tw.n; k++) {
      const m = Math.round(n * (0.25 + 0.5 * k) / tw.n), i0 = Math.max(0, m - per), i1 = Math.min(n, m + per);
      if (m > n || i1 <= i0) continue;
      if (k % 2) tube(c, B, i0, i1, tw.w, darker(fill, 0.1), sc, "butt"); else tube(c, A, i0, i1, tw.w, fill, sc, "butt");
    }
  };
  // The strand, as it lies: its nodes nd in state st (S.states[st]), seen at the fraction v of its way into it (beads
  // still to come aside). Used by the stage and by the panel's cards.
  const strandShape = (c, S, st, nd, sc, fresh) => {
    const X = S.states[st], n = nd.x.length - 1;
    if (X.twist) cordDraw(c, nd, X.twist, S.fill, sc);
    else {
      tube(c, nd, 0, n, S.W, S.fill, sc, "round");
      for (const [s0, s1] of X.over) tube(c, nd, Math.max(0, Math.floor(s0 / nd.ds)), Math.min(n, Math.ceil(s1 / nd.ds)), S.W, S.fill, sc, "butt");
    }
    if (X.join != null) {
      const i = Math.min(n - 1, Math.round(X.join / nd.ds)), h = nd.h[i], dx = -Math.sin(h) * S.W * 0.95, dy = Math.cos(h) * S.W * 0.95;
      c.lineCap = "butt"; c.beginPath(); c.moveTo(nd.x[i] - dx, nd.y[i] - dy); c.lineTo(nd.x[i] + dx, nd.y[i] + dy);
      c.strokeStyle = INK; c.lineWidth = S.W * 0.7 + 4 / sc; c.stroke(); c.strokeStyle = "#d7dbe2"; c.lineWidth = S.W * 0.7; c.stroke();
    }
    for (const [s0, r, col, a] of fresh || X.beads) {
      const i = Math.max(0, Math.min(n, Math.round(s0 / nd.ds))), al = a == null ? 1 : a;
      if (al <= 0.01) continue;
      c.globalAlpha *= al; c.beginPath(); c.arc(nd.x[i], nd.y[i], r, 0, Math.PI * 2); c.fillStyle = col; c.fill(); c.strokeStyle = INK; c.lineWidth = 2 / sc; c.stroke();
      c.beginPath(); c.arc(nd.x[i] - r * 0.3, nd.y[i] - r * 0.3, r * 0.3, 0, Math.PI * 2); c.fillStyle = "rgba(255,255,255,0.55)"; c.fill(); c.globalAlpha /= al;
    }
  };
  // The strand's state at time t: the operation running (if one is), else the state the last finished one left.
  const strandAt = (S) => {
    let run = null, rest = 0;
    for (const o of S.ops) { if (t >= o.at + o.len) rest = o.state; else if (t >= o.at) run = o; }
    return { run, rest };
  };
  // Shared by contact sites and the strand drawing, once per strand per frame.
  const strandWorkCache = new Map();
  const strandWorkNodes = (key) => {
    if (strandWorkCache.has(key)) return strandWorkCache.get(key);
    const S = D.strands[key], { run, rest } = strandAt(S), u = run ? (t - run.at) / run.len : 1, v = run ? ease.inOut(span(u, 0.22, 0.86)) : 1;
    const nd = run ? strandNodes(S, run.from, run.state, run.hold, v, run.hold0) : strandNodes(S, rest, rest, S.anchors[rest], 1);
    strandWorkCache.set(key, nd); return nd;
  };
  // The twist as it is done: the cord grows from the fold, its twisted length c·v long with n·v turns, the halves not yet
  // twisted running straight on from its end, the way they lay, shorter by what the twisting took up.
  const twistRun = (c, S, o, v, sc) => {
    const tw = o.twist, amp = S.W / 2, cl = tw.c * v, dir = tw.dir, cx = Math.cos(dir), cy = Math.sin(dir), m = 48, nd = { x: [], y: [], h: new Array(m).fill(dir), ds: 1 };
    for (let i = 0; i <= m; i++) { nd.x.push(tw.tip[0] + cx * cl * i / m); nd.y.push(tw.tip[1] + cy * cl * i / m); }
    const rest = (1 - v) * tw.ell, ex = tw.tip[0] + cx * cl, ey = tw.tip[1] + cy * cl, nx = -cy * amp, ny = cx * amp;
    if (rest > 0.5) for (const sign of [-1, 1]) {
      const e = { x: [ex + sign * nx, ex + sign * nx + cx * rest], y: [ey + sign * ny, ey + sign * ny + cy * rest] };
      tube(c, e, 0, 1, S.W, S.fill, sc, "round");
    }
    if (v > 0.02) cordDraw(c, nd, { n: Math.max(0.01, tw.n * v), w: S.W, c: cl }, S.fill, sc);
    else { c.beginPath(); c.arc(tw.tip[0], tw.tip[1], amp, dir + Math.PI / 2, dir + Math.PI * 1.5); c.strokeStyle = INK; c.lineWidth = S.W + 4 / sc; c.stroke(); c.strokeStyle = S.fill; c.lineWidth = S.W; c.stroke(); }
  };
  const strandDraw = (key, o) => {
    const S = D.strands[key], { run, rest } = strandAt(S), sc = o.scale || 1, alpha = o.alpha ?? 1, sz = sizeOf(key), an = o.anchor || [sz.width / 2, sz.height / 2];
    const u = run ? (t - run.at) / run.len : 1, v = run ? ease.inOut(span(u, 0.22, 0.86)) : 1;
    // (a cord's making draws itself: no blend of one profile into another)
    const making = run && run.cord;
    const nd = making ? null : strandWorkNodes(key);
    const st = run ? (v > 0.5 ? run.state : run.from) : rest;
    ctx.save(); ctx.globalAlpha = alpha; ctx.translate(o.x, o.y); ctx.rotate(o.angle || 0); ctx.scale(sc, sc); ctx.translate(-an[0], -an[1]);
    ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.setLineDash([]);
    if (o.outline && nd) { tube(ctx, nd, 0, nd.x.length - 1, S.W, o.outline, sc, "round"); ctx.restore(); return; }
    let box = null;
    if (making) {
      if (u < 0.22) { const n0 = strandNodes(S, run.from, run.from, S.anchors[run.from], 1); tube(ctx, n0, 0, n0.x.length - 1, S.W, S.fill, sc, "round"); box = n0; }
      else twistRun(ctx, S, run, v, sc);
      if (!box) box = strandNodes(S, run.state, run.state, S.anchors[run.state], 1);
    } else {
      // the strand as it was, dashed, while the move is announced
      if (run && u < 0.4 && !o.still) {
        const n0 = strandNodes(S, run.from, run.from, run.hold0, 1), g = 0.45 * (1 - span(u, 0.22, 0.4));
        ctx.globalAlpha = alpha * g; ctx.setLineDash([10 / sc, 8 / sc]); ctx.strokeStyle = INK; ctx.lineWidth = 2.4 / sc; ctx.beginPath();
        n0.x.forEach((x, i) => (i ? ctx.lineTo(x, n0.y[i]) : ctx.moveTo(x, n0.y[i]))); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = alpha;
      }
      // beads being threaded slide in from the strand's far end, the one furthest along first
      let fresh = null;
      if (run && run.kind === "thread") {
        const had = S.states[run.from].beads, all = S.states[run.state].beads, news = all.filter((b) => !had.some((x) => x[0] === b[0]));
        const order = news.map((b) => b[0]).sort((a, b) => b - a);
        fresh = all.map((b) => {
          const r = order.indexOf(b[0]); if (r < 0) return b;
          const f = ease.inOut(span(u, 0.1 + r * 0.6 / Math.max(1, news.length), 0.3 + r * 0.6 / Math.max(1, news.length)));
          return [S.L + (b[0] - S.L) * f, b[1], b[2], Math.min(1, f * 4)];
        });
      }
      strandShape(ctx, S, st, nd, sc, fresh);
      box = nd;
    }
    if (ctx.mark) { const x0 = Math.min(...box.x), y0 = Math.min(...box.y); ctx.mark(key, x0, y0, Math.max(...box.x) - x0, Math.max(...box.y) - y0); }
    if (o.highlight) { ctx.globalAlpha = alpha * o.highlight; ctx.strokeStyle = ACCENT; ctx.lineWidth = S.W + 7 / sc; ctx.beginPath(); box.x.forEach((x, i) => (i ? ctx.lineTo(x, box.y[i]) : ctx.moveTo(x, box.y[i]))); ctx.stroke(); }
    ctx.restore(); ctx.globalAlpha = 1;
    // (a strand just laid down says how long it is, the way a manual dimensions its first picture)
    if (!run && !o.still && !o.asPhoto && rest === 0 && S.placed != null && S.cm) {
      const until = Math.min(S.ops.length ? S.ops[0].at : 1e9, S.placed + 4), g = span(t, S.placed + 0.3, S.placed + 0.8) * (1 - span(t, until - 0.4, until));
      if (g > 0.01) {
        const q = (x, y) => { const c = Math.cos(o.angle || 0), sn = Math.sin(o.angle || 0), dx = (x - an[0]) * sc, dy = (y - an[1]) * sc; return [o.x + c * dx - sn * dy, o.y + sn * dx + c * dy]; };
        const [lx, ly] = q((Math.min(...box.x) + Math.max(...box.x)) / 2, Math.min(...box.y) - S.W * 3);
        readableTag(S.cm + " cm", lx, ly, g * alpha);
      }
    }
    if (!run || o.still) return;
    // the arrow (a bend: from where its free end was to where it lands) and the label, in stage space
    const q = (x, y) => { const c = Math.cos(o.angle || 0), sn = Math.sin(o.angle || 0), dx = (x - an[0]) * sc, dy = (y - an[1]) * sc; return [o.x + c * dx - sn * dy, o.y + sn * dx + c * dy]; };
    const end = strandNodes(S, run.state, run.state, run.hold, 1), m = Math.min(end.x.length - 1, Math.max(0, Math.round(run.mark / end.ds)));
    const marks = span(u, 0.02, 0.2) * (1 - span(u, 0.8, 0.92)), [px, py] = q(end.x[m], end.y[m]);
    if (run.kind === "bend" && marks > 0.01) {
      const free = run.hold[0] < S.L / 2 ? end.x.length - 1 : 0, was = strandNodes(S, run.from, run.from, run.hold0, 1);
      const [ax, ay] = q(was.x[free], was.y[free]), [bx, by] = q(end.x[free], end.y[free]);
      bowArrow(ax, ay, bx, by, px, py, marks * alpha);
    }
    // (what the operation did, as the caption gives it: the angle and the length that moves, the turns and what they take, the
    // overlap, the beads — the plan's own label first)
    const num = (v) => String(Math.round(v * 10) / 10);
    const items = { bend: [run.angle ? Math.round(run.angle) + "°" : "", run.dist ? num(run.dist) + " cm" : ""],
      coil: [run.wound ? num(run.wound) + " cm" : "", run.turns ? "about " + Math.round(run.turns * 2) / 2 + " turns" : ""],
      ring: [run.overlap != null ? num(run.overlap) + " cm overlap" : "", run.circumference ? num(run.circumference) + " cm round" : ""],
      knot: [run.knot ? run.knot + " knot" : ""], twist: [run.turns ? run.turns + " twists" : ""], thread: [run.fresh ? run.fresh + " beads" : "", run.bead ? num(run.bead) + " cm" : ""] };
    const word = [run.label, ...(items[run.kind] || [])].filter((x, i, all) => x && all.indexOf(x) === i).join(" · ");
    if (word) readableTag(word, px + 70, py - 60, span(u, 0.5, 0.65) * alpha);
  };
  // The engine's panel of a step of strand operations (in the card's 400 × 400): the strand before, an arrow, the strand after.
  const strandPanel = (c, F, p) => {
    const S = D.strands[F.k];
    const fit = (st, y0, y1, alpha) => {
      if (alpha <= 0.01) return;
      const nd = strandNodes(S, st, st, S.anchors[st], 1), pad = S.W * 1.5;
      const a = Math.min(...nd.x) - pad, b = Math.min(...nd.y) - pad, cc = Math.max(...nd.x) + pad, d = Math.max(...nd.y) + pad, k = Math.min(340 / Math.max(1, cc - a), (y1 - y0) / Math.max(1, d - b));
      c.save(); c.globalAlpha = alpha; c.translate(200 - ((a + cc) / 2) * k, (y0 + y1) / 2 - ((b + d) / 2) * k); c.scale(k, k); c.lineJoin = "round"; c.lineCap = "round";
      strandShape(c, S, st, nd, k, null);
      c.restore();
    };
    fit(F.before, 14, 150, 1);
    const g = span(p, 0.1, 0.45);
    if (g > 0.01) {
      c.save(); c.globalAlpha = g; c.strokeStyle = INK; c.fillStyle = INK; c.lineWidth = 6; c.lineCap = "round";
      c.beginPath(); c.moveTo(200, 168); c.lineTo(200, 210); c.stroke();
      c.beginPath(); c.moveTo(184, 204); c.lineTo(200, 224); c.lineTo(216, 204); c.closePath(); c.fill(); c.restore();
    }
    fit(F.after, 248, 390, span(p, 0.35, 0.8));
  };
  // (the unit normal of a move, turned away from the thing's middle: where its arrow bows and its label sits)
  const nxOf = (x0, y0, x1, y1, mx, my) => {
    const L = Math.hypot(x1 - x0, y1 - y0) || 1; let nx = -(y1 - y0) / L, ny = (x1 - x0) / L;
    if ((nx * ((x0 + x1) / 2 - mx) + ny * ((y0 + y1) / 2 - my)) < 0) { nx = -nx; ny = -ny; }
    return [nx, ny];
  };
  // (the camera's zoom while the steps draw: a reshape's label is sized to stay readable on the frame)
  let stageZoom = 1;
  const readableTag = (label, x, y, alpha) => { const size = Math.max(22, Math.ceil(17 / stageZoom)); tag(label, x, y, { size, h: size + 8, alpha }); };
  const reshaping = (key) => D.reshapes.find((r) => r.k === key && t >= r.at && t < r.at + r.len);
  const plain = (key, o) => !o.asPhoto && !o.still && reshaping(key) ? reshapeDraw(key, o, reshaping(key))
    : !o.asPhoto && D.appearances[key] && D.appearances[key][stateNow[key]] && (!D.sheets[key] || D.stateEvents.some((a) => t >= a.at && a.effects.some((e) => e.k === key) && !D.sheets[key].folds.some((f) => t >= f.at && f.at >= a.at))) ? stateDraw(key, o)
    : !o.asPhoto && D.sheets[key] ? sheetDraw(key, o)
    : !o.asPhoto && D.strands[key] ? strandDraw(key, o)
    : D.piece[key] ? piece(key, o) : D.boards[key] && !o.asPhoto ? boardOf(key, o)
    : D.upgrade[key] != null && t >= D.upgrade[key] ? upgraded(key, o)
    : named(key, o, objects.draw(ctx, key, D.cutOut[key] ? { ...o, photo: 1, reveal: 0, fill: 0 } : o));
  // Its name on its label face, turned and scaled with it (not in the tray, where it would be too small to read).
  const named = (key, o) => {
    const L = D.named[key]; if (!L || o.asPhoto) return;
    const sc = o.scale || 1, size = fit(L.text, Math.min(L.h * sc, 40), "800", L.w * sc); if (size < 14) return;
    const c = objects.point(key, [L.x + L.w / 2, L.y], o);
    ctx.save(); ctx.globalAlpha = o.alpha ?? 1; ctx.translate(c.x, c.y); ctx.rotate(o.angle || 0);
    text(L.text, 0, size * 0.36, size, "800", L.color, "center"); ctx.restore();
  };
  // A thing whose model drawing has come in (its tracing was the stand-in): the tracing cross-fades into it in 0.6 s.
  // Both are drawn in the same box, so nothing moves.
  const upgraded = (key, o) => {
    const f = span(t, D.upgrade[key], D.upgrade[key] + 0.6), a = o.alpha ?? 1;
    if (f < 1) objects.draw(ctx, key, { ...o, ...(D.cutOut[key] ? { photo: 1, reveal: 0, fill: 0 } : {}), alpha: a * (1 - f) });
    return objects.draw(ctx, key + "@drawn", { ...o, alpha: a * f });
  };
  // A tool held with its working end at (x, y), turned by angle: the photo's own tool or one drawn from tools.mjs.
  const toolAt = (key, x, y, angle, scale) => {
    if (!key || !D.poses[key]) return;
    const tip = D.tips[key] || D.toolTip[key] || [0, sizeOf(key).height / 2];
    plain(key, { x, y, scale: scale || D.poses[key].scale, angle, anchor: tip });
  };
  // A thing cut into pieces: what is inside shows (its wrapper, a photo's packaging, gives way to a plain block of its
  // colour), the knife goes along it and each stretch it has passed is pieces — cubes, slices, bits, wedges or
  // strips — laid where the block was. left (0..1) is how much of the heap is still there (a sprinkle takes it).
  const chopped = (key, o, left) => {
    const c = D.chop[key], s = sizeOf(key), sc = o.scale || 1, alpha = o.alpha ?? 1;
    // (what is cut rests where it stands: on the board, not at the middle of the bag it came in)
    const unwrap = span(t, c.at, c.at + 0.35), pointed = objects.point(key, [s.width / 2, s.height / 2], o);
    if (unwrap < 1) { ctx.save(); ctx.globalAlpha = alpha * (1 - unwrap); plain(key, o); ctx.restore(); }
    const flat = c.kind === "slices" || c.kind === "strips" || c.kind === "wedges", cols = flat ? 6 : c.kind === "bits" ? 5 : 4, rows = flat ? 1 : 3;
    const bw = c.slot ? Math.min(c.slot * 0.92, 300) : Math.max(90, Math.min(s.width * sc * 0.85, 300));
    let bh = Math.max(50, Math.min(s.height * sc * 0.5, bw * 0.55));
    // (slices stand as rounds, not long thin ovals, however wide the block)
    if (flat) bh = Math.min(bh, (bw / cols) * 1.7);
    // (pieces sharing a board lie in a low mound, close together, not a wall of rows)
    else if (c.slot) bh = Math.min(bh, bw * 0.36);
    const gap = c.slot ? 2 : 8;
    const mid = { x: pointed.x, y: (o.y ?? pointed.y + bh / 2) - bh / 2 };
    const x0 = mid.x - bw / 2, y0 = mid.y - bh / 2, along = span(t, c.at + 0.35, c.at + c.len * 0.85);
    // Cut pieces retain their arrangement when their holder rotates.
    ctx.save(); ctx.translate(mid.x, mid.y); ctx.rotate(o.angle || 0); ctx.translate(-mid.x, -mid.y);
    const cw = bw / cols, ch = bh / rows, total = cols * rows, keep = Math.ceil(total * (left == null ? 1 : left) - 1e-6);
    ctx.save(); ctx.globalAlpha = alpha * unwrap; ctx.lineWidth = 2; ctx.strokeStyle = INK; ctx.lineJoin = "round";
    // The part the knife has not reached yet: one block.
    const cutCols = Math.min(cols, Math.floor(along * cols + 1e-6));
    if (cutCols < cols) { ctx.fillStyle = c.color; ctx.fillRect(x0 + cutCols * cw, y0, (cols - cutCols) * cw, bh); ctx.strokeRect(x0 + cutCols * cw, y0, (cols - cutCols) * cw, bh); }
    // The pieces cut off so far, each springing a little apart from its neighbours.
    let n = 0;
    for (let i = 0; i < cutCols; i++) for (let j = 0; j < rows; j++) {
      if (n++ >= keep) continue;
      const pop = kit.spring(span(t, c.at + 0.35 + (c.len * 0.5) * (i + 1) / cols, c.at + 0.35 + (c.len * 0.5) * (i + 1) / cols + 0.35), { bounce: 0.35 });
      const r = env.random(i * 7 + j), mound = c.slot && !flat ? 0.62 + 0.19 * j : 1;
      const cx = mid.x + (x0 + (i + 0.5) * cw + (i - (cols - 1) / 2) * gap * pop + (r - 0.5) * 6 - mid.x) * mound, cy = y0 + (j + 0.5) * ch + (j - (rows - 1) / 2) * gap * pop;
      ctx.save(); ctx.translate(cx, cy); ctx.rotate((r - 0.5) * 0.5 * pop); ctx.fillStyle = c.color; ctx.beginPath();
      if (c.kind === "slices") ctx.ellipse(0, 0, cw * 0.3, ch * 0.42, 0, 0, Math.PI * 2);
      else if (c.kind === "wedges") { ctx.moveTo(-cw * 0.4, ch * 0.4); ctx.lineTo(cw * 0.4, ch * 0.4); ctx.lineTo(0, -ch * 0.42); ctx.closePath(); }
      else if (c.kind === "bits") ctx.ellipse(0, 0, cw * 0.42, ch * (c.slot ? 0.5 : 0.3), r * 3, 0, Math.PI * 2);
      else if (c.kind === "strips") ctx.rect(-cw * 0.22, -ch * 0.45, cw * 0.44, ch * 0.9);
      else ctx.roundRect(-cw * 0.4, -ch * 0.4, cw * 0.8, ch * 0.8, 4);
      ctx.fill(); ctx.stroke();
      // A cube's lit upper face.
      if (c.kind === "cubes") { ctx.fillStyle = "rgba(255,255,255,0.35)"; ctx.fillRect(-cw * 0.4 + 2, -ch * 0.4 + 2, cw * 0.8 - 4, ch * 0.22); }
      ctx.restore();
    }
    ctx.restore();
    ctx.restore();
    // The knife, coming down through the block at the cut it is making and lifting before the next (a cut is a press
    // down through it, not a saw back and forth over it), held no longer than the block's width and a third.
    if (c.with && t < c.at + c.len && D.poses[c.with]) {
      const cut = Math.min(cols - 1, Math.floor(along * cols)), q = along * cols - cut, down = q < 0.6 ? ease.inOut(q / 0.6) : 1 - ease.inOut((q - 0.6) / 0.4);
      const ks = sizeOf(c.with), scale = Math.min(D.poses[c.with].scale, bw * 1.3 / Math.max(ks.width, ks.height));
      toolAt(c.with, x0 + cw * (cut + 1), y0 - 34 + (bh + 34) * (along >= 1 ? 0 : down), -0.35, scale);
    }
    // How much (its label: "100 g"), over it while it is cut.
    if (c.label && t < c.at + c.len) tag(c.label, mid.x, y0 - 90, { size: 22, h: 30 });
  };
  // A strand snipped: from the edge of the piece it was worked into, it runs out a hand's length; the scissors close
  // on it a third of the way along, the far end drops away and the tail stays.
  const snips = () => {
    for (const key of Object.keys(D.chop)) {
      const c = D.chop[key]; if (c.kind !== "snip" || !c.made || t < c.at) continue;
      const P = atPose(c.made); if (!P) continue;
      const s = sizeOf(c.made), edge = objects.point(c.made, [s.width, s.height * 0.55], P), L = 260;
      const snipAt = c.at + c.len * 0.55, away = span(t, snipAt, snipAt + 0.7), show = span(t, c.at, c.at + 0.3);
      const m = { x: edge.x + L * 0.35, y: edge.y + 18 };
      ctx.save(); ctx.globalAlpha = show; ctx.strokeStyle = c.color; ctx.lineWidth = 10; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(edge.x, edge.y); ctx.quadraticCurveTo(edge.x + L * 0.15, edge.y + 22, m.x, m.y); ctx.stroke();
      if (away < 1) {
        ctx.globalAlpha = show * (1 - away);
        ctx.beginPath(); ctx.moveTo(m.x + 6 + 50 * away, m.y + 90 * away * away); ctx.quadraticCurveTo(edge.x + L * 0.7 + 50 * away, m.y + 30 + 90 * away * away, edge.x + L + 50 * away, m.y + 10 + 120 * away * away); ctx.stroke();
      }
      ctx.restore();
      if (c.with && t < snipAt + 0.5) {
        const shut = t < snipAt ? 0.18 * Math.abs(Math.sin((t - c.at) * 9)) : 0;
        toolAt(c.with, m.x + 4, m.y, -0.25 - shut);
      }
      if (t >= snipAt) tag(c.label ? "snip " + c.label : "snip", m.x, m.y - 46, { size: 20, h: 28, alpha: span(t, snipAt, snipAt + 0.3) * (1 - span(t, snipAt + 1.4, snipAt + 1.8)) });
    }
  };
  const draw = (key, o, forced) => {
    if (!forced && activeDemo && activeDemo.demo.actors.includes(key)) return;
    if (D.chop[key] && D.chop[key].kind !== "snip" && t >= D.chop[key].at) return chopped(key, o, o.left);
    const ci = cutInto[key];
    if (ci && t >= ci.at && !D.boards[key]) {
      // Its parts, each where it was in it, drawn apart by the joints cut so far.
      const sl = D.slices[key], n = sl.length, s = sizeOf(key), an = o.anchor || [s.width / 2, s.height], a = o.angle || 0;
      const gaps = sl.slice(0, -1).map((_, j) => 26 * kit.spring(span(t, jointAt(ci, j, n) - 0.1, jointAt(ci, j, n) + 0.4), { bounce: 0.3 }));
      const total = gaps.reduce((x, y) => x + y, 0);
      let shift = -total / 2;
      sl.forEach((p, j) => {
        plain(p.k, { ...o, anchor: [an[0] - p.x0, an[1]], x: o.x + shift * Math.cos(a), y: o.y + shift * Math.sin(a) });
        shift += gaps[j] || 0;
      });
      return;
    }
    if (cutAt[key] == null || t < cutAt[key]) return plain(key, o);
    const gap = 26 * kit.spring(span(t, cutAt[key], cutAt[key] + 0.5), { bounce: 0.3 }) * (o.scale || 1) * 2;
    for (const side of [-1, 1]) {
      ctx.save(); ctx.beginPath(); ctx.rect(side < 0 ? o.x - 1e4 : o.x, -1e4, 1e4, 3e4); ctx.clip();
      ctx.translate(side * gap, 0); plain(key, o); ctx.restore();
    }
  };

  // Where things are: the photo, large in the middle; the tray, a column on the left; each object's slot in it.
  const PH = Math.min(620 / D.photo.height, 900 / D.photo.width), PW = D.photo.width * PH, PHH = D.photo.height * PH;
  const PX = (W - PW) / 2 + 60, PY = (H - PHH) / 2;
  const slotH = Math.min(84, 700 / D.cast.length);
  const tray = (key) => {
    const i = D.cast.indexOf(key), s = sizeOf(key);
    return { x: 95, y: 120 + slotH * (i + 0.5), scale: Math.min(110 / s.width, (slotH - 14) / s.height), angle: 0 };
  };
  const inPhoto = (key) => {
    const box = D.illustrations[key], s = sizeOf(key);
    if (box) return { x: PX + (box[0] + box[2] / 2) * PH, y: PY + (box[1] + box[3] / 2) * PH,
      scale: Math.min(box[2] / s.width, box[3] / s.height) * PH, angle: 0 };
    return { x: PX + D.middles[key][0] * PH, y: PY + D.middles[key][1] * PH, scale: PH / 4, angle: D.turns[key] || 0, anchor: D.pivots[key] };
  };
  // Where a thing stands now: where it was put, or, once it has been moved there (scene.mjs), where it was moved to —
  // so whatever comes after (the finale, a later step) finds it where it ended up.
  // Where it stands once placed: a build waiting for the feet that go under it (joints.mjs: raise) rests on the floor
  // until the first of them goes in, and is lifted onto them as it does.
  const rested = (key) => D.raise && D.raise.keys.includes(key) ? { ...D.poses[key], y: D.poses[key].y + D.raise.dy * (1 - ease.inOut(span(t, D.raise.at, D.raise.at + 0.45))) } : { ...D.poses[key] };
  const ingredientHolders = {}, ingredientGroups = {};
  for (const a of D.acts) if (a.v === "place" && D.ingredients[a.k] && t >= a.at)
    ingredientHolders[a.k] = a.rel === "in" && D.vessels[a.to]?.interior ? a.to : null;
  for (const key of D.order) if (ingredientHolders[key]) (ingredientGroups[ingredientHolders[key]] ||= []).push(key);
  const ingredientHolder = (key) => ingredientHolders[key] || null;
  const ingredientPoseAt = (key, holder, holderPose) => {
    const v = D.vessels[holder], state = containerLevel(v, contents[holder] || [], t), members = ingredientGroups[holder];
    return containedIngredientPose(v, sizeOf(key), holderPose, D.poses[key].scale, state?.surface, D.ingredients[key].floating,
      members.indexOf(key), members.length);
  };
  const atPose = (key) => {
    const holder = ingredientHolder(key);
    if (holder) {
      return ingredientPoseAt(key, holder, atPose(holder));
    }
    return D.moves[key] && t >= D.moves[key].at + 1.0 ? { ...D.poses[key], ...D.moves[key].pose } : rested(key);
  };
  const seatOf = (key, pose) => objects.point(key, D.seats[key], pose || atPose(key));
  const liquidTarget = (key, pose) => {
    const v = D.vessels[key], state = containerLevel(v, contents[key] || [], t);
    return state ? objects.point(key, [v.seat[0], state.surface], pose || atPose(key)) : seatOf(key, pose);
  };
  const trayBox = (alpha) => {
    ctx.globalAlpha = alpha; ctx.fillStyle = "#f8f6f1"; ctx.strokeStyle = INK; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(28, 70, 134, 790, 14); ctx.fill(); ctx.stroke();
    ctx.font = "700 16px " + env.mono; ctx.fillStyle = INK; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    ctx.fillText(D.recipe ? "INGREDIENTS" : "PARTS", 40, 98);
    ctx.globalAlpha = 1;
  };
  const floor = () => {
    if (D.view === "plan") {
      // Looking down on a work surface: a cutting mat with its grid.
      ctx.fillStyle = "#dfe6dc"; ctx.strokeStyle = INK; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.roundRect(-200, 190, 2400, 1000, 18); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = "rgba(29,43,79,0.12)"; ctx.lineWidth = 1;
      for (let x = -200; x < 2200; x += 50) { ctx.beginPath(); ctx.moveTo(x, 190); ctx.lineTo(x, 1190); ctx.stroke(); }
      for (let y = 190; y < 1190; y += 50) { ctx.beginPath(); ctx.moveTo(-200, y); ctx.lineTo(2200, y); ctx.stroke(); }
      return;
    }
    if (D.view === "front") {
      // A wall to mount on — painted, its cut edge hatched as a manual draws a section — and the floor in front of it,
      // with its skirting.
      ctx.fillStyle = "#d6dde6"; ctx.fillRect(-400, -600, 2800, D.floorY + 600);
      ctx.strokeStyle = "rgba(29,43,79,0.35)"; ctx.lineWidth = 2;
      for (let y = -600; y < D.floorY; y += 22) { ctx.beginPath(); ctx.moveTo(200, y); ctx.lineTo(228, y + 28); ctx.stroke(); }
      ctx.strokeStyle = INK; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(228, -600); ctx.lineTo(228, D.floorY); ctx.stroke();
      ctx.fillStyle = "#efe9dd"; ctx.fillRect(-400, D.floorY, 2800, 600);
      ctx.fillStyle = "#bfc7d2"; ctx.fillRect(228, D.floorY - 26, 2400, 26);
      ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(228, D.floorY - 26); ctx.lineTo(2400, D.floorY - 26); ctx.moveTo(-400, D.floorY); ctx.lineTo(2400, D.floorY); ctx.stroke();
      ctx.font = "700 16px " + env.mono; ctx.fillStyle = "rgba(29,43,79,0.55)"; ctx.textAlign = "left"; if (!lensed) ctx.fillText("WALL", 244, Math.max(220, Math.min(D.floorY - 40, 860)));
    }
    // (everyday things stand on a table, scene.mjs: its upper face and its front edge, two flat fills)
    if (D.table) {
      const poly = (pts) => { ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); };
      ctx.fillStyle = "#e9dcc7"; poly(D.table.upper); ctx.fill();
      ctx.fillStyle = "#d6c4a6"; poly(D.table.front); ctx.fill();
      ctx.strokeStyle = "rgba(29,43,79,0.35)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(...D.table.front[0]); ctx.lineTo(...D.table.front[1]); ctx.stroke();
      return;
    }
    // (a brick build stands on plain paper, as a brick manual's does: no grid)
    if (D.view === "iso" && Object.values(D.boards).some((g) => g.brick)) return;
    if (D.view === "iso") {
      // The floor, drawn as an iso grid fading back.
      ctx.strokeStyle = "rgba(29,43,79,0.08)"; ctx.lineWidth = 1;
      for (let i = -40; i < 60; i++) {
        ctx.beginPath(); ctx.moveTo(i * 60, 0); ctx.lineTo(i * 60 + 1600, 1600 * Math.tan(Math.PI / 6)); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(i * 60, 1200); ctx.lineTo(i * 60 + 1600, 1200 - 1600 * Math.tan(Math.PI / 6)); ctx.stroke();
      }
      return;
    }
    // Side on: a work surface a shade darker than the paper behind it, its edge a faint line.
    const y = D.floorY;
    ctx.fillStyle = "#e9e1d2"; ctx.fillRect(-2400, y, 6400, 2600);
    ctx.strokeStyle = "rgba(29,43,79,0.22)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(-2400, y); ctx.lineTo(4000, y); ctx.stroke();
  };
  const flames = (x, y, size, strength, at = t) => {
    for (let i = 0; i < 3; i++) {
      const fx = x + (i - 1) * size * 0.45, h = size * (0.8 + 0.25 * Math.sin(at * 17 + i * 2.1)) * strength;
      ctx.globalAlpha = 0.9 * strength; ctx.fillStyle = i === 1 ? "#ff8a00" : "#ffcc00";
      ctx.beginPath(); ctx.moveTo(fx - size * 0.22, y); ctx.quadraticCurveTo(fx - size * 0.1, y - h * 0.6, fx, y - h);
      ctx.quadraticCurveTo(fx + size * 0.1, y - h * 0.6, fx + size * 0.22, y); ctx.fill();
    }
    ctx.globalAlpha = 1;
  };

  // A thing as a label names it: its key in words ("chili-beans": chili beans), and its amount if the act gives one.
  const said = (key, a) => key.replace(/-/g, " ") + (a && a.label ? " · " + a.label : "");
  // A heated thing stands on a burner: the plate under it and its flames, drawn before the thing so they come up round
  // its base, as on a stove — as high as its heat says (high, medium, low), low between its heat steps. Not once lifted
  // off it to pour.
  const burner = (key, pose, lifted) => {
    if (!heats[key] || lifted || !pose || pose.alpha === 0) return;
    const first = heats[key][0], on = span(t, first.at, first.at + 0.4); if (on <= 0) return;
    const now = heats[key].filter((h) => t >= h.at && t <= h.at + h.len).pop(), last = heats[key].filter((h) => t >= h.at).pop();
    const level = { high: 1, medium: 0.7, low: 0.4, off: 0 }[(now || last || {}).level] ?? 0.85, strength = (now ? on : 0.6) * level;
    // (they flicker while a heat step runs; between and after, they hold as they were when it ended, as a manual draws
    // a lit burner: hold the finished step still)
    const base = objects.point(key, pose.anchor, pose), half = sizeOf(key).width * pose.scale / 2, size = half * 0.7;
    ctx.fillStyle = "#3a4256"; ctx.beginPath(); ctx.ellipse(base.x, base.y + 6, half * 1.25, size * 0.22, 0, 0, Math.PI * 2); ctx.fill();
    if (!level) return;
    // (a flame each side, at the base's edge, licking up past it; the ones under the middle are hidden by the pot anyway)
    for (const side of [-1, 1]) flames(base.x + side * half * 0.92, base.y + 4, size * 0.75, strength, now ? t : last.at + last.len);
  };

  // What has happened to a thing on the stage so far: what was poured into it, stirred, heated. Drawn just after the
  // thing itself, so what is placed on it later covers it.
  const layers = (key, pose, lifted) => {
    if (activeDemo && activeDemo.demo.actors.includes(key)) return;
    if (!pose || pose.alpha === 0) return;
    markLayer(key, pose);
    if (contents[key] && (!D.illustrations[key] || D.vessels[key])) {
      const vessel = D.vessels[key], volume = containerLevel(vessel, contents[key], t);
      const arrived = contents[key].filter((c) => t >= (volume ? c.fillAt ?? c.at : c.at));
      if (arrived.length) {
        const seat = volume ? liquidTarget(key, pose) : seatOf(key, pose), rx = (vessel ? vessel.rx : sizeOf(key).width * 0.3) * pose.scale, ry = vessel ? vessel.ry * pose.scale : rx * 0.26, grow = span(t, arrived[0].at, arrived[0].settled ?? arrived[0].at + 0.5);
        const mixed = (stirs[key] || []).some((s) => t >= s.at + s.len * 0.5);
        if (volume && volume.level > 0) {
          // Use the artwork's own coordinates so the clip follows scale, tilt and movement.
          const origin = objects.point(key, [0, 0], pose), xAxis = objects.point(key, [1, 0], pose), yAxis = objects.point(key, [0, 1], pose);
          ctx.save(); ctx.transform(xAxis.x - origin.x, xAxis.y - origin.y, yAxis.x - origin.x, yAxis.y - origin.y, origin.x, origin.y);
          ctx.save(); ctx.beginPath();
          vessel.interior.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath(); ctx.clip();
          ctx.globalAlpha = 0.8 * (pose.alpha ?? 1); ctx.fillStyle = mixed ? blendContents(arrived) : arrived.at(-1).color;
          const left = Math.min(...vessel.interior.map(p => p[0])), right = Math.max(...vessel.interior.map(p => p[0]));
          ctx.fillRect(left, volume.surface, right - left, volume.bottom - volume.surface);
          ctx.beginPath(); ctx.ellipse(vessel.seat[0], volume.surface, vessel.rx, vessel.ry, 0, 0, Math.PI * 2); ctx.fill();
          ctx.restore();
          // Front rim lines and narrow highlights remain visible over the liquid.
          ctx.globalAlpha = pose.alpha ?? 1;
          for (const shape of vessel.front || []) {
            if (shape.hidden) continue;
            const path = new Path2D(shape.d);
            if (shape.fill && shape.fill !== "none") { ctx.fillStyle = shape.fill; ctx.fill(path, shape.fillRule || "nonzero"); }
            if (shape.stroke && shape.stroke !== "none" && shape.weight !== "none") { ctx.strokeStyle = shape.stroke; ctx.lineWidth = shape.weight == null ? 3 : ({ detail: 1.25, edge: 2, silhouette: 3 })[shape.weight]; ctx.stroke(path); }
          }
          ctx.restore();
        } else if (!volume) {
          ctx.globalAlpha = 0.9 * grow; ctx.fillStyle = mixed ? blendContents(arrived) : arrived[0].color;
          ctx.beginPath(); ctx.ellipse(seat.x, seat.y, rx, ry, pose.angle || 0, 0, Math.PI * 2); ctx.fill();
          arrived.slice(1).forEach((c, i) => {
            if (mixed) return;
            ctx.fillStyle = c.color; ctx.beginPath(); ctx.ellipse(seat.x + (i % 2 ? 1 : -1) * rx * 0.3, seat.y, rx * 0.4, rx * 0.12, 0, 0, Math.PI * 2); ctx.fill();
          });
          ctx.globalAlpha = 1;
        }
        const foam = (stirs[key] || []).find((s) => s.finish === "foam" && t >= s.at + s.len * 0.5 && !arrived.some((c) => c.at > s.at + s.len));
        if (foam) {
          ctx.fillStyle = "#e4edcf"; ctx.globalAlpha = 0.75 * span(t, foam.at + foam.len * 0.5, foam.at + foam.len * 0.88);
          for (let j = 0; j < 18; j++) { const angle = j * 2.4, r = Math.sqrt((j + 0.5) / 18) * 0.85; ctx.beginPath(); ctx.ellipse(seat.x + Math.cos(angle) * rx * r, seat.y + Math.sin(angle) * ry * r, 2.5, 1.4, 0, 0, Math.PI * 2); ctx.fill(); }
          ctx.globalAlpha = 1;
        }
      }
    }
    if (stirs[key]) {
      for (const s of stirs[key]) {
        const p = span(t, s.at, s.at + s.len); if (p <= 0 || p >= 1) continue;
        const seat = seatOf(key, pose), r = sizeOf(key).width * pose.scale * 0.22;
        ctx.strokeStyle = INK; ctx.lineWidth = 4; ctx.lineCap = "round";
        if (s.pattern === "zigzag") {
          const shift = stirMove(s.pattern, s.pace, t); ctx.beginPath();
          for (let j = 0; j < 5; j++) { const x = seat.x + (j - 2) * r * 0.25 + shift[0] * 4, y = seat.y + (j % 2 ? 1 : -1) * r * 0.1; if (j) ctx.lineTo(x, y); else ctx.moveTo(x, y); } ctx.stroke();
        } else for (let i = 0; i < 2; i++) { ctx.beginPath(); ctx.ellipse(seat.x, seat.y, r * (0.5 + 0.4 * i), r * 0.15 * (1 + i), 0, t * 9 + i * 2, t * 9 + i * 2 + 2.2); ctx.stroke(); }
      }
    }
    // Off the stove (lifted to pour), it stops steaming; the burner and its flames are under it (burner, drawn first).
    if (heats[key] && !lifted) {
      const first = heats[key][0], on = span(t, first.at, first.at + 0.4); if (on <= 0) return;
      const now = heats[key].filter((h) => t >= h.at && t <= h.at + h.len).pop(), last = heats[key].filter((h) => t >= h.at).pop();
      // (rising while a heat step runs; held as it was when the last one ended, after: still frames stay still)
      const at = now ? t : last.at + last.len;
      const seat = seatOf(key, pose), size = sizeOf(key).width * pose.scale * 0.35;
      // How high and how long it heats (its level, its label), over the steam while it does.
      const said = now && [now.level === "off" ? "heat off" : now.level ? now.level + " heat" : "", now.label || ""].filter(Boolean).join(" · ");
      if (said) tag(said, seat.x, seat.y - 150, { size: 24, h: 34 });
      ctx.strokeStyle = "rgba(29,43,79,0.45)"; ctx.lineWidth = 3; ctx.lineCap = "round";
      for (let i = 0; i < 3; i++) {
        const x = seat.x + (i - 1) * size * 0.6, rise = ((at * 0.7 + i * 0.33) % 1);
        ctx.globalAlpha = on * Math.sin(Math.PI * rise);
        ctx.beginPath(); for (let j = 0; j <= 10; j++) { const y = seat.y - 20 - j * 9 - rise * 60; const wx = x + 10 * Math.sin(j * 0.9 + at * 4 + i); j ? ctx.lineTo(wx, y) : ctx.moveTo(wx, y); } ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  };
  // Contents and their front outlines use the same animated holder pose as the vessel.
  const drawIngredient = (key, holder, holderPose, poses) => {
    const v = D.vessels[holder], pose = ingredientPoseAt(key, holder, holderPose);
    poses[key] = { ...poses[key], ...pose };
    ctx.save(); ctx.beginPath();
    v.interior.forEach((q, i) => { const P = objects.point(holder, q, holderPose); if (i) ctx.lineTo(P.x, P.y); else ctx.moveTo(P.x, P.y); });
    ctx.closePath(); ctx.clip(); draw(key, pose); layers(key, pose); ctx.restore();
    const origin = objects.point(holder, [0, 0], holderPose), xAxis = objects.point(holder, [1, 0], holderPose), yAxis = objects.point(holder, [0, 1], holderPose);
    ctx.save(); ctx.transform(xAxis.x - origin.x, xAxis.y - origin.y, yAxis.x - origin.x, yAxis.y - origin.y, origin.x, origin.y);
    for (const shape of v.front || []) if (!shape.hidden && shape.stroke && shape.stroke !== "none" && shape.weight !== "none") {
      ctx.strokeStyle = shape.stroke; ctx.lineWidth = shape.weight == null ? 3 : ({ detail: 1.25, edge: 2, silhouette: 3 })[shape.weight]; ctx.stroke(new Path2D(shape.d));
    }
    ctx.restore();
  };
  // The stage: every placed thing as the layout says, each pose merged with an override, and what happened to them.
  const stage = {
    keys: D.order, floorY: D.floorY, pose: atPose,
    draw: (c, over) => {
      const poses = Object.fromEntries(D.order.map(key => [key, { ...atPose(key), ...((over || {})[key] || {}) }]));
      // A hidden vessel also hides its attached contents. Visible contents inherit its transform.
      const posed = D.order.filter(key => !gone(key) && poses[key].alpha !== 0 && poses[ingredientHolder(key)]?.alpha !== 0);
      for (const key of posed) if (!ingredientHolder(key)) castShadow(key, poses[key]);
      for (const key of posed) {
        const holder = ingredientHolder(key);
        if (holder) drawIngredient(key, holder, poses[holder] || atPose(holder), poses);
        else { burner(key, poses[key]); draw(key, poses[key]); layers(key, poses[key]); }
      }
    },
    point: (key, name, pose, part) => objects.point(key, Array.isArray(name) ? name : name === "seat" ? D.seats[key] : D.poses[key].anchor, pose || atPose(key), part),
  };

  const T = D.times;
  paper();

  // 1. The photo: the objects used outlined one by one, then lifting off into the tray (turning into drawings, if drawn).
  if (t < D.T.intro + 0.4) {
    const fade = 1 - span(t, D.T.intro - 0.6, D.T.intro + 0.2);
    ctx.globalAlpha = fade; env.drawScreen(ctx, "photo", PX, PY, PW, PHH);
    ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.strokeRect(PX, PY, PW, PHH); ctx.globalAlpha = 1;
    trayBox(span(t, 0.6, 1.2));
    // What was found, said over the photo while its things light up by name.
    // Every outline lights up, and the header comes in, while the tray slides in (0.6 to 0.95 s): frames that move
    // anyway; the prelude, which the film takes over from at 0.95 s, lights them the same.
    const litAt = (j, n) => { const d = 0.2 / Math.max(1, n - 1); return span(t, 0.6 + j * d, 0.75 + j * d); };
    const found = D.cast.filter((k) => !D.tool[k] && !D.piece[k] && D.appearAt[k] == null && BOX[k]).length;
    if (found) { ctx.globalAlpha = span(t, 0.6, 0.85) * fade; text("FOUND IN YOUR PHOTO · " + found + (found > 1 ? " THINGS" : " THING"), PX + PW / 2, PY - 18, 22, "700", INK, "center"); ctx.globalAlpha = 1; }
    D.cast.forEach((key, i) => {
      // A tool is not in the photo: it pops into the tray once the photo's things are in.
      if (D.piece[key] || D.appearAt[key] != null) return;
      if (D.tool[key] || D.supplied[key]) { const pop = kit.spring(span(t, 2.2 + i * 0.08, 2.7 + i * 0.08), { bounce: 0.4 }); if (pop > 0) {
        plain(key, { ...tray(key), scale: tray(key).scale * pop });
        if (D.supplied[key]) tag("ADDITIONAL SUPPLY", tray(key).x, tray(key).y + 26, { size: 14, h: 22, pad: 6, alpha: pop * fade });
      } return; }
      // (lit in the object list's order, the photo's boxes', when the prelude lights them: the film takes over from it)
      const j = Object.keys(BOX).indexOf(key), lit = litAt(j, Object.keys(BOX).length), lift = ease.inOut(span(t, 1.0 + i * 0.11, 1.9 + i * 0.11));
      const [bx, by, bw, bh] = BOX[key];
      if (lift <= 0) {
        ctx.globalAlpha = lit * fade; ctx.strokeStyle = ACCENT; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.roundRect(PX + bx * PH - 4, PY + by * PH - 4, bw * PH + 8, bh * PH + 8, 8); ctx.stroke(); ctx.globalAlpha = 1;
        // (its name on the outline's upper edge, as it lights up)
        if (lit > 0) tag(key.replace(/-/g, " "), PX + (bx + bw / 2) * PH, PY + by * PH - 4, { size: 18, h: 26, pad: 6, alpha: lit * fade, fill: ACCENT });
        return;
      }
      const a = inPhoto(key), b = tray(key), arc = Math.sin(Math.PI * lift) * 60;
      plain(key, { asPhoto: !D.illustrations[key] && lift < 0.6, x: lerp(a.x, b.x, lift), y: lerp(a.y, b.y, lift) - arc, scale: lerp(a.scale, b.scale, lift), angle: lerp(a.angle, 0, lift), anchor: a.anchor,
        ...(D.illustrations[key] ? { photo: 0, reveal: 1, fill: 1, alpha: span(lift, 0, 0.25) } :
          { photo: 1 - span(lift, 0.4, 0.9), reveal: span(lift, 0.3, 0.9), fill: span(lift, 0.6, 1) }) });
    });
    return;
  }

  // 2. The title card.
  if (t < T.steps0) {
    const u = t - D.T.intro, inn = ease.out(span(u, 0, 0.5)), out = 1 - span(u, D.T.title - 0.3, D.T.title);
    trayBox(1); D.cast.forEach((key) => { if (!D.piece[key] && D.appearAt[key] == null) plain(key, tray(key)); });
    ctx.globalAlpha = inn * out;
    const things = D.cast.filter((k) => !D.tool[k]).length;
    text((D.recipe ? "RECIPE · " + things + " INGREDIENTS" : "INSTRUCTIONS · " + things + " PARTS"), 880, 300, 22, "700", INK, "center");
    const size = fit(D.title, 120, "800", 1200);
    text(D.title, 880, 300 + 40 + size * (1 - 0.15 * (1 - inn)), size, "800", INK, "center");
    text(D.sub, 880, 520, 40, "600", INK, "center");
    text(D.tag, 880, 590, 30, "400", "rgba(29,43,79,0.7)", "center");
    ctx.globalAlpha = 1;
    return;
  }

  // 3. The steps.
  if (t < T.finale) {
    let i = 0; while (i + 1 < D.starts.length && t >= D.starts[i + 1]) i++;
    const u = t - D.starts[i], step = D.steps[i], stepEnd = D.starts[i + 1] ?? T.finale;
    // The camera's view now, eased between its keys; the stage is drawn through it, the tray and caption over it.
    let k = 0; while (k + 1 < D.cam.length && t >= D.cam[k + 1].at) k++;
    const c0 = D.cam[k], c1 = D.cam[Math.min(k + 1, D.cam.length - 1)], cu = c1.at > c0.at ? ease.inOut(span(t, c0.at, c1.at)) : 0;
    let view = { x: lerp(c0.x, c1.x, cu), y: lerp(c0.y, c1.y, cu), zoom: lerp(c0.zoom, c1.zoom, cu) };
    // (within a twentieth of a pixel of where a move starts or ends, it is there: an easing's last ten-thousandths of a
    // pixel adds no useful motion, so snap it to its settled view)
    const at = (c) => Math.abs(view.x - c.x) * view.zoom < 0.05 && Math.abs(view.y - c.y) * view.zoom < 0.05 && Math.abs(view.zoom - c.zoom) * 1600 < 0.05;
    if (at(c1)) view = { x: c1.x, y: c1.y, zoom: c1.zoom }; else if (at(c0)) view = { x: c0.x, y: c0.y, zoom: c0.zoom };
    stageZoom = view.zoom;
    // Where a point of the frame (the tray's) is on the stage seen through the camera, and back.
    const toStage = (p) => ({ ...p, x: (p.x - W / 2) / view.zoom + view.x, y: (p.y - H / 2) / view.zoom + view.y, scale: p.scale / view.zoom });
    const toFrame = (p) => ({ x: (p.x - view.x) * view.zoom + W / 2, y: (p.y - view.y) * view.zoom + H / 2 });
    const busy = {};
    // (a serving made with a ladle leaves what it is served from standing: serves)
    for (const a of D.acts) if ((a.v === "pour" || a.v === "sprinkle") && a.to && !(a.with && D.poses[a.with]) && t >= a.at && t < a.at + a.len) busy[a.k] = a;
    // The stage — drawn once through the camera, and again inside a callout's magnifier. Returns the spot a tool is
    // working at, if a callout should show it.
    // Where a placed thing is now: carried as a hand would, out of the tray (or from where it was cut) on an arc to
    // its place, coming to its size early, leaning a little into the move and turning to its angle on the way, then
    // set down with a small rock that dies away. A bigger thing takes longer (dur, s); all of it within 0.8 s, less than the old drop took, so no more
    // frames of motion. lift: how far above its place.
    // ...and a thing moved (scene.mjs: placed again, or in or on one that is) is carried the same way from where it was
    // to where it ends up, when it is moved.
    const placing = (key) => {
      const m = D.moves[key];
      if (m && t >= m.at) return carry(key, { ...D.poses[key] }, { ...D.poses[key], ...m.pose }, m.at);
      const when = D.placedAt[key];
      return carry(key, (when < (D.homeUntil[key] ?? 0) && homeOf(key)) || toStage(tray(key)), atPose(key), when);
    };
    const carry = (key, from, p, when) => {
      const sz = sizeOf(key), big = Math.min(1, Math.max(sz.width, sz.height) * p.scale / 700), dur = D.boards[key] ? 0.45 : 0.45 + 0.15 * big;
      const u = ease.inOut(span(t, when, when + dur)), settle = span(t, when + dur, when + dur + 0.2);
      // (the arc's high point under the caption band, frame y 240, wherever the camera is)
      // (a brick comes down straight onto its studs: the arc's high point right over its place, and no rock once on)
      const isBrick = !!(D.boards[key] && D.boards[key].brick);
      const apex = Math.min(180, 50 + Math.hypot(p.x - from.x, p.y - from.y) * 0.15), cx = isBrick ? p.x : (from.x + p.x) / 2;
      const cy = Math.max(toStage({ x: 0, y: 240, scale: 1 }).y, Math.min(from.y, p.y) - apex);
      const x = (1 - u) * (1 - u) * from.x + 2 * (1 - u) * u * cx + u * u * p.x, y = (1 - u) * (1 - u) * from.y + 2 * (1 - u) * u * cy + u * u * p.y;
      const dir = Math.sign(p.x - from.x) || 1, rock = !D.boards[key] && settle > 0 && settle < 1 ? 0.05 * dir * Math.sin(settle * Math.PI * 2) * (1 - settle) : 0;
      const stirring = (stirs[key] || []).find((s) => t >= s.at && t <= s.at + s.len);
      return { ...p, x, y, scale: lerp(from.scale, p.scale, ease.out(span(t, when, when + dur * 0.6))),
        angle: lerp(from.angle || 0, p.angle || 0, u) + (isBrick ? 0.06 * dir *Math.sin(Math.PI * Math.min(1, u * 1.6)) : 0.14 * dir * Math.sin(Math.PI * u)) + rock + (stirring && !D.vessels[key] ? 0.04 * Math.sin(t * 22) : 0),
        highlight: 1 - span(t, when + 1.0, when + 1.8), lift: Math.max(0, p.y - y), dur };
    };
    const things = () => {
      // Each placed thing flies out of the tray to above its place, then drops onto it with a bounce, an arrow over it.
      const poses = {};
      // What covers a spot a tool is working on now: the boards drawn over it there.
      const ghost = new Set();
      const inside = (q, P) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) if ((P[i][1] > q.y) !== (P[j][1] > q.y) && q.x < (P[j][0] - P[i][0]) * (q.y - P[i][1]) / (P[j][1] - P[i][1]) + P[i][0]) c = !c; return c; };
      for (const a of D.acts) {
        if (a.v !== "use" || t < a.at || t >= a.at + a.len || !D.boards[a.k] || !D.poses[a.k]) continue;
        const after = D.order.slice(D.order.indexOf(a.k) + 1);
        const pts = spots(a);
        for (const [index, fx] of pts.entries()) {
          const q = onTop(a.k, fx, atPose(a.k), a.face, pts.lat[index]);
          for (const other of after) {
            if (!D.boards[other] || t < D.placedAt[other] || gone(other)) continue;
            const op = atPose(other);
            if (D.boards[other].faces.some((f) => inside(q, f.pts.map((v) => { const w = objects.point(other, v, op); return [w.x, w.y]; })))) ghost.add(other);
          }
        }
      }
      for (const key of D.order) {
        const when = D.placedAt[key]; if (t < when || gone(key) || busy[key] || inHand(key) || busy[ingredientHolder(key)]) continue;
        // A piece is not carried in: it grows where it stands, with the hook at work on it.
        if (D.piece[key]) {
          poses[key] = atPose(key); const at = piece(key, poses[key]);
          const a = works.find((w) => w.k === key && t >= w.at && t < w.at + w.len); if (a) hook(a, at);
          continue;
        }
        const p = atPose(key);
        poses[key] = placing(key);
        // See-through while a tool works on a spot it covers (the base inside a box, being drilled).
        if (ghost.has(key)) poses[key] = { ...poses[key], alpha: 0.3 };
        const ingredientIn = ingredientHolder(key);
        if (ingredientIn && t >= when + poses[key].dur) {
          drawIngredient(key, ingredientIn, poses[ingredientIn] || placing(ingredientIn), poses);
        } else { burner(key, poses[key]); draw(key, poses[key]); layers(key, poses[key]); }
        // (standing in a container with no lid: the container's front again, over its lower part)
        const holder = D.inside[key]; if (holder && poses[holder] && D.boards[holder]) boardOf(holder, { ...poses[holder], frontOnly: true, highlight: 0, lift: 0 });
        // (the arrow over its place while it comes down onto it)
        const drop = span(t, when + poses[key].dur * 0.45, when + poses[key].dur + 0.15);
        if (drop > 0 && drop < 1) {
          // (its tail never above the caption band, frame y 200, wherever the camera is: shorter if it must be)
          const h = sizeOf(key).height * p.scale, ax = p.x, ay = p.y - h - 30, from = Math.max(ay - 100, toStage({ x: 0, y: 200, scale: 1 }).y);
          ctx.globalAlpha = Math.sin(Math.PI * drop); if (ay - from > 20) arrow(ax, from, ax, ay); ctx.globalAlpha = 1;
        }
      }
      // Cut parts not yet placed lie where they were cut.
      for (const key of Object.keys(D.home)) {
        if (D.appearAt[key] == null || t < D.appearAt[key] || busy[key] || holding(key)) continue;
        if (D.order.includes(key) && t >= D.placedAt[key]) continue;
        if (t >= (D.homeUntil[key] ?? 1e9)) continue;
        let h = homeOf(key); if (!h) continue;
        // A board's part springs apart from its neighbours as the board comes apart.
        const gap = D.boards[key]?.homeGap;
        if (gap) { const sp = kit.spring(span(t, D.appearAt[key], D.appearAt[key] + 0.6), { bounce: 0.3 }); h = { ...h, x: h.x - gap[0] * (1 - sp), y: h.y - gap[1] * (1 - sp) }; }
        if (D.offcut[key] != null) {
          // An offcut: it drops off the bench and is gone.
          const f = span(t, D.offcut[key] + 0.3, D.offcut[key] + 1.1); if (f >= 1) continue;
          h = { ...h, y: h.y + 260 * ease.in(f), angle: (h.angle || 0) + 0.6 * f, alpha: 1 - f };
        }
        poses[key] = poses[key] || h; draw(key, h); layers(key, h);
        // Its length, as a cut list gives it: a dimension along it, over it, a tick at each end, the length in a box — so a
        // short part reads as a measured length of board, not a square. An offcut is only named, on it.
        const label = D.partLabel[key];
        if (label && D.boards[key]) {
          const shown = span(t, D.appearAt[key] + 0.2, D.appearAt[key] + 0.6) * (h.alpha ?? 1);
          if (label === "offcut") { const c = onTop(key, 0.5, h); tag(label, c.x, c.y, { size: 22, h: 30, alpha: shown, fill: "#f3e3c0" }); }
          else if (shown > 0) {
            const A = onTop(key, 0, h), B = onTop(key, 1, h), up = (q) => ({ x: q.x, y: q.y - 34 }), a = up(A), b = up(B);
            ctx.globalAlpha = shown; ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.setLineDash([]);
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
            for (const q of [a, b]) { ctx.beginPath(); ctx.moveTo(q.x, q.y - 9); ctx.lineTo(q.x, q.y + 9); ctx.stroke(); }
            ctx.globalAlpha = 1;
            tag(label, (a.x + b.x) / 2, (a.y + b.y) / 2, { size: 22, h: 30, alpha: shown });
          }
        }
      }
      // The knife: a line sweeping down through what is being cut in two.
      for (const a of D.acts) {
        if (a.v !== "cut" || D.slices[a.k] || (Array.isArray(a.into) && a.into.some((p) => p.size)) || D.chop[a.k] || !poses[a.k]) continue;
        const p = span(t, a.at, a.at + 0.55); if (p <= 0 || p >= 1) continue;
        const pose = poses[a.k], s = sizeOf(a.k), h = s.height * pose.scale, y0 = pose.y - h - 60;
        ctx.strokeStyle = INK; ctx.lineWidth = 6; ctx.lineCap = "round"; ctx.setLineDash([18, 12]);
        ctx.beginPath(); ctx.moveTo(pose.x, y0); ctx.lineTo(pose.x, lerp(y0, pose.y + 10, ease.inOut(p))); ctx.stroke(); ctx.setLineDash([]);
      }
      snips();
      // A cut into parts: each joint in turn — the saw at it, or the knife's line — then each part's length over it.
      let spot = null;
      // A board: marked at every joint with the cut list over it, then sawn joint by joint — the saw in hand from the
      // first to the last, a kerf left at each — until it comes apart (its parts drawn on their own from then).
      for (const key of Object.keys(cutInto)) {
        if (!D.boards[key]) continue;
        const a = cutInto[key], parts = D.boards[key].slices || [], pose = poses[key], L = a.len;
        if (!pose || t < a.at || t >= goneAt[key] || parts.length < 2) continue;
        const joints = parts.slice(0, -1).map((p) => p.f1), sawFrom = a.at + L * 0.24, sawTo = a.at + L * 0.78;
        const cutAt = (j) => sawFrom + (sawTo - sawFrom) * (j + 1) / joints.length;
        joints.forEach((f, j) => {
          const [S0, S1] = crossLine(key, f, pose), g = ease.out(span(t, a.at + 0.1 + j * 0.12, a.at + L * 0.2));
          if (g <= 0) return;
          const cut = t >= cutAt(j);
          ctx.strokeStyle = INK; ctx.lineWidth = cut ? 5 : 2.5; ctx.setLineDash(cut ? [] : [10, 7]); ctx.lineCap = "round";
          ctx.beginPath(); ctx.moveTo(S0.x, S0.y); ctx.lineTo(lerp(S0.x, S1.x, g), lerp(S0.y, S1.y, g)); ctx.stroke(); ctx.setLineDash([]);
        });
        if (a.with && D.motion[a.with] && D.poses[a.with]) {
          const P = useTool({ ...a, v: "use", k: key, x: joints, cm: undefined, n: undefined, face: undefined, quiet: true,
            at: sawFrom - (sawTo - sawFrom) * 0.22 / 0.66, len: (sawTo - sawFrom) / 0.66 }, poses, toStage);
          spot = spot || P;
        }
        // The cut list over the saw, so the saw never hides a length.
        chain(key, parts, pose, ease.out(span(t, a.at, a.at + L * 0.18)));
      }
      for (const key of Object.keys(cutInto)) {
        if (D.boards[key]) continue;
        const a = cutInto[key], sl = D.slices[key], n = sl.length, pose = poses[key]; if (!pose || t < a.at || t > a.at + a.len + 0.4) continue;
        const w = sizeOf(key).width, bs = D.boards[key]?.slices;
        // Where along it a part ends or its middle is: a fraction (a board's from the solver).
        const f1 = (p) => bs ? (bs.find((b) => b.k === p.k)?.f1 ?? p.x1 / w) : p.x1 / w;
        const fm = (p) => bs ? (() => { const b = bs.find((x) => x.k === p.k); return b ? (b.f0 + b.f1) / 2 : (p.x0 + p.x1) / 2 / w })() : (p.x0 + p.x1) / 2 / w;
        sl.slice(0, -1).forEach((p, j) => {
          const start = a.at + a.len * (0.15 + 0.7 * j / Math.max(1, n - 1)), end = jointAt(a, j, n);
          if (t < start - 0.3 || t > end + 0.2) return;
          if (a.with && D.motion[a.with]) { const P = useTool({ ...a, x: f1(p), n: 1, cm: undefined, at: start - 0.3, len: end - start + 0.5 }, poses, toStage); spot = spot || P; }
          else {
            const P = onTop(key, f1(p), pose), h = sizeOf(key).height * pose.scale, g = ease.inOut(span(t, start, end));
            ctx.strokeStyle = INK; ctx.lineWidth = 6; ctx.lineCap = "round"; ctx.setLineDash([18, 12]);
            ctx.beginPath(); ctx.moveTo(P.x, P.y - 60); ctx.lineTo(P.x, lerp(P.y - 60, P.y + h, g)); ctx.stroke(); ctx.setLineDash([]);
          }
        });
        sl.forEach((p, j) => {
          const shown = span(t, j < n - 1 ? jointAt(a, j, n) : jointAt(a, n - 2, n), (j < n - 1 ? jointAt(a, j, n) : jointAt(a, n - 2, n)) + 0.3);
          if (shown <= 0 || !p.label) return;
          const P = onTop(key, fm(p), pose);
          if (lensed) return;
          ctx.globalAlpha = shown; ctx.font = "700 28px " + env.mono; const tw = ctx.measureText(p.label).width;
          ctx.fillStyle = PAPER; ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.fillRect(P.x - tw / 2 - 10, P.y - 78, tw + 20, 40); ctx.strokeRect(P.x - tw / 2 - 10, P.y - 78, tw + 20, 40);
          ctx.fillStyle = INK; ctx.textAlign = "center"; ctx.fillText(p.label, P.x, P.y - 48); ctx.globalAlpha = 1;
        });
      }
      // Measuring: the dimension stays up for the rest of its step.
      for (const a of D.acts) if (a.v === "measure" && poses[a.k] && t >= a.at && t < (D.starts[a.step + 1] ?? T.finale)) dimension(a, poses[a.k], i);
      // A measured gap, just in front of the row on the table: grows out from its middle, ticks at its ends, the count.
      for (const d of D.dims) {
        if (t < d.at || t >= d.until) continue;
        const g = ease.out(span(t, d.at, d.at + 0.6));
        // A gap between boards (joints.mjs: along) is measured along its own way across the frame, set off to the side
        // that faces down or right; a brick's lies level under its row.
        if (d.along) {
          const dx = d.to[0] - d.from[0], dy = d.to[1] - d.from[1], len = Math.hypot(dx, dy), u = [dx / len, dy / len];
          let n = [-u[1], u[0]]; if (n[1] < 0 || (n[1] === 0 && n[0] < 0)) n = [-n[0], -n[1]];
          const off = 46, mx = (d.from[0] + d.to[0]) / 2 + n[0] * off, my = (d.from[1] + d.to[1]) / 2 + n[1] * off, half = len / 2 * g;
          const ends = [[mx - u[0] * half, my - u[1] * half], [mx + u[0] * half, my + u[1] * half]];
          ctx.strokeStyle = INK; ctx.lineWidth = 3; ctx.setLineDash([]);
          ctx.beginPath(); ctx.moveTo(...ends[0]); ctx.lineTo(...ends[1]); ctx.stroke();
          for (const [x, y] of ends) { ctx.beginPath(); ctx.moveTo(x - n[0] * 14, y - n[1] * 14); ctx.lineTo(x + n[0] * 14, y + n[1] * 14); ctx.stroke(); }
          ctx.globalAlpha = 0.35; ctx.setLineDash([6, 6]); ctx.lineWidth = 2;
          for (const [[x, y], q] of [[ends[0], d.from], [ends[1], d.to]]) { ctx.beginPath(); ctx.moveTo(q[0], q[1]); ctx.lineTo(x - n[0] * 14, y - n[1] * 14); ctx.stroke(); }
          ctx.setLineDash([]); ctx.globalAlpha = 1;
          if (g > 0.8) tag(d.label, mx, my, { size: 28, pad: 12, h: 42, line: 3 });
          continue;
        }
        const y = Math.max(d.from[1], d.to[1]) + 46, mx = (d.from[0] + d.to[0]) / 2, half = (d.to[0] - d.from[0]) / 2 * g;
        ctx.strokeStyle = INK; ctx.lineWidth = 3; ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(mx - half, y); ctx.lineTo(mx + half, y); ctx.stroke();
        for (const x of [mx - half, mx + half]) { ctx.beginPath(); ctx.moveTo(x, y - 14); ctx.lineTo(x, y + 14); ctx.stroke(); }
        ctx.globalAlpha = 0.35; ctx.setLineDash([6, 6]); ctx.lineWidth = 2;
        for (const [x, y0] of [[mx - half, d.from[1]], [mx + half, d.to[1]]]) { ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y - 14); ctx.stroke(); }
        ctx.setLineDash([]); ctx.globalAlpha = 1;
        if (g > 0.8) tag(d.label, mx, y, { size: 28, pad: 12, h: 42, line: 3 });
      }
      // A part worked on before it has a place on the stage (sanding the cut parts before assembly) is brought out for
      // its act, where it will stand.
      for (const a of D.acts) {
        if ((a.v !== "use" && a.v !== "measure") || t < a.at || t >= a.at + a.len || poses[a.k] || !D.poses[a.k] || gone(a.k) || D.tool[a.k]) continue;
        const h = homeOf(a.k) && t < (D.homeUntil[a.k] ?? 0) ? homeOf(a.k) : atPose(a.k), in_ = ease.out(span(t, a.at, a.at + 0.3)), out_ = 1 - span(t, a.at + a.len - 0.25, a.at + a.len);
        poses[a.k] = { ...h, alpha: Math.min(in_, out_) }; draw(a.k, poses[a.k]); layers(a.k, poses[a.k]);
      }
      // A sheet cut follows each actual part outline in the source sheet. No wood grain or saw-crosscut animation.
      for (const a of D.sheetCuts) {
        if (t < a.at || t >= a.at + a.len * 0.82 || !poses[a.k]) continue;
        const pose = poses[a.k], progress = span(t, a.at + a.len * 0.12, a.at + a.len * 0.78);
        const count = a.into.length, active = Math.min(count - 1, Math.floor(progress * count));
        for (let j = 0; j < count; j++) {
          const part = D.flatParts[a.into[j].k], path = [...part.outline, part.outline[0]].map((q) => [q[0] + part.origin[0], q[1] + part.origin[1]]);
          ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.setLineDash(j < active ? [] : [7, 5]); ctx.beginPath();
          path.forEach((q, i) => { const P = flatPoint(a.k, q, pose); if (i) ctx.lineTo(P.x, P.y); else ctx.moveTo(P.x, P.y); }); ctx.stroke(); ctx.setLineDash([]);
          if (j === active && a.with && D.poses[a.with]) useTool({ ...a, k: a.k, path, pathProgress: progress * count - active }, poses, toStage);
        }
      }
      // Tools at work: a use; and a stir or a cut done with a tool (the spoon that stirs, the knife that cuts), shown
      // doing its motion where the stirring or cutting happens.
      for (const a of D.acts) {
        if (t < a.at || t >= a.at + a.len) continue;
        if (a.v === "cut" && Array.isArray(a.into) && a.into.some((p) => p.size)) continue;
        // (a cut into pieces or a snip draws its own knife or scissors: chopped, snips)
        if (a.v === "cut" && D.chop[a.k]) continue;
        if (a.v === "stir" || (a.v === "cut" && !D.slices[a.k])) {
          const tool = [a.with, a.k].find((key) => key && D.motion[key] && D.poses[key]), on = a.v === "stir" ? a.to : a.k;
          if (tool && on && D.poses[on]) useTool({ ...a, v: "use", with: tool, k: on, x: 0.5, n: 1 }, poses, toStage);
          continue;
        }
        if (a.v !== "use" || !a.with || !D.poses[a.with] || !D.poses[a.k]) continue;
        const P = useTool(a, poses, toStage);
        if (P && (a.part || ["turn", "tap", "mark"].includes(D.motion[a.with]))) spot = spot || P;
      }
      // Pouring and sprinkling: the thing comes over its target, tips, and its stream or bits fall in; then back.
      for (const key of Object.keys(busy)) {
        const a = busy[key], p = span(t, a.at, a.at + a.len), target = poses[a.to] || atPose(a.to), seat = seatOf(a.to, target);
        if (D.chop[key] && D.chop[key].kind !== "snip" && t >= D.chop[key].at) {
          // Pieces cut earlier go in by the handful: the heap stays where it was cut and empties as they fly over.
          const heap = poses[key] || atPose(key), flow = span(p, 0.1, 0.9), s = sizeOf(key), from = { x: objects.point(key, [s.width / 2, s.height / 2], heap).x, y: heap.y - 30 };
          draw(key, { ...heap, left: 1 - flow });
          if (flow > 0 && flow < 1 && !(a.handful && !a.label)) tag(said(key, a), from.x, from.y - 70, { size: 22, h: 30 });
          ctx.fillStyle = D.chop[key].color; ctx.strokeStyle = INK; ctx.lineWidth = 1.5;
          for (let j = 0; j < 10; j++) {
            const f = (flow * 4 + env.random(j)) % 1; if (flow <= 0 || flow >= 1) break;
            const x = lerp(from.x, seat.x + (env.random(j + 40) - 0.5) * 50, f), y = lerp(from.y, seat.y, f) - 120 * Math.sin(Math.PI * f);
            ctx.save(); ctx.translate(x, y); ctx.rotate(f * 4 + j); ctx.beginPath(); ctx.roundRect(-9, -9, 18, 18, 3); ctx.fill(); ctx.stroke(); ctx.restore();
          }
          continue;
        }
        const s = sizeOf(key), scale = D.poses[key].scale, sprinkle = a.v === "sprinkle";
        // From the tray, or from its place on the stage, and back there.
        const from = D.order.includes(key) ? atPose(key) : toStage(tray(key)), there = ease.inOut(span(p, 0, 0.25)), back = ease.inOut(span(p, 0.85, 1));
        const tip = ease.inOut(span(p, 0.2, 0.35)) * (1 - back);
        const outlet = D.outlets[key] || D.vessels[key]?.spout || D.seats[key];
        const hold = { x: 0, y: 0, scale, anchor: D.poses[key].anchor, angle: -(sprinkle ? 2.5 : 1.9) * tip };
        // Solve the translation after rotation: the actual lip stays directly above the target rim.
        const offset = objects.point(key, outlet, hold);
        hold.x = seat.x - offset.x; hold.y = seat.y - 70 - offset.y;
        const shake = sprinkle ? 12 * Math.sin(t * 38) * span(p, 0.35, 0.8) : 0;
        const pose = { ...hold, x: lerp(lerp(from.x, hold.x, there), from.x, back) + shake, y: lerp(lerp(from.y, hold.y, there), from.y, back),
          scale: lerp(lerp(from.scale, scale, there), from.scale, back), angle: (from.angle || 0) * (1 - there) - (sprinkle ? 2.5 : 1.9) * tip };
        const spout = objects.point(key, outlet, pose), flow = span(p, 0.35, 0.8);
        const landing = liquidTarget(a.to, target);
        ctx.strokeStyle = a.color || "#c8a165"; ctx.fillStyle = a.color || "#c8a165";
        if (!sprinkle && flow > 0 && flow < 1) {
          ctx.lineWidth = 12 * Math.sin(Math.PI * flow) + 2; ctx.lineCap = "round";
          const entry = D.vessels[a.to]?.interior ? seat : landing;
          ctx.beginPath(); ctx.moveTo(spout.x, spout.y); ctx.quadraticCurveTo(spout.x, (spout.y + entry.y) / 2, entry.x, entry.y);
          if (D.vessels[a.to]?.interior) ctx.lineTo(landing.x, landing.y);
          ctx.stroke();
        }
        if (sprinkle && flow > 0 && flow < 1)
          for (let j = 0; j < 16; j++) {
            const f = (flow * 3 + env.random(j)) % 1;
            ctx.beginPath(); ctx.arc(lerp(spout.x, seat.x + (env.random(j + 40) - 0.5) * 60, f), lerp(spout.y, seat.y, f * f), 5, 0, Math.PI * 2); ctx.fill();
          }
        if (!gone(key)) {
          poses[key] = pose;
          draw(key, pose); layers(key, pose, true);
          for (const child of D.order) if (ingredientHolder(child) === key && !gone(child) && !busy[child] && !inHand(child)) {
            drawIngredient(child, key, pose, poses);
          }
        }
        // What goes in, named (and how much, its label), while it pours: two cans tipping in turn are otherwise told
        // apart by colour alone.
        if (there >= 1 && back <= 0 && !(a.unpacked && !a.label)) {
          const corners = [[0, 0], [s.width, 0], [0, s.height], [s.width, s.height]].map(q => objects.point(key, q, pose));
          tag(said(key, a), (Math.min(...corners.map(q => q.x)) + Math.max(...corners.map(q => q.x))) / 2,
            Math.min(...corners.map(q => q.y)) - 34, { size: 22, h: 30 });
        }
      }
      // Serving with a ladle (script.mjs): what it is served from stays where it stands; the ladle comes out of the tray,
      // dips in at its rim, carries a ladleful over the bowl on an arc, tips it in, and goes back.
      for (const a of D.acts) {
        if (!["pour", "sprinkle"].includes(a.v) || !a.with || !D.poses[a.with] || !D.poses[a.k] || !D.poses[a.to] || t < a.at || t >= a.at + a.len) continue;
        const L = a.with, p = span(t, a.at, a.at + a.len), s = sizeOf(L), scale = D.toolAxis[L] == null ? D.poses[L].scale : Math.min(D.poses[L].scale, 240 / Math.max(s.width, s.height)), lift = 50 + s.height * scale;
        const into = liquidTarget(a.to, poses[a.to] || atPose(a.to));
        let source = poses[a.k] || atPose(a.k);
        if (!D.order.includes(a.k)) {
          source = { ...D.poses[a.k], x: into.x - 220, y: (poses[a.to] || atPose(a.to)).y };
          draw(a.k, source); layers(a.k, source);
        }
        const rim = seatOf(a.k, source);
        const out = ease.inOut(span(p, 0, 0.2)), dip = Math.sin(Math.PI * span(p, 0.2, 0.4)), carry = ease.inOut(span(p, 0.4, 0.62));
        const tip = ease.inOut(span(p, 0.62, 0.72)) * (1 - ease.inOut(span(p, 0.85, 0.92))), back = ease.inOut(span(p, 0.85, 1));
        // Where its bowl (its seat) is, and the pose that puts it there.
        const qx = lerp(rim.x, into.x + 30, carry), qy = lerp(rim.y - lift, into.y - lift * 0.7, carry) - 50 * Math.sin(Math.PI * carry) + dip * lift;
        const contact = D.toolTip[L] || D.seats[L], zero = { x: 0, y: 0, scale, anchor: D.poses[L].anchor, angle: D.toolAxis[L] == null ? -1.1 * tip : -D.toolAxis[L] - 0.15 - 0.3 * tip }, q0 = objects.point(L, contact, zero);
        const work = { ...zero, x: qx - q0.x, y: qy - q0.y }, home = toStage(tray(L)), f = out * (1 - back);
        const pose = { ...work, x: lerp(home.x, work.x, f), y: lerp(home.y, work.y, f), scale: lerp(home.scale, scale, f), angle: lerp(home.angle || 0, work.angle, f) };
        const flow = span(p, 0.68, 0.84);
        if (flow > 0 && flow < 1) {
          const from = objects.point(L, D.toolTip[L] || [D.seats[L][0] * 0.15, D.seats[L][1]], pose);
          ctx.strokeStyle = a.color || "#c8a165"; ctx.lineWidth = 10 * Math.sin(Math.PI * flow) + 2; ctx.lineCap = "round";
          if (a.v === "sprinkle") { ctx.fillStyle = a.color; for (let j = 0; j < 12; j++) { const u = (flow * 2 + j / 12) % 1; ctx.beginPath(); ctx.arc(lerp(from.x, into.x + (env.random(j) - 0.5) * 35, u), lerp(from.y, into.y, u * u), 3, 0, Math.PI * 2); ctx.fill(); } }
          else {
            const entry = D.vessels[a.to]?.interior ? seatOf(a.to, poses[a.to] || atPose(a.to)) : into;
            ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.quadraticCurveTo(from.x - 6, (from.y + entry.y) / 2, entry.x, entry.y);
            if (D.vessels[a.to]?.interior) ctx.lineTo(into.x, into.y);
            ctx.stroke();
          }
        }
        draw(L, pose);
        if (carry > 0 && back <= 0) tag((a.v === "sprinkle" ? "scoop into " : "serve into ") + a.to.replace(/-/g, " ") + (a.label ? " · " + a.label : ""), qx, qy - 90, { size: 22, h: 30 });
      }
      if (activeDemo) {
        const a = activeDemo, allowed = (k) => { if (!a.demo.actors.includes(k)) throw Error("undeclared actor"); };
        const api = { check: allowed, point: (k, xy) => { allowed(k); const q = objects.point(k, xy || D.seats[k], poses[k] || atPose(k)); return demoPosition(q.x, q.y); } };
        api.point01 = (k, xy) => { allowed(k); const s = sizeOf(k); return api.point(k, [xy[0]*s.width, xy[1]*s.height]); };
        const frame = demoFrame(clips[a.demoIndex], span(t, a.at, a.at + a.len), { width: W, height: H, font: env.font, mono: env.mono, palette: env.palette }, api, ctx, { pale: paleHere, ink: INK });
        for (const k of a.demo.actors) draw(k, { ...(poses[k] || atPose(k)), ...demoDrawingPose(frame.draws.get(k), sizeOf(k)) }, true);
        ctx.save(); const f = a.focus, b = f.bounds, s = sizeOf(f.k);
        const pts = [[b[0], b[1]], [b[0] + b[2], b[1]], [b[0], b[1] + b[3]], [b[0] + b[2], b[1] + b[3]]].map(([x, y]) => api.point(f.k, [x * s.width, y * s.height]));
        const x0 = Math.min(...pts.map((p) => p.x)), y0 = Math.min(...pts.map((p) => p.y));
        ctx.beginPath(); ctx.rect(x0, y0, Math.max(...pts.map((p) => p.x)) - x0, Math.max(...pts.map((p) => p.y)) - y0); ctx.clip();
        try { frame.paint(); } finally { ctx.restore(); }
      }
      return spot;
    };
    // The stage on its floor, and (not in the magnifier) the shadows of what stands on it.
    const scene = (under) => {
      floor();
      if (under) for (const key of D.order)
        if (t >= D.placedAt[key] && !gone(key) && !busy[key] && !inHand(key) && !(activeDemo && activeDemo.demo.actors.includes(key))) castShadow(key, D.piece[key] ? atPose(key) : placing(key));
      return things();
    };
    ctx.save(); ctx.translate(W / 2, H / 2); ctx.scale(view.zoom, view.zoom); ctx.translate(-view.x, -view.y);
    if (squash < 1) { ctx.translate(0, D.flip.cy); ctx.scale(1, squash); ctx.translate(0, -D.flip.cy); }
    staged = toFrame; unstaged = toStage;
    const spot = scene(true);
    staged = null; unstaged = null;
    ctx.restore();
    // A recipe's time bar, along the frame's foot: still within a step, so it adds no moving frame.
    if (D.timebar) {
      const n = D.timebar.length, x0 = 200, x1 = D.panel ? 1100 : 1560, y = 846, h = 34, w = (x1 - x0) / n;
      const HEAT = { high: "#e8743b", medium: "#f0a04b", low: "#f5cf86", off: "#e6e1d6" };
      ctx.fillStyle = PAPER; ctx.globalAlpha = 0.92; ctx.fillRect(x0 - 8, y - 26, x1 - x0 + 16, h + 40); ctx.globalAlpha = 1;
      D.timebar.forEach((b, j) => {
        const x = x0 + j * w;
        ctx.globalAlpha = j > i ? 0.45 : 1;
        ctx.fillStyle = b.level ? HEAT[b.level] : "#e6e1d6"; ctx.fillRect(x + 2, y, w - 4, h);
        ctx.strokeStyle = INK; ctx.lineWidth = j === i ? 4 : 1.5; ctx.strokeRect(x + 2, y, w - 4, h);
        const say = (j + 1) + (b.adds ? "  " + b.adds : "");
        text(say, x + 10, y + 23, fit(say, 18, "600", w - 20), "600", INK);
        const over = [b.level === "off" ? "heat off" : b.level ? b.level + " heat" : "", b.time].filter(Boolean).join(" · ");
        if (over && (j === 0 || over !== [D.timebar[j - 1].level === "off" ? "heat off" : D.timebar[j - 1].level ? D.timebar[j - 1].level + " heat" : "", D.timebar[j - 1].time].filter(Boolean).join(" · ")))
          text(over, x + 6, y - 8, fit(over, 16, "700", w - 12), "700", INK);
      });
      ctx.globalAlpha = 1;
    }
    // The manual's turn-over sign while the work is turned: a curved arrow coming round on itself, beside the work.
    if (turnNow) {
      const show = span(t, turnNow.from, turnNow.from + 0.3) * (1 - span(t, turnNow.to - 0.3, turnNow.to));
      const cx = 1330, cy = 330, r = 62, a0 = -2.6, a1 = a0 + 5.2 * Math.min(1, span(t, turnNow.from, turnNow.from + ${TURN}) + span(t, turnNow.to - ${TURN}, turnNow.to));
      ctx.save(); ctx.globalAlpha = show; ctx.strokeStyle = INK; ctx.lineWidth = 7; ctx.lineCap = "round";
      ctx.beginPath(); ctx.ellipse(cx, cy, r, r * 0.45, 0, a0, Math.max(a0 + 0.3, a1)); ctx.stroke();
      const e = Math.max(a0 + 0.3, a1), ex = cx + r * Math.cos(e), ey = cy + r * 0.45 * Math.sin(e), dir = Math.atan2(r * 0.45 * Math.cos(e), -r * Math.sin(e));
      ctx.fillStyle = INK; ctx.beginPath(); ctx.moveTo(ex + 20 * Math.cos(dir), ey + 20 * Math.sin(dir));
      ctx.lineTo(ex + 14 * Math.cos(dir + 2.3), ey + 14 * Math.sin(dir + 2.3)); ctx.lineTo(ex + 14 * Math.cos(dir - 2.3), ey + 14 * Math.sin(dir - 2.3)); ctx.closePath(); ctx.fill();
      ctx.restore();
      tag("turn over", cx, cy + 62, { size: 22, h: 32, alpha: show });
    }
    // The callout: a magnifier on the spot a tool works at, the stage drawn again three times closer inside it.
    if (spot && !D.acts.some((a) => (a.focus || a.joint) && t >= a.at && t < a.at + a.len)) {
      // On the side of the frame away from the spot, clear of the tray (and the panel, when it shows); higher or lower,
      // or the other side, where that covers fewer labels. (Every frame with a magnifier has a tool moving in it, so
      // where it goes costs nothing.)
      const S = toFrame(spot), R = 150, Z = 3, near = S.x > W * 0.55 || (D.panel && D.panel.spans[i]) ? 420 : W - 250, far = near === 420 ? W - 250 : 420;
      const covers = (c) => labelled.reduce((sum, r) => sum + Math.max(0, Math.min(r.x1, c.x + R) - Math.max(r.x0, c.x - R)) * Math.max(0, Math.min(r.y1, c.y + R) - Math.max(r.y0, c.y - R)), 0);
      const C = [{ x: near, y: 380 }, { x: near, y: 600 }, { x: far, y: 380 }, { x: far, y: 600 }]
        .filter((c, j) => j === 0 || (Math.hypot(c.x - S.x, c.y - S.y) > R + 60 && !(D.panel && D.panel.spans[i] && c.x + R > 1130)))
        .reduce((best, c) => (covers(c) < covers(best) - 1 ? c : best));
      ctx.strokeStyle = INK; ctx.lineWidth = 3; ctx.setLineDash([10, 8]); ctx.beginPath(); ctx.moveTo(S.x, S.y); ctx.lineTo(C.x + (S.x < C.x ? -1 : 1) * R * 0.7, C.y + R * 0.7); ctx.stroke(); ctx.setLineDash([]);
      ctx.save(); ctx.beginPath(); ctx.arc(C.x, C.y, R, 0, Math.PI * 2); ctx.clip(); ctx.fillStyle = PAPER; ctx.fillRect(C.x - R, C.y - R, 2 * R, 2 * R);
      ctx.translate(C.x, C.y); ctx.scale(Z, Z); ctx.translate(-spot.x, -spot.y); lensed = true; scene(); lensed = false; ctx.restore();
      ctx.strokeStyle = INK; ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(C.x, C.y, R, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(S.x, S.y, 22, 0, Math.PI * 2); ctx.stroke();
    }
    // The reference panel, on the right: the craft's own diagram of the step (the model's), building up as its work
    // runs; held, not faded, from one panelled step to the next. One that throws leaves its card blank.
    if (D.panel && D.panel.spans[i] && (panel || D.panel.own[i] != null)) {
      const [p0, p1] = D.panel.spans[i], before = D.panel.spans[i - 1], after = D.panel.spans[i + 1];
      // (the last one gone before the camera pulls out for the next step, so it never sits over the work)
      const show = (before ? 1 : span(u, 0, 0.4)) * (after ? 1 : 1 - span(t, stepEnd - 0.85, stepEnd - 0.5));
      ctx.save(); ctx.globalAlpha = show;
      ctx.fillStyle = "#ffffff"; ctx.strokeStyle = INK; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.roundRect(1130, 196, 440, 500, 14); ctx.fill(); ctx.stroke();
      const label = D.panel.labels[i];
      text(label, 1150, 236, fit(label, 26, "800", 400), "800");
      ctx.strokeStyle = "rgba(29,43,79,0.25)"; ctx.beginPath(); ctx.moveTo(1150, 256); ctx.lineTo(1550, 256); ctx.stroke();
      ctx.save(); ctx.beginPath(); ctx.rect(1150, 276, ${SIZE}, ${SIZE}); ctx.clip(); ctx.translate(1150, 276);
      // (its own alpha, whatever it sets, scaled by the card's, so it fades with the card)
      const faded = show >= 1 ? ctx : new Proxy(ctx, {
        get: (o, k) => k === "globalAlpha" ? o.globalAlpha / show : typeof o[k] === "function" ? o[k].bind(o) : o[k],
        set: (o, k, v) => { o[k] = k === "globalAlpha" ? v * show : v; return true; } });
      const mine = D.panel.own[i] != null ? D.reshapes.find((r) => r.at === D.panel.own[i]) : null;
      const folding = D.panel.folds[i];
      const stranding = D.panel.strands[i];
      if (show > 0.01 && folding) foldPanel(faded, folding, ease.inOut(span(t, p0, p1)));
      else if (show > 0.01 && stranding) strandPanel(faded, stranding, ease.inOut(span(t, p0, p1)));
      else if (show > 0.01 && mine) reshapePanel(faded, mine, ease.inOut(span(t, p0, p1)));
      else if (show > 0.01 && panel) try { panel(faded, i, ease.inOut(span(t, p0, p1)), { ...env, operations: D.facts.filter((f) => !D.panel.structured ? f.step === i : f.step <= i),
        drawObject: (c, key, width, height) => { const size = objects.size(key), scale = Math.min(width / size.width, height / size.height); objects.draw(c, key, { x: width / 2, y: height / 2, scale }); } }); } catch (e) {}
      ctx.restore(); ctx.restore();
    }
    // What waits in the tray: placed things until they land; cut parts once cut; poured, sprinkled and held things
    // until used, then back (poured ones spent).
    trayBox(1);
    for (const key of D.cast) {
      // (a cut part only once its bench time is over; an offcut never)
        if (D.piece[key] || inHand(key) || holding(key) || broughtOut(key) || D.offcut[key] != null || activeDemo && activeDemo.demo.actors.includes(key)) continue;
      if (D.home[key] && t < (D.homeUntil[key] ?? 1e9)) continue;
      if (D.appearAt[key] != null && t < D.appearAt[key]) continue;
      const placed = D.placedAt[key] != null && D.order.includes(key);
      if (placed ? t < D.placedAt[key] : !busy[key]) {
        const spent = !placed && !D.contentSpec[key] && D.acts.some((a) => a.k === key && (a.v === "pour" || a.v === "sprinkle") && t >= a.at + a.len);
        plain(key, { ...tray(key), alpha: spent ? 0.35 : 1 });
        const many = D.acts.find((a) => a.part === key && +a.n > 1);
        if (many) { const tp = tray(key); text(D.acts.filter((a) => a.part === key).reduce((s, a) => s + (+a.n || 1), 0) + "×", 150, tp.y + 10, 22, "800", INK, "right"); }
      }
    }
    // The caption, on a band of paper so the stage pushed in under it never runs into the words.
    ctx.fillStyle = PAPER; ctx.globalAlpha = 0.92; ctx.fillRect(180, 52, W - 200, 124); ctx.globalAlpha = 1;
    const head = ease.out(span(u, 0, 0.35));
    ctx.globalAlpha = head;
    ctx.fillStyle = INK; ctx.beginPath(); ctx.arc(236, 112, 38, 0, Math.PI * 2); ctx.fill();
    text(String(i + 1), 236, 126, 40, "800", ACCENT, "center");
    text(step.t, 296, 108, fit(step.t, 52, "800", 1200), "800");
    text(step.c, 298, 152, 30, "400", "rgba(29,43,79,0.8)");
    ctx.globalAlpha = 1;
    return;
  }

  // 4. The finale: the model's, or the engine's own from the script's beats.
  const u = t - T.finale;
  const own = () => {
    paper(); floor();
    const over = {}, heat = [], n = Math.max(1, D.beats.length), each = (D.T.finale - 1.4) / n;
    D.beats.forEach((b, i) => {
      const p = span(u, 0.4 + i * each, 0.4 + (i + 0.9) * each), k = D.order.includes(b.k) ? b.k : b.to;
      if (!k || !D.poses[k]) return;
      const base = { ...atPose(k), ...(over[k] || {}) };
      const parts = objects.info(k).parts, by = (b.by || 90) * Math.PI / 180;
      if (b.v === "turn" && parts.length > 1) over[k] = { ...over[k], angles: { [parts[parts.length - 1].id]: by * kit.spring(p, { bounce: 0.4 }) } };
      else if (b.v === "turn") over[k] = { ...over[k], angle: base.angle + by * ease.inOut(p) };
      else if (b.v === "spin" || b.v === "flip") {
        // About its middle, not the base it stands on: the anchor moved there, and the pose with it.
        const s = sizeOf(k), mid = [s.width / 2, s.height / 2], an = base.anchor || [s.width / 2, s.height];
        const lift = b.v === "flip" ? 260 * Math.sin(Math.PI * p) : 0;
        over[k] = { ...over[k], anchor: mid, x: base.x + (mid[0] - an[0]) * base.scale, y: base.y + (mid[1] - an[1]) * base.scale - lift, angle: base.angle + Math.PI * 2 * ease.inOut(p) };
      }
      else if (b.v === "stir") over[k] = { ...over[k], angle: base.angle + (p > 0 && p < 1 ? 0.05 * Math.sin(u * 24) : 0) };
      else if (b.v === "heat") { if (p > 0) heat.push([k, p]); }
      else if (b.v === "drop") {
        // Onto its target's seat, else to the floor.
        const goal = b.to && D.poses[b.to] ? stage.point(b.to, "seat") : { x: base.x, y: D.floorY };
        const up = span(p, 0, 0.35), down = span(p, 0.35, 1);
        over[k] = { ...over[k], x: lerp(base.x, goal.x, ease.inOut(up)), y: down > 0 ? lerp(base.y - 160, goal.y, ease.in(down)) : lerp(base.y, base.y - 160, ease.out(up)) };
      }
      else if (b.v === "throw") {
        const goal = b.to && D.poses[b.to] ? stage.point(b.to, "seat") : { x: W + 300, y: 200 };
        over[k] = { ...over[k], x: lerp(base.x, goal.x, p), y: lerp(base.y, goal.y, p) - 420 * Math.sin(Math.PI * p), angle: base.angle + 4 * p };
      }
      if (p > 0 && p < 1) over[k] = { ...over[k], highlight: 1 };
    });
    for (const [k, p] of heat) {
      const pose = { ...atPose(k), ...(over[k] || {}) }, b = objects.point(k, pose.anchor, pose), half = sizeOf(k).width * pose.scale / 2;
      for (const side of [-1, 1]) flames(b.x + side * half * 0.92, b.y + 4, half * 0.52, Math.min(1, p * 3));
    }
    stage.draw(ctx, over);
    const done = kit.spring(span(u, D.T.finale - 1.2, D.T.finale - 0.6), { bounce: 0.5 });
    if (done > 0) {
      ctx.save(); ctx.translate(880, 200); ctx.scale(done, done);
      ctx.fillStyle = ACCENT; ctx.beginPath(); ctx.roundRect(-210, -62, 420, 110, 16); ctx.fill();
      text(D.recipe ? "Serve." : "It works.", 0, 22, 72, "800", INK, "center"); ctx.restore();
    }
  };
  if (t < T.end) {
    if (finale) {
      // The finale draws through the same helper, which here also draws the pieces the steps made.
      // (and sizes boards as they are drawn)
      const carried = new Set();
      const helper = { ...objects, size: sizeOf, info: (key) => D.boards[key] ? { ...objects.info(key), width: D.boards[key].w, height: D.boards[key].h } : objects.info(key),
        draw: (c, key, o) => {
          // Legacy finales may draw a vessel and then explicitly draw some of its contents.
          // Draw the complete vessel here and suppress those duplicate child calls.
          if (carried.has(key)) return;
          const pose = { ...atPose(key), ...(o || {}) };
          if (D.piece[key]) return piece(key, pose);
          if (!D.vessels[key]?.interior) return plain(key, o);
          draw(key, pose); layers(key, pose);
          if (pose.alpha === 0) return;
          const poses = { [key]: pose };
          for (const child of D.order) if (ingredientHolder(child) === key && !gone(child)) {
            drawIngredient(child, key, pose, poses); carried.add(child);
          }
        } };
      try { ctx.save(); finale(ctx, u, env, helper, stage); ctx.restore(); } catch (e) { ctx.restore(); own(); }
    } else own();
    return;
  }

  // 5. The end card: the title and what to do with it, then all required inputs and the cut list, as a
  // manual's last page has them.
  const e = ease.out(span(t, T.end, T.end + 0.5));
  ctx.globalAlpha = e;
  const lists = [["YOU'LL NEED", D.need], ["CUT LIST", D.cutList]].filter(([, l]) => l.length);
  const size = fit(D.title, 110, "800", 1300), y0 = lists.length ? 210 : 400;
  text(D.title, W / 2, y0, size, "800", INK, "center");
  text(D.end, W / 2, y0 + 80, 40, "600", INK, "center");
  const columns = lists.map(([, items]) => Math.min(3, Math.max(1, Math.ceil(items.length / 8))));
  const totalColumns = columns.reduce((n, c) => n + c, 0), columnWidth = Math.min(440, 1360 / Math.max(1, totalColumns));
  let nextColumn = 0;
  lists.forEach(([head, items], i) => {
    const count = columns[i], x = (W - totalColumns * columnWidth) / 2 + nextColumn * columnWidth;
    nextColumn += count;
    const rows = Math.ceil(items.length / count), rowHeight = Math.min(38, 290 / Math.max(1, rows)), width = columnWidth - 30;
    text(head, x, 400, 22, "700", INK);
    ctx.fillStyle = INK; ctx.fillRect(x, 414, count * columnWidth - 30, 3);
    items.forEach((item, j) => text(item, x + Math.floor(j / rows) * columnWidth, 458 + (j % rows) * rowHeight,
      fit(item, Math.min(28, rowHeight * 0.8), "600", width), "600", INK));
  });
  const by = lists.length ? 800 : 540;
  ctx.fillStyle = ACCENT; ctx.beginPath(); ctx.roundRect(W / 2 - 230, by, 460, 64, 12); ctx.fill();
  text("Made from your photo.", W / 2, by + 44, 34, "700", INK, "center");
  ctx.globalAlpha = 1;
}`
}

// The prelude: what the film shows before it exists — the photo, each thing found lit up by name, "found in your
// photo", the parts tray coming in — as soon as the object list is in (seconds before the layout), then holding there.
// It draws exactly what the film's own intro draws up to PRELUDE_HOLD, so the film, when it comes, takes over at that
// moment (the player's program swap) and the things lift off into the tray from where they are lit.
//   prelude({photo: {width, height}, objects: [{key, box: [x, y, w, h]}], recipe}) → {source, duration, hold}
// box: the model's rough box, in photo pixels (the film's are SAM's: an outline may settle a little at the swap).
export const PRELUDE_HOLD = 0.95
export function prelude({ photo, objects, recipe = null }) {
  const data = JSON.stringify({ photo, objects: objects.map((o) => ({ key: o.key, box: o.box })), recipe })
  const source = `(ctx, t, env) => {
  const P = ${data}, W = env.width, H = env.height, INK = env.palette.ink, ACCENT = env.palette.accent;
  const span = (u, a, b) => Math.min(1, Math.max(0, (u - a) / (b - a)));
  // (held at the moment the film takes over: nothing moves after it, so the wait costs nothing to draw)
  t = Math.min(t, ${PRELUDE_HOLD});
  const PH = Math.min(620 / P.photo.height, 900 / P.photo.width), PW = P.photo.width * PH, PHH = P.photo.height * PH;
  const PX = (W - PW) / 2 + 60, PY = (H - PHH) / 2;
  const text = (s, x, y, size, weight, color, align) => {
    ctx.font = weight + " " + size + "px " + env.font; ctx.fillStyle = color || INK; ctx.textAlign = align || "left"; ctx.textBaseline = "alphabetic";
    ctx.fillText(s, x, y);
  };
  // (the film's boxed label, and its placer: a spot already held this frame moves to the nearest free one)
  const taken = [];
  const tag = (label, x, y, o) => {
    const size = o.size, pad = o.pad, h = o.h;
    ctx.font = "700 " + size + "px " + env.mono; const w = ctx.measureText(label).width + 2 * pad;
    const free = (cx, cy) => taken.every((r) => cx + w / 2 + 4 <= r.x0 || cx - w / 2 - 4 >= r.x1 || cy + h / 2 + 4 <= r.y0 || cy - h / 2 - 4 >= r.y1);
    const onFrame = (cx, cy) => ({ x: Math.min(W - w / 2 - 8, Math.max(176 + w / 2 + 8, cx)), y: Math.min(H - h / 2 - 8, Math.max(184 + h / 2 + 8, cy)) });
    let q = onFrame(x, y);
    if (!free(q.x, q.y)) {
      for (let i = 1, found = false; i <= 6 && !found; i++)
        for (const [cx, cy] of [[x, y - i * (h + 6)], [x - i * (w / 2 + 6), y], [x + i * (w / 2 + 6), y], [x, y + i * (h + 6)]])
          if (free(cx, cy)) { q = onFrame(cx, cy); found = true; break; }
    }
    if (o.alpha <= 0.05) return;
    taken.push({ x0: q.x - w / 2, x1: q.x + w / 2, y0: q.y - h / 2, y1: q.y + h / 2 });
    ctx.globalAlpha = o.alpha; ctx.strokeStyle = INK; ctx.setLineDash([]);
    if (q.x !== x || q.y !== y) {
      const ey = Math.abs(q.y - y) < h / 2 ? q.y : q.y + (q.y < y ? h / 2 : -h / 2), ex = Math.abs(q.y - y) < h / 2 ? q.x + (q.x < x ? w / 2 : -w / 2) : q.x;
      ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.fillStyle = INK; ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = ACCENT; ctx.lineWidth = 2;
    ctx.fillRect(q.x - w / 2, q.y - h / 2, w, h); ctx.strokeRect(q.x - w / 2, q.y - h / 2, w, h);
    ctx.fillStyle = INK; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(label, q.x, q.y + 1); ctx.textBaseline = "alphabetic";
    ctx.globalAlpha = 1;
  };
  env.drawScreen(ctx, "photo", PX, PY, PW, PHH);
  ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.strokeRect(PX, PY, PW, PHH);
  // The tray, as the film draws it (its heading once the plan says what kind of film it is).
  const tray = span(t, 0.6, 1.2);
  if (tray > 0) {
    ctx.globalAlpha = tray; ctx.fillStyle = "#f8f6f1"; ctx.strokeStyle = INK; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(28, 70, 134, 790, 14); ctx.fill(); ctx.stroke();
    if (P.recipe != null) { ctx.font = "700 16px " + env.mono; ctx.fillStyle = INK; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic"; ctx.fillText(P.recipe ? "INGREDIENTS" : "PARTS", 40, 98); }
    ctx.globalAlpha = 1;
  }
  const n = P.objects.length;
  if (n) { ctx.globalAlpha = span(t, 0.6, 0.85); text("FOUND IN YOUR PHOTO · " + n + (n > 1 ? " THINGS" : " THING"), PX + PW / 2, PY - 18, 22, "700", INK, "center"); ctx.globalAlpha = 1; }
  P.objects.forEach((o, i) => {
    const d = 0.2 / Math.max(1, n - 1), lit = span(t, 0.6 + i * d, 0.75 + i * d), [bx, by, bw, bh] = o.box;
    ctx.globalAlpha = lit; ctx.strokeStyle = ACCENT; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.roundRect(PX + bx * PH - 4, PY + by * PH - 4, bw * PH + 8, bh * PH + 8, 8); ctx.stroke(); ctx.globalAlpha = 1;
    if (lit > 0) tag(o.key.replace(/-/g, " "), PX + (bx + bw / 2) * PH, PY + by * PH - 4, { size: 18, h: 26, pad: 6, alpha: lit });
  });
}`
  return { source, duration: 600, hold: PRELUDE_HOLD }
}
