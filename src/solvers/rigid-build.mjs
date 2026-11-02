// Explicit rigid-stock declarations compiled into the existing operation contract.
// No creation or attachment steps are inserted, and dimensions are never stretched to fit.
const list = v => Array.isArray(v) ? v : []
const key = v => typeof v === 'string' && /^[a-z][a-z0-9-]*$/.test(v)
const positive = v => Number.isFinite(v) && v > 0
const round = v => +v.toFixed(6)
const KERF_CM = 0.3
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))

export function compileCutPlans(script) {
  if (script.cuts == null || Array.isArray(script.cuts) && !script.cuts.length) {
    const unknown = list(script.steps).flatMap(s => list(s?.do)).find(a => a?.cut != null)
    if (unknown) throw Error(`Unknown named cut ${unknown.cut}`)
    return []
  }
  if (!Array.isArray(script.cuts) || script.cuts.length > 32) throw Error('cuts must be an array of at most 32 stock-cut declarations')
  const objects = new Map(list(script.objects).map(o => [o.k, o])), tools = new Map(list(script.tools).map(t => [t.k, t]))
  const design = new Map(), reserved = new Set([...objects.keys(), ...tools.keys(), ...list(script.makes).map(m => m.k)])
  for (const p of list(script.design?.parts)) {
    if (!p || !key(p.k) || design.has(p.k)) throw Error('Named cuts need unique design.parts keys')
    design.set(p.k, p)
  }
  const acts = list(script.steps).flatMap(s => list(s?.do)), usedStock = new Set(), cutIds = new Set(), outputs = new Set(), notes = []
  for (const cut of script.cuts) {
    if (!cut || Object.keys(cut).some(k => !['id', 'stock', 'with', 'parts'].includes(k)) || !key(cut.id) || cutIds.has(cut.id) || !key(cut.stock) || !key(cut.with)
      || !Array.isArray(cut.parts) || !cut.parts.length || cut.parts.length > 64 || cut.parts.some(k => !key(k)))
      throw Error('Each cut needs a unique id, stock key, saw key and 1–64 design part keys')
    cutIds.add(cut.id)
    if (usedStock.has(cut.stock)) throw Error(`${cut.stock}: allocate the stock in one named cut, not overlapping cut declarations`)
    usedStock.add(cut.stock)
    const stock = objects.get(cut.stock), tool = tools.get(cut.with) || objects.get(cut.with)
    if (!stock || !positive(stock.cm) || ['sheet', 'brick'].includes(stock.part?.family)) throw Error(`${cut.id}: named rigid cuts need known rigid stock with a positive cm length`)
    if ((tool?.use || tool?.toolKind) !== 'saw') throw Error(`${cut.id}: rigid stock cuts need a declared saw`)
    const into = cut.parts.map(k => {
      const p = design.get(k)
      if (!p || p.from !== cut.stock || !positive(p.cm) || p.n != null && p.n !== 1) throw Error(`${cut.id}: ${k} must be one design part with a positive cm length from ${cut.stock}`)
      if (outputs.has(k) || reserved.has(k)) throw Error(`${cut.id}: cut output ${k} duplicates another actor or cut output`)
      outputs.add(k)
      return { k, cm: p.cm, label: `${p.cm} cm` }
    })
    const minimum = into.reduce((sum, p) => sum + p.cm, 0) + KERF_CM * (into.length - 1)
    if (minimum > stock.cm + 0.000001) throw Error(`${cut.id}: cut parts and saw kerfs need ${round(minimum)} cm but ${cut.stock} is only ${stock.cm} cm`)
    const margin = round(stock.cm - minimum)
    if (into.length === 1 && margin === 0) throw Error(`${cut.id}: use the whole stock actor directly when no cut is needed`)
    if (margin > 0.000001) {
      if (margin < KERF_CM - 0.000001) throw Error(`${cut.id}: insufficient stock for the final ${KERF_CM} cm saw kerf`)
      const remainder = round(margin - KERF_CM)
      if (remainder > 0.000001) {
        const k = `${cut.id}-offcut`
        if (reserved.has(k) || design.has(k) || outputs.has(k)) throw Error(`${cut.id}: generated offcut key ${k} conflicts with another part`)
        outputs.add(k); into.push({ k, cm: remainder, label: `${remainder} cm` })
      }
    }
    const references = acts.filter(a => a?.cut === cut.id)
    if (references.length !== 1) throw Error(`${cut.id}: show exactly one explicit cut action referencing this declaration`)
    const act = references[0]
    if (act.v !== 'cut' || act.intent !== 'cut' || act.k !== cut.stock || act.with != null && act.with !== cut.with || act.shape != null)
      throw Error(`${cut.id}: cut action must use v/intent cut, k:${cut.stock}, and its declared saw`)
    if (act.kerfCm != null && act.kerfCm !== KERF_CM) throw Error(`${cut.id}: named cuts use an assumed ${KERF_CM} cm saw kerf`)
    if (!acts.slice(0, acts.indexOf(act)).some(a => a?.v === 'place' && [a.k].flat().includes(cut.stock))) throw Error(`${cut.id}: explicitly place ${cut.stock} before cutting it`)
    if (acts.some(a => a !== act && a?.v === 'cut' && a.k === cut.stock)) throw Error(`${cut.stock}: another cut action would reuse the same stock`)
    const existing = act.into
    if (existing != null && (!Array.isArray(existing) || !same(existing.map(p => ({ k: p.k, cm: p.cm, label: p.label })), into)))
      throw Error(`${cut.id}: inline cut outputs contradict the named cut declaration`)
    const compiled = into.map(p => {
      const old = list(existing).find(o => o.k === p.k)
      if (old && Object.keys(old).some(k => !['k', 'cm', 'label', 'state', 'states'].includes(k))) throw Error(`${cut.id}: rigid cut outputs cannot also declare sheet geometry`)
      return { ...p, ...(old?.state != null ? { state: old.state } : {}), ...(old?.states ? { states: old.states } : {}) }
    })
    if (!same(act.into, compiled) || act.with !== cut.with || act.kerfCm !== KERF_CM) {
      act.into = compiled; act.with = cut.with; act.kerfCm = KERF_CM
      notes.push(`${cut.id}: compiled explicit stock cut with checked kerfs and offcut`)
    }
  }
  for (const a of acts) if (a?.cut != null && !cutIds.has(a.cut)) throw Error(`Unknown named cut ${a.cut}`)
  return notes
}

