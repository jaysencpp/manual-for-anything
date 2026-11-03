// Read-and-explain mode: typed text, never segmented glyphs or model-written animation code.
import { data } from './words.mjs'

const string = { type: 'string' }, strings = { type: 'array', items: string }, number = { type: 'number' }, flag = { type: 'boolean' }
const list = (properties, required, maxItems) => ({ type: 'array', maxItems, items: { type: 'object', properties, required } })
// A step's diagram: named points in the problem's own units (y up), the segments between them, and angle marks. The
// film draws it to scale and, where a point keeps its id from one step's diagram to the next, moves it there.
// (a label is a name or a value — "A", "h", "5 m" — short enough to stand beside its line without crowding the figure)
export const DIAGRAM_LIMITS = { points: 24, segments: 40, angles: 12, label: 16 }
const DIAGRAM = { type: 'object', properties: {
  units: string,
  points: list({ id: string, x: number, y: number, label: string }, ['id', 'x', 'y'], DIAGRAM_LIMITS.points),
  segments: list({ from: string, to: string, label: string, dashed: flag, accent: flag, surface: flag }, ['from', 'to'], DIAGRAM_LIMITS.segments),
  angles: list({ at: string, from: string, to: string, label: string, right: flag }, ['at', 'from', 'to'], DIAGRAM_LIMITS.angles),
}, required: ['points', 'segments'] }
export const PROBLEM_SCHEMA = { type: 'object', properties: {
  title: string, subject: string, status: { enum: ['solved', 'needs_clarification', 'unsupported'] },
  transcription: string, expression: string, assumptions: strings, uncertainties: strings,
  steps: { type: 'array', maxItems: 200, items: { type: 'object', properties: { title: string, expression: string, explanation: string, diagram: DIAGRAM }, required: ['title', 'expression', 'explanation'] } },
  answer: string, verification: string,
}, required: ['title', 'subject', 'status', 'transcription', 'expression', 'assumptions', 'uncertainties', 'steps', 'answer', 'verification'] }

// Bounded one-variable linear algebra, with no eval. Unsupported notation is explicitly left unchecked.
function linearEquation(text) {
  const input = text.replaceAll('−', '-').replaceAll('×', '*').replaceAll('÷', '/').trim()
  if (input.length > 1000 || !/^[\dA-Za-z+*/().=\s-]+$/.test(input) || input.split('=').length !== 2) return null
  const variables = [...new Set(input.match(/[A-Za-z]/g) || [])]
  if (variables.length !== 1) return null
  const tokens = input.match(/\d+(?:\.\d+)?|\.\d+|[A-Za-z+*/()=-]/g) || []
  if (tokens.length > 250) return null
  let at = 0
  const add = (x, y, sign = 1) => [x[0] + sign * y[0], x[1] + sign * y[1]]
  const atom = () => {
    const t = tokens[at++]
    if (t === '+' || t === '-') { const x = atom(); return t === '-' ? x.map((n) => -n) : x }
    if (t === '(') { const x = sum(); if (tokens[at++] !== ')') throw Error(); return x }
    if (/^\d|^\./.test(t || '')) return [0, Number(t)]
    if (t === variables[0]) return [1, 0]
    throw Error()
  }
  const product = () => {
    let x = atom()
    while (at < tokens.length) {
      const t = tokens[at], implicit = t === '(' || /^[A-Za-z\d.]$/.test(t || '')
      if (!['*', '/'].includes(t) && !implicit) break
      if (!implicit) at++
      const y = atom()
      if (t === '/') { if (y[0] || !y[1]) throw Error(); x = x.map((n) => n / y[1]) }
      else { if (x[0] && y[0]) throw Error(); x = [x[0] * y[1] + y[0] * x[1], x[1] * y[1]] }
    }
    return x
  }
  const sum = () => { let x = product(); while (['+', '-'].includes(tokens[at])) { const t = tokens[at++]; x = add(x, product(), t === '-' ? -1 : 1) } return x }
  try {
    const left = sum(); if (tokens[at++] !== '=') return null
    const right = sum(); if (at !== tokens.length) return null
    const [a, b] = add(left, right, -1)
    if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) < 1e-12) return null
    const value = -b / a
    return Number.isFinite(value) ? { variable: variables[0], value } : null
  } catch { return null }
}

