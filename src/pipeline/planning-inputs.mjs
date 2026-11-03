// Compile explicit planning declarations. Never infer missing stock or execution steps.
import { compileCutPlans, compileBoxJoints } from '../solvers/rigid-build.mjs'
const list = v => Array.isArray(v) ? v : []
const positive = v => Number.isFinite(v) && v > 0
const UPDATE_FIELDS = new Set(['k', 'part', 'toolKind', 'contents', 'state', 'states'])

// The planner supplies annotations only. Photo identity and measurements come from our frozen input.
export function hydrateInventory(script, inventory) {
  if (!script || !Object.hasOwn(script, 'objectUpdates')) return script
  if (!Array.isArray(inventory) || !Array.isArray(script.objectUpdates) || Object.hasOwn(script, 'objects'))
    throw new Error('objectUpdates requires frozen inventory and cannot be combined with objects')
  const keys = new Set(inventory.map(o => o.k)), updates = new Map()
  for (const update of script.objectUpdates) {
    if (!update || !keys.has(update.k) || updates.has(update.k)) throw new Error('Object annotations need unique known inventory keys')
    if (Object.keys(update).some(k => !UPDATE_FIELDS.has(k))) throw new Error(`${update.k}: object annotations cannot change frozen identity or measurements`)
    updates.set(update.k, update)
  }
  const { objectUpdates, ...plan } = script
  return { ...plan, objects: inventory.map(o => ({ ...structuredClone(o), ...structuredClone(updates.get(o.k) || {}), k: o.k })) }
}

export function suppliedObjects(script) {
  return list(script.materials).map(m => {
    if (!m || !/^[a-z][a-z0-9-]*$/.test(m.k) || typeof m.n !== 'string' || !m.n.trim()
      || !['sheet', 'box', 'rod', 'cylinder', 'loose'].includes(m.family)
      || !Array.isArray(m.size) || m.size.length !== 3 || !m.size.every(positive))
      throw new Error('Additional materials need a unique key, name, family and positive size [width,depth,height] in cm')
    const [cm, w, thick] = m.size
    const measurement = { status: 'estimated', source: 'Required additional supply; declared size, not observed in photo' }
    return { k: m.k, n: m.n, source: 'additional-supply', cm, w, thick,
      measurements: { cm: { ...measurement }, w: { ...measurement }, thick: { ...measurement } },
      part: { family: m.family, size: [...m.size] } }
  })
}

export function settlePlanningInputs(script) {
  const notes = []
  if (!script || typeof script !== 'object') return notes
  if (script.materials != null && !Array.isArray(script.materials)) throw new Error('materials must be an array')
  const supplied = suppliedObjects(script)
  const photographed = list(script.objects).filter(o => o?.source !== 'additional-supply')
  const keys = new Set(photographed.map(o => o?.k))
  for (const o of supplied) {
    if (keys.has(o.k)) throw new Error(`Additional material ${o.k} duplicates an existing object`)
    keys.add(o.k)
  }
  if (supplied.length || list(script.objects).some(o => o?.source === 'additional-supply')) {
    // (a supply's identity and size come from its declaration; the states it passes through come from the plan)
    const planned = new Map(list(script.objects).map(o => [o?.k, o]))
    const next = [...photographed, ...supplied.map(o => {
      const { states, state } = planned.get(o.k) || {}
      return { ...o, ...(states != null && { states }), ...(state != null && { state }) }
    })]
    if (JSON.stringify(next) !== JSON.stringify(script.objects)) {
      script.objects = next; notes.push('Declared additional materials compiled as separate supply actors')
    }
  }
  notes.push(...compileCutPlans(script))
  if (!script.assembly) return notes
  const a = script.assembly, members = ['base', 'front', 'back', 'left', 'right'].map(k => a[k])
  if (a.kind !== 'open-box' || members.some(k => typeof k !== 'string' || !k) || new Set(members).size !== 5)
    throw new Error('open-box assembly needs five distinct part keys: base, front, back, left, right')
  const placements = list(script.steps).flatMap(s => list(s?.do)).filter(act => act?.v === 'place')
  const last = k => placements.findLast(act => act.k === k)
  if (members.some(k => !last(k))) throw new Error('Every assembly member needs an explicit place action in the steps')
  const target = {
    [a.base]: { rel: 'floor', stand: 'flat', axis: 'x' },
    [a.front]: { rel: 'on', to: a.base, side: 'front', stand: 'edge', axis: 'x', at: 'start' },
    [a.back]: { rel: 'on', to: a.base, side: 'back', stand: 'edge', axis: 'x', at: 'start' },
    [a.left]: { rel: 'between', to: a.front, and: a.back, at: 'start' },
    [a.right]: { rel: 'between', to: a.front, and: a.back, at: 'end' },
  }
  for (const k of members) {
    const act = last(k), next = { ...act }
    for (const field of ['rel', 'to', 'and', 'also', 'side', 'stand', 'axis', 'at', 'cm', 'gap', 'align', 'tilt', 'splay']) delete next[field]
    Object.assign(next, target[k])
    if (JSON.stringify(act) !== JSON.stringify(next)) {
      for (const field of Object.keys(act)) delete act[field]
      Object.assign(act, next); notes.push(`Assembly placement compiled for ${k}`)
    }
  }
  notes.push(...compileBoxJoints(script))
  return notes
}

