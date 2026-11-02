import { refusedIn, data } from '../pipeline/words.mjs'

// Checks run only on Node's watchdog-limited VM, never by evaluating generated code in the host process.
import { Script, createContext, constants } from 'node:vm'

// Both common coordinate conventions are supported by the validator and the film runtime.
export function demoPoint(x, y) {
  const point = [x, y]
  point.x = x; point.y = y
  return point
}

// Keep generated scene.draw poses identical in the watchdog and the player.
export function demoPose(delta, size) {
  if (delta == null) return {}
  if (typeof delta !== 'object' || Array.isArray(delta)) throw Error('drawing pose must be an object')
  const pose = { ...delta }
  // Explicit positions locate the drawing's origin unless an anchor is supplied.
  // With no position overrides the actor keeps its existing pose and anchor.
  if (pose.anchor == null && pose.x != null && pose.y != null) pose.anchor = [0, 0]
  if (pose.anchor === 'center') pose.anchor = [size.width / 2, size.height / 2]
  if (pose.anchor != null && (!Array.isArray(pose.anchor) || pose.anchor.length !== 2 || !pose.anchor.every(Number.isFinite))) throw Error('drawing anchor must be center or two finite coordinates')
  for (const key of ['x', 'y', 'angle', 'scale', 'alpha']) if (pose[key] != null && !Number.isFinite(pose[key])) throw Error('drawing pose must have finite numbers')
  if (pose.scale != null && pose.scale <= 0) throw Error('drawing scale must be positive')
  return pose
}

// Record one bounded frame before painting it: whole actors sit beneath the clipped
// operation marks. Actor fallback is decided each frame, including conditional draws.
export function demonstrationFrame(clip, p, env, scene, canvas, guard) {
  const commands = [], values = {}, stack = [], draws = new Map()
  const recording = new Proxy({}, {
    get: (_, k) => {
      if (k in values) return values[k]
      if (typeof canvas[k] !== 'function') return canvas[k]
      return (...args) => {
        if (k === 'measureText') {
          canvas.save()
          if (values.font != null) canvas.font = values.font
          try { return canvas.measureText(...args) } finally { canvas.restore() }
        }
        if (k === 'save') stack.push({ ...values })
        if (k === 'restore') {
          const saved = stack.pop() || {}
          for (const key of Object.keys(values)) delete values[key]
          Object.assign(values, saved)
        }
        commands.push([k, args])
      }
    },
    set: (_, k, v) => { values[k] = v; commands.push([k, v]); return true },
  })
  const bounded = drawingContext(recording, guard)
  try { clip(bounded.ctx, p, env, { point: scene.point, point01: scene.point01, draw: (k, delta) => {
    if (draws.has(k)) throw Error('actor drawn twice')
    scene.check(k)
    draws.set(k, delta)
  } }) } finally { bounded.finish() }
  return { draws, paint: () => {
    for (const [key, value] of commands) {
      if (Array.isArray(value)) canvas[key](...value)
      else canvas[key] = value
    }
  } }
}

// Embedded unchanged in the film and in the local validator. Restore cannot escape the caller's clip.
// Is a colour too close to the paper to be seen on it? (A white paperclip drawn #f2f2f2 on the film's cream paper
// vanished.) Contrast ratio as WCAG defines it, under 1.6 counts as pale. Self-contained: the film's runtime gets its
// source too. Colours it cannot read (gradients, names) count as not pale.
export function paleOn(paper) {
  const rgb = (c) => {
    if (typeof c !== 'string') return null
    let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim())
    if (m) { const h = m[1].length === 3 ? m[1].replace(/./g, (x) => x + x) : m[1]; return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) }
    m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(c.trim())
    if (m) return [+m[1], +m[2], +m[3]]
    if (/^white$/i.test(c.trim())) return [255, 255, 255]
    return null
  }
  const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
  const p = rgb(paper), lp = p ? lum(p) : 1
  return (c) => { const q = rgb(c); if (!q) return false; const l = lum(q); return (Math.max(l, lp) + 0.05) / (Math.min(l, lp) + 0.05) < 1.6 }
}