// A diagram's own checks: what it names exists, it fits the frame's limits, and a label giving a length in the diagram's
// units is the length the points draw (a "5 m" ladder is 5 m between its ends), so a drawing never shows a size it is not.
export function diagramProblems(d, where) {
  const errors = [], text = (v) => v == null || (typeof v === 'string' && v.length <= DIAGRAM_LIMITS.label)
  if (!d || typeof d !== 'object' || Array.isArray(d)) return [`${where}: a diagram is an object with points and segments`]
  const points = Array.isArray(d.points) ? d.points : [], segments = Array.isArray(d.segments) ? d.segments : [], angles = d.angles == null ? [] : d.angles
  if (!Array.isArray(d.points) || !points.length || points.length > DIAGRAM_LIMITS.points) errors.push(`${where}: a diagram needs 1–${DIAGRAM_LIMITS.points} points`)
  if (!Array.isArray(d.segments) || segments.length > DIAGRAM_LIMITS.segments) errors.push(`${where}: a diagram has at most ${DIAGRAM_LIMITS.segments} segments`)
  if (!Array.isArray(angles) || angles.length > DIAGRAM_LIMITS.angles) errors.push(`${where}: a diagram has at most ${DIAGRAM_LIMITS.angles} angle marks`)
  if (d.units != null && (typeof d.units !== 'string' || d.units.length > 12)) errors.push(`${where}: diagram units are a short unit name such as "m"`)
  const at = new Map()
  for (const q of points) {
    if (!q || typeof q.id !== 'string' || !/^[\w-]{1,24}$/.test(q.id) || at.has(q.id)) { errors.push(`${where}: diagram points need unique short ids`); continue }
    if (![q.x, q.y].every((v) => Number.isFinite(v) && Math.abs(v) <= 1e6)) errors.push(`${where}: point ${q.id} needs finite x and y`)
    if (!text(q.label)) errors.push(`${where}: point ${q.id}'s label is at most ${DIAGRAM_LIMITS.label} characters`)
    at.set(q.id, q)
  }
  const known = (id) => at.has(id)
  for (const g of segments) {
    if (!g || !known(g.from) || !known(g.to) || g.from === g.to) { errors.push(`${where}: a segment joins two different points of the diagram`); continue }
    if (!text(g.label)) errors.push(`${where}: segment ${g.from}–${g.to}'s label is at most ${DIAGRAM_LIMITS.label} characters`)
    // (the last number in the label, when it is in the diagram's units: "5 m", "h = 4 m", "4")
    const m = typeof g.label === 'string' && /(-?\d+(?:\.\d+)?)\s*([A-Za-z]*)\s*$/.exec(g.label)
    if (m && (!m[2] || m[2] === d.units)) {
      const a = at.get(g.from), b = at.get(g.to), length = Math.hypot(b.x - a.x, b.y - a.y), said = +m[1]
      if (Math.abs(length - said) > Math.max(0.02 * said, 1e-6)) errors.push(`${where}: segment ${g.from}–${g.to} is labelled ${g.label} but its points are ${+length.toFixed(3)}${d.units ? ' ' + d.units : ''} apart: draw it to scale`)
    }
  }
  for (const a of angles) {
    if (!a || ![a.at, a.from, a.to].every(known) || new Set([a.at, a.from, a.to]).size !== 3) { errors.push(`${where}: an angle mark names its corner and two other points of the diagram`); continue }
    if (!text(a.label)) errors.push(`${where}: angle ${a.at}'s label is at most ${DIAGRAM_LIMITS.label} characters`)
    const o = at.get(a.at), u = at.get(a.from), v = at.get(a.to)
    const cos = ((u.x - o.x) * (v.x - o.x) + (u.y - o.y) * (v.y - o.y)) / ((Math.hypot(u.x - o.x, u.y - o.y) * Math.hypot(v.x - o.x, v.y - o.y)) || 1)
    if (a.right && Math.abs(cos) > 0.02) errors.push(`${where}: the right angle at ${a.at} is ${+(Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI).toFixed(1)}° as drawn`)
  }
  const xs = points.map((q) => q?.x).filter(Number.isFinite), ys = points.map((q) => q?.y).filter(Number.isFinite)
  if (points.length > 1 && Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) <= 0) errors.push(`${where}: a diagram's points cannot all be in one place`)
  return errors
}

