import { brickOf } from '../solvers/bricks.mjs'
import { isSceneBuild, partOf } from '../solvers/scene.mjs'

// Geometry-dependent work and damaged objects must retain their photographed frame.
// The version is saved on the script so historical films retain their original artwork/layout.
export function completeIllustration(script, object) {
  if (script.artworkMode !== 'complete' || !Array.isArray(object?.b) || object.b.length !== 4 ||
    !object.b.every(Number.isFinite) || object.b[2] <= 0 || object.b[3] <= 0 ||
    object.source === 'additional-supply' || object.toolKind || object.tip || brickOf(object)) return false
  if (/\b(repair|fix|mend|reattach|restitch|torn|broken|damaged)\b/i.test([script.title, script.design?.purpose, ...(script.steps || []).map(s => s.c)].join(' '))) return false
  if ((script.rigs || []).some(r => r.k === object.k) || (script.cuts || []).some(c => c.from === object.k)) return false
  const acts = (script.steps || []).flatMap(s => s.do || [])
  if (acts.some(a => a.with === object.k || a.part === object.k ||
    (['cut', 'fold', 'strand', 'reshape', 'work', 'use', 'measure', 'demonstrate'].includes(a.v) && [a.k, a.to, ...(a.demo?.actors || [])].includes(object.k)))) return false
  if (script.assembly || script.joints?.length || ['brick', 'sheet', 'rod'].includes(object.part?.family) || +object.thick > 0) return false
  if (isSceneBuild(script) && !['loose', 'cylinder'].includes(partOf(object).family)) return false
  return true
}

export function illustrationFrame(script, object, cutSize) {
  const declared = object.part?.size
  const width = declared?.[0] || object.b[2]
  const height = declared?.[script.view === 'plan' ? 1 : 2] || object.b[3]
  const scale = Math.max(cutSize.width, cutSize.height) / Math.max(width, height)
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}