export function compileBoxJoints(script) {
  const box = script.assembly
  if (!box || !['id', 'fastener', 'driver'].some(k => box[k] != null)) return []
  if (![box.id, box.fastener, box.driver].every(key)) throw Error('Compiled box joints require assembly id, fastener and driver keys together')
  if (!Array.isArray(script.joints)) throw Error('Compiled box joints need a joints array; use [] when every joint is compiled from assembly')
  const objects = new Map(list(script.objects).map(o => [o.k, o])), parts = new Map()
  for (const a of list(script.steps).flatMap(s => list(s?.do))) if (a?.v === 'cut') for (const p of list(a.into)) parts.set(p.k, { ...p, from: a.k })
  const dims = k => {
    const cut = parts.get(k), stock = objects.get(cut?.from || k)
    const L = cut?.cm ?? stock?.cm, W = stock?.w ?? stock?.part?.size?.[1], T = stock?.thick ?? stock?.part?.size?.[2]
    if (!stock || ![L, W, T].every(positive) || stock.part?.family && !['box', 'loose'].includes(stock.part.family) || ['log', 'round'].includes(stock.part?.shape))
      throw Error(`${k}: box joints need an existing rectangular part with length, width and thickness`)
    return { L, W, T }
  }
  const d = Object.fromEntries(['base', 'front', 'back', 'left', 'right'].map(role => [role, dims(box[role])]))
  const close = (a, b) => Math.abs(a - b) <= 0.01
  if (!close(d.base.L, d.front.L) || !close(d.base.L, d.back.L)) throw Error('Box base and long sides must have matching lengths')
  const gap = d.base.W - d.front.T - d.back.T
  if (!(gap > 0) || !close(d.left.L, gap) || !close(d.right.L, gap)) throw Error(`Box ends must fit the ${round(gap)} cm gap between the sides; change the cut dimensions`)
  const declared = new Map([...objects, ...list(script.tools).map(t => [t.k, t])])
  const fastener = declared.get(box.fastener), driver = declared.get(box.driver), kind = fastener?.use || fastener?.toolKind
  const compatible = { screw: ['screwdriver', 'drill'], nail: ['hammer'], dowel: ['hammer'], bolt: ['wrench'] }
  if (!positive(fastener?.cm) || !compatible[kind]?.includes(driver?.use || driver?.toolKind)) throw Error('Box joints need a declared fastener length and compatible driving tool')
  const joints = [], add = (suffix, a, b, face, otherFace, sites, through, receiver) => {
    const minimum = through + Math.min(receiver / 2, 5), maximum = through + receiver
    if (fastener.cm < minimum - 0.01 || fastener.cm > maximum + 0.01) throw Error(`${box.id}-${suffix}: fastener must be ${round(minimum)}–${round(maximum)} cm for the through thickness and receiving bite`)
    joints.push({ id: `${box.id}-${suffix}`, a, b, method: 'fasten', face, otherFace,
      depthCm: fastener.cm, sites: sites.map(s => ({ x: round(s.x), lat: round(s.lat) })) })
  }
  for (const side of ['front', 'back']) {
    for (const end of ['left', 'right']) {
      const x = end === 'left' ? d[end].T / 2 / d[side].L : 1 - d[end].T / 2 / d[side].L
      const overlap = Math.min(d[side].W, d[end].W)
      add(`${side}-${end}`, box[side], box[end], side, side, [0.25, 0.75].map(f => ({ x, lat: overlap * f / d[side].W - 0.5 })), d[side].T, d[end].L)
    }
    const lat = side === 'front' ? d.front.T / 2 / d.base.W - 0.5 : 0.5 - d.back.T / 2 / d.base.W
    add(`base-${side}`, box.base, box[side], 'lower', 'lower', [0.25, 0.75].map(x => ({ x, lat })), d.base.T, d[side].W)
  }
  for (const end of ['left', 'right']) {
    const x = end === 'left' ? d[end].T / 2 / d.base.L : 1 - d[end].T / 2 / d.base.L
    add(`base-${end}`, box.base, box[end], 'lower', 'lower', [0.25, 0.75].map(f => ({ x, lat: (d.front.T + gap * f) / d.base.W - 0.5 })), d.base.T, d[end].W)
  }
  const prior = list(script.joints), ids = new Set(joints.map(j => j.id))
  for (const old of prior) if (ids.has(old.id) && !same(old, joints.find(j => j.id === old.id))) throw Error(`${old.id}: explicit joint conflicts with compiled box geometry`)
  const next = [...prior.filter(j => !ids.has(j.id)), ...joints]
  if (same(script.joints, next)) return []
  script.joints = next
  return [`${box.id}: compiled eight box joints and their measured work sites`]
}
