// What a script means, made plain before anything reads it (run.mjs, relayout.mjs, server.mjs):
// - an act naming several parts ("k": ["side-a", "side-b"]: two screws through each side) is one act per part, in turn;
// - glue spread on a part fitted between two others, with no spot given, goes on both its ends: it has a joint at each;
// - a cut with no tool named is made with what the photo or the tools have for it: scissors for a strand (yarn,
//   string, ribbon), else a knife; and a cut with no parts named says what it makes, from its step's caption
//   ("cubes", "slices", "chopped") — or, a strand, that it is snipped;
// - work on the underside of a part ("face": "lower"), or drilling through a part other parts stand on (a box's
//   base: "drainage holes through the base"), is done with the work turned over ("turn": true), as a person would:
//   upside down for it, the right way up again after;
// - a pour from something that was heated (the pot of chili) into something to eat or drink from (a bowl, a plate, a
//   cup) is served with a ladle, as a person would, never by tipping the hot pot: the photo's or the tools' ladle, else
//   one added to the tools;
// - a heat with no level takes the one its step's caption gives ("on medium heat"; "bring to a boil" is high, "simmer"
//   low), when the step heats once.
// It is idempotent: a plain script comes back as it was.
//
//   plain(script) → the script, its steps' acts so expanded
import { compileOperations } from '../solvers/operations.mjs'
import { validateContract } from '../solvers/contracts.mjs'
import { settleProcesses } from '../solvers/processes.mjs'
import { settlePlanningInputs } from './planning-inputs.mjs'

const STRAND = /yarn|wool|thread|string|twine|ribbon|rope|cord|floss/i
const SERVING = /bowl|plate|cup|mug|dish|glass/i
const PIECES = [[/cube|dice/i, 'cubes'], [/slice/i, 'slices'], [/chop|mince/i, 'bits'], [/wedge|quarter/i, 'wedges'], [/strip|julienne/i, 'strips']]

export function plain(script) {
  if (!script || typeof script !== 'object') throw new Error('Instruction script must be an object')
  if (script.materials || script.assembly || script.cuts != null || (script.steps || []).some(s => (s.do || []).some(a => a?.cut != null))) { script = structuredClone(script); settlePlanningInputs(script) }
  const contract = validateContract(script)
  if (contract.errors.length) throw new Error(`Invalid operation contract: ${contract.errors.join('; ')}`)
  script = compileOperations(script)
  const fitted = new Set((script.steps || []).flatMap((s) => s.do || []).filter((a) => a.v === 'place' && (a.rel === 'between' || a.rel === 'end')).map((a) => a.k))
  const glue = new Set((script.tools || []).filter((t) => t.use === 'glue' || /glue/.test(`${t.k} ${t.use}`)).map((t) => t.k))
  const named = [...(script.objects || []).map((o) => [o.k, `${o.k} ${o.n || ''}`]), ...(script.tools || []).map((t) => [t.k, `${t.k} ${t.use || ''}`])]
  const find = (re) => named.find(([, words]) => re.test(words))?.[0]
  const nameOf = (k) => named.find(([key]) => key === k)?.[1] || k || ''
  // The parts something has been set on so far, in the script's order: a base carries the sides once they stand on it.
  const carries = new Set()
  // What has been on the heat so far; the ladle a serving from it is made with (added to the tools if none is named).
  const heated = new Set(), tools = [...(script.tools || [])]
  const ladle = () => {
    const found = find(/ladle/i)
    if (found) return found
    if (!tools.some((t) => t.k === 'ladle')) tools.push({ k: 'ladle', use: 'ladle' })
    return 'ladle'
  }
  const steps = (script.steps || []).map((s) => ({
    ...s,
    do: (s.do || []).flatMap((a) => (Array.isArray(a.k) ? a.k.map((k) => ({ ...a, k, ...(a.id ? { id: `${a.id}:${k}` } : {}) })) : [a])).map((a) => {
      if (a.v === 'place' && a.to && ['on', 'end', 'between'].includes(a.rel)) carries.add(a.to)
      if (a.v === 'heat') for (const k of [a.k, a.to]) if (k) heated.add(k)
      if (a.v === 'pour' && !a.with && heated.has(a.k) && a.to && SERVING.test(nameOf(a.to)) && !/\bwater\b/i.test(`${s.t || ''} ${s.c || ''}`)) return { ...a, with: ladle() }
      if (a.v === 'use' && glue.has(a.with) && fitted.has(a.k) && a.x == null && a.cm == null && a.at == null && !(+a.n > 1)) return { ...a, x: [0.06, 0.94] }
      if (a.v === 'use' && !a.turn && (a.face === 'lower'
          || (!a.face && !a.part && /drill/i.test(nameOf(a.with)) && carries.has(a.k) && /through|drain/i.test(`${s.t || ''} ${s.c || ''}`))))
        return { ...a, face: 'lower', turn: true }
      // Solvers work in centimetres. A model's "800 mm" must not become an 800 cm board through parseFloat.
      if (a.v === 'cut' && Array.isArray(a.into)) return { ...a, into: a.into.map((p) => {
        const match = String(p.label || '').match(/^\s*(\d+(?:\.\d+)?|\.\d+)\s*(mm|cm|m)\s*$/i)
        if (!match || match[2].toLowerCase() === 'cm') return p
        const cm = +(+match[1] * ({ mm: 0.1, m: 100 }[match[2].toLowerCase()])).toFixed(6)
        return { ...p, label: `${cm} cm` }
      }) }
      if (a.v !== 'cut' || Array.isArray(a.into)) return a
      const strand = STRAND.test(nameOf(a.k))
      const into = a.into || (strand ? 'snip' : PIECES.find(([re]) => re.test(`${s.t || ''} ${s.c || ''}`))?.[1])
      const tool = a.with || (strand ? find(/scissor|shear|snip/i) : find(/knife/i))
      return { ...a, ...(into ? { into } : {}), ...(tool ? { with: tool } : {}) }
    }),
  }))
  for (const [i, s] of steps.entries()) {
    const expand = (id) => {
      const a = (script.steps[i].do || []).find((a) => a.id === id)
      return Array.isArray(a?.k) ? a.k.map((k) => `${id}:${k}`) : [id]
    }
    if (s.caption) s.caption = { ...s.caption, actions: s.caption.actions.flatMap(expand) }
    if (s.claims) s.claims = s.claims.flatMap(expand)
  }
  // Within a step, a thing is placed before what goes in or on it ("slide the sheet into the folder, the folder into the
  // binder", written sheet first): placings whose `to` is placed later in the same step move after it.
  for (const s of steps) {
    const acts = s.do, out = [], waiting = []
    const placedLater = (a, i) => a.v === 'place' && a.to && acts.slice(i + 1).some((b) => b.v === 'place' && b.k === a.to)
    acts.forEach((a, i) => {
      if (placedLater(a, i)) { waiting.push(a); return }
      out.push(a)
      for (let j = 0; j < waiting.length; j++) if (out.some((b) => b.v === 'place' && b.k === waiting[j].to)) { out.push(waiting[j]); waiting.splice(j--, 1) }
    })
    s.do = [...out, ...waiting]
  }
  for (const s of steps) s.do = withQuantities(s)
  for (const s of steps) {
    const heats = s.do.filter((a) => a.v === 'heat'), caption = `${s.t || ''} ${typeof s.c === 'string' ? s.c : ''}`
    const level = caption.match(/\b(high|medium|low)\b/i)?.[1].toLowerCase() || (/\bboil/i.test(caption) ? 'high' : /\bsimmer/i.test(caption) ? 'low' : null)
    if (heats.length === 1 && !heats[0].level && level) s.do = s.do.map((a) => (a === heats[0] ? { ...a, level } : a))
  }
  const result = { ...script, objects: (script.objects || []).map((o) => ({ ...o })), ...(tools.length !== (script.tools || []).length ? { tools } : {}), steps }
  settleProcesses(result)
  return result
}

