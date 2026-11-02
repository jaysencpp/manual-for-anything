import { pathToFileURL } from 'node:url'
// The catalogue: one photo, twenty things to make from it. One model call writes the photo's objects and the projects,
// each with its time, level, what it uses and needs, and a compact look (thumbs.mjs draws it in milliseconds). Streamed:
// the objects as soon as they are complete, then each project as it closes, so the page fills while the model writes.
// Picking a project plans it on this inventory (run.mjs --idea, plan.mjs's onInventory).
// run.mjs writes one beside each photo film: given the planner's object list (options.inventory), the call writes only
// the projects, on the same objects and cut-outs as the film.
//
//   node catalogue.mjs <photo> <run dir> [--effort low] [--no-thinking] [--count 20]
// Writes <run dir>/script/photo.png (the normalized photo), catalogue/objects.json, catalogue/projects/<i>.json and
// catalogue.json, each just before its mark ("catalogue: object list", "project: <i>", "catalogue: done"), which
// server.mjs follows. CATALOGUE_MODEL picks the model for this call (default: the planner's, META_MODEL).
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { generate, json } from './model.mjs'
import { preparePhoto, streamedObjects, fitBoxes, MATERIALS } from './plan.mjs'
import { isLog } from '../solvers/joints.mjs'
import { validateObjects } from './validate.mjs'
import { OBJECTS_SCHEMA } from './plan-schema.mjs'
import { TOOL_KINDS } from '../solvers/tools.mjs'
import { SHAPES, MARKS, ROPE_FORMS, MAX_SOLIDS, checkLook } from '../film/thumbs.mjs'
import { guidancePrompt } from './guidance.mjs'

export const KINDS = ['recipe', 'build', 'outfit', 'craft', 'other']
export const LEVELS = ['easy', 'medium', 'hard']

const string = { type: 'string' }, numbers = (n) => ({ type: 'array', items: { type: 'number' }, minItems: n, maxItems: n })
const SOLID_SCHEMA = { type: 'object', properties: {
  s: { enum: SHAPES }, p: numbers(3), d: numbers(3), c: string, axis: { enum: ['x', 'y', 'z'] }, t: { type: 'number', exclusiveMinimum: 0 },
  open: { type: 'boolean' }, f: string, m: { enum: MARKS }, r: numbers(3), o: { type: 'array', items: numbers(2), minItems: 3, maxItems: 24 }, form: { enum: ROPE_FORMS },
}, required: ['s', 'p', 'd', 'c'] }
export function catalogueSchema(count, { withObjects = true } = {}) {
  return { type: 'object', properties: {
    ...(withObjects ? { objects: OBJECTS_SCHEMA } : {}),
    projects: { type: 'array', minItems: 0, maxItems: count, items: { type: 'object', properties: {
      title: string, kind: { enum: KINDS }, pitch: string, minutes: { type: 'integer', minimum: 1, maximum: 2880 },
      level: { enum: LEVELS }, serves: { type: 'integer', minimum: 1, maximum: 50 },
      uses: { type: 'array', items: string }, needs: { type: 'array', items: { enum: TOOL_KINDS } },
      supplies: { type: 'array', items: string }, confirmations: { type: 'array', items: string },
      look: { type: 'array', items: SOLID_SCHEMA, minItems: 1, maxItems: MAX_SOLIDS },
    }, required: ['title', 'kind', 'pitch', 'minutes', 'level', 'uses', 'needs', 'look'] } },
  }, required: withObjects ? ['objects', 'projects'] : ['projects'] }
}

// The completed elements of the array under "key" so far, each parsed (one still being written is not among them).
export function streamedItems(text, key) {
  const match = new RegExp(`"${key}"\\s*:\\s*\\[`).exec(text)
  if (!match) return []
  const items = []
  let depth = 0, quoted = false, escaped = false, from = -1
  for (let i = match.index + match[0].length; i < text.length; i++) {
    const c = text[i]
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue }
    if (c === '"') quoted = true
    else if (c === '{' || c === '[') { if (depth++ === 0) from = i }
    else if (c === '}' || c === ']') {
      if (depth === 0) break // (the array itself closed)
      if (--depth === 0) { try { items.push(JSON.parse(text.slice(from, i + 1))) } catch { items.push(null) } }
    }
  }
  return items
}

