import { refusedIn, data } from '../pipeline/words.mjs'

// Checks run only on Node's watchdog-limited VM, never by evaluating generated code in the host process.
import { Script, createContext, constants } from 'node:vm'

// A point given to scene.point as fractions of the actor ([0.5, 0.34]) rather than its own units (cut-out pixels × 4):
// no working point is half a pixel from a corner, so the film reads it as scene.point01 would (models often write it).
export function demoFraction(xy) {
  return Array.isArray(xy) && xy.length === 2 && xy.every((v) => Number.isFinite(v) && v >= 0 && v <= 1) && xy.some((v) => v > 0 && v < 1)
}

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

// A traced drawing's strokes, as plain polylines in fractions of the sheet's box (u from its left, v from its far
// edge): a list of points; {points, smooth, closed, fill}; or {ellipse: [cu, cv, ru, rv], fill} (radii as fractions
// of the sheet's width and height). The film draws these, never model code, and keeps them on the sheet afterwards.
// (total: points a step, a filled stroke's counted twice, since it is drawn twice: within the 512-call frame budget)
export const TRACE_LIMITS = { strokes: 40, points: 64, total: 360 }
export function traceStrokes(strokes) {
  if (!Array.isArray(strokes) || !strokes.length || strokes.length > TRACE_LIMITS.strokes) throw new Error(`Tracing needs 1–${TRACE_LIMITS.strokes} strokes`)
  const onSheet = (q) => Array.isArray(q) && q.length === 2 && q.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)
  const round = (q) => q.map((v) => Math.round(v * 1e4) / 1e4)
  const out = strokes.map((s, i) => {
    const spec = Array.isArray(s) ? { points: s } : s
    if (!spec || typeof spec !== 'object') throw new Error(`Trace stroke ${i + 1} is a list of points, {points} or {ellipse}`)
    if (spec.fill != null && typeof spec.fill !== 'boolean') throw new Error(`Trace stroke ${i + 1}: fill is true or false`)
    let points
    if (spec.ellipse != null) {
      const e = spec.ellipse
      if (!Array.isArray(e) || e.length !== 4 || !e.every(Number.isFinite) || !(e[2] > 0 && e[3] > 0)) throw new Error(`Trace stroke ${i + 1}: ellipse is [centre u, centre v, radius u, radius v]`)
      // (from its top, clockwise, as a hand draws a circle)
      points = Array.from({ length: 25 }, (_, j) => { const a = -Math.PI / 2 + j / 24 * Math.PI * 2; return [e[0] + e[2] * Math.cos(a), e[1] + e[3] * Math.sin(a)] })
    } else {
      points = spec.points
      if (!Array.isArray(points) || points.length < 2 || points.length > TRACE_LIMITS.points) throw new Error(`Trace stroke ${i + 1} needs 2–${TRACE_LIMITS.points} points`)
      if (!points.every(onSheet)) throw new Error(`Trace stroke ${i + 1}: points are [u, v] fractions of the sheet, 0 to 1`)
      if (spec.closed) points = [...points, points[0]]
      // (smooth: corner cutting, twice — a curve through the points' neighbourhood, its ends kept)
      if (spec.smooth) for (let n = 0; n < 2; n++) points = [points[0], ...points.slice(1).flatMap((q, j) => {
        const a = points[j]; return [[a[0] * 0.75 + q[0] * 0.25, a[1] * 0.75 + q[1] * 0.25], [a[0] * 0.25 + q[0] * 0.75, a[1] * 0.25 + q[1] * 0.75]]
      }), points.at(-1)]
    }
    if (!points.every(onSheet)) throw new Error(`Trace stroke ${i + 1} leaves the sheet`)
    if (spec.fill && points.length < 3) throw new Error(`Trace stroke ${i + 1}: a filled stroke needs an area`)
    return { points: points.map(round), fill: !!spec.fill }
  })
  if (out.reduce((n, s) => n + s.points.length * (s.fill ? 2 : 1), 0) > TRACE_LIMITS.total)
    throw new Error(`Tracing draws at most ${TRACE_LIMITS.total} points a step (a smooth stroke's points count 4 each, an ellipse 25, a filled stroke twice): split the drawing over more steps`)
  return out
}

export const TRACE_COLOR = '#3b3b3b'

