import { spawn } from 'node:child_process'

// A worker runs against its local run folder and handles model output. The server alone stores files, so storage
// credentials stay out of the worker's environment.
const SERVER_ONLY = ['AZURE_STORAGE_CONNECTION_STRING']
export const workerEnv = env => Object.fromEntries(Object.entries(env).filter(([name]) => !SERVER_ONLY.includes(name)))

// Linux/VPS workers have a private process group, including any descendants.
export function spawnWorker(command, args, { timeoutMs, graceMs = 5000, ...options }) {
  const grouped = process.platform !== 'win32'
  const child = spawn(command, args, { ...options, detached: grouped })
  let forced, closed = false
  const signal = name => {
    try { if (grouped && child.pid) process.kill(-child.pid, name); else child.kill(name) }
    // (a finished group answers ESRCH on Linux and EPERM on macOS; either way there is nothing left to stop)
    catch (error) { if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error }
  }
  child.stopWorker = () => {
    if (closed || forced) return
    signal('SIGTERM')
    forced = setTimeout(() => signal('SIGKILL'), graceMs)
    forced.unref()
  }
  const deadline = setTimeout(() => { child.timedOut = true; child.stopWorker() }, timeoutMs)
  deadline.unref()
  // 'exit' runs even if an orphan descendant is keeping stdout/stderr open.
  const cleanup = () => {
    closed = true; clearTimeout(deadline); clearTimeout(forced)
    if (grouped) signal('SIGKILL')
  }
  child.once('exit', cleanup)
  child.once('error', cleanup)
  return child
}
