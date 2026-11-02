import { validatePlan } from './validate.mjs'
import { operationFacts, measurementFacts } from '../solvers/operations.mjs'

export function auditInstruction(script, layout = null, photo, perception = null) {
  const validation = validatePlan(script, photo)
  const geometry = layout?.diagnostics || []
  const missing = (script.joints || []).filter((j) => layout && !layout.connections?.some((c) => c.id === j.id))
    .map((j) => ({ joint: j.id, code: 'unchecked-connection', message: 'Connection has not been checked in numeric geometry' }))
  const blockers = [...new Set([...validation.errors, ...(validation.soft || []), ...geometry.map((p) => p.message), ...missing.map((p) => `${p.joint}: ${p.message}`)])]
  return { contractVersion: script.contractVersion, valid: !blockers.length,
    blockers, warnings: [...validation.warnings, ...Object.entries(perception || {}).flatMap(([k, p]) => (p.warnings || []).map((w) => `${k}: ${w}`))],
    operations: !blockers.length ? operationFacts(script) : [], measurements: measurementFacts(script),
    geometryChecked: !!layout?.world && !layout.sheetLayout, sheetLayoutChecked: !!layout?.sheetLayout,
    perceptionRecorded: !!perception, identityVerified: false, physicalStrengthChecked: false }
}
