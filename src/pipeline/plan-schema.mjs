// Provider-side structure constraints supplement validate.mjs's cross-object and physical consistency checks.
import { TOOL_KINDS } from '../solvers/tools.mjs'
import { OPS as STRAND_OPS } from '../solvers/strand.mjs'
import { PROBLEM_SCHEMA } from './problem.mjs'

const string = { type: 'string' }, positive = { type: 'number', exclusiveMinimum: 0 }
const numbers = (n) => ({ type: 'array', items: { type: 'number' }, minItems: n, maxItems: n })
const array = (items) => ({ type: 'array', items })
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false })
const reference = { type: ['string', 'null'] }
const numberOrList = { anyOf: [{ type: 'number' }, array({ type: 'number' })] }
const sites = { ...array(object({ x: { type: 'number', minimum: 0, maximum: 1 }, lat: { type: 'number', minimum: -0.5, maximum: 0.5 } }, ['x'])), minItems: 1, maxItems: 64 }
const stateRef = object({ k: string, state: string })
const measurement = object({ status: { enum: ['estimated', 'confirmed'] }, source: string })
const appearance = object({ width: positive, height: positive,
  shapes: { ...array(object({ d: string, fill: string, stroke: string })), minItems: 1, maxItems: 64 } })
const states = array(object({ id: string, label: string, appearance }, ['id', 'label']))
// (a cut part's states, inside a step's action, carry no drawing in the schema: with one, the plan's deepest path was
// 13 levels and the Meta API refuses a schema nested deeper than 10 — "JSON schema exceeds the maximum nesting depth")
const cutStates = array(object({ id: string, label: string }, ['id', 'label']))
const action = object({
  v: { enum: ['place', 'pour', 'sprinkle', 'cut', 'stir', 'heat', 'work', 'use', 'measure', 'demonstrate', 'reshape', 'fold', 'strand'] },
  id: string, intent: string, joint: string, sites, cut: { type: 'string', minLength: 1 }, kerfCm: { enum: [0.3] },
  path: { ...array(numbers(2)), minItems: 2, maxItems: 48 }, otherPath: { ...array(numbers(2)), minItems: 2, maxItems: 48 },
  requires: array(stateRef), effects: array(stateRef),
  focus: object({ k: string, bounds: numbers(4), clearance: { type: 'number', minimum: 0, maximum: 0.5 } }, ['k', 'bounds']),
  demo: { ...object({ actors: { ...array(string), minItems: 1 }, draw: string,
    technique: { enum: ['weave-ends'] }, piece: string, yarn: string, needle: string,
    path: { ...array(numbers(2)), minItems: 3, maxItems: 12 }, color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
  }, ['actors']), anyOf: [{ required: ['draw'] }, { required: ['technique', 'piece', 'yarn', 'needle', 'path'] }] },
  k: { anyOf: [string, { ...array(string), minItems: 1 }] }, to: reference, also: array(string), with: reference, part: reference, and: reference,
  rel: { enum: ['floor', 'on', 'in', 'hang', 'pivot', 'lean', 'parallel', 'end', 'between', 'across', 'under', 'wall', 'next'] },
  at: string, side: { enum: ['front', 'back', 'left', 'right', 'middle', '+', '−', '-'] },
  stand: { enum: ['flat', 'edge', 'end'] }, axis: { enum: ['x', 'y'] },
  cm: { ...numberOrList, description: 'For place: one offset in cm along target to, from its start/left edge to the placed part start/left edge, not its center. The whole placed part must fit. For use/measure: work positions along k. For fold/strand: the declared operation distance.' }, x: numberOrList,
  align: { enum: ['front', 'back', 'left', 'right', 'middle'] },
  gap: { type: 'number', minimum: 0 }, height: positive, studs: numbers(2),
  tilt: { type: 'number', minimum: 0, maximum: 45 }, splay: { type: 'number', minimum: 0, maximum: 30 },
  turn: { anyOf: [{ type: 'number' }, { type: 'boolean' }] },
  face: { enum: ['upper', 'lower', 'front', 'back', 'left', 'right', 'start', 'end'] },
  label: string, color: string, level: { enum: ['high', 'medium', 'low', 'off'] },
  pattern: { enum: ['circle', 'zigzag'] }, pace: { enum: ['gentle', 'normal', 'brisk'] }, finish: { enum: ['mixed', 'foam'] },
  form: { enum: ['liquid', 'powder', 'pieces'] }, opacity: { type: 'number', minimum: 0, maximum: 1 },
  // (a fold, fold.mjs: what moves, onto where, through which point; valley or mountain; folded and opened again; only the
  // uppermost layer; a name for the crease later folds refer to; a rotation's degrees)
  move: string, onto: string, through: string, crease: { enum: ['valley', 'mountain'] }, unfold: { type: 'boolean' },
  layers: { enum: ['all', 'top'] }, name: string, deg: { type: 'number', minimum: -180, maximum: 180 },
  // (a strand's operation, strand.mjs: bend, coil, ring, knot, twist, thread or straighten; the end that holds still; a bend's
  // or a coil's radius in cm. Its place is "at", its angle "deg", its count "n", a knot's name "name", bead size "cm")
  op: { enum: STRAND_OPS }, hold: { enum: ['start', 'end'] }, radius: positive,
  // (a cut through a folded sheet: its outline, fractions of the folded sheet's box)
  shape: { ...array(numbers(2)), minItems: 3, maxItems: 24 },
  n: { type: 'integer', minimum: 1, maximum: 64, description: 'Count per object in k. For eight screws across two parts use k:[a,b], n:4, not n:8. With explicit sites this MUST equal sites.length.' }, p: { type: 'number', minimum: 0, maximum: 1 },
  into: { anyOf: [array(object({ k: string, label: string, cm: positive, size: numbers(2), origin: numbers(2),
    outline: { ...array(numbers(2)), minItems: 3, maxItems: 48 }, state: string, states: cutStates }, ['k', 'label'])),
    { enum: ['cubes', 'slices', 'bits', 'wedges', 'strips', 'snip'] }] },
}, ['v', 'k', 'id', 'intent'])
// Shallow tagged branches add required fields without repeating the nested action payload.
action.anyOf = action.properties.v.enum.map(v => ({ properties: { v: { enum: [v] },
  ...(v === 'place' ? { cm: { type: 'number', minimum: 0 } } : {}),
  ...(['work', 'cut'].includes(v) ? { intent: { enum: [v] } } : {}) },
  required: v === 'work' ? ['to', 'p'] : v === 'demonstrate' ? ['demo', 'focus', 'requires', 'effects'] : [] ,
  ...(v === 'place' ? { anyOf: [{ required: ['rel'] }, { required: ['to'] }] } : {}),
  ...(v === 'cut' ? { anyOf: [{ required: ['cut'] }, { required: ['with', 'into'] }, { required: ['with', 'shape'] }] } : {}),
  ...(v === 'use' ? { anyOf: [
    { properties: { intent: { enum: ['fasten'] }, joint: { type: 'string', minLength: 1 },
      with: { type: 'string', minLength: 1 }, part: { type: 'string', minLength: 1 } }, required: ['joint', 'with', 'part'] },
    { properties: { intent: { enum: ['use', 'drill', 'glue', 'sand', 'clamp', 'mark', 'apply', 'fit', 'stitch'] } } },
  ] } : {}),
}))
const cutOutputs = action.properties.into.anyOf[0]
cutOutputs.minItems = 1
cutOutputs.items.anyOf = [{ required: ['cm'] }, { required: ['size', 'origin'] }]

