import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

// Where Chrome is on this machine, or null. Found by path: on Windows, running chrome.exe --version opens a browser.
export function chromeExecutable(env = process.env, platform = process.platform, exists = existsSync) {
  if (env.CHROME_BIN) return env.CHROME_BIN
  if (platform === 'darwin') return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'].find(exists) ?? null
  if (platform === 'win32') return [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean).map(root => join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')).find(exists) ?? null
  for (const folder of (env.PATH || '').split(delimiter)) for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'])
    if (folder && exists(join(folder, name))) return join(folder, name)
  return null
}
export const chromePresent = !!chromeExecutable()

// Dedicated browser, not the user's tabs. A persistent page avoids per-sample browser startup time.
export async function openDrawingBrowser(url, executable = chromeExecutable() ?? 'google-chrome', { renderModule = '/assets/drawing-render.mjs' } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'drawing-bench-chrome-'))
  const child = spawn(executable, ['--headless', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
  let socket, next = 0
  const pending = new Map(), events = new Map()
  const infrastructure = message => Object.assign(new Error(message), { code: 'BENCH_BROWSER' })
  const close = async () => {
    socket?.close()
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Browser closed')) }
    pending.clear()
    if (child.exitCode == null && child.signalCode == null) {
      const exited = new Promise(resolve => child.once('exit', resolve))
      child.kill('SIGKILL'); await exited
    }
    // Renderer children may finish writing just after the browser process exits.
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let stderr = ''
      const timer = setTimeout(() => reject(new Error('Chrome startup timed out')), 15000)
      const finish = (err, value) => { clearTimeout(timer); err ? reject(err) : resolve(value) }
      child.once('error', e => finish(e))
      child.once('exit', () => finish(new Error('Chrome exited before becoming available')))
      child.stderr.on('data', chunk => {
        stderr = (stderr + chunk).slice(-8000)
        const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)
        if (match) finish(null, match[1])
      })
    })
    socket = new WebSocket(endpoint)
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error('Cannot connect to Chrome')) })
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data)
      if (message.method) events.get(`${message.sessionId}:${message.method}`)?.(message)
      const task = pending.get(message.id)
      if (!task) return
      pending.delete(message.id); clearTimeout(task.timer)
      message.error ? task.reject(infrastructure(message.error.message)) : task.resolve(message.result)
    }
    socket.onclose = () => {
      for (const task of pending.values()) { clearTimeout(task.timer); task.reject(infrastructure('Browser connection closed')) }
      pending.clear()
    }
    const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++next
      const timer = setTimeout(() => { pending.delete(id); reject(infrastructure(`Browser timeout: ${method}`)) }, 15000)
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, sessionId }))
    })
    const { targetId } = await call('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true })
    await call('Page.enable', {}, sessionId)
    const loaded = new Promise((resolve, reject) => {
      const key = `${sessionId}:Page.loadEventFired`
      const timer = setTimeout(() => { events.delete(key); reject(new Error('Review page load timed out')) }, 15000)
      events.set(key, () => { clearTimeout(timer); events.delete(key); resolve() })
    })
    await call('Page.navigate', { url }, sessionId); await loaded
    const evaluate = async expression => {
      const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
      return result.result.value
    }
    if (renderModule) await evaluate(`import(${JSON.stringify(renderModule)}).then(m => { window.benchRender = m.renderDrawing; return true })`)
    return { evaluate, render: drawing => evaluate(`window.benchRender(${JSON.stringify(drawing)})`),
      viewport: (width, height) => call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId),
      screenshot: async () => (await call('Page.captureScreenshot', { captureBeyondViewport: true }, sessionId)).data, close }
  } catch (error) { await close(); throw error }
}
