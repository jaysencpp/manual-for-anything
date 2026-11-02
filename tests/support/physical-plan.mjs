// Author a complete current-contract test plan from the details a test exercises.
// This is fixture construction only; production rejects missing contract declarations.
export function physicalPlan(input) {
  const script = { contractVersion: 2, mode: 'physical', view: 'side', title: 'Test manual', sub: '', tag: '', end: '',
    objects: [], tools: [], makes: [], joints: [], goals: [], ideas: [], pick: 0, finale: [], ...input }
  for (const o of script.objects) for (const field of ['cm', 'w', 'thick']) if (o[field] != null) {
    o.measurements ||= {}; o.measurements[field] ||= { status: 'estimated', source: 'Explicit test estimate' }
  }
  for (const [i, step] of script.steps.entries()) {
    for (const [j, a] of step.do.entries()) { a.id ||= `step-${i}-${j}`; a.intent ||= a.v === 'use' ? 'apply' : a.v }
    step.claims ||= step.do.map(a => a.id)
  }
  script.design ||= { purpose: script.title, size: [120, 120, 120], parts: script.steps.flatMap(s => s.do).flatMap(a =>
    Array.isArray(a.into) ? a.into.map(p => ({ k: p.k, from: a.k, cm: p.cm })) : []) }
  return script
}