export const OBJECTS_SCHEMA = { ...array(object({ k: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' }, n: string, segment: { type: 'string', minLength: 1 }, b: numbers(4), cm: positive,
    w: positive, thick: positive, tip: numbers(2),
    toolKind: { enum: TOOL_KINDS },
    contents: object({ name: string, form: { enum: ['liquid', 'powder', 'pieces'] }, color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$', description: 'Six-digit hex colour, for example #a8cce0. Contents only describe material inside an actual vessel.' }, opacity: { type: 'number', minimum: 0, maximum: 1 } }, ['name', 'form', 'color']),
    measurements: object({ cm: measurement, w: measurement, thick: measurement }, ['cm']),
    state: string, states,
    part: object({ family: { enum: ['box', 'sheet', 'rod', 'cylinder', 'loose', 'brick'] }, size: numbers(3),
      studs: { ...array({ type: 'integer', minimum: 1 }), minItems: 2, maxItems: 2 }, plates: { type: 'integer', minimum: 1 },
      shape: string, low: positive, side_studs: { type: 'boolean' },
    }, ['family']),
  }, ['k', 'n', 'segment', 'b', 'cm', 'measurements'])), minItems: 1 }
const partSchema = OBJECTS_SCHEMA.items.properties.part
partSchema.anyOf = [
  { properties: { family: { enum: ['brick'] } }, required: ['studs', 'plates'] },
  { properties: { family: { enum: ['box', 'sheet', 'rod', 'cylinder', 'loose'] } }, required: ['size'] },
]
const annotationProperties = Object.fromEntries(['k', 'part', 'toolKind', 'contents', 'state', 'states'].map(k => [k, OBJECTS_SCHEMA.items.properties[k]]))
const OBJECT_UPDATES = array(object(annotationProperties, ['k']))

// The parts of a plan a repair may give again on their own (PATCH_SCHEMA), as the whole plan has them.
const DESIGN = object({ purpose: string, standard: string, size: numbers(3),
  parts: array(object({ k: string, from: string, cm: { type: 'number', minimum: 0 }, n: { type: 'integer', minimum: 1 } }, ['k', 'from', 'cm'])),
  joins: string, stands: string }, ['purpose', 'standard', 'parts'])
const TOOLS = array(object({ k: string, use: { enum: TOOL_KINDS }, cm: positive, state: string, states }, ['k', 'use']))
const JOINTS = array(object({ id: string, a: string, b: string, face: { enum: ['upper', 'lower', 'front', 'back', 'left', 'right', 'start', 'end'] },
  otherFace: { enum: ['upper', 'lower', 'front', 'back', 'left', 'right', 'start', 'end'] },
  method: { enum: ['fasten', 'glue', 'clamp', 'fit'] }, sites, depthCm: positive,
}, ['id', 'a', 'b', 'face', 'otherFace', 'method', 'sites']))
const GOALS = array(stateRef)
const MAKES = array(object({ k: string, n: string, shape: { enum: ['flat', 'round', 'ball', 'tube', 'square', 'hexagon', 'flower'] },
  petals: { type: 'integer', minimum: 3, maximum: 12 }, motifs: { type: 'integer', minimum: 1, maximum: 36 }, cols: { type: 'integer', minimum: 1, maximum: 6 },
  state: string, states,
  size: positive, aspect: positive, cm: positive,
  weight: { enum: ['lace', 'fingering', 'sport', 'dk', 'worsted', 'aran', 'bulky', 'super-bulky', 'jumbo'] },
  rows: { type: 'integer', minimum: 1 }, start: { type: 'integer', minimum: 1 },
  stitches: { type: 'integer', minimum: 1 }, colors: array(string),
}, ['k', 'n', 'shape', 'size', 'cm', 'weight', 'rows', 'colors']))
// A part shaped beyond a plain board (shapes.mjs): its outline in cm (u along its length, v across its width), or a
// taper, notches, rounded corners, angled or mitred ends.
const PROFILES = array(object({ k: string, outline: { ...array(numbers(2)), minItems: 3, maxItems: 48 },
  taper: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 }, round: { type: 'number', minimum: 0 },
  ends: { ...array({ anyOf: [{ type: 'number', minimum: -60, maximum: 60 }, { enum: ['mitre', 'square'] }] }), minItems: 2, maxItems: 2 },
  notches: array(object({ at: { type: 'number', minimum: 0 }, w: positive, d: positive, edge: { enum: ['a', 'b'] } }, ['at', 'w', 'd'])),
}, ['k']))
const stepProperties = { t: string, c: string, caption: object({ template: string, actions: array(string) }), claims: { ...array(string), minItems: 1 }, do: { ...array(action), minItems: 1 } }
const STEP = object(stepProperties, ['t', 'c', 'claims', 'do'])

const physicalRequired = ['mode', 'contractVersion', 'objects', 'ideas', 'pick', 'design', 'title', 'sub', 'tag', 'view', 'tools', 'joints', 'goals', 'steps', 'finale', 'end', 'cuts', 'assembly']
export const PLAN_SCHEMA = { ...object({
  mode: { enum: ['physical', 'problem'], description: 'Use problem for a photographed equation, worksheet or written exercise. Use physical for materials, ingredients and everyday objects.' },
  problem: PROBLEM_SCHEMA,
  contractVersion: { enum: [2] },
  objects: OBJECTS_SCHEMA,
  ideas: { ...array(object({ title: string, kind: { enum: ['recipe', 'build', 'outfit', 'craft', 'other'] }, pitch: string })), minItems: 3, maxItems: 3 },
  pick: { type: 'integer', minimum: 0, maximum: 2 },
  // (the maker's design before the steps: what it is for, its size, its parts and what they come from — validate.mjs
  // holds the steps to it)
  design: DESIGN,
  title: string, sub: string, tag: string,
  view: { enum: ['side', 'plan', 'front', 'iso'] },
  tools: TOOLS,
  supplies: array(string), confirmations: array(string),
  materials: array(object({ k: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' }, n: string,
    family: { enum: ['sheet', 'box', 'rod', 'cylinder', 'loose'] }, size: { ...array(positive), minItems: 3, maxItems: 3 } })),
  cuts: { ...array(object({ id: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' }, stock: string, with: string,
    parts: { ...array(string), minItems: 1, maxItems: 64 } })), maxItems: 32 },
  assembly: { ...object({ kind: { enum: ['open-box'] }, base: string, front: string, back: string, left: string, right: string,
    id: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' }, fastener: string, driver: string }),
    type: ['object', 'null'], description: 'Explicit assembly choice: a declared open box, or null for a manually specified or different construction. Generated box joint names require the full id/fastener/driver declaration.' },
  // Top-level declarations keep full appearances for cut parts below the provider's nesting limit.
  states: array(object({ k: string, state: string, states }, ['k', 'states'])),
  joints: JOINTS,
  goals: GOALS,
  makes: MAKES,
  profiles: PROFILES,
  steps: { ...array(STEP), minItems: 1 },
  rigs: array(object({ k: string, pivot: numbers(2), split: { enum: ['above', 'below', 'left', 'right'] } })),
  finale: array(object({ v: string, k: string, to: reference, by: { type: 'number' } }, ['v', 'k'])),
  end: string,
}, ['mode']), additionalProperties: false,
  // Routing must not make every actual plan field optional. Keep the branches shallow: repeating the full
  // properties inside a union would increase the already bounded action schema's nesting depth.
  anyOf: [
    { properties: { mode: { enum: ['physical'] } }, required: physicalRequired },
    { properties: { mode: { enum: ['problem'] } }, required: ['mode', 'problem'] },
  ],
}

// Once perception has committed to a mode, a repair cannot escape its required output by selecting another branch.
const { anyOf: modeBranches, ...physicalBase } = PLAN_SCHEMA
const { problem: problemPayload, ...physicalProperties } = PLAN_SCHEMA.properties
export const PHYSICAL_PLAN_SCHEMA = { ...physicalBase, required: physicalRequired,
  properties: { ...physicalProperties, mode: { enum: ['physical'] } } }
const { objects: repeatedInventory, ...boundProperties } = PHYSICAL_PLAN_SCHEMA.properties
export const INVENTORY_PLAN_SCHEMA = { ...PHYSICAL_PLAN_SCHEMA,
  properties: { ...boundProperties, objectUpdates: OBJECT_UPDATES },
  required: physicalRequired.map(k => k === 'objects' ? 'objectUpdates' : k) }
export const PROBLEM_PLAN_SCHEMA = { type: 'object', additionalProperties: false, required: ['mode', 'problem'],
  properties: { mode: { enum: ['problem'] }, problem: PROBLEM_SCHEMA } }

// A small first call selects a single complete planning schema. No root union is sent in the live pipeline.
const { contents: planningContents, part: planningPart, state: planningState, states: planningStates, ...perceptionObjectProperties } = OBJECTS_SCHEMA.items.properties
export const PERCEPTION_SCHEMA = { type: 'object', additionalProperties: false, required: ['mode', 'objects'],
  properties: { mode: { enum: ['physical', 'problem'] }, objects: { ...OBJECTS_SCHEMA, minItems: 0,
    items: { ...OBJECTS_SCHEMA.items, properties: perceptionObjectProperties } } } }

// A repair of only what failed (plan.mjs): the steps it rewrites, each whole with its number ("at", from 1; one past the
// last adds a step), the numbers of steps it removes, and whichever of the design, tools, joints, makes, goals and
// profiles it changes, each whole. (The step's number sits beside its fields, not around them: the Meta API refuses a schema
// nested deeper than 10, and the plan's steps are at 10 already.)
export const PATCH_SCHEMA = { ...object({
  steps: array(object({ at: { type: 'integer', minimum: 1 }, ...stepProperties }, ['at', 't', 'c', 'claims', 'do'])),
  remove: array({ type: 'integer', minimum: 1 }),
  design: DESIGN, tools: TOOLS, joints: JOINTS, makes: MAKES, goals: GOALS, profiles: PROFILES,
  supplies: array(string), confirmations: array(string),
  materials: PLAN_SCHEMA.properties.materials, assembly: PLAN_SCHEMA.properties.assembly,
  cuts: PLAN_SCHEMA.properties.cuts,
  objectUpdates: OBJECT_UPDATES,
  // (a thing's states redrawn: the one field of a photo object a patch may change)
  states: array(object({ k: string, state: string, states }, ['k', 'states'])),
}, []), additionalProperties: false }

export function frozenPlanningSchema(inventory, patch = false) {
  const schema = structuredClone(patch ? PATCH_SCHEMA : INVENTORY_PLAN_SCHEMA)
  schema.properties.objectUpdates.maxItems = inventory.length
  schema.properties.objectUpdates.items.properties.k = { enum: inventory.map(o => o.k) }
  return schema
}
