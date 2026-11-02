// Shared process semantics. Derive only literal instructions/visible named contents;
// never infer temperature measurements, amounts or material identities from colour.
export function settleProcesses(script) {
  const notes = [], objects = Array.isArray(script?.objects) ? script.objects.filter(Boolean) : []
  if (!Array.isArray(script?.steps)) return notes
  for (const step of script.steps) for (const a of Array.isArray(step?.do) ? step.do.filter(Boolean) : []) {
    const words = `${step.t || ''} ${typeof step.c === 'string' ? step.c : ''}`
    if (a.v === 'heat' && (a.intent === 'cool' || a.level === 'off' || /^cool\b/i.test(step.t || '') || /\b(?:turn|switch) (?:the )?heat off\b/i.test(words))) {
      if (a.level !== 'off' || a.intent !== 'cool') notes.push(`${a.id || a.k}: cooling turns the heat off`)
      a.level = 'off'; a.intent = 'cool'
    }
    if (a.v === 'stir') {
      if (!a.pattern && /\bzigzag\b|\b[MW](?:[- ]shaped| motion)\b/i.test(words)) { a.pattern = 'zigzag'; notes.push(`${a.id || a.k}: explicit zigzag motion`) }
      if (!a.pace && /\bgently|\bgentle|\bslowly\b/i.test(words)) a.pace = 'gentle'
      if (!a.pace && /\bbrisk|\brapid|\bvigorous/i.test(words)) a.pace = 'brisk'
      if (!a.finish && /\bfroth|\bfoam/i.test(words) && !/\b(?:no|without|avoid|prevent)\b.*\b(?:foam|froth)/i.test(words)) a.finish = 'foam'
    }
    if (['pour', 'sprinkle'].includes(a.v)) {
      if (a.opacity == null && /\bwater\b/i.test(words) && !/\bmilk|\bjuice|\bpaint/i.test(words)) a.opacity = 0
      const source = objects.find((o) => o?.k === a.k)
      if (source && !source.contents && /\bpowder\b/i.test(source.n || '') && /\b(?:in|of)\b.*\b(?:dish|bowl|jar|container|cup)\b/i.test(source.n || '') && /^#[\da-f]{6}$/i.test(a.color || '')) {
        source.contents = { name: 'powder', form: 'powder', color: a.color, opacity: 1 }
        notes.push(`${a.k}: distinguish named powder from its container`)
      }
      if (source?.contents) {
        if (a.opacity == null) a.opacity = source.contents.opacity ?? 1
        if (!a.form) a.form = source.contents.form
        if (!a.color) a.color = source.contents.color
        if (!a.with && a.v === 'sprinkle' && source.contents.form === 'powder' && a.label) {
          const spoons = objects.filter((o) => o.toolKind === 'spoon')
          if (spoons.length === 1) { a.with = spoons[0].k; notes.push(`${a.id || a.k}: measured powder transfer uses the photographed scoop`) }
        }
      }
    }
  }
  return notes
}

// An illustrative colour model, not fluid simulation. Transparent additions carry volume,
// but do not contribute opaque pigment. When opacity is unspecified, use equal weighting.
export function mixtureColor(entries) {
  const pigment = entries.filter((e) => /^#[\da-f]{6}$/i.test(e.color || '') && (e.opacity ?? 1) > 0)
  if (!pigment.length) return entries.at(-1)?.color || '#dcecf0'
  const weight = pigment.reduce((n, e) => n + (e.opacity ?? 1), 0)
  return '#' + [1, 3, 5].map((i) => Math.round(pigment.reduce((n, e) => n + parseInt(e.color.slice(i, i + 2), 16) * (e.opacity ?? 1), 0) / weight).toString(16).padStart(2, '0')).join('')
}

export function stirOffset(pattern, pace, phase) {
  const speed = pace === 'gentle' ? 0.6 : pace === 'brisk' ? 1.4 : 1
  const t = phase * speed, strength = pace === 'gentle' ? 0.55 : 1
  return pattern === 'zigzag' ? [Math.sin(t * 8) * strength, (2 / Math.PI) * Math.asin(Math.sin(t * 24)) * 0.3 * strength]
    : [Math.cos(t * 8) * strength, Math.sin(t * 8) * 0.3 * strength]
}