export function validateProblem(p) {
  const errors = [], warnings = []
  const text = (s) => typeof s === 'string' && !!s.trim()
  if (!p || typeof p !== 'object') return { valid: false, errors: ['problem must be an object'], warnings }
  for (const f of ['title', 'subject', 'transcription']) if (typeof p[f] !== 'string' || !p[f].trim() || p[f].length > 6000) errors.push(`problem.${f} needs readable text (at most 6000 characters)`)
  for (const f of ['expression', 'answer', 'verification']) if (typeof p[f] !== 'string' || p[f].length > 6000) errors.push(`problem.${f} must be text (at most 6000 characters)`)
  for (const [f, limit] of [['title', 80], ['subject', 80], ['expression', 240], ['answer', 240], ['verification', 400]]) if (typeof p[f] === 'string' && p[f].length > limit) errors.push(`problem.${f} exceeds its readable ${limit}-character limit; split the explanation into more steps`)
  for (const f of ['assumptions', 'uncertainties']) if (!Array.isArray(p[f]) || p[f].length > 30 || p[f].some((s) => typeof s !== 'string' || s.length > 1000)) errors.push(`problem.${f} must be a bounded text array`)
  if (!['solved', 'needs_clarification', 'unsupported'].includes(p.status)) errors.push('problem.status is invalid')
  if (!Array.isArray(p.steps) || p.steps.length > 200 || p.steps.some((s) => !s || ['title', 'expression', 'explanation'].some((f) => typeof s[f] !== 'string' || s[f].length > 3000))) errors.push('problem.steps must contain bounded titled explanations and expressions')
  if (Array.isArray(p.steps) && p.steps.some((s) => s && (s.title?.length > 80 || s.expression?.length > 240 || s.explanation?.length > 400))) errors.push('problem steps need titles ≤80, expressions ≤240 and explanations ≤400 characters; use more steps instead of unreadable cards')
  if (p.status === 'solved' && (!p.steps?.length || !text(p.answer) || !text(p.verification) || p.uncertainties?.length)) errors.push('a solved problem needs steps, an answer, a verification and no unresolved transcription uncertainty')
  if (p.status === 'solved' && Array.isArray(p.steps) && p.steps.some((s) => !text(s?.title) || !text(s?.explanation))) errors.push('each solution step needs a title and an explanation')
  if (Array.isArray(p.steps)) for (const [i, s] of p.steps.entries()) if (s?.diagram != null) errors.push(...diagramProblems(s.diagram, `step ${i + 1}`))
  if (Array.isArray(p.steps)) {
    const units = new Set(p.steps.map((s) => s?.diagram).filter(Boolean).map((d) => d.units ?? ''))
    if (units.size > 1) errors.push('problem diagrams share one scale: give every diagram the same units')
  }
  if (p.status !== 'solved' && (p.steps?.length || text(p.answer) || !p.uncertainties?.length)) errors.push('an unclear/unsupported problem must state what is missing and give no speculative solution')
  let check = { status: 'not_checked', detail: 'General mathematical correctness is not independently checked.' }
  if (!errors.length && p.status === 'solved') {
    const original = linearEquation(p.expression)
    if (original) {
      let checked = 0, skipped = 0
      for (const [i, expression] of [...p.steps.map((s) => s.expression), p.answer].entries()) {
        const next = linearEquation(expression)
        if (!next) { skipped++; continue }
        checked++
        if (next.variable !== original.variable || Math.abs(next.value - original.value) > 1e-8 * Math.max(1, Math.abs(original.value))) errors.push(`problem: step/answer ${i + 1} changes the solution of the original linear equation`)
      }
      check = { status: checked && !skipped && !errors.length ? 'verified_linear' : 'partially_checked', detail: `${checked} linear equations checked against the starting equation; ${skipped} expressions use unchecked notation.` }
    }
    if (check.status !== 'verified_linear') warnings.push(check.detail)
  }
  return { valid: !errors.length, errors, warnings, check }
}

