import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { uploadPhoto } from '../public/photo.mjs'

test('upload completion is reported before the server answers, and failures reject', async () => {
  const original = globalThis.XMLHttpRequest
  let request
  globalThis.XMLHttpRequest = class {
    upload = {}
    constructor() { request = this }
    open(method, path) { assert.equal(method, 'POST'); assert.equal(path, '/api/films') }
    send(body) { assert.equal(body, 'photo body') }
  }
  try {
    let uploaded = false, finished = false
    const pending = uploadPhoto('photo body', () => { uploaded = true }).then((answer) => { finished = true; return answer })
    request.upload.onload()
    await Promise.resolve()
    assert.equal(uploaded, true)
    assert.equal(finished, false)
    request.status = 200; request.responseText = '{"id":"manual123"}'
    request.onload()
    assert.deepEqual(await pending, { id: 'manual123' })

    for (const [status, body, message] of [
      [400, '{"error":"Choose a photo"}', /Choose a photo/],
      [502, '<html>Bad gateway</html>', /server response/],
      [200, '{}', /Could not start/],
    ]) {
      const failed = uploadPhoto('photo body', () => {})
      request.status = status; request.responseText = body; request.onload()
      await assert.rejects(failed, message)
    }
    const failed = uploadPhoto('photo body', () => {})
    request.onerror()
    await assert.rejects(failed, /Could not reach/)
  } finally { globalThis.XMLHttpRequest = original }
})

test('the form clears completed upload status, restores controls, and preserves errors for retry', async () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  const handler = source.slice(source.indexOf("$('photo-form').onsubmit"), source.indexOf('// Keep the current film'))
  for (const fail of [false, true]) {
    const elements = new Map()
    const $ = (id) => {
      if (!elements.has(id)) elements.set(id, { disabled: false, hidden: true, value: 'notes' })
      return elements.get(id)
    }
    let finish
    const response = new Promise((resolve, reject) => { finish = () => fail ? reject(new Error('Server unavailable')) : resolve({ id: 'manual123' }) })
    const visits = []
    runInNewContext(handler, {
      $, selectedPhoto: {}, config: { live: true }, previewURL: 'blob:photo',
      preparePhoto: async () => ({ name: 'photo.jpg' }), FormData: class { append() {} },
      uploadPhoto: (body, uploaded) => { uploaded(); return response },
      teardown() {}, showMaking: (photo) => visits.push(photo),
      history: { pushState() {} }, connect: (id) => visits.push(id),
    })
    const pending = $('photo-form').onsubmit({ preventDefault() {} })
    await new Promise(setImmediate)
    assert.equal($('upload-status').textContent, 'Photo uploaded. Starting your manual…')
    assert.equal($('remove-photo').disabled, true)
    finish(); await pending
    assert.equal($('make-manual').disabled, false)
    assert.equal($('remove-photo').disabled, false)
    if (fail) {
      assert.equal($('upload-status').hidden, false)
      assert.equal($('upload-status').textContent, 'Server unavailable')
      assert.deepEqual(visits, [])
    } else {
      assert.equal($('upload-status').hidden, true)
      assert.equal($('upload-status').textContent, '')
      assert.deepEqual(visits, ['blob:photo', 'manual123'])
    }
  }
})
