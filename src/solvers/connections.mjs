const AXES = ['x', 'y', 'z']
export function faceFrame(b, face) {
  const named = { upper: ['z', 1], lower: ['z', -1], front: ['y', -1], back: ['y', 1], left: ['x', -1], right: ['x', 1],
    start: [b.o.L, -1], end: [b.o.L, 1] }
  const [axis, sign] = named[face] || named.upper
  const along = b.o.L !== axis ? b.o.L : b.o.W !== axis ? b.o.W : AXES.find((a) => a !== axis)
  const across = AXES.find((a) => a !== axis && a !== along)
  return { axis, sign, along, across }
}

export function facePoint(b, face, site) {
  const f = faceFrame(b, face), p = { ...b.p }
  p[f.axis] += f.sign > 0 ? b.e[f.axis] : 0
  p[f.along] += b.e[f.along] * site.x
  p[f.across] += b.e[f.across] * (0.5 + (site.lat || 0))
  return p
}

export function faceLinesFor(b, project) {
  return Object.fromEntries(['upper', 'lower', 'front', 'back', 'left', 'right', 'start', 'end'].map((name) => {
    const point = (x, lat) => { const p = facePoint(b, name, { x, lat }); return project(p.x, p.y, p.z) }
    const f = faceFrame(b, name), center = facePoint(b, name, { x: 0.5, lat: 0 }), c0 = project(center.x, center.y, center.z)
    center[f.axis] += f.sign
    const c1 = project(center.x, center.y, center.z), len = Math.hypot(c1[0] - c0[0], c1[1] - c0[1])
    return [name, { line: [point(0, 0), point(1, 0)], basis: [point(0, -0.5), point(1, -0.5), point(0, 0.5)],
      n: len < 0.2 ? [0, -1] : [(c1[0] - c0[0]) / len, (c1[1] - c0[1]) / len] }]
  }))
}

export function checkConnections(script, world, tolerance = 0.01) {
  const problems = [], connections = []
  for (const j of script.joints || []) {
    const a = world[j.a], b = world[j.b]
    const bounds = (part) => part && Object.fromEntries(AXES.map((ax) => [ax, [+part.p[ax].toFixed(2), +(part.p[ax] + part.e[ax]).toFixed(2)]]))
    const fail = (code, message, details = {}) => problems.push({ joint: j.id, code, message,
      details: { units: 'cm', a: { key: j.a, bounds: bounds(a), entryFace: j.face }, b: { key: j.b, bounds: bounds(b), receivingFace: j.otherFace }, ...details } })
    if (!a || !b) { fail('missing-solid', 'Both joint parts need numeric geometry'); continue }
    const entry = faceFrame(a, j.face), other = faceFrame(b, j.otherFace), through = j.method === 'fasten'
    // (a part turned — leaning, splayed — meets the other where its upright box does, near enough to show: its joint is
    // taken as made, not measured)
    if (a.turn || b.turn) { connections.push({ id: j.id, a: j.a, b: j.b, axis: entry.axis, plane: a.p[entry.axis] + (entry.sign > 0 ? a.e[entry.axis] : 0), sites: j.sites, approx: true }); continue }
    const sign = through ? -entry.sign : entry.sign
    if (entry.axis !== other.axis || sign !== -other.sign) { fail('face-direction', `Mating faces must oppose each other. ${j.a} entry face is ${j.face}; ${j.b} receiving face is ${j.otherFace}. For fastening, name the outer entry face and the receiver's entry face, not the two contacting faces.`); continue }
    const planeA = a.p[entry.axis] + (sign > 0 ? a.e[entry.axis] : 0)
    const planeB = b.p[other.axis] + (other.sign > 0 ? b.e[other.axis] : 0)
    if (Math.abs(planeA - planeB) > tolerance) {
      const opposite = { left: 'right', right: 'left', front: 'back', back: 'front', upper: 'lower', lower: 'upper', start: 'end', end: 'start' }
      const reverseA = a.p[entry.axis] + (entry.sign > 0 ? a.e[entry.axis] : 0)
      const reverseB = b.p[other.axis] + (other.sign < 0 ? b.e[other.axis] : 0)
      const overlap = AXES.filter((ax) => ax !== entry.axis).every((ax) => Math.min(a.p[ax] + a.e[ax], b.p[ax] + b.e[ax]) - Math.max(a.p[ax], b.p[ax]) > tolerance)
      const placement = (script.steps || []).flatMap((s) => s.do || []).filter((op) => op.v === 'place' && op.k === j.b).at(-1)
      const neighbour = placement?.to && world[placement.to]
      const across = ['left', 'right'].includes(placement?.side) ? 'x' : ['front', 'back'].includes(placement?.side) ? 'y' : null
      const aligned = neighbour && b.o.L === 'z' && placement.rel === 'parallel' && across && across !== entry.axis && entry.axis !== 'z' &&
        Math.abs(neighbour.p[entry.axis] + (other.sign > 0 ? neighbour.e[entry.axis] : 0) - planeA) <= tolerance
      const alignFace = { x: ['left', 'right'], y: ['front', 'back'] }[entry.axis]?.[other.sign > 0 ? 1 : 0]
      const hint = through && overlap && Math.abs(reverseA - reverseB) <= tolerance
        ? ` The parts touch on the opposite side: use entry face ${opposite[j.face]} on ${j.a} and receiving face ${opposite[j.otherFace]} on ${j.b}, keeping the placement.`
        : aligned ? ` On ${j.b}'s existing parallel placement relative to ${placement.to}, explicitly set align:"${alignFace}" to align their ${alignFace} edges; then recheck every joint. Keep the entry faces.`
        : ` Position ${j.b} relative to ${j.a}; an independent floor placement does not define a second row. Change the placement, not just the face names.`
      fail('no-contact', `Joint surfaces do not touch: ${j.a} exit plane ${entry.axis}=${+planeA.toFixed(2)} cm, ${j.b} receiving plane ${other.axis}=${+planeB.toFixed(2)} cm (separation ${+Math.abs(planeA - planeB).toFixed(2)} cm).${hint}`,
        { axis: entry.axis, exitPlane: planeA, receivingPlane: planeB, separation: Math.abs(planeA - planeB) })
      continue
    }
    for (const [i, site] of (j.sites || []).entries()) {
      const p = facePoint(a, j.face, site); p[entry.axis] = planeA
      if (AXES.filter((ax) => ax !== entry.axis).some((ax) => p[ax] < b.p[ax] - tolerance || p[ax] > b.p[ax] + b.e[ax] + tolerance))
        fail('missed-target', `Work site ${i + 1} misses the receiving part`)
    }
    if (through && j.depthCm != null && (j.depthCm <= a.e[entry.axis] + tolerance || j.depthCm > a.e[entry.axis] + b.e[entry.axis] + tolerance))
      fail('invalid-depth', `Fastener must enter the receiver without exiting its far face: ${j.a} is ${+a.e[entry.axis].toFixed(1)} cm and ${j.b} ${+b.e[entry.axis].toFixed(1)} cm thick there, so a ${j.depthCm} cm fastener ${j.depthCm <= a.e[entry.axis] ? `ends inside ${j.a}` : `comes out of ${j.b}`}; use one longer than ${+a.e[entry.axis].toFixed(1)} cm and at most ${+(a.e[entry.axis] + b.e[entry.axis]).toFixed(1)} cm (the fastener's cm and the joint's depthCm)`)
    connections.push({ id: j.id, a: j.a, b: j.b, axis: entry.axis, plane: planeA, sites: j.sites })
  }
  return { problems, connections }
}