// A traced step: the tool's tip moves along each stroke while the line grows behind it, lifting between strokes.
function traceDrawing(demo) {
  const { sheet, tool, actors } = demo
  if (![sheet, tool].every((k) => typeof k === 'string' && actors?.includes(k)) || sheet === tool)
    throw new Error('Tracing needs distinct declared sheet and tool actors')
  if (demo.color != null && !/^#[\da-f]{6}$/i.test(demo.color)) throw new Error('Invalid trace line color')
  const strokes = traceStrokes(demo.strokes)
  return `(ctx,p,env,scene)=>{
    const S=${data(strokes)}, P=S.map(s=>s.points.map(q=>scene.point01(${data(sheet)},q)));
    const o=scene.point01(${data(sheet)},[0,0]), r=scene.point01(${data(sheet)},[1,0]), sw=Math.hypot(r.x-o.x,r.y-o.y);
    const lw=Math.max(1.2,sw*0.006), d=(a,b)=>Math.hypot(b.x-a.x,b.y-a.y);
    const len=P.map(s=>{let n=0;for(let i=1;i<s.length;i++)n+=d(s[i-1],s[i]);return n;});
    const hop=P.map((s,i)=>i?d(P[i-1][P[i-1].length-1],s[0])*0.5+sw*0.08:0);
    let total=0;for(let i=0;i<P.length;i++)total+=len[i]+hop[i];
    const u=Math.min(1,Math.max(0,(p-0.08)/0.8));let pos=u*total, tip=P[0][0], lift=0, done=0, part=null;
    if(p<0.08)lift=1-p/0.08;
    for(let i=0;i<P.length;i++){
      if(pos<hop[i]){const a=P[i-1][P[i-1].length-1], f=pos/hop[i];tip={x:a.x+(P[i][0].x-a.x)*f,y:a.y+(P[i][0].y-a.y)*f};lift=Math.sin(Math.PI*f);break;}
      pos-=hop[i];
      if(pos<len[i]||i===P.length-1&&u<1){let k=1;for(;k<P[i].length;k++){const g=d(P[i][k-1],P[i][k]);if(pos<=g){const f=g?pos/g:1;tip={x:P[i][k-1].x+(P[i][k].x-P[i][k-1].x)*f,y:P[i][k-1].y+(P[i][k].y-P[i][k-1].y)*f};break;}pos-=g;}
        part={i,k:Math.min(k,P[i].length-1)};break;}
      done=i+1;tip=P[i][P[i].length-1];
    }
    if(p>0.88)lift=(p-0.88)/0.12;
    scene.draw(${data(tool)},{alpha:0});
    ctx.strokeStyle=${data(demo.color || TRACE_COLOR)};ctx.fillStyle=${data(demo.color || TRACE_COLOR)};ctx.lineWidth=lw;ctx.lineCap="round";ctx.lineJoin="round";
    ctx.beginPath();
    for(let i=0;i<done;i++){ctx.moveTo(P[i][0].x,P[i][0].y);for(let k=1;k<P[i].length;k++)ctx.lineTo(P[i][k].x,P[i][k].y);}
    if(part){const s=P[part.i];ctx.moveTo(s[0].x,s[0].y);for(let k=1;k<part.k;k++)ctx.lineTo(s[k].x,s[k].y);ctx.lineTo(tip.x,tip.y);}
    ctx.stroke();
    for(let i=0;i<done;i++)if(S[i].fill){ctx.beginPath();ctx.moveTo(P[i][0].x,P[i][0].y);for(let k=1;k<P[i].length;k++)ctx.lineTo(P[i][k].x,P[i][k].y);ctx.closePath();ctx.fill();}
    const L=sw*0.75, w=L*0.075;
    ctx.save();ctx.translate(tip.x,tip.y-lift*sw*0.06);ctx.rotate(-1.05);
    ctx.strokeStyle=env.palette.ink;ctx.lineWidth=1.5;
    ctx.fillStyle="#e3c08d";ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(L*0.12,-w/2);ctx.lineTo(L*0.12,w/2);ctx.closePath();ctx.fill();ctx.stroke();
    ctx.fillStyle=${data(demo.color || TRACE_COLOR)};ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(L*0.04,-w/6);ctx.lineTo(L*0.04,w/6);ctx.closePath();ctx.fill();
    ctx.fillStyle="#f2c14e";ctx.fillRect(L*0.12,-w/2,L*0.8,w);ctx.strokeRect(L*0.12,-w/2,L*0.8,w);
    ctx.beginPath();ctx.moveTo(L*0.12,0);ctx.lineTo(L*0.92,0);ctx.stroke();
    ctx.fillStyle="#b9b9b9";ctx.fillRect(L*0.92,-w/2,L*0.04,w);ctx.strokeRect(L*0.92,-w/2,L*0.04,w);
    ctx.fillStyle="#e48a8a";ctx.fillRect(L*0.96,-w/2,L*0.04,w);ctx.strokeRect(L*0.96,-w/2,L*0.04,w);
    ctx.restore();
  }`
}

// Trusted templates produce schematic technique drawings; they never synthesize project outcomes or states.
export function demonstrationDrawing(demo) {
  if (!demo?.technique) return demo?.draw
  if (demo.technique === 'trace' && demo.draw == null) return traceDrawing(demo)
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
