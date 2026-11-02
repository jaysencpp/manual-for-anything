import { lineWidth, drawingSVG } from '/drawing-format.mjs'
const $ = id => document.getElementById(id)
const film = new URLSearchParams(location.search).get('film')
const endpoint = `/api/films/${encodeURIComponent(film || '')}/artwork`
$('back').href = `/films/${encodeURIComponent(film || '')}`
let objects = [], busy = false
const selected = () => objects.find(o => o.key === $('object').value)
function show() {
  const object = selected(); $('layers').replaceChildren()
  if (!object) return
  const drawing = object.drawing, ctx = $('preview').getContext('2d')
  ctx.clearRect(0, 0, 640, 480)
  ctx.save(); const scale = Math.min(600 / drawing.width, 440 / drawing.height)
  ctx.translate((640 - drawing.width * scale) / 2, (480 - drawing.height * scale) / 2); ctx.scale(scale, scale)
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'
  for (const part of drawing.parts) for (const shape of part.shapes) {
    if (!shape.hidden) {
      const path = new Path2D(shape.d)
      if (shape.fill && shape.fill !== 'none') { ctx.fillStyle = shape.fill; ctx.fill(path, shape.fillRule || "nonzero") }
      if (shape.stroke && shape.stroke !== 'none' && lineWidth(shape) > 0) { ctx.lineWidth = lineWidth(shape); ctx.strokeStyle = shape.stroke; ctx.stroke(path) }
    }
    const row = document.createElement('div'); row.className = 'artwork-layer'
    const label = document.createElement('span'); label.textContent = `${part.id}: ${shape.id}`
    const visible = document.createElement('button'); visible.type = 'button'; visible.textContent = shape.hidden ? 'Show' : 'Hide'; visible.disabled = busy
    visible.onclick = () => save({ partId: part.id, shapeId: shape.id, hidden: !shape.hidden })
    row.append(label, visible)
    if (/^#[\da-f]{6}$/i.test(shape.fill || '')) {
      const color = document.createElement('input'); color.type = 'color'; color.value = shape.fill; color.disabled = busy; color.setAttribute('aria-label', `Fill colour of ${shape.id}`)
      color.onchange = () => save({ partId: part.id, shapeId: shape.id, fill: color.value }); row.append(color)
    }
    $('layers').append(row)
  }
  ctx.restore(); $('object').disabled = busy; $('undo').disabled = busy
}
async function save(edit, undo = false) {
  if (busy || !selected()) return
  const object = selected(); busy = true; show(); $('status').textContent = 'Saving…'
  try {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: object.key, edit, undo }) })
    const result = await response.json(); if (!response.ok) throw Error(result.error || 'Could not save drawing')
    object.drawing = result.drawing; $('status').textContent = 'Saved. Return to the film to see the change.'
  } catch (error) { $('status').textContent = error.message }
  finally { busy = false; show() }
}
$('object').onchange = () => { $('status').textContent = ''; show() }
$('undo').onclick = () => save(null, true)
$('download').onclick = () => {
  if (!selected()) return
  const url = URL.createObjectURL(new Blob([drawingSVG(selected().drawing)], { type: 'image/svg+xml' }))
  const a = document.createElement('a'); a.href = url; a.download = `${selected().key}.svg`; a.click(); URL.revokeObjectURL(url)
}
try {
  const response = await fetch(endpoint), result = await response.json()
  if (!response.ok) throw Error(result.error || 'Could not load drawings')
  objects = result.objects
  for (const object of objects) $('object').append(Object.assign(document.createElement('option'), { value: object.key, textContent: object.name }))
  $('status').textContent = objects.length ? '' : 'This film uses parts drawn from dimensions and has no editable object artwork.'; show()
} catch (error) { $('status').textContent = error.message }
