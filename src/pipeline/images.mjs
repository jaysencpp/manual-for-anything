// Image work for the pipeline, using sharp's prebuilt binaries on every platform.
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import sharp from 'sharp'

// Real phone photos need EXIF orientation and format normalization before pixel coordinates mean anything, and a size
// the pipeline works at: a phone's 4032 × 3024 is a 10 MB PNG the model API refuses. At most 1600 px on its longest side.
export async function normalizePhoto(source, png) {
  const image = sharp(source).rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3' })
    .removeAlpha().toColourspace('srgb')
  await image.clone().png().toFile(png)
  await jpegBeside(png)
}

// The models are sent photo.jpg, the same pixels at about a sixth of the bytes. photo.png stays for cut-outs and the film.
export async function jpegBeside(png) {
  const jpeg = join(dirname(png), `${basename(png, '.png')}.jpg`)
  if (!existsSync(jpeg)) await sharp(png).removeAlpha().jpeg({ quality: 90 }).toFile(jpeg)
  return jpeg
}

// The reference a model draws from: a cut-out at four times its size, on mid grey so its pale edges show.
export async function referenceImage(cutOut, output) {
  const { width, height } = await sharp(cutOut).metadata()
  await sharp(cutOut).resize(width * 4, height * 4, { kernel: 'lanczos3' }).flatten({ background: { r: 150, g: 150, b: 150 } }).png().toFile(output)
}

export async function cropTo(source, [x, y, w, h], output) {
  const { width, height } = await sharp(source).metadata()
  const left = Math.max(0, Math.min(width - 1, Math.round(x))), top = Math.max(0, Math.min(height - 1, Math.round(y)))
  await sharp(source).extract({ left, top, width: Math.max(1, Math.min(width - left, Math.round(w))), height: Math.max(1, Math.min(height - top, Math.round(h))) }).png().toFile(output)
}
