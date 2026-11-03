// The brick solver, for builds of toy bricks: every brick on a stud grid, placed the way a builder says it ("on the
// log, from its second stud, turned"), checked so the build could really stand, and drawn by the engine from its
// numbers in IKEA's iso view — never from the photo, whose angles can't line up. Its output is the joint solver's
// (layout.mjs → solveJoints), so the engine's placing, camera, shadows and draw order all work as for boards.
//
// A brick ("part": {"family": "brick", "studs": [w, d], "plates": h, "shape": …} on its object, else read from its name:
// "red 1x4 brick", "blue 2x2 round brick", "tan 1x2 grille", "a 2x4 plate"): w × d studs, h plates high (a brick 3, a
// plate or tile 1); shape brick, plate, tile (no studs), round (a cylinder), slope (falls to the front, studs on the
// back row), log (rounded ridges down its face), grille (slots down its face); "side_studs" for studs on its face.
// World axes in studs (x right, y away) and plates (z up); a stud is 0.8 cm, a plate 0.32 cm.
// Plans count rows from the back, as the prompt tells them: a larger row is nearer the viewer, so it is a smaller y.
// Placing it, for "place" k:
//   floor  — on the table: "studs": [x, row] for its back-left corner, else beside the build, a stud apart;
//   on     — on `to`: "studs": [i, j], where its corner sits on `to`'s stud grid (from `to`'s back left stud), else
//            centred on it; "turn": 90 turns it a quarter (w and d swap). It sits on the highest brick under it.
// The checks: it must sit on at least one stud of what is under it (moved onto the nearest that does), and never in
// another brick (slid along to the nearest free place). What was moved is noted in layout.notes.
//
//   isBrickBuild(script) → whether the script is one;  solveBricks(script, geometry, sizes) → the joint solver's layout

const STUD = 0.8, PLATE = 0.32

// A brick's part, from the script or its name.
export function brickOf(object) {
  if (!object) return null
  const p = object.part
  if (p && p.family === 'brick' && Array.isArray(p.studs)) return { w: +p.studs[0] || 1, d: +p.studs[1] || 1, h: +p.plates || 3, shape: p.shape || 'brick', sideStuds: !!p.side_studs }
  const n = String(object.n || '').toLowerCase()
  const m = n.match(/(\d+)\s*[x×]\s*(\d+)/)
  if (!m || !/brick|plate|tile|lego|duplo|slope|round|grille/.test(n)) return null
  const shape = /round|cylinder/.test(n) ? 'round' : /slope|curved/.test(n) ? 'slope' : /grille/.test(n) ? 'grille' : /log/.test(n) ? 'log'
    : /tile/.test(n) ? 'tile' : /plate/.test(n) ? 'plate' : 'brick'
  const [a, b] = [+m[1], +m[2]]
  return { w: Math.max(a, b), d: Math.min(a, b), h: shape === 'plate' || shape === 'tile' ? 1 : 3, shape, sideStuds: /side stud/.test(n) }
}

export const isBrickBuild = (script) => {
  const placed = new Set((script.steps || []).flatMap((s) => (s.do || []).filter((a) => a.v === 'place').map((a) => a.k)))
  const objects = (script.objects || []).filter((o) => placed.has(o.k))
  return objects.length > 0 && objects.filter((o) => brickOf(o)).length >= Math.max(1, objects.length * 0.6)
}