export function problemScript(problem) {
  const validation = validateProblem(problem)
  if (!validation.valid) throw Error(`Invalid problem: ${validation.errors.join('; ')}`)
  return { mode: 'problem', problem, title: problem.title, sub: problem.transcription, objects: [], ideas: [], pick: 0,
    steps: problem.steps.map((s) => ({ t: s.title, c: [s.expression, s.explanation].filter(Boolean).join(' — '), do: [] })) }
}
export function problemTimeline(p) {
  const starts = p.steps.map((_, i) => 2.4 + i * 6), finale = 2.4 + p.steps.length * 6
  return { starts, acts: [], steps0: 2.4, finale, end: finale + 7, duration: finale + 9 }
}
// Each step's diagram, the last one given standing until a step gives another, and one frame round all of them: every
// diagram is drawn to the same scale, so a point that moves between steps moves by its real distance.
export function problemDiagrams(p) {
  let last = null
  const frames = (p.steps || []).map((s) => (last = s.diagram || last))
  const all = frames.filter(Boolean).flatMap((d) => d.points)
  if (!all.length) return null
  const x0 = Math.min(...all.map((q) => q.x)), x1 = Math.max(...all.map((q) => q.x)), y0 = Math.min(...all.map((q) => q.y)), y1 = Math.max(...all.map((q) => q.y))
  return { frames, bounds: [x0, y0, x1, y1] }
}

