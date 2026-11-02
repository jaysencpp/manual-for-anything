// Shared operation facts. Planning, captions, panels, tools and persistent marks use the same sites/counts.
// This function is also embedded in the sandboxed film. Keep it self-contained and free of refused identifiers.
export function operationSites(a, length) {
  if (a.n != null && (!Number.isInteger(a.n) || a.n < 1 || a.n > 64)) throw new Error('Operation count must be 1–64')
  if (Array.isArray(a.sites) && a.sites.length) return a.sites.map((s) => ({ x: s.x, lat: s.lat || 0 }))
  const clamp = (x) => Math.min(1, Math.max(0, +x))
  const positions = Array.isArray(a.x) ? a.x.map(clamp)
    : length && a.cm != null ? [].concat(a.cm).map((x) => clamp(x / length)) : null
  const n = Number.isInteger(a.n) && a.n > 0 ? a.n : positions?.length || 1
  if (!positions?.length) {
    const at = typeof a.x === 'number' ? clamp(a.x) : ({ left: 0.15, start: 0.15, middle: 0.5, center: 0.5, right: 0.85, end: 0.85 }[a.at] ?? 0.5)
    return Array.from({ length: n }, (_, i) => ({ x: n === 1 ? at : 0.1 + 0.8 * i / (n - 1), lat: 0 }))
  }
  const rows = Math.ceil(n / positions.length)
  return Array.from({ length: n }, (_, i) => ({ x: positions[i % positions.length],
    lat: rows === 1 ? 0 : 0.62 * (Math.floor(i / positions.length) / (rows - 1) - 0.5) }))
}

export function entities(script) {
  const list = (v) => Array.isArray(v) ? v.filter((o) => o && typeof o === 'object') : []
  const definitions = new Map(list(script.states).map((d) => [d.k, d]))
  return [...list(script.objects), ...list(script.tools), ...list(script.makes),
    ...list(script.steps).flatMap((s) => list(s.do).flatMap((a) => list(a.into)))].map((o) => definitions.has(o.k) ? { ...o, ...definitions.get(o.k) } : o)
}

export function operationFacts(script) {
  const lengths = Object.fromEntries((script.objects || []).map((o) => [o.k, o.cm]))
  return (script.steps || []).flatMap((s, step) => (s.do || []).flatMap((a, index) =>
    [].concat(a.k || []).map((k) => ({ id: a.id || `s${step + 1}a${index + 1}`, step, k, intent: a.intent || a.v,
      joint: a.joint, receiver: a.to, face: a.face, depthCm: a.depthCm, part: a.part, sites: operationSites(a, lengths[k]),
      count: operationSites(a, lengths[k]).length }))))
}

export function compileOperations(script) {
  const joints = new Map((script.joints || []).map((j) => [j.id, j]))
  const steps = (script.steps || []).map((s) => ({ ...s, do: (s.do || []).map((a) => {
    if (Array.isArray(a.into)) a = { ...a, into: a.into.map((p) => p.cm > 0 ? { ...p, label: `${p.cm} cm` } : p) }
    const j = joints.get(a.joint)
    return j ? { ...a, k: j.a, to: j.b, face: j.face, depthCm: j.depthCm, sites: j.sites, n: j.sites.length }
      : a.sites?.length ? { ...a, n: a.sites.length } : a
  }) }))
  const result = { ...script, steps }, facts = operationFacts(result)
  result.steps = steps.map((s, i) => {
    if (!s.caption) return s
    const ids = new Set(s.caption.actions || [])
    const count = facts.filter((f) => f.step === i && ids.has(f.id)).reduce((n, f) => n + f.count, 0)
    return { ...s, c: s.caption.template.replaceAll('{count}', String(count)) }
  })
  return result
}

// Missing measurement evidence never becomes confirmation.
export function measurementFacts(script) {
  const objects = Array.isArray(script.objects) ? script.objects.filter(Boolean) : []
  const facts = objects.flatMap((o) => ['cm', 'w', 'thick'].filter((k) => typeof o[k] === 'number').map((field) => ({
    k: o.k, field, value: o[field], unit: 'cm', status: o.measurements?.[field]?.status || 'estimated',
    source: o.measurements?.[field]?.source || 'single photo estimate',
  })))
  for (const s of Array.isArray(script.steps) ? script.steps.filter(Boolean) : []) for (const a of Array.isArray(s.do) ? s.do.filter(Boolean) : []) for (const p of Array.isArray(a.into) ? a.into.filter(Boolean) : []) {
    if (p.cm > 0) facts.push({ k: p.k, field: 'cm', value: p.cm, unit: 'cm', derived: true,
      status: facts.find((f) => f.k === a.k && f.field === 'cm')?.status || 'estimated', source: `cut from ${a.k}` })
  }
  return facts
}