// guard (optional): {pale, ink}. Pale strokes get an ink casing under them, pale fills an ink outline, pale text is
// written in ink: whatever colour the model chose, the operation stays visible on the paper.
export function drawingContext(canvas, guard) {
  const methods = new Set(['save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'bezierCurveTo', 'quadraticCurveTo',
    'arc', 'arcTo', 'ellipse', 'rect', 'roundRect', 'fill', 'stroke', 'fillRect', 'strokeRect', 'fillText', 'strokeText',
    'translate', 'rotate', 'scale', 'transform', 'setLineDash', 'clip', 'measureText'])
  const properties = new Set(['fillStyle', 'strokeStyle', 'lineWidth', 'lineCap', 'lineJoin', 'font', 'textAlign', 'textBaseline', 'globalAlpha'])
  let calls = 0, depth = 0
  const ctx = new Proxy({}, { get: (_, k) => {
    if (properties.has(k)) return canvas[k]
    if (!methods.has(k)) throw Error('Unsupported drawing operation')
    return (...args) => {
      if (++calls > 512) throw Error('Demonstration drawing budget exceeded')
      if (args.some((v) => typeof v === 'number' && !Number.isFinite(v))) throw Error('Non-finite drawing coordinate')
      if (k === 'save') depth++
      if (k === 'restore' && --depth < 0) { depth = 0; throw Error('Unbalanced drawing restore') }
      if (guard) {
        if ((k === 'stroke' || k === 'strokeRect') && guard.pale(canvas.strokeStyle)) {
          const style = canvas.strokeStyle, width = canvas.lineWidth
          canvas.strokeStyle = guard.ink; canvas.lineWidth = width + 3; canvas[k](...args)
          canvas.strokeStyle = style; canvas.lineWidth = width
        } else if ((k === 'fill' || k === 'fillRect') && guard.pale(canvas.fillStyle)) {
          canvas[k](...args)
          const style = canvas.strokeStyle, width = canvas.lineWidth
          canvas.strokeStyle = guard.ink; canvas.lineWidth = 2
          if (k === 'fillRect') canvas.strokeRect(...args); else canvas.stroke(...args.filter((a) => typeof a === 'object'))
          canvas.strokeStyle = style; canvas.lineWidth = width
          return
        } else if (k === 'fillText' && guard.pale(canvas.fillStyle)) {
          const style = canvas.fillStyle; canvas.fillStyle = guard.ink; canvas.fillText(...args); canvas.fillStyle = style; return
        }
      }
      return canvas[k](...args)
    }
  }, set: (_, k, v) => {
    if (!properties.has(k) || !['string', 'number'].includes(typeof v) || typeof v === 'number' && !Number.isFinite(v)) throw Error('Unsupported drawing property')
    canvas[k] = v; return true
  } })
  return { ctx, finish: () => { const n = depth; while (depth > 0) { canvas.restore(); depth-- } if (n) throw Error('Unbalanced drawing save') } }
}