// A project made safe for the page and the planner: known kinds, levels and tools, keys that are in the photo, a look
// that draws. Returns {project, problems}; project is null when there is nothing to show (no title).
export function checkProject(raw, objects) {
  const problems = []
  if (!raw || typeof raw !== 'object' || typeof raw.title !== 'string' || !raw.title.trim()) return { project: null, problems: ['a project without a title'] }
  const keys = new Set((objects || []).map((o) => o.k))
  const title = raw.title.trim().slice(0, 60)
  const project = { title, kind: KINDS.includes(raw.kind) ? raw.kind : 'other', pitch: typeof raw.pitch === 'string' ? raw.pitch.trim().slice(0, 140) : '' }
  if (Number.isInteger(raw.minutes) && raw.minutes > 0 && raw.minutes <= 2880) project.minutes = raw.minutes
  else problems.push(`${title}: minutes ${JSON.stringify(raw.minutes)} left out`)
  if (LEVELS.includes(raw.level)) project.level = raw.level
  if (project.kind === 'recipe' && Number.isInteger(raw.serves) && raw.serves > 0 && raw.serves <= 50) project.serves = raw.serves
  const uses = Array.isArray(raw.uses) ? raw.uses : []
  project.uses = [...new Set(uses.filter((k) => keys.has(k)))]
  for (const k of uses) if (!keys.has(k)) problems.push(`${title}: uses ${JSON.stringify(k)}, which is not in the photo`)
  if (!project.uses.length) problems.push(`${title}: uses nothing in the photo`)
  const needs = Array.isArray(raw.needs) ? raw.needs : []
  project.needs = [...new Set(needs.filter((k) => TOOL_KINDS.includes(k)))]
  for (const field of ['supplies', 'confirmations']) project[field] = [...new Set((Array.isArray(raw[field]) ? raw[field] : []).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 200)))].slice(0, 16)
  for (const k of needs) if (!TOOL_KINDS.includes(k)) problems.push(`${title}: unknown tool ${JSON.stringify(k)}`)
  const look = checkLook(raw.look)
  project.look = look.look
  problems.push(...look.problems.map((p) => `${title}: ${p}`))
  if (!project.look.length) problems.push(`${title}: no look to draw`)
  // A build of wood (boards, logs) can have no part longer than its longest piece of wood: such a card is left out
  // (a 40 cm bench seat drawn from 35 cm logs). Yarn, food, bricks and everyday things become other shapes, so pass.
  const stock = project.uses.map((k) => objects.find((o) => o.k === k)).filter(Boolean)
  const wood = stock.length && stock.every((o) => isLog(o) || (o.w > 0 && o.thick > 0) || /\b(boards?|planks?|battens?|timber|lumber|plywood|offcuts?)\b/i.test(o.n || ''))
  if (['build', 'craft'].includes(project.kind) && wood) {
    const longest = Math.max(...stock.map((o) => +o.cm || 0)), part = Math.max(0, ...project.look.filter((s) => s.s !== 'brick').map((s) => Math.max(...s.d)))
    if (longest > 0 && part > longest * 1.1 + 1) return { project: null, problems: [...problems, `${title}: left out — a ${+part.toFixed(1)} cm part, but the longest wood is ${longest} cm`] }
  }
  return { project, problems }
}

// The sizes an object gives that are only estimates (none confirmed: a single photo confirms nothing by itself).
const estimated = (o) => {
  const fields = ['cm', 'w', 'thick'].filter((f) => typeof o[f] === 'number' && o.measurements?.[f]?.status !== 'confirmed')
  return fields.length ? { estimated: fields } : {}
}

