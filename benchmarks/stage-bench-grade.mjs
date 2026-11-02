import { PERCEPTION_SCHEMA } from '../src/pipeline/plan-schema.mjs'
import { validateObjects, groupedInventoryProblems } from '../src/pipeline/validate.mjs'
import { fitBoxes } from '../src/pipeline/plan.mjs'
import { schemaProblems } from './planning-grade.mjs'

export function boxIoU(a, b) {
  const area = r => Math.max(0, r[2]) * Math.max(0, r[3])
  const intersection = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]))
    * Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]))
  return intersection / (area(a) + area(b) - intersection || 1)
}

// Maximum cardinality bipartite matching: one predicted object cannot satisfy two labels.
export function matchObjects(expected, predicted, threshold = 0.5) {
  const owners = new Map()
  const compatible = (a, b) => (a.classes || [a.segment]).some(x => x.toLowerCase() === b.segment?.toLowerCase())
  const visit = (i, seen) => {
    const edges = predicted.map((p, j) => ({ j, iou: boxIoU(expected[i].b, p.b) }))
      .filter(e => e.iou >= threshold && compatible(expected[i], predicted[e.j])).sort((a, b) => b.iou - a.iou)
    for (const { j } of edges) {
      if (seen.has(j)) continue
      seen.add(j)
      if (!owners.has(j) || visit(owners.get(j), seen)) { owners.set(j, i); return true }
    }
    return false
  }
  expected.forEach((_, i) => visit(i, new Set()))
  return [...owners].map(([predictedIndex, expectedIndex]) => ({ predictedIndex, expectedIndex,
    iou: boxIoU(expected[expectedIndex].b, predicted[predictedIndex].b) }))
}

export function gradeRecognition(rawText, c) {
  const errors = [], metrics = {}, partial = c.expected.coverage === 'partial'; let output
  try {
    output = JSON.parse(rawText)
    errors.push(...schemaProblems(output, PERCEPTION_SCHEMA))
    if (output.mode !== c.expected.mode) errors.push(`Expected ${c.expected.mode} mode, received ${output.mode}`)
    if (!errors.length && output.mode === 'physical') {
      const objects = fitBoxes(output.objects, c.photo)
      errors.push(...validateObjects(objects, c.photo), ...groupedInventoryProblems(objects))
      for (const o of objects) for (const value of Object.values(o.measurements || {})) {
        if (value.status === 'confirmed') errors.push('Recognition manufactured a confirmed measurement')
      }
      if (!errors.length) {
        const matches = matchObjects(c.expected.objects, objects, c.expected.iouThreshold ?? 0.5)
        Object.assign(metrics, { coverage: partial ? 'partial' : 'complete', expectedCount: c.expected.objects.length, predictedCount: objects.length, matched: matches.length,
          precision: partial ? null : objects.length ? matches.length / objects.length : c.expected.objects.length ? 0 : 1,
          unjudgedPredictions: partial ? objects.length - matches.length : 0,
          recall: c.expected.objects.length ? matches.length / c.expected.objects.length : 1, matches })
        if (matches.length !== c.expected.objects.length) errors.push('Missing or misidentified objects or boxes below the overlap threshold')
        if (!partial && matches.length !== objects.length) errors.push('Extra, duplicate or misidentified objects')
      }
    } else if (output.mode === 'problem' && output.objects?.length) errors.push('Problem routing must return no objects')
  } catch (error) { errors.push(`Invalid recognition response: ${error.message}`) }
  return { machine: errors.length ? 'fail' : 'pass', errors, metrics, output: output ?? null,
    limitation: partial ? 'Partial labels: checks cover only the labelled subset. Other detections and full-photo recall require review; precision is not estimated.' : null }
}

export function pointer(value, path) {
  if (path === '') return value
  if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('Assertion paths must be JSON pointers')
  return path.slice(1).split('/').reduce((v, k) => v?.[k.replaceAll('~1', '/').replaceAll('~0', '~')], value)
}
export function assertionErrors(output, baseline, assertions = []) {
  const errors = []
  for (const a of assertions) {
    const actual = pointer(output, a.path), before = pointer(baseline, a.path)
    const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v
    const same = (x, y) => JSON.stringify(canonical(x)) === JSON.stringify(canonical(y))
    let pass
    if (a.op === 'equals') pass = same(actual, a.value)
    else if (a.op === 'preserve') pass = before !== undefined && same(actual, before)
    else if (a.op === 'change') pass = before !== undefined && actual !== undefined && !same(actual, before)
    else if (a.op === 'excludes') pass = actual !== undefined && !JSON.stringify(actual).toLowerCase().includes(String(a.value).toLowerCase())
    else throw new Error(`Unsupported assertion: ${a.op}`)
    if (!pass) errors.push(`Task assertion failed: ${a.op} ${a.path}`)
  }
  return errors
}
