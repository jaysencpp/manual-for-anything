import test from 'node:test'
import assert from 'node:assert/strict'
import { checkLook, containedContents, drawThumb } from '../src/film/thumbs.mjs'
import { recordingCanvas } from '../scripts/offline-canvas.mjs'

const bowl = { s: 'cone', p: [0, 0, 0], d: [12, 12, 8], t: 1.6, c: '#8b2f2a', open: true, f: '#3d7a1e' }
const tea = { s: 'cyl', p: [1, 1, 6], d: [10, 10, 1], c: '#5aa02c' }

test('separate thin contents below a bowl rim are clipped and painted after their vessel', () => {
  const contents = containedContents([bowl, tea])
  assert.equal(contents[1].parent, 0)
  assert.ok(contents[1].clip.length > 8)
  const c = recordingCanvas()
  drawThumb(c.ctx, [tea, bowl], { width: 300, height: 220, shadow: false })
  assert.equal(c.depth(), 0)
  assert.ok(c.calls.some((x) => x.method === 'clip'))
})

test('liquid without an existing fill is still contained, while objects above or outside the bowl are independent', () => {
  const empty = { ...bowl, f: undefined }
  assert.equal(containedContents([empty, tea])[1].parent, 0)
  for (const outside of [{ ...tea, p: [1, 1, 8] }, { ...tea, p: [15, 1, 6] }, { ...tea, r: [0, 25, 0] }, { ...tea, s: 'box' }])
    assert.equal(containedContents([bowl, outside])[1], null)
  assert.equal(containedContents([{ ...bowl, r: [20, 0, 0] }, tea])[1], null)
})

test('model f_color survives validation as the vessel fill, with canonical f taking precedence', () => {
  const glass = { s: 'cone', p: [0, 0, 0], d: [7, 7, 14], t: 1.2, c: '#d8e6e8', open: true }
  assert.equal(checkLook([{ ...glass, f_color: '#7a4a12' }]).look[0].f, '#7a4a12')
  assert.equal(checkLook([{ ...glass, f: '#abc', f_color: '#7a4a12' }]).look[0].f, '#aabbcc')
  assert.equal(checkLook([{ ...glass, f_color: 'invalid' }]).look[0].f, undefined)
  assert.equal(checkLook([{ ...glass, open: false, f_color: '#7a4a12' }]).look[0].f, undefined)
})

test('ice at the glass rim is painted after the drink and clipped behind its front wall', () => {
  // Geometry from run 915ecb408eae47d08126607311f5bd36, Crown and Cola.
  const glass = { s: 'cone', p: [0, 0, 0], d: [7, 7, 14], t: 1.2, c: '#d8e6e8', open: true, f: '#482515' }
  const ice = { s: 'box', p: [1, 1, 12], d: [2, 2, 2], c: '#ffffff' }
  assert.equal(containedContents([ice, glass])[0].parent, 1)
  const c = recordingCanvas()
  drawThumb(c.ctx, [ice, glass], { width: 300, height: 220, shadow: false })
  const liquid = c.calls.findIndex(x => x.method === 'fill' && x.fill !== glass.c && x.fill !== '#ffffff')
  const clip = c.calls.findLastIndex(x => x.method === 'clip')
  const cube = c.calls.findLastIndex(x => x.method === 'fill')
  assert.ok(liquid >= 0 && clip > liquid && cube > clip)
  assert.equal(c.depth(), 0)
  for (const outside of [{ ...ice, p: [10, 1, 12] }, { ...ice, p: [1, 1, 14] }, { ...ice, d: [7, 7, 2] }])
    assert.equal(containedContents([glass, outside])[1], null)
  assert.equal(containedContents([glass, { ...ice, s: 'ball' }])[1].parent, 0)
})
