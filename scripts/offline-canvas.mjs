// A recording canvas for deterministic local program checks. It creates no image or film and calls no provider.
export function recordingCanvas() {
  const calls = [], stack = [], state = { globalAlpha: 1 }, identity = () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
  const ctx = new Proxy(state, { get: (o, k) => {
    if (k in o) return o[k]
    if (k === 'measureText') return (s) => ({ width: String(s).length * 12 })
    if (k === 'getTransform') return identity
    return (...args) => {
      calls.push({ method: k, args, fill: state.fillStyle })
      if (k === 'save') stack.push({ ...state })
      if (k === 'restore') { const saved = stack.pop(); if (!saved) throw Error('Unbalanced canvas restore'); Object.keys(state).forEach((k) => delete state[k]); Object.assign(state, saved) }
      for (const a of args) if (typeof a === 'number' && !Number.isFinite(a)) throw Error(`Non-finite canvas coordinate in ${String(k)}`)
    }
  }, set: (o, k, v) => { o[k] = v; return true } })
  return { ctx, calls, depth: () => stack.length }
}

export function offlineEnv() {
  const clamp = (u) => Math.max(0, Math.min(1, u)), ease = {
    linear: clamp, in: (u) => clamp(u) ** 3, out: (u) => 1 - (1 - clamp(u)) ** 3,
    inOut: (u) => (u = clamp(u)) < 0.5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2,
    expoOut: (u) => clamp(u) === 1 ? 1 : 1 - 2 ** (-10 * clamp(u)), back: clamp,
  }
  return { width: 1600, height: 900, font: 'Inter', mono: 'JetBrains Mono',
    palette: { background: '#f3efe6', accent: '#ffcc00', ink: '#1d2b4f', second: '#ffcc00', muted: '#1d2b4f' },
    ease, random: (i) => { const n = Math.sin(i * 78.233) * 43758.5453; return n - Math.floor(n) },
    kit: { spring: clamp }, screens: {}, drawScreen: () => {} }
}
