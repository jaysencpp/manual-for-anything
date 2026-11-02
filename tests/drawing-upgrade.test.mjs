import { drawingStyle } from '../src/pipeline/drawing-style.mjs'
import { check as checkPanel } from '../src/pipeline/panel.mjs'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { openDrawingBrowser, chromePresent } from '../benchmarks/drawing-chrome.mjs'
import { renderDrawing } from '../benchmarks/drawing-render.mjs'
import { helperFor, withUp } from '../src/film/helper.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateDrawing, editDrawing, namedDrawing, lineWidth, drawingSVG } from '../src/pipeline/drawing-format.mjs'
import { validateDiagrams, compileDiagrams, renderDiagram } from '../src/film/diagram.mjs'
import { artworkReferences } from '../src/pipeline/artwork-references.mjs'
import { startServer } from './support/server.mjs'

const drawing = () => ({ width: 100, height: 100, parts: [{ id: 'cup', parent: null, pivot: [50, 100], shapes: [
  { id: 'body', d: 'M10 10L90 10L90 90L10 90Z', fill: '#fff', stroke: '#1d2b4f', weight: 'silhouette' },
  { id: 'seam', d: 'M20 40L80 40', fill: 'none', stroke: '#1d2b4f', weight: 'detail' },
] }] })

test('shared drawing validation rejects malformed geometry, hierarchy and invisible artwork', () => {
  validateDrawing(drawing())
  const bad = [d => d.parts[0].shapes[0].d = 'M10 10C20 30', d => d.parts[0].parent = 'cup',
    d => d.parts[0].shapes[1].id = 'body', d => d.parts[0].shapes[0].weight = 'bold',
    d => d.parts[0].shapes[0].fill = 'currentColor', d => d.parts.forEach(p => p.shapes.forEach(s => s.hidden = true))]
  for (const mutate of bad) { const value = drawing(); mutate(value); assert.throws(() => validateDrawing(value)) }
})

test('layer editing preserves geometry, has stable legacy IDs and exports matching line weights', () => {
  const original = drawing(), edited = editDrawing(original, { partId: 'cup', shapeId: 'seam', hidden: true })
  assert.equal(original.parts[0].shapes[1].hidden, undefined)
  assert.deepEqual(edited.parts[0].pivot, original.parts[0].pivot)
  assert.doesNotMatch(drawingSVG(edited), /M20 40/)
  assert.match(drawingSVG(original), /stroke-width="1.25"/)
  assert.equal(lineWidth({}), 3)
  const legacy = drawing(); delete legacy.parts[0].shapes[1].id
  assert.deepEqual(namedDrawing(namedDrawing(legacy)), namedDrawing(legacy))
  assert.throws(() => editDrawing(original, { partId: 'cup', shapeId: 'seam', pivot: [0, 0] }))
})

const facts = [{ id: 'stitches', step: 0, count: 6, sites: Array.from({ length: 6 }, (_, i) => ({ x: i / 5, lat: 0 })) }]
const diagrams = () => [{ step: 0, label: 'Round', elements: [{ type: 'repeat', operation: 'stitches', symbol: 'cross', layout: 'row', x: 20, y: 60, width: 360, height: 200 }] }]
test('structured diagrams derive mark counts and progress from facts and reject invented operations/counts', () => {
  validateDiagrams(diagrams(), facts, { stepCount: 1 })
  for (const patch of [{ count: 12 }, { operation: 'invented' }, { layout: 'spiral' }]) {
    const value = diagrams(); Object.assign(value[0].elements[0], patch); assert.throws(() => validateDiagrams(value, facts))
  }
  const commands = [], ctx = new Proxy({ globalAlpha: 1 }, { get: (o, k) => k in o ? o[k] : (...args) => commands.push([k, ...args]) })
  renderDiagram(ctx, 0, 0.5, { operations: facts, font: 'Inter', palette: { ink: '#111', accent: '#ff0' } }, diagrams())
  assert.equal(commands.filter(c => c[0] === 'lineTo').length, 6, 'halfway reveals three crosses, each with two strokes')
  assert.ok(commands.some(c => c[0] === 'fillText' && c[1] === '6 × sc'))
  const withPath = diagrams(); withPath[0].elements.push({ type: 'path', x: 0, y: 0, d: 'M10 10L20 20', fill: 'none', stroke: '#111' });
  assert.equal(checkPanel({ panels: compileDiagrams(withPath) }, facts), null, 'structured paths are data, not executed in Node without Path2D')
  const compiled = compileDiagrams(diagrams()); assert.equal(compiled.format, 'diagram/v1'); assert.doesNotThrow(() => new Function(`return (${compiled.draw})`))
})