// A quantity the caption gives (a bit's 8 mm, a screw's 4 × 40 mm, 20 minutes, 100 g, a 15 cm tail) belongs in the
// label of the action it is about: the film shows an action's label at its work. A script that wrote it in the caption
// only gets it moved there, when it can mean just one action (or one group of them, in order): a time to the step's
// heat (else its stir or work), a weight or volume to its cut, pour or sprinkle, millimetres to its tool uses (grouped
// by tool and fastener, in the caption's order), centimetres to a snipped strand. Anything less clear is left alone.
const QUANTITY = /(\d+(?:\.\d+)?(?:\s*[×x]\s*\d+(?:\.\d+)?)?)\s*(mm|cm|minutes?|mins?|hours?|kg|g|ml|l)(?![a-z])/gi
function withQuantities(s) {
  const caption = typeof s.c === 'string' ? s.c : '', acts = s.do
  const given = new Set(acts.flatMap((a) => [a.label, ...[a.cm, a.x].flat()]).filter((v) => v != null).flatMap((v) => String(v).match(/\d+(?:\.\d+)?/g) || []))
  const found = [...caption.matchAll(QUANTITY)].filter((m) => !(m[1].match(/\d+(?:\.\d+)?/g) || []).every((n) => given.has(n)))
  const unit = (u) => (/^min/i.test(u) ? 'min' : /^hour/i.test(u) ? 'h' : u.toLowerCase())
  const kinds = {
    time: { units: /^(min|h)$/, groups: () => { const heat = acts.filter((a) => a.v === 'heat'); return (heat.length ? heat : acts.filter((a) => a.v === 'stir' || a.v === 'work')).map((a) => [a]) } },
    amount: { units: /^(kg|g|ml|l)$/, groups: () => acts.filter((a) => ['cut', 'pour', 'sprinkle'].includes(a.v)).map((a) => [a]) },
    size: { units: /^mm$/, groups: () => {
      const by = new Map()
      for (const a of acts.filter((a) => a.v === 'use' && a.with)) { const k = `${a.with}|${a.part || ''}`; by.set(k, [...(by.get(k) || []), a]) }
      return [...by.values()]
    } },
    tail: { units: /^cm$/, groups: () => acts.filter((a) => a.v === 'cut' && a.into === 'snip').map((a) => [a]) },
  }
  const labels = new Map()
  for (const kind of Object.values(kinds)) {
    const said = found.filter((m) => kind.units.test(unit(m[2]))), groups = kind.groups()
    if (!said.length || !groups.length || (said.length !== groups.length && !(said.length === 1 && groups.length === 1))) continue
    said.forEach((m, i) => { for (const a of groups[i]) if (!a.label) labels.set(a, `${m[1].replace(/\s*[×x]\s*/, ' × ')} ${unit(m[2])}`) })
  }
  return acts.map((a) => (labels.has(a) ? { ...a, label: labels.get(a) } : a))
}
