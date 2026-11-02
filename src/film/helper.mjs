// The objects helper the film programs draw with: every object's part-based
// drawing, posed, with its cut-out under it. helperFor(vectors, boxes) is the source of a block that defines `objects`
// inside a (ctx, t, env) program.
import { data } from '../pipeline/words.mjs'

// "parent" is a word the program validator refuses, even as a property name: the chain is carried as "up".
export const withUp = (vectors) => Object.fromEntries(Object.entries(vectors).map(([key, object]) =>
  [key, { ...object, parts: object.parts.map(({ parent: up, ...part }) => ({ ...part, up: up ?? null })) }]))

export const helperFor = (vectors, boxes) => `
  const V = ${data(vectors)}, BOX = ${data(boxes)};
  const ACCENT = env.palette.accent, INK = env.palette.ink;
  // An object's transform, as [a, b, c, d, e, f]: its anchor (default its middle) placed at x, y, turned and scaled.
  const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  const move = (x, y) => [1, 0, 0, 1, x, y], turn = (a) => [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0], grow = (s) => [s, 0, 0, s, 0, 0];
  const placed = (key, o) => {
    const v = V[key], an = o.anchor || [v.width / 2, v.height / 2];
    return mul(mul(mul(move(o.x || 0, o.y || 0), turn(o.angle || 0)), grow(o.scale || 1)), move(-an[0], -an[1]));
  };
  const chainOf = (v, id) => { const list = []; for (let p = v.parts.find((q) => q.id === id); p; p = v.parts.find((q) => q.id === p.up)) list.unshift(p); return list; };
  const posed = (v, id, angles) => chainOf(v, id).reduce((m, p) => {
    const a = (angles || {})[p.id] || 0;
    return a ? mul(mul(mul(m, move(p.pivot[0], p.pivot[1])), turn(a)), move(-p.pivot[0], -p.pivot[1])) : m;
  }, [1, 0, 0, 1, 0, 0]);
  const apply = (m, x, y) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });
  const objects = {
    keys: Object.keys(V),
    size: (key) => ({ width: V[key].width, height: V[key].height }),
    info: (key) => V[key],
    photoBox: (key) => BOX[key],
    // Where a point of the object (its own coordinates, on part "part" if given, posed by o.angles) is on the frame.
    point: (key, pt, o, part) => apply(part ? mul(placed(key, o), posed(V[key], part, o.angles)) : placed(key, o), pt[0], pt[1]),
    draw: (ctx, key, o) => {
      const v = V[key], m = placed(key, o);
      const photo = o.photo || 0, reveal = o.reveal === undefined ? 1 : o.reveal, fill = o.fill === undefined ? 1 : o.fill;
      const glow = o.highlight || 0, alpha = o.alpha === undefined ? 1 : o.alpha;
      if (alpha <= 0) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
      // A piece cut from another object is that object's drawing and cut-out, clipped to its stretch.
      if (v.slice) { ctx.beginPath(); ctx.rect(0, 0, v.width, v.height); ctx.clip(); ctx.translate(-v.slice[0], 0); }
      // (a model drawing a tracing is upgraded to, key@drawn, lies over the same cut-out)
      const screen = v.sliceOf || key.split("@")[0];
      // (where it is drawn, for a canvas that keeps track: frames.mjs's; the film's canvas has no mark)
      if (ctx.mark) ctx.mark(key, ...(v.bounds || [0, 0, v.width, v.height]));
      if (photo > 0) {
        // The cut-out lies under the drawing at the drawing's own size: its pixels times 4.
        ctx.globalAlpha = alpha * photo; env.drawScreen(ctx, screen, 0, 0, env.screens[screen].width * 4, env.screens[screen].height * 4);
        ctx.globalAlpha = alpha;
      }
      for (const part of v.parts) {
        ctx.save();
        const p = posed(v, part.id, o.angles);
        ctx.transform(p[0], p[1], p[2], p[3], p[4], p[5]);
        for (const shape of part.shapes) {
          if (shape.hidden) continue;
          const width = shape.weight == null ? 3 : ({ none: 0, detail: 1.25, edge: 2, silhouette: 3 })[shape.weight];
          const path = new Path2D(shape.d);
          if (shape.fill && shape.fill !== "none" && fill > 0) { ctx.globalAlpha = alpha * fill; ctx.fillStyle = shape.fill; ctx.fill(path, shape.fillRule || "nonzero"); }
          if (shape.stroke && shape.stroke !== "none" && width > 0 && reveal > 0) {
            ctx.lineJoin = "round"; ctx.lineCap = "round";
            // lit: the parts to light, as a list or one id; anything else lights them all.
            const only = Array.isArray(o.lit) ? o.lit : typeof o.lit === "string" ? [o.lit] : null;
            const lit = glow * (only === null || only.includes(part.id) ? 1 : 0);
            if (lit > 0) { ctx.globalAlpha = alpha * lit; ctx.strokeStyle = ACCENT; ctx.lineWidth = 9 / (o.scale || 1) * 1.2; ctx.stroke(path); }
            ctx.globalAlpha = alpha; ctx.strokeStyle = shape.stroke; ctx.lineWidth = width;
            if (reveal < 1) { ctx.setLineDash([4000, 4000]); ctx.lineDashOffset = 4000 * (1 - reveal); }
            ctx.stroke(path); ctx.setLineDash([]);
          }
        }
        ctx.restore();
      }
      // A clock's digits: o.digits ("1259"), or o.flip {from, to, p} folding each changed card over its middle.
      if (v.digits && (o.digits || o.flip) && fill > 0) {
        const [dx, dy, dw, dh] = v.digits, cw = dw / 4;
        const from = o.flip ? o.flip.from : o.digits, to = o.flip ? o.flip.to : o.digits, f = o.flip ? o.flip.p : 0;
        ctx.font = "700 " + Math.round(dh * 0.78) + "px " + env.mono; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        for (let i = 0; i < 4; i++) {
          const g = Math.min(1, Math.max(0, f * 1.6 - i * 0.2)), changed = from[i] !== to[i];
          const ch = changed && g >= 0.5 ? to[i] : from[i], squash = changed ? Math.abs(Math.cos(Math.PI * g)) : 1;
          const cx = dx + cw * (i + 0.5), cy = dy + dh / 2;
          ctx.save(); ctx.globalAlpha = alpha * fill; ctx.translate(cx, cy); ctx.scale(1, Math.max(0.02, squash));
          ctx.fillStyle = "#ffffff"; ctx.strokeStyle = INK; ctx.lineWidth = 3;
          ctx.beginPath(); ctx.roundRect(-cw / 2 + 5, -dh / 2 + 4, cw - 10, dh - 8, 8); ctx.fill(); ctx.stroke();
          ctx.fillStyle = INK; ctx.fillText(ch, 0, 4); ctx.restore();
        }
      }
      ctx.restore();
    },
  };`