export function problemProgram(p) {
  const validation = validateProblem(p)
  if (!validation.valid) throw Error(`Invalid problem: ${validation.errors.join('; ')}`)
  const times = problemTimeline(p)
  return { duration: times.duration, source: `(ctx,t,env)=>{
    const P=${data(p)}, T=${data(times)}, DG=${data(problemDiagrams(p))}, W=env.width, H=env.height;
    const TW=DG?600:W-510;
    const ink=env.palette.ink, paper=env.palette.background;
    ctx.fillStyle=paper;ctx.fillRect(0,0,W,H);
    const line=(text,x,y,size,color=ink)=>{ctx.fillStyle=color;ctx.font="600 "+size+"px "+env.font;const measured=ctx.measureText(text).width;if(measured>W-x-48){size=Math.max(18,size*(W-x-48)/measured);ctx.font="600 "+size+"px "+env.font;}ctx.fillText(text,x,y);};
    const wrap=(text,x,y,width,size,max)=>{let rows=[];
      const layout=()=>{ctx.font="500 "+size+"px "+env.font;rows=[];let row="";
        for(const word of String(text).split(/\\s+/)){if(ctx.measureText(word).width>width){if(row){rows.push(row);row="";}for(const ch of word){if(row&&ctx.measureText(row+ch).width>width){rows.push(row);row="";}row+=ch;}}
          else{const next=row?row+" "+word:word;if(row&&ctx.measureText(next).width>width){rows.push(row);row=word;}else row=next;}}
        if(row)rows.push(row);};
      layout();while(rows.length>max&&size>16){size-=2;layout();}ctx.fillStyle=ink;rows.forEach((row,i)=>ctx.fillText(row,x,y+i*size*1.4));};
    line(P.title,48,84,42);line(P.subject,48,128,24);
    const image=env.screens.photo, scale=image?Math.min(300/image.width,400/image.height):1;
    env.drawScreen(ctx,"photo",48,210,image?image.width*scale:300,image?image.height*scale:400);
    ctx.fillStyle="#ffffff";ctx.fillRect(390,180,W-438,H-230);
    line("Problem as read",420,225,22);wrap(P.transcription.length>200?P.transcription.slice(0,200)+" …":P.transcription,420,270,W-510,30,3);
    let i=0;while(i+1<T.starts.length&&t>=T.starts[i+1])i++;
    if(P.status!=="solved"){line("Check the reading",420,425,34);wrap(P.uncertainties.join(" "),420,485,W-510,30,6);}
    else if(t<T.steps0){line("Starting expression",420,445,26);wrap(P.expression,420,510,W-510,46,3);}
    else if(t<T.finale){const s=P.steps[i];line((i+1)+". "+s.title,420,410,30);wrap(s.expression,420,485,TW,DG?38:46,DG?4:3);wrap(s.explanation,420,665,TW,26,DG?5:4);}
    else{line("Answer",420,410,30);wrap(P.answer,420,485,TW,DG?38:46,3);line("Check",420,650,24);wrap(P.verification,420,695,TW,24,DG?5:3);}
    if(DG&&P.status==="solved"&&t>=T.steps0)diagram(t>=T.finale?DG.frames.length-1:i,t>=T.finale?1:Math.min(1,Math.max(0,(t-T.starts[i])/1.4)));
    function diagram(k,raw){
      const now=DG.frames[k];if(!now)return;
      const before=k>0&&DG.frames[k-1]&&DG.frames[k-1]!==now?DG.frames[k-1]:null, u=raw<0.5?2*raw*raw:1-Math.pow(-2*raw+2,2)/2;
      // (the frame: the right of the card under the problem as read, round every diagram's points with room for labels)
      const bx=1100,by=410,bw=380,bh=380,[x0,y0,x1,y1]=DG.bounds,sx=x1-x0||1,sy=y1-y0||1,k1=Math.min(bw/sx,bh/sy);
      const ox=bx+(bw-sx*k1)/2,oy=by+bh-(bh-sy*k1)/2;
      const at=(q)=>({x:ox+(q.x-x0)*k1,y:oy-(q.y-y0)*k1});
      const pts=new Map(),was=new Map();
      for(const q of now.points){const b=before&&before.points.find((r)=>r.id===q.id);const a=at(q),c=b?at(b):a;pts.set(q.id,{x:c.x+(a.x-c.x)*u,y:c.y+(a.y-c.y)*u,q});}
      if(before)for(const q of before.points)if(!pts.has(q.id))was.set(q.id,{...at(q),q});
      const where=(id)=>pts.get(id)||was.get(id);
      // (labels stand away from the middle of the figure itself: the points its lines join, not a wall's or floor's far end)
      const used=new Set(now.segments.filter((g)=>!g.surface).flatMap((g)=>[g.from,g.to])), mid=[...pts.values()].filter((q)=>used.has(q.q.id)), all=mid.length?mid:[...pts.values()];
      const cx=all.reduce((n,q)=>n+q.x,0)/all.length,cy=all.reduce((n,q)=>n+q.y,0)/all.length;
      const key=(g)=>g.from+">"+g.to, has=(d,g)=>d&&d.segments.some((h)=>key(h)===key(g)&&(h.label||"")===(g.label||"")), hasA=(d,a)=>d&&(d.angles||[]).some((b)=>b.at===a.at&&b.from===a.from&&b.to===a.to&&(b.label||"")===(a.label||""));
      const segs=[...now.segments.map((g)=>({g,alpha:!before||has(before,g)?1:u})),...(before?before.segments.filter((g)=>!has(now,g)&&where(g.from)&&where(g.to)).map((g)=>({g,alpha:1-u})):[])];
      const angs=[...(now.angles||[]).map((a)=>({a,alpha:!before||hasA(before,a)?1:u})),...(before?(before.angles||[]).filter((a)=>!hasA(now,a)&&[a.at,a.from,a.to].every(where)).map((a)=>({a,alpha:1-u})):[])];
      const away=(x,y,n)=>{let dx=x-cx,dy=y-cy;const l=Math.hypot(dx,dy)||1;return {x:x+dx/l*n,y:y+dy/l*n};};
      // (a label stays in the diagram's part of the card: never over the step's text, never past the card's edge)
      // (and clear of the labels placed before it: one that would overlap moves up or down until it does not; a label
      // fading out, as another fades in, takes no room)
      const placed=[];
      const tag=(text,x,y,alpha,size)=>{ctx.globalAlpha=alpha;ctx.font="600 "+size+"px "+env.font;const w=ctx.measureText(text).width;x=Math.min(W-64-w/2,Math.max(1040+w/2,x));y=Math.min(H-66,Math.max(390,y));
        const hit=(yy)=>placed.some((b)=>Math.abs(b.x-x)<(b.w+w)/2+6&&Math.abs(b.y-yy)<(b.h+size*1.1)/2+2);
        if(alpha>=0.5){let tries=0,yy=y;while(hit(yy)&&tries<8){tries++;yy=y+(tries%2?-1:1)*Math.ceil(tries/2)*size*1.15;}if(!hit(yy))y=yy;placed.push({x,y,w,h:size*1.1});}ctx.fillStyle="#ffffff";ctx.fillRect(x-w/2-6,y-size*0.75,w+12,size*1.1);ctx.fillStyle=ink;ctx.textAlign="center";ctx.fillText(text,x,y+size*0.25);ctx.textAlign="left";ctx.globalAlpha=1;};
      ctx.lineCap="round";ctx.lineJoin="round";
      for(const {g,alpha} of segs){const a=where(g.from),b=where(g.to);if(!a||!b||alpha<=0)continue;ctx.globalAlpha=alpha;
        if(g.surface){const l=Math.hypot(b.x-a.x,b.y-a.y),n=Math.min(60,Math.floor(l/18)),ux=(b.x-a.x)/(l||1),uy=(b.y-a.y)/(l||1),m=away((a.x+b.x)/2,(a.y+b.y)/2,1),mx=(a.x+b.x)/2,my=(a.y+b.y)/2;
          let nx=-uy,ny=ux;if(nx*(m.x-mx)+ny*(m.y-my)<0){nx=-nx;ny=-ny;}
          ctx.strokeStyle=ink;ctx.lineWidth=1.5;ctx.beginPath();for(let j=0;j<=n;j++){const px=a.x+ux*j*l/(n||1),py=a.y+uy*j*l/(n||1);ctx.moveTo(px,py);ctx.lineTo(px+(nx-ux)*9,py+(ny-uy)*9);}ctx.stroke();}
        if(g.accent){ctx.strokeStyle=env.palette.accent;ctx.lineWidth=12;ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();}
        ctx.strokeStyle=ink;ctx.lineWidth=g.surface?2:g.dashed?2.5:3.5;if(g.dashed){ctx.setLineDash([12,9]);ctx.globalAlpha=alpha*0.55;}ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();ctx.setLineDash([]);ctx.globalAlpha=1;}
      for(const {a,alpha} of angs){const o=where(a.at),p1=where(a.from),p2=where(a.to);if(!o||!p1||!p2||alpha<=0)continue;
        const a1=Math.atan2(p1.y-o.y,p1.x-o.x),a2=Math.atan2(p2.y-o.y,p2.x-o.x);ctx.globalAlpha=alpha;ctx.strokeStyle=ink;ctx.lineWidth=2;
        if(a.right){const s=18,u1=[Math.cos(a1),Math.sin(a1)],u2=[Math.cos(a2),Math.sin(a2)];ctx.beginPath();ctx.moveTo(o.x+u1[0]*s,o.y+u1[1]*s);ctx.lineTo(o.x+(u1[0]+u2[0])*s,o.y+(u1[1]+u2[1])*s);ctx.lineTo(o.x+u2[0]*s,o.y+u2[1]*s);ctx.stroke();}
        else{let d=a2-a1;while(d>Math.PI)d-=2*Math.PI;while(d<-Math.PI)d+=2*Math.PI;ctx.beginPath();ctx.arc(o.x,o.y,34,a1,a1+d,d<0);ctx.stroke();
          if(a.label){const m=a1+d/2;tag(a.label,o.x+Math.cos(m)*62,o.y+Math.sin(m)*62,alpha,20);}}
        ctx.globalAlpha=1;}
      for(const {g,alpha} of segs){if(!g.label||alpha<=0)continue;const a=where(g.from),b=where(g.to);if(!a||!b)continue;
        const mx=(a.x+b.x)/2,my=(a.y+b.y)/2,l=Math.hypot(b.x-a.x,b.y-a.y)||1;let nx=-(b.y-a.y)/l,ny=(b.x-a.x)/l;if(nx*(mx-cx)+ny*(my-cy)<0){nx=-nx;ny=-ny;}
        tag(g.label,mx+nx*30,my+ny*30,alpha,22);}
      for(const q of pts.values()){if(!used.has(q.q.id)&&!q.q.label)continue;ctx.fillStyle=ink;ctx.beginPath();ctx.arc(q.x,q.y,5,0,Math.PI*2);ctx.fill();if(q.q.label){const m=away(q.x,q.y,26);tag(q.q.label,m.x,m.y,1,20);}}
    }
  }` }
}