test('reference manifest contains approved vector identity and distinguishes original state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'artwork-refs-'))
  try {
    const refs = artworkReferences(dir, { objects: [{ k: 'cup', n: 'White cup' }], steps: [{ do: [{ k: 'cup' }] }] }, { cup: drawing() }, dir)
    assert.deepEqual(refs.manifest[0].drawing, drawing()); assert.match(refs.manifest[0].state, /original/)
    assert.equal(refs.manifest[0].sha256.length, 64)
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'artwork-references.json'))), refs.manifest)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('film layer edits save, update playback and undo without model calls', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'artwork-durable-'))
  let server = await startServer(['--speed', '100000'], { MANUAL_DATA_DIR: dataDir })
  try {
    const { id } = await fetch(`${server.base}/api/films?example=groceries`, { method: 'POST' }).then(r => r.json())
    const events = await fetch(`${server.base}/api/films/${id}/events`, { signal: AbortSignal.timeout(10000) })
    const reader = events.body.getReader(); let stream = ''
    while (!stream.includes('"type":"done"') && !stream.includes('"type":"failed"')) { const { value, done } = await reader.read(); if (done) break; stream += new TextDecoder().decode(value) }
    await reader.cancel()
    assert.match(stream, /"type":"done"/)
    let endpoint = `${server.base}/api/films/${id}/artwork`
    const loaded = await fetch(endpoint).then(r => r.json())
    assert.ok(loaded.objects.length)
    const object = loaded.objects[0], part = object.drawing.parts[0], shape = part.shapes[0]
    const post = value => fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
    const response = await post({ key: object.key, edit: { partId: part.id, shapeId: shape.id, fill: '#123456' } })
    assert.equal(response.status, 200); assert.equal((await response.json()).drawing.parts[0].shapes[0].fill, '#123456')
    const program = await fetch(`${server.base}/api/films/${id}/program?name=replay`).then(r => r.json())
    assert.ok(program.source.includes('#123456'))
    await server.stop()
    server = await startServer([], { MANUAL_DATA_DIR: dataDir })
    endpoint = `${server.base}/api/films/${id}/artwork`
    const restored = await fetch(endpoint).then(r => r.json())
    assert.equal(restored.objects.find(o => o.key === object.key).drawing.parts[0].shapes[0].fill, '#123456', 'edit survives restart')
    const undone = await post({ key: object.key, undo: true }); assert.equal(undone.status, 200)
    assert.deepEqual((await undone.json()).drawing, object.drawing)
    assert.equal((await post({ key: object.key, edit: { partId: part.id, shapeId: shape.id, fill: 'url(evil)' } })).status, 400)
  } finally { await server.stop(); rmSync(dataDir, { recursive: true, force: true }) }
})


test('transparent compound holes agree in the browser benchmark, film helper and exported SVG', { skip: !chromePresent }, async () => {
  const ring = { width: 100, height: 100, parts: [{ id: 'ring', parent: null, pivot: [0, 0], shapes: [
    { id: 'outline', d: 'M10 10H90V90H10Z M30 30H70V70H30Z', fill: '#aabbcc', stroke: 'none', weight: 'none', fillRule: 'evenodd' },
  ] }] }
  validateDrawing(ring); assert.match(drawingSVG(ring), /fill-rule="evenodd"/)
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html>') })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  let browser
  try {
    browser = await openDrawingBrowser(`http://127.0.0.1:${server.address().port}`, undefined, { renderModule: null })
    const result = await browser.evaluate(`(async()=>{
      const env={palette:{ink:'#1d2b4f',accent:'#ffcc00'}};
      const canvas=document.createElement('canvas');canvas.width=100;canvas.height=100;const ctx=canvas.getContext('2d');
      ${helperFor(withUp({ ring }), {})};objects.draw(ctx,'ring',{anchor:[0,0]});
      const film=canvas.toDataURL(), centerAlpha=ctx.getImageData(50,50,1,1).data[3];
      const benchmark=(${renderDrawing.toString()})(${JSON.stringify(ring)}).png;
      const img=new Image();img.src='data:image/svg+xml,'+encodeURIComponent(${JSON.stringify(drawingSVG(ring))});await img.decode();
      const c=document.createElement('canvas');c.width=100;c.height=100;const x=c.getContext('2d');x.drawImage(img,0,0);
      return {centerAlpha,svgCenter:x.getImageData(50,50,1,1).data[3],same:film===benchmark};
    })()`)
    assert.deepEqual(result, { centerAlpha: 0, svgCenter: 0, same: true })
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)) }
})


test('layered drawings are default and classic remains explicitly selectable', () => {
  assert.equal(drawingStyle([], {}), 'layered')
  assert.equal(drawingStyle(['--drawing-style', 'layered'], {}), 'layered')
  assert.equal(drawingStyle([], { DRAWING_STYLE: 'layered' }), 'layered')
  assert.equal(drawingStyle([], { DRAWING_STYLE: 'classic' }), 'classic')
  assert.equal(drawingStyle(['--drawing-style', 'classic'], { DRAWING_STYLE: 'layered' }), 'classic')
  assert.throws(() => drawingStyle(['--drawing-style'], {}))
})
