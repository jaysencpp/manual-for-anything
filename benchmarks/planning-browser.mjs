import { createServer } from 'node:http'
import { once } from 'node:events'
import { openDrawingBrowser } from './drawing-chrome.mjs'

export async function openPlanningBrowser() {
  // Opaque-origin page: model demonstrations have no Node handles, credentials or network access.
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-eval'; connect-src 'none'; frame-src 'none'; object-src 'none'" })
    res.end('<!doctype html><title>Offline plan playback check</title>')
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  let browser
  try { browser = await openDrawingBrowser(`http://127.0.0.1:${server.address().port}/`, undefined, { renderModule: null }) }
  catch (error) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); throw error }
  return {
    smoke: async compiled => {
      const result = await browser.evaluate(`(${checkPlayback.toString()})(${JSON.stringify({ source: compiled.source, times: compiled.times, screens: compiled.screens })})`)
      if (result.error) throw new Error(result.error)
      return { frames: result.frames, duration: compiled.duration, standInArtwork: true, browser: 'Chrome',
        note: 'Sampled real Canvas playback with deterministic stand-ins, not a full visual film review.' }
    },
    close: async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) },
  }
}

function checkPlayback({ source, times, screens }) {
  const draw = new Function(`return (${source})`)(), canvas = document.createElement('canvas')
  canvas.width = 1600; canvas.height = 900
  const actual = canvas.getContext('2d'), methods = new Map()
  let depth = 0
  const ctx = new Proxy(actual, {
    get(target, key) {
      if (key === 'mark') return () => {}
      const value = target[key]
      if (typeof value !== 'function') return value
      if (!methods.has(key)) methods.set(key, (...args) => {
        if (args.some(a => typeof a === 'number' && !Number.isFinite(a))) throw new Error(`Non-finite Canvas coordinate: ${String(key)}`)
        if (key === 'save') depth++
        if (key === 'restore' && --depth < 0) throw new Error('Unbalanced Canvas restore')
        return value.apply(target, args)
      })
      return methods.get(key)
    },
    set(target, key, value) {
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`Non-finite Canvas property: ${String(key)}`)
      target[key] = value; return true
    },
  })
  const clamp = u => Math.max(0, Math.min(1, u))
  const env = { width: 1600, height: 900, font: 'sans-serif', mono: 'monospace', screens,
    palette: { background: '#f3efe6', accent: '#ffcc00', ink: '#1d2b4f', second: '#ffcc00', muted: '#1d2b4f' },
    ease: { linear: clamp, in: u => clamp(u) ** 3, out: u => 1 - (1 - clamp(u)) ** 3,
      inOut: u => (u = clamp(u)) < .5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2,
      expoOut: u => clamp(u) === 1 ? 1 : 1 - 2 ** (-10 * clamp(u)), back: clamp },
    kit: { spring: clamp }, random: i => { const n = Math.sin(i * 78.233) * 43758.5453; return n - Math.floor(n) },
    drawScreen: (target, key, x, y, w, h) => {
      if (!screens[key]) throw new Error(`Missing actor screen: ${key}`)
      target.fillStyle = '#bbc5bf'; target.fillRect(x, y, w, h)
    },
  }
  try {
    for (const t of times) { draw(ctx, t, env); if (depth) throw new Error(`Unbalanced Canvas state at ${t.toFixed(3)}s`) }
    return { frames: times.length }
  } catch (error) { return { error: error.message } }
}