export function solveBricks(script, geometry, sizes, options = {}) {
  const { floorY = 790, centerX = 910, maxWidth = 900, maxHeight = 560 } = options
  const objects = Object.fromEntries((script.objects || []).map((o) => [o.k, o]))
  const B = {}, order = [], extras = [], notes = [], gaps = []
  // Its box on the grid: corner (x, y, z) and extent (w, d, h), turned if it is.
  const cells = (b) => { const r = []; for (let i = 0; i < b.w; i++) for (let j = 0; j < b.d; j++) r.push([b.x + i, b.y + j]); return r }
  const overlapsXY = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.d && b.y < a.y + a.d
  const clash = (b, skip) => Object.entries(B).some(([k, o]) => k !== skip && overlapsXY(b, o) && b.z < o.z + o.h && o.z < b.z + b.h)
  // What it sits on: the highest top under its footprint (0, the table).
  const restOn = (b) => Math.max(0, ...Object.values(B).filter((o) => overlapsXY(b, o)).map((o) => o.z + o.h))
  let floorRight = 0
  const put = (k, b) => { B[k] = b; order.push(k); floorRight = Math.max(floorRight, b.x + b.w) }
  for (const step of script.steps || []) for (const a of step.do || []) {
    if (a.v !== 'place') {
      for (const held of [a.with, a.part]) if (held && geometry[held] && !extras.includes(held)) extras.push(held)
      continue
    }
    const part = brickOf(objects[a.k]); if (!part || B[a.k] || !geometry[a.k]) continue
    const turned = +a.turn === 90 || +a.turn === 270
    let b = { w: turned ? part.d : part.w, d: turned ? part.w : part.d, h: part.h, part, turned }
    const to = a.to && B[a.to] ? B[a.to] : null
    const s = Array.isArray(a.studs) && a.studs.length >= 2 ? a.studs.map(Number) : null
    if (!to || a.rel === 'floor') {
      // On the table: where the script says on its grid (on whatever is already there), else beside the build.
      b = s ? { ...b, x: s[0], y: -s[1] - b.d } : { ...b, x: order.length ? Math.ceil(floorRight) + 1 : 0, y: -b.d }
      b.z = restOn(b)
      // Set on the table at a stud the script gave, beside a brick already there in its row: the film measures how far
      // apart they are, corner to corner, as the script counts it ("6 studs to the right" of it).
      if (s && b.z === 0) {
        const row = Object.entries(B).filter(([, o]) => o.z === 0 && o.y < b.y + b.d && b.y < o.y + o.d && o.x !== b.x)
        const [ref, o] = row.sort((p, q) => Math.abs(p[1].x - b.x) - Math.abs(q[1].x - b.x))[0] || []
        if (ref) gaps.push({ k: a.k, ref, x0: Math.min(o.x, b.x), x1: Math.max(o.x, b.x), y: Math.min(o.y, b.y), studs: Math.abs(b.x - o.x) })
      }
    } else {
      // (no studs given: "at" start, middle or end along `to`'s length, else its middle)
      const along = { start: 0, left: 0, end: to.w - b.w, right: to.w - b.w }[a.at]
      let ox = s ? s[0] : along ?? Math.round((to.w - b.w) / 2), oy = s ? s[1] : Math.round((to.d - b.d) / 2)
      // On at least one of its studs: the offset kept within reach of it.
      const nx = Math.min(Math.max(ox, 1 - b.w), to.w - 1), ny = Math.min(Math.max(oy, 1 - b.d), to.d - 1)
      if (nx !== ox || ny !== oy) notes.push(`${a.k}: moved onto ${a.to}'s studs (${ox},${oy} → ${nx},${ny})`)
      b = { ...b, x: to.x + nx, y: to.y + to.d - ny - b.d }
      b.z = restOn(b)
      // Never in another brick: slid along x, then y, to the nearest place that is free and still on `to`.
      if (clash(b)) {
        const tries = []
        for (let r = 1; r <= 6; r++) for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r]]) tries.push([dx, dy])
        const free = tries.map(([dx, dy]) => ({ ...b, x: b.x + dx, y: b.y + dy })).map((c) => ({ ...c, z: restOn(c) })).find((c) => overlapsXY(c, to) && !clash(c))
        if (free) { notes.push(`${a.k}: slid clear of another brick`); b = free }
      }
    }
    put(a.k, b)
  }

  // The view: IKEA's iso, as the joint solver draws it (x right and down, y away right and up, z up), in cm.
  const unit = 4
  // Three ways to look at it (viewOf, below): "oblique" (the default: the front square to the viewer, so a row of bricks is level and a
  // brick bridging two plainly bridges them; depth half as long, up and to the right at 45°), "dimetric" (7°/42°: rows
  // fall a little as they run right) and "iso" (IKEA's 30°: a row runs down the frame as it runs right, so two legs in a
  // row read as one in front of the other). All three scored alike with the critic (Oct 27, 3.8-4.0 a step); only
  // oblique drew no note that the legs looked staggered.
  const { project, flat } = viewOf(options.brickView || process.env.BRICK_VIEW || 'oblique', unit)
  const cm = (b) => ({ x0: b.x * STUD, x1: (b.x + b.w) * STUD, y0: b.y * STUD, y1: (b.y + b.d) * STUD, z0: b.z * PLATE, z1: (b.z + b.h) * PLATE })
  const corners = (k) => { const c = cm(B[k]), r = []; for (const x of [c.x0, c.x1]) for (const y of [c.y0, c.y1]) for (const z of [c.z0, c.z1 + 0.17]) r.push(project(x, y, z)); return r }
  const fitOf = (keys) => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
    for (const k of keys) for (const [x, y] of corners(k)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
    return x0 === Infinity ? { x0: 0, x1: 1, y0: -1, y1: 0 } : { x0, x1, y0, y1 }
  }
  // The whole build, fitted once: its scale never changes as bricks go on (up to 120 screen pixels a cm: bricks are small).
  const f = fitOf(order)
  const scale = Math.min(maxWidth / Math.max(1, f.x1 - f.x0), maxHeight / Math.max(1, f.y1 - f.y0), 120) / unit
  const toScreen = ([x, y]) => [centerX + (x - (f.x0 + f.x1) / 2) * scale * unit, floorY + (y - f.y1) * scale * unit]
  const poses = {}, boards = {}
  const perCm = Object.values(objects).filter((o) => +o.cm > 0 && sizes[o.k]).map((o) => Math.max(sizes[o.k].width, sizes[o.k].height) / +o.cm).sort((a, b) => a - b)
  const pxPerCm = perCm.length ? perCm[perCm.length >> 1] : 10
  for (const k of extras.filter((x) => !B[x])) poses[k] = { x: 0, y: 0, scale: scale * unit / (pxPerCm * 4), angle: 0, anchor: geometry[k].base ? geometry[k].base.map((n) => n * 4) : [0, 0] }
  for (const k of order) {
    const b = B[k], c = cm(b), all = corners(k)
    const x0 = Math.min(...all.map((q) => q[0])), y0 = Math.min(...all.map((q) => q[1])), x1 = Math.max(...all.map((q) => q[0])), y1 = Math.max(...all.map((q) => q[1]))
    const local = ([x, y]) => [(x - x0) * unit, (y - y0) * unit], at = (x, y, z) => local(project(x, y, z))
    const q = (pts) => pts.map(([x, y, z]) => at(x, y, z))
    const shape = b.part.shape
    // Its faces (as the joint solver's: front at y0, right at x1, upper); a slope's upper face falls to the front.
    const low = shape === 'slope' && b.d > 1 ? c.z0 + PLATE : c.z1, back = shape === 'slope' && b.d > 1 ? c.y0 + STUD : c.y0
    const faces = [
      { kind: 'front', pts: q([[c.x0, c.y0, c.z0], [c.x1, c.y0, c.z0], [c.x1, c.y0, low], [c.x0, c.y0, low]]) },
      { kind: 'side', pts: q(shape === 'slope' && b.d > 1 ? [[c.x1, c.y0, c.z0], [c.x1, c.y1, c.z0], [c.x1, c.y1, c.z1], [c.x1, back, c.z1], [c.x1, c.y0, low]] : [[c.x1, c.y0, c.z0], [c.x1, c.y1, c.z0], [c.x1, c.y1, c.z1], [c.x1, c.y0, c.z1]]) },
      { kind: 'upper', pts: q(shape === 'slope' && b.d > 1 ? [[c.x0, back, c.z1], [c.x1, back, c.z1], [c.x1, c.y0, low], [c.x0, c.y0, low]] : [[c.x0, c.y0, c.z1], [c.x1, c.y0, c.z1], [c.x1, c.y1, c.z1], [c.x0, c.y1, c.z1]]) },
    ]
    if (shape === 'slope' && b.d > 1) faces.push({ kind: 'upper', pts: q([[c.x0, back, c.z1], [c.x1, back, c.z1], [c.x1, c.y1, c.z1], [c.x0, c.y1, c.z1]]) })
    // Studs: the middle of each on its upper face (none on a tile; a slope's only behind its fall), and a stud's size.
    const studs = shape === 'tile' ? [] : cells(b).filter(([, y]) => !(shape === 'slope' && b.d > 1 && y < b.y + 1))
      .map(([x, y]) => at((x + 0.5) * STUD, (y + 0.5) * STUD, c.z1))
    const brick = { color: geometry[k].color || '#c8402f', shape, studs, stud: { ...flat(0.24), h: 0.17 * unit },
      // a round brick: its cylinder's bottom and top middles and its radius on the frame
      round: shape === 'round' ? { c0: at((c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2, c.z0), c1: at((c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2, c.z1), ...flat(Math.min(c.x1 - c.x0, c.y1 - c.y0) / 2) } : null,
      // its face's stud columns (log ridges, grille slots, side studs run down it): their feet and tops on the front face
      columns: Array.from({ length: b.w }, (_, i) => [at(c.x0 + (i + 0.5) * STUD, c.y0, c.z0), at(c.x0 + (i + 0.5) * STUD, c.y0, low)]),
      sideStuds: b.part.sideStuds }
    const [cx, cy] = toScreen([(x0 + x1) / 2, (y0 + y1) / 2])
    poses[k] = { x: cx, y: cy, scale, angle: 0, anchor: [(x1 - x0) * unit / 2, (y1 - y0) * unit / 2] }
    boards[k] = { w: (x1 - x0) * unit, h: (y1 - y0) * unit, faces, line: [at(c.x0, (c.y0 + c.y1) / 2, c.z1), at(c.x1, (c.y0 + c.y1) / 2, c.z1)], faceLines: {}, brick }
  }
  // Drawn back to front: the lower first, then the further away.
  const depth = (k) => { const b = B[k]; return b.z * 100 + (b.x + b.w / 2) - (b.y + b.d / 2) }
  // Each measured gap on the frame: its two ends on the table at the front of the row.
  const dims = gaps.map((g) => ({ k: g.k, label: `${g.studs} stud${g.studs === 1 ? '' : 's'}`,
    from: toScreen(project(g.x0 * STUD, g.y * STUD, 0)), to: toScreen(project(g.x1 * STUD, g.y * STUD, 0)) }))
  return { order: [...order].sort((a, b) => depth(a) - depth(b)), extras: extras.filter((x) => !B[x]), transients: [], poses, boards, floorY, view: 'iso', grid: B, notes, dims }
}

// A way of looking at a build in cm (x right, y away, z up): "oblique" (the front square to the viewer, depth half as
// long at 45°), "dimetric" (7°/42°) or "iso" (30°). X and Y: where one cm along x and along y goes on the frame; z is
// straight up. project(x, y, z) → [x, y] on the frame (cm); flat(r) → a circle of radius r lying flat, as drawn (in
// drawing units, unit to a cm): an ellipse's half-axes and its turn. Shared with scene.mjs.
export function viewOf(angle, unit) {
  const deg = Math.PI / 180
  const [X, Y] = angle === 'oblique' ? [[1, 0], [0.5 * Math.cos(45 * deg), -0.5 * Math.sin(45 * deg)]]
    : angle === 'dimetric' ? [[Math.cos(7 * deg), Math.sin(7 * deg)], [0.5 * Math.cos(42 * deg), -0.5 * Math.sin(42 * deg)]]
    : [[Math.cos(30 * deg), Math.sin(30 * deg)], [Math.cos(30 * deg), -Math.sin(30 * deg)]]
  const project = (x, y, z) => [x * X[0] + y * Y[0], x * X[1] + y * Y[1] - z]
  const flat = (r) => {
    const a = X[0] * X[0] + Y[0] * Y[0], b = X[0] * X[1] + Y[0] * Y[1], c = X[1] * X[1] + Y[1] * Y[1]
    const m = (a + c) / 2, d = Math.sqrt(((a - c) / 2) ** 2 + b * b)
    return { rx: r * Math.sqrt(m + d) * unit, ry: r * Math.sqrt(Math.max(0, m - d)) * unit, rot: 0.5 * Math.atan2(2 * b, a - c) }
  }
  return { project, flat }
}