export async function writeCatalogue(dir, photo, options = {}) {
  const count = options.count ?? 20
  const out = join(dir, 'catalogue')
  mkdirSync(out, { recursive: true })
  const inventory = options.inventory ? fitBoxes(options.inventory, photo) : null
  // ([[objects]]…[[/objects]]: asking for the objects; [[given]]…[[/given]]: telling the model them, when given)
  const keep = inventory ? 'given' : 'objects', drop = inventory ? 'objects' : 'given'
  const prompt = readFileSync(new URL('../../prompts/catalogue-prompt.txt', import.meta.url), 'utf8')
    .replace(new RegExp(`\\[\\[${drop}\\]\\][\\s\\S]*?\\[\\[/${drop}\\]\\]\\n?`, 'g'), '').replace(new RegExp(`\\[\\[/?${keep}\\]\\]`, 'g'), '')
    .replace(/\{\{(\w+)\}\}/g, (_, key) => ({ photo: 'photo.jpg', width: photo.width, height: photo.height, count,
      inventory: inventory && JSON.stringify(inventory.map((o) => ({ k: o.k, n: o.n, cm: o.cm, ...(Array.isArray(o.part?.size) ? { size: o.part.size } : o.w && o.thick ? { size: [o.cm, o.w, o.thick] } : {}), ...estimated(o) }))),
      materials: MATERIALS }[key]))
    + guidancePrompt(options.guidance ? { messages: options.guidance.messages } : null)
  writeFileSync(join(out, 'prompt.txt'), prompt)
  let objects = null
  const projects = [], problems = [], titles = new Set()
  let seen = 0
  const publishObjects = (list) => {
    list = fitBoxes(list, photo)
    if (objects || !Array.isArray(list) || validateObjects(list, photo).length) return
    objects = list
    options.onObjects?.(objects)
  }
  // Each project once, in order, as it closes. (The objects come first in the answer: their key sorts first, and Meta
  // writes keys in order. Projects that close before them wait for them, for their keys to be checked.)
  const publishProjects = (items) => {
    if (!objects) return
    for (; seen < items.length; seen++) {
      const { project, problems: found } = checkProject(items[seen], objects)
      problems.push(...found)
      if (!project || titles.has(project.title.toLowerCase())) continue
      titles.add(project.title.toLowerCase())
      projects.push(project)
      options.onProject?.(projects.length - 1, project)
    }
  }
  const stream = (text) => {
    if (!objects) publishObjects(streamedObjects(text))
    publishProjects(streamedItems(text, 'projects'))
  }
  if (inventory) {
    const problems = validateObjects(inventory, photo)
    if (problems.length) throw new Error(`The inventory does not pass: ${problems.join('; ')}`)
    objects = inventory
  }
  // (the model reads the photo from this folder: the JPEG preparePhoto wrote beside the PNG)
  const jpeg = photo.path.replace(/\.png$/, '.jpg')
  if (existsSync(jpeg) && resolve(jpeg) !== resolve(out, 'photo.jpg')) copyFileSync(jpeg, join(out, 'photo.jpg'))
  const response = await generate(out, prompt, { ...options, out: 'out.json', maxTokens: options.maxTokens ?? 32000,
    model: options.model ?? process.env.CATALOGUE_MODEL ?? undefined,
    responseFormat: { type: 'json_schema', json_schema: { name: 'Catalogue', schema: catalogueSchema(count, { withObjects: !inventory }) } }, images: ['photo.jpg'],
    onText: (text) => { options.onText?.(text); stream(text) } })
  let answer = null
  try { answer = json(response.text) } catch (error) { problems.push(`the answer is not JSON: ${error.message}`) }
  if (answer) {
    publishObjects(answer.objects)
    if (!objects) throw new Error(`The catalogue's objects do not pass: ${validateObjects(fitBoxes(answer.objects, photo), photo).join('; ') || 'none given'}`)
    publishProjects(Array.isArray(answer.projects) ? answer.projects : [])
  } else if (!objects) throw new Error('The catalogue answer could not be read')
  const { text, ...call } = response
  const catalogue = { status: projects.length ? 'ready' : 'empty', photo: { width: photo.width, height: photo.height }, objects, projects, problems, call }
  writeFileSync(join(dir, 'catalogue.json'), JSON.stringify(catalogue, null, 1))
  return catalogue
}

// ---- the command line, followed by server.mjs ----
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
  const valued = ['--effort', '--count']
  const [photoPath, runDir] = args.filter((a, i) => !a.startsWith('--') && !valued.includes(args[i - 1])).map((p) => resolve(p))
  const started = performance.now()
  const mark = (name) => console.log(`${((performance.now() - started) / 1000).toFixed(2).padStart(7)}s  ${name}`)
  const dir = join(runDir, 'catalogue')
  mkdirSync(join(dir, 'projects'), { recursive: true })
  mark('start')
  const photo = await preparePhoto(photoPath, join(runDir, 'script'))
  let first = false
  writeCatalogue(runDir, photo, { effort: flag('--effort', 'low'), noThinking: args.includes('--no-thinking'), count: +flag('--count', 20),
    onText: (text) => { if (!first && text) { first = true; mark('catalogue: first text') } },
    onObjects: (objects) => { writeFileSync(join(dir, 'objects.json'), JSON.stringify(objects)); mark('catalogue: object list') },
    onProject: (i, project) => { writeFileSync(join(dir, 'projects', `${i}.json`), JSON.stringify(project)); mark(`project: ${i}`) },
  }).then((c) => { mark(c.projects.length ? 'catalogue: done' : 'catalogue: empty'); console.log(`${c.projects.length} projects, ${c.problems.length} problems; $${(c.call.cost ?? 0).toFixed(3)}`) })
    .catch((error) => { console.error(error.message); process.exitCode = 1 })
}
