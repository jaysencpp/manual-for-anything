// The film player: a canvas runtime (programEnvFor and the flat frame loop) on the
// browser canvas, so a film plays the moment its program is ready.
// It runs in a sandboxed iframe (player.html: scripts only, an opaque origin, nothing to fetch), because a film's program
// carries model-written code (the finale, the reference panel's drawing, demonstrations). The page talks to it by
// messages only:
//   in:  {type: 'assets', kit, fonts: [{family, weight, data}]}        the drawing kit and the fonts, once
//        {type: 'screens', screens: {key: {width, height, regions, bitmap}}}  pictures drawScreen draws, any time
//        {type: 'program', source, duration, at?}   a film's program; a later one takes over at the same moment
//        {type: 'play'} {type: 'pause'} {type: 'seek', t}
//   out: {type: 'ready'} {type: 'time', t, duration, playing} {type: 'error', message}
(function () {
  'use strict'
  // The HTTP sandbox also applies to direct navigation and hostile embeddings.
  // Only the same-origin app parent may supply trusted assets or film programs.
  if (window.parent === window) return
  const appOrigin = new URL(window.location.href).origin
  const VW = 1600, VH = 900
  const canvas = document.getElementById('film'), ctx = canvas.getContext('2d', { alpha: false })
  const freeze = Object.freeze
  const numeric = (value, fallback = 0) => { const n = Number(value); return Number.isFinite(n) ? n : fallback }
  const say = (message) => parent.postMessage(message, '*')
  // Shared drawing defaults for the browser film program.
  const PROPS = { background: '#f3efe6', accent: '#ffcc00', ink: '#1d2b4f', second: '#ffcc00', muted: '#1d2b4f', font: 'Inter', mono: 'JetBrains Mono', seed: 1 }

  let programKit = null
  const library = new Map()
  let film = null // {draw, env, duration}
  let t = 0, playing = false, last = null

  // ---- programEnvFor, as prelude.js has it, but drawScreen draws a bitmap ----
  const seeded = (seed, index) => { const v = Math.sin(numeric(seed) * 12.9898 + index * 78.233) * 43758.5453; return v - Math.floor(v) }
  function envFor(props) {
    const text = (value, fallback) => typeof value === 'string' && value.length <= 64 ? value : fallback
    const palette = freeze({ background: text(props.background, '#0b0e14'), accent: text(props.accent, '#7c5cff'), ink: text(props.ink, '#ffffff'), second: text(props.second, '#ff7a59'), muted: text(props.muted, '#8b93a7') })
    const font = text(props.font, 'Inter'), seed = numeric(props.seed, 1), mono = text(props.mono, 'JetBrains Mono')
    const screens = freeze(Object.fromEntries([...library.entries()].map(([key, e]) => [key, freeze({ width: e.width, height: e.height,
      regions: freeze((e.regions || []).map((r) => freeze({ key: r.key, x: r.x, y: r.y, width: r.width, height: r.height, kind: r.kind }))) })])))
    const clamp01 = (u) => Math.min(1, Math.max(0, Number(u) || 0))
    const ease = freeze({ linear: (u) => clamp01(u), in: (u) => { u = clamp01(u); return u * u * u }, out: (u) => { u = clamp01(u); return 1 - Math.pow(1 - u, 3) }, inOut: (u) => { u = clamp01(u); return u < .5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2 },
      expoOut: (u) => { u = clamp01(u); return u >= 1 ? 1 : 1 - Math.pow(2, -10 * u) }, back: (u) => { u = clamp01(u); const c = 1.70158; return 1 + (c + 1) * Math.pow(u - 1, 3) + c * Math.pow(u - 1, 2) } })
    function drawScreen(c, key, x, y, w, h, sx, sy, sw, sh) {
      const e = library.get(String(key)); if (!e || !e.bitmap) return false
      c.drawImage(e.bitmap, numeric(sx, 0), numeric(sy, 0), numeric(sw, e.width), numeric(sh, e.height), numeric(x, 0), numeric(y, 0), numeric(w, 0), numeric(h, 0))
      return true
    }
    const random = freeze((index) => seeded(seed, Math.floor(Number(index) || 0)))
    const duration = numeric(props.duration, 1)
    const kit = programKit(freeze({ width: VW, height: VH, duration, palette, font, mono, ease, screens, drawScreen, random, style: text(props.style, 'print') }))
    return freeze({ width: VW, height: VH, duration, palette, font, mono, ease, screens, drawScreen: freeze(drawScreen), random, kit, style: kit.style })
  }
  // Bound source size and shadow browser capabilities. The iframe sandbox isolates the program from the page.
  const BLOCKED = ['globalThis', 'self', 'window', 'top', 'parent', 'opener', 'frames', 'document', 'location', 'history', 'navigator', 'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker', 'SharedWorker', 'importScripts', 'postMessage', 'close', 'setTimeout', 'setInterval', 'queueMicrotask', 'requestAnimationFrame', 'MessageChannel', 'BroadcastChannel', 'Blob', 'File', 'FileReader', 'URL', 'URLSearchParams', 'indexedDB', 'caches', 'crypto', 'performance', 'Function', 'OffscreenCanvas', 'WebAssembly', 'SharedArrayBuffer', 'Atomics']
  function evaluateSource(source) {
    if (typeof source !== 'string' || !source.length || source.length > 400000) throw new Error('Source exceeds the runtime limit.')
    if (/\bimport\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*\(/.test(source)) throw new Error('Source contains forbidden dynamic import.')
    const factory = Function(...BLOCKED, 'assets', 'virtualDocument', '"use strict";return (' + source + '\n);')
    const draw = factory(...new Array(BLOCKED.length).fill(undefined), freeze({}), undefined)
    if (typeof draw !== 'function') throw new Error('A program must be a function of (ctx, t, env).')
    return draw
  }

  // ---- the frame: background, then the program at 1600 × 900 scaled to the canvas ----
  function size() {
    const r = canvas.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1)
    const w = Math.min(1920, Math.max(320, Math.round(r.width * dpr)))
    if (canvas.width !== w) { canvas.width = w; canvas.height = Math.round(w * VH / VW); dirty = true }
  }
  // Reset the drawing context each frame; paint the background before the film.
  function draw() {
    size()
    if (ctx.reset) ctx.reset()
    else { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.setLineDash([]) }
    ctx.fillStyle = PROPS.background; ctx.fillRect(0, 0, canvas.width, canvas.height)
    if (!film) return
    const s = canvas.width / VW
    ctx.setTransform(s, 0, 0, s, 0, 0)
    ctx.save()
    const began = performance.now()
    try { film.draw(ctx, Math.min(t, film.duration), film.env) } catch (error) { film = null; say({ type: 'error', message: `${error && error.message || error} (at ${t.toFixed(2)} s)`.slice(0, 300), stack: String(error && error.stack || '').slice(0, 600) }) }
    ctx.restore()
    cost = cost * 0.9 + (performance.now() - began) * 0.1
  }

  // A still film is drawn again only when something changes (a seek, a new program, the size).
  let told = 0, cost = 0, dirty = true
  function tick(now) {
    if (playing && last != null) {
      t += Math.min(0.1, (now - last) / 1000)
      if (film && t >= film.duration) { t = film.duration; playing = false }
    }
    last = now
    size()
    if (playing || dirty) {
      draw(); dirty = false
      if (now - told > 100 || !playing) { told = now; say({ type: 'time', t, duration: film ? film.duration : 0, playing, ms: +cost.toFixed(1) }) }
    }
    requestAnimationFrame(tick)
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window.parent || event.origin !== appOrigin) return
    const m = event.data || {}
    dirty = true
    try {
      if (m.type === 'assets') {
        programKit = (0, eval)('(' + String(m.kit).trim() + ')')
        await Promise.all((m.fonts || []).map(async (f) => { const face = new FontFace(f.family, f.data, { weight: String(f.weight) }); await face.load(); document.fonts.add(face) }))
        say({ type: 'ready' })
      } else if (m.type === 'screens') {
        for (const [key, s] of Object.entries(m.screens || {})) library.set(key, { width: s.width, height: s.height, regions: s.regions || [], bitmap: s.bitmap })
      } else if (m.type === 'program') {
        const drawFn = evaluateSource(m.source)
        const env = envFor({ ...PROPS, duration: m.duration })
        film = { draw: drawFn, env, duration: numeric(m.duration, 1) }
        if (m.at != null) t = numeric(m.at, 0)
        if (m.play) playing = true
      } else if (m.type === 'play') { if (film && t >= film.duration) t = 0; playing = true }
      else if (m.type === 'pause') playing = false
      else if (m.type === 'seek') t = Math.max(0, Math.min(numeric(m.t, 0), film ? film.duration : 0))
    } catch (error) { say({ type: 'error', message: String(error && error.message || error).slice(0, 300) }) }
  })
  requestAnimationFrame(tick)
  say({ type: 'loaded' })
})()
