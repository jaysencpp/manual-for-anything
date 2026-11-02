// Bounded reference diagrams. Models describe data; the engine owns drawing and repetition.
import { checkPath, checkPaint } from '../pipeline/drawing-format.mjs'
import { data } from '../pipeline/words.mjs'

export function validateDiagrams(diagrams, facts, { stepCount = Infinity, objectKeys = [] } = {}) {
  if (!Array.isArray(diagrams) || diagrams.length > 64) throw new Error('Expected at most 64 diagrams')
  const seen = new Set()
  for (const diagram of diagrams) {
    if (!Number.isInteger(diagram.step) || diagram.step < 0 || diagram.step >= stepCount || seen.has(diagram.step)) throw new Error('Invalid or repeated diagram step')
    seen.add(diagram.step)
    if (typeof diagram.label !== 'string' || diagram.label.length > 60) throw new Error('Invalid diagram label')
    if (!Array.isArray(diagram.elements) || !diagram.elements.length || diagram.elements.length > 64) throw new Error('Missing or excessive diagram elements')
    const operations = new Set()
    for (const el of diagram.elements) {
      if (!['path', 'text', 'object', 'repeat'].includes(el.type)) throw new Error('Unsupported diagram element')
      if (![el.x, el.y].every(n => Number.isFinite(n) && n >= 0 && n <= 400)) throw new Error('Diagram coordinates must be inside 400 by 400')
      if (el.type === 'path') { checkPath(el.d); checkPaint(el.fill || 'none'); checkPaint(el.stroke || '#1d2b4f') }
      if (el.type === 'text' && (typeof el.text !== 'string' || el.text.length > 80)) throw new Error('Invalid diagram text')
      if (['object', 'repeat'].includes(el.type) && ![el.width, el.height].every(n => Number.isFinite(n) && n > 0 && n <= 400)) throw new Error('Invalid diagram size')
      if (el.x + (el.width || 0) > 400 || el.y + (el.height || 0) > 400) throw new Error('Diagram element exceeds panel')
      if (el.type === 'object' && !objectKeys.includes(el.key)) throw new Error('Unknown diagram object reference')
      if (el.type === 'repeat') {
        if (operations.has(el.operation)) throw new Error('An operation may appear only once in a diagram')
        operations.add(el.operation)
        const matches = facts.filter(f => f.id === el.operation)
        if (matches.length !== 1 || matches[0].step > diagram.step || matches[0].count < 1 || matches[0].count > 64) throw new Error('Diagram repetition needs one existing operation, no later than the diagram step')
        if (!['row', 'ring', 'sites'].includes(el.layout) || !['cross', 'chain', 'increase', 'dot'].includes(el.symbol)) throw new Error('Unsupported repetition layout or symbol')
        if ('count' in el) throw new Error('Diagram counts must come from operation facts')
      }
    }
  }
  return diagrams
}

// Self-contained: embedded unchanged in film programs and also used by browser comparison tests.
export function renderDiagram(ctx, i, p, env, diagrams) {
  const diagram = diagrams.find(d => d.step === i)
  if (!diagram) return
  const ink = env.palette.ink, accent = env.palette.accent
  for (const el of diagram.elements) {
    ctx.save(); ctx.translate(el.x, el.y); ctx.lineWidth = 2; ctx.strokeStyle = ink; ctx.fillStyle = ink
    if (el.type === 'path') {
      const path = new Path2D(el.d)
      if (el.fill && el.fill !== 'none') { ctx.fillStyle = el.fill; ctx.fill(path) }
      if (el.stroke !== 'none') { ctx.strokeStyle = el.stroke || ink; ctx.stroke(path) }
    } else if (el.type === 'text') {
      ctx.font = '18px ' + env.font; ctx.textBaseline = 'top'; ctx.fillText(el.text, 0, 0, 400 - el.x)
    } else if (el.type === 'object') {
      env.drawObject?.(ctx, el.key, el.width, el.height)
    } else if (el.type === 'repeat') {
      const fact = env.operations.find(f => f.id === el.operation)
      if (!fact) { ctx.restore(); continue }
      const n = fact.count, current = fact.step === i, shown = current ? Math.floor(Math.min(1, Math.max(0, p)) * n + 1e-7) : n
      const size = Math.min(18, el.layout === 'row' ? el.width / Math.max(1, n) * 0.65 : Math.min(el.width, el.height) * 0.1)
      ctx.globalAlpha *= current ? 1 : 0.45
      for (let j = 0; j < shown; j++) {
        const angle = -Math.PI / 2 + j * Math.PI * 2 / n
        const site = fact.sites[j]
        const x = el.layout === 'ring' ? el.width / 2 + Math.cos(angle) * (el.width / 2 - size)
          : el.layout === 'sites' ? size + site.x * (el.width - 2 * size) : (j + 0.5) * el.width / n
        const y = el.layout === 'ring' ? el.height / 2 + Math.sin(angle) * (el.height / 2 - size)
          : el.layout === 'sites' ? el.height / 2 + (site.lat || 0) * (el.height - 2 * size) : el.height / 2
        ctx.save(); ctx.translate(x, y)
        // The newest mark has an accent backing with an ink symbol for contrast on white.
        if (current && j === shown - 1) { ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(0, 0, size * 0.8, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = ink }
        ctx.beginPath()
        if (el.symbol === 'dot') { ctx.arc(0, 0, size * 0.2, 0, Math.PI * 2); ctx.fill() }
        else if (el.symbol === 'chain') { ctx.ellipse(0, 0, size * 0.4, size * 0.22, 0, 0, Math.PI * 2); ctx.stroke() }
        else {
          const cross = (x, y) => { ctx.moveTo(x - size * 0.3, y - size * 0.3); ctx.lineTo(x + size * 0.3, y + size * 0.3); ctx.moveTo(x - size * 0.3, y + size * 0.3); ctx.lineTo(x + size * 0.3, y - size * 0.3) }
          if (el.symbol === 'increase') { ctx.moveTo(0, size * 0.55); ctx.lineTo(-size * 0.35, -size * 0.2); ctx.moveTo(0, size * 0.55); ctx.lineTo(size * 0.35, -size * 0.2); cross(-size * 0.35, -size * 0.25); cross(size * 0.35, -size * 0.25) }
          else cross(0, 0)
          ctx.stroke()
        }
        ctx.restore()
      }
      ctx.font = '18px ' + env.font; ctx.textBaseline = 'top'; ctx.fillText(String(n) + ' ' + ({ cross: '× sc', chain: '× ch', increase: 'increases', dot: 'work sites' })[el.symbol], 0, el.height + 4)
    }
    ctx.restore()
  }
}

export function compileDiagrams(diagrams) {
  return { format: 'diagram/v1', diagrams, steps: diagrams.map(d => d.step),
    labels: Object.fromEntries(diagrams.map(d => [d.step, d.label])),
    draw: `(ctx, i, p, env) => { (${renderDiagram.toString()})(ctx, i, p, env, ${data(diagrams)}); }` }
}
