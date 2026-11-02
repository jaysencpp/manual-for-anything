// Read-and-explain mode: typed text, never segmented glyphs or model-written animation code.
import { data } from './words.mjs'

const string = { type: 'string' }, strings = { type: 'array', items: string }
export const PROBLEM_SCHEMA = { type: 'object', properties: {
  title: string, subject: string, status: { enum: ['solved', 'needs_clarification', 'unsupported'] },
  transcription: string, expression: string, assumptions: strings, uncertainties: strings,
  steps: { type: 'array', maxItems: 200, items: { type: 'object', properties: { title: string, expression: string, explanation: string }, required: ['title', 'expression', 'explanation'] } },
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
export function problemProgram(p) {
  const validation = validateProblem(p)
  if (!validation.valid) throw Error(`Invalid problem: ${validation.errors.join('; ')}`)
  const times = problemTimeline(p)
  return { duration: times.duration, source: `(ctx,t,env)=>{
    const P=${data(p)}, T=${data(times)}, W=env.width, H=env.height;
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
    else if(t<T.finale){const s=P.steps[i];line((i+1)+". "+s.title,420,410,30);wrap(s.expression,420,485,W-510,46,3);wrap(s.explanation,420,665,W-510,26,4);}
    else{line("Answer",420,410,30);wrap(P.answer,420,485,W-510,46,3);line("Check",420,650,24);wrap(P.verification,420,695,W-510,24,3);}
  }` }
}