export function materialPlanningPrompt(inventory) {
  const names = list(inventory).map(o => `${o.k} ${o.n} ${o.segment}`).join(' ')
  const notes = []
  if (/board|plank|timber|wood/i.test(names)) notes.push(`WOOD: Every named part must be created by cut.into:[{k,cm,label}] before use. design.parts alone does not create parts. Reserve 0.3 cm per saw cut; never allocate the entire stock length to finished parts. For a simple planter use assembly:{kind:"open-box",base,front,back,left,right}, all five values being actual part keys. Include a place action for each, base then sides then ends; their final placement fields are compiled from this declaration. Base lies flat; sides stand ON its top, inset to its front/back edges; ends fit BETWEEN sides. End length = base width minus both side thicknesses. The base and sides must have matching lengths. Joint entry/receiving faces still need to match this geometry: sides-to-ends screw through front/back faces, while fastening the base upward into a side uses base face lower, side otherFace lower. Keep explicit executable joints and actions; do not invent dimensions to hide an impossible fit.`)
  if (/brick|lego|duplo/i.test(names)) notes.push('BRICKS: Every brick part MUST give studs:[width,depth] AND plates:height (ordinary brick 3, plate/tile 1). These are material geometry, not optional decoration. Preserve photographed identities and measurements.')
  if (/board|plank|timber|wood/i.test(names)) notes.push('FASTENING REFERENCES: Every use action with intent:"fasten" must include joint:"the-joint-id", with:"the-driver-key", part:"the-declared-fastener-key". Example: with:"screwdriver", part:"screws". Listing screws in tools is insufficient. Omit path and otherPath for fastening; the joint sites already define every screw position. Keep the fastener cm equal to joint.depthCm.')
  if (/board|plank|timber|wood/i.test(names)) notes.push('RIGID BUILD COMPILATION: Prefer root cuts declarations referencing design.parts keys and explicit cut actions with cut:the-declaration-id, rather than repeating into lists. Do not list offcuts in design.parts; the compiler accounts for them and the saw kerf. For a plain planter without requested extras, prefer the open-box assembly with id/fastener/driver: this compiles joint coordinates and placement relations from the parts. The base and sides must have equal lengths; ends fit the base width minus both side thicknesses. Show every cut, placement and all eight fastening operations explicitly. Use a suitable screw length for the through thickness plus required bite; 7 cm works for 2 cm through plus 5 cm bite where receivers are deep enough. Honor any request for a different project or construction. If a repair changes named cut lengths, rewrite the affected cut steps without stale inline into; if it changes compiled box geometry, reset generated joints to [] to regenerate them.')
  if (/yarn|wool|skein|crochet/i.test(names)) notes.push(`CROCHET: Skein cm/w/thick measure its outside shape, never its available yarn length or the finished piece. Declare finished dimensions in makes and design.size. Do not treat a made piece as a rigid part cut from a skein. Use work ONLY with intent:"work", k:the makes key, to:the photographed yarn key, and increasing p ending at 1 for overall progress. Put specific stitch techniques, weaving ends and joining motifs in separate demonstrate actions with demo.actors, bounded demo.draw, focus, requires and effects; these actors must be declared. Use cut intent:"cut" into:"snip" on yarn for tails. Avoid describing a stitch technique as a work intent. If yarn quantity is unknown, declare that in confirmations; do not infer yardage from the skein's outside dimensions.`)
  if (/yarn|wool|skein|crochet/i.test(names)) notes.push(`CROCHET SIMPLIFICATION: Prefer one useful flat rectangle or square with an explicit foundation count and consistent row counts. The built-in work renderer already shows stitches growing: use plain work intents for rows, with exact counts in captions, rather than writing custom code for every row. For finishing, declare a needle in tools and use a demonstrate action with demo:{actors:[pieceKey,yarnKey,needleKey],technique:"weave-ends",piece:pieceKey,yarn:yarnKey,needle:needleKey,path:[[0.2,0.65],[0.35,0.6],[0.5,0.65],[0.65,0.6]]}. Its path uses normalized coordinates inside the focus region; we compile the schematic needle and yarn motion. No demo.draw is needed for this technique. Give the piece declared before/after states and matching requires/effects. Do not use this finishing template to claim stitches, seams or motifs it does not make. Custom drawing remains available for other techniques, but use only documented Canvas properties and declared actors.`)
  notes.push('ADDITIONAL MATERIALS: objects contains photographed inventory only. Declare extra project stock in materials:[{k,n,family:"sheet|box|rod|cylinder|loose",size:[width,depth,height]}], one physical instance per key, with no photo box. These are required additional supplies, not photographed objects. Reference their keys in actions/design.parts. Use supplies for the readable shopping list, and tools for tools/fasteners. Prefer a simple feasible project with complete steps.')
  notes.push('EXPLICIT CONSTRUCTION CHOICE: Always return cuts (an array) and assembly (a complete box declaration or null). A cut reference with no matching cuts declaration is invalid. Generated box-* joints with no full assembly declaration are invalid; provide id, base, front, back, left, right, fastener and driver. For manual geometry or another project use assembly:null and declare the actual joints. Omit neither field.')
  return '\n' + notes.join('\n')
}
