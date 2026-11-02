// A finished assembly stays intact. Reuse its solved geometry rather than generating a second, contradictory scene.
import { data } from './words.mjs'

export function fixedReveal(script, layout) {
  if (!Object.keys(layout.boards || {}).length) return null
  const placed = new Set((script.steps || []).flatMap((s) => s.do || []).filter((a) => a.v === 'place').flatMap((a) => a.k))
  const bounds = layout.order.filter((k) => placed.has(k) && !layout.transients?.includes(k)).map((k) => {
    const b = layout.boards[k], p = layout.poses[k]
    if (!b || !p) return null
    const x = p.x - p.anchor[0] * p.scale, y = p.y - p.anchor[1] * p.scale
    return [x, y, x + b.w * p.scale, y + b.h * p.scale]
  }).filter(Boolean)
  if (!bounds.length) return null
  const x0 = Math.min(...bounds.map((b) => b[0])), y0 = Math.min(...bounds.map((b) => b[1]))
  const x1 = Math.max(...bounds.map((b) => b[2])), y1 = Math.max(...bounds.map((b) => b[3]))
  const zoom = Math.min(1100 / Math.max(1, x1 - x0), 490 / Math.max(1, y1 - y0), 1.5)
  return `(ctx, u, env, objects, stage) => {
    ctx.save(); ctx.translate(900, 540); ctx.scale(${zoom}, ${zoom}); ctx.translate(${-(x0 + x1) / 2}, ${-(y0 + y1) / 2});
    stage.draw(ctx); ctx.restore();
    ctx.fillStyle = "#1d2b4f"; ctx.textAlign = "center"; ctx.font = "700 48px " + env.font;
    ctx.fillText(${data(script.title)}, 900, 165);
    ctx.font = "400 26px " + env.font; ctx.fillText(${data(script.tag || '')}, 900, 210);
  }`
}
