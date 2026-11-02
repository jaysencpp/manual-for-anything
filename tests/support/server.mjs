// Every server test gets its own SQLite database and file store, never the developer's data or Azure credentials.
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'

export function spawnServer(args = [], env = {}) {
  const owned = !env.MANUAL_DATA_DIR
  const dataDir = env.MANUAL_DATA_DIR || mkdtempSync(join(tmpdir(), 'manual-server-test-'))
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../src/server/server.mjs', import.meta.url)), ...args], {
    env: { ...process.env, NODE_ENV: 'test', AUTH_MODE: 'local', APP_ORIGIN: '', FILE_STORAGE: 'local', MANUAL_DATA_DIR: dataDir, ...env },
  })
  child.serverErrors = ''
  child.stderr.on('data', chunk => { child.serverErrors += chunk })
  if (owned) child.once('close', () => rmSync(dataDir, { recursive: true, force: true }))
  return child
}
export async function startServer(args = [], env = {}) {
  const child = spawnServer(['--port', '0', ...args], env)
  const port = await new Promise((resolve, reject) => {
    child.stdout.on('data', data => { const match = /localhost:(\d+)/.exec(String(data)); if (match) resolve(match[1]) })
    child.once('error', reject)
    child.once('exit', () => reject(Error(child.serverErrors || 'Server exited before listening')))
  })
  return { child, base: `http://127.0.0.1:${port}`, stop: async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const closed = once(child, 'close'); child.kill('SIGTERM'); await closed
  } }
}