// Trusted templates produce schematic technique drawings; they never synthesize project outcomes or states.
export function demonstrationDrawing(demo) {
  if (!demo?.technique) return demo?.draw
  if (demo.technique !== 'weave-ends' || demo.draw != null) throw new Error('Use one supported technique or custom drawing code')
  const { piece, yarn, needle, path, actors } = demo
  if (![piece, yarn, needle].every(k => typeof k === 'string' && actors?.includes(k)) || new Set([piece, yarn, needle]).size !== 3)
    throw new Error('Weaving ends needs distinct declared piece, yarn and needle actors')
  if (!Array.isArray(path) || path.length < 3 || path.length > 12 || path.some(q => !Array.isArray(q) || q.length !== 2 || !q.every(v => Number.isFinite(v) && v >= 0 && v <= 1))
    || path.slice(1).some((q, i) => Math.hypot(q[0] - path[i][0], q[1] - path[i][1]) < 0.01))
    throw new Error('Weaving ends needs 3–12 distinct successive normalized path points')
  if (demo.color != null && !/^#[\da-f]{6}$/i.test(demo.color)) throw new Error('Invalid weaving thread color')
  // Alternating segments pass under/over existing stitches. The tail shortens as the needle advances.
  return `(ctx,p,env,scene)=>{
    const points=${data(path)}.map(q=>scene.point01(${data(piece)},q));
    const progress=p*(points.length-1), index=Math.min(points.length-2,Math.floor(progress)), u=progress-index;
    const a=points[index], b=points[index+1], x=a.x+(b.x-a.x)*u, y=a.y+(b.y-a.y)*u;
    scene.draw(${data(needle)},{alpha:0});
    ctx.strokeStyle=${data(demo.color || '#427c83')};ctx.lineWidth=3;ctx.lineCap="round";
    for(let i=0;i<points.length-1;i++){if(i>progress)break;const f=Math.min(1,progress-i);
      ctx.globalAlpha=i%2?0.35:1;ctx.beginPath();ctx.moveTo(points[i].x,points[i].y);
      ctx.lineTo(points[i].x+(points[i+1].x-points[i].x)*f,points[i].y+(points[i+1].y-points[i].y)*f);ctx.stroke();}
    ctx.globalAlpha=1;ctx.beginPath();ctx.moveTo(x,y);ctx.quadraticCurveTo(x+14*(1-p),y+14*(1-p),x+32*(1-p),y+8*(1-p));ctx.stroke();
    ctx.strokeStyle=env.palette.ink;ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(x-9,y+4);ctx.lineTo(x+9,y-4);ctx.stroke();
  }`
}

// Long enough for a valid drawing on a busy machine, since a false refusal costs a paid repair; endless loops still stop here.
const CHECK_MS = 250

export function checkDemonstration(demo) {
  let drawing
  try { drawing = demonstrationDrawing(demo) } catch (error) { return error.message }
  if (typeof drawing !== 'string') return 'a demonstration needs drawing code'
  if (!Array.isArray(demo.actors) || !demo.actors.length || demo.actors.some((k) => typeof k !== 'string' || !k)
      || new Set(demo.actors).size !== demo.actors.length) return 'demonstration actors must be unique nonempty keys'
  if (drawing.length > 16000) return 'demonstration drawing exceeds 16000 characters'
  const refused = refusedIn(drawing)
  if (refused.length) return `demonstration has refused words: ${refused.join(', ')}`
  try {
    const sample = new Script(`const actors = new Set(${JSON.stringify(demo.actors)}), drawn = new Set();
      const canvas = new Proxy({}, { get: (_, k) => k === 'measureText' ? () => ({ width: 100 }) : () => {}, set: () => true });
      const paleOn = ${paleOn.toString()};
      const makeContext = ${drawingContext.toString()};
      const env = { width: 1600, height: 900, font: 'Inter', mono: 'JetBrains Mono', palette: { ink: '#1d2b4f', accent: '#ffcc00', background: '#f3efe6' } };
      const makePoint = ${demoPoint.toString()}, makePose = ${demoPose.toString()};
      const scene = { point01: (k, xy) => { if (!actors.has(k)) throw Error('undeclared actor'); return makePoint(xy[0]*100, xy[1]*100); },
        point: (k) => { if (!actors.has(k)) throw Error('undeclared actor'); return makePoint(100, 100); },
        draw: (k, delta) => { if (!actors.has(k)) throw Error('undeclared actor'); makePose(delta, { width: 100, height: 100 }); if (drawn.has(k)) throw Error('actor drawn twice'); drawn.add(k); } };
      const draw = (${drawing}); if (typeof draw !== 'function') throw Error('drawing must be a function');
      for (const p of [0, 0.25, 0.5, 0.75, 1]) { drawn.clear(); const bounded = makeContext(canvas, { pale: paleOn('#f3efe6'), ink: '#1d2b4f' });
        const result = draw(bounded.ctx, p, env, scene); if (result && typeof result.then === 'function') throw Error('Async drawing is unsupported'); bounded.finish(); }`)
    // A contextified host object would expose the host's Function through this.constructor: generated code must see
    // only its own global. (vm limits accidents; the worker also keeps no storage credentials. See job-worker.mjs.)
    sample.runInContext(createContext(constants.DONT_CONTEXTIFY, { codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' }), { timeout: CHECK_MS })
  } catch (e) { return `demonstration failed: ${e.message}` }
  return null
}

export function demonstrationSources(script) {
  return (script.steps || []).flatMap((s) => s.do || []).map((a) => a.demo ? demonstrationDrawing(a.demo) : null)
}
