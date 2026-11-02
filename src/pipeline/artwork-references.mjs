// Share approved vector identity across independently generated panels and finales.
import { existsSync, copyFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { namedDrawing, drawingMetrics } from './drawing-format.mjs'

export function artworkReferences(dir, script, vectors, screensDir) {
  mkdirSync(dir, { recursive: true })
  const used = new Set((script.steps || []).flatMap(s => (s.do || []).flatMap(a => [a.k, a.to, a.with, a.part])).flat().filter(Boolean))
  const manifest = [], images = []
  let budget = 48000
  for (const object of script.objects || []) {
    if (!used.has(object.k) || !vectors[object.k] || manifest.length >= 8) continue
    const drawing = namedDrawing(vectors[object.k]), encoded = JSON.stringify(drawing)
    if (encoded.length > budget) continue
    budget -= encoded.length
    const entry = { key: object.k, name: object.n, sha256: createHash('sha256').update(encoded).digest('hex'),
      state: 'original object artwork; never use this as proof of a transformed result', drawing, metrics: drawingMetrics(drawing) }
    if (/^[\w-]+$/.test(object.k) && images.length < 4 && existsSync(join(screensDir, `${object.k}.png`))) {
      const file = `reference-${images.length + 1}.png`
      copyFileSync(join(screensDir, `${object.k}.png`), join(dir, file)); images.push(file)
      entry.photo = file; entry.photoPurpose = 'Original photographed identity; the approved vector geometry is in drawing.'
    }
    manifest.push(entry)
  }
  writeFileSync(join(dir, 'artwork-references.json'), JSON.stringify(manifest, null, 2))
  return { manifest, images }
}
