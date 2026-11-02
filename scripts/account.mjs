// Provision/reset accounts on the app host. Passwords are never command-line arguments or echoed.
import { fileURLToPath } from 'node:url'
import '../src/pipeline/model.mjs' // load the same .env.local as the server
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { emitKeypressEvents } from 'node:readline'
import { Accounts } from '../src/server/auth.mjs'

async function readPassword() {
  if (!process.stdin.isTTY) {
    let value = ''
    for await (const chunk of process.stdin) {
      value += chunk
      if (value.length > 1024) throw Error('Password input too long')
    }
    return value.replace(/\r?\n$/, '')
  }
  process.stderr.write('Password (15–256 characters, hidden): ')
  emitKeypressEvents(process.stdin)
  process.stdin.setRawMode(true)
  process.stdin.resume()
  return new Promise((resolve, reject) => {
    let value = ''
    const finish = () => {
      process.stdin.off('keypress', keypress); process.stdin.setRawMode(false); process.stdin.pause()
      process.stderr.write('\n')
    }
    const keypress = (text, key) => {
      if (key.ctrl && key.name === 'c') { finish(); reject(Error('Cancelled')); return }
      if (key.name === 'return') { finish(); resolve(value); return }
      if (key.name === 'backspace') value = [...value].slice(0, -1).join('')
      else if (!key.ctrl && !key.meta && text && value.length < 256) value += text
    }
    process.stdin.on('keypress', keypress)
  })
}

let db
try {
  const args = process.argv.slice(2), username = args[0]
  if (!username || args.slice(1).some(arg => arg !== '--claim-local-films')) throw Error('Usage: node scripts/account.mjs <username> [--claim-local-films]')
  const dir = resolve(process.env.MANUAL_DATA_DIR || fileURLToPath(new URL('../data', import.meta.url)))
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  db = new DatabaseSync(join(dir, 'app.sqlite'))
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;')
  const accounts = new Accounts(db)
  const id = await accounts.provision(username, await readPassword())
  if (args.includes('--claim-local-films') && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='films'").get()) {
    if (!db.prepare('PRAGMA table_info(films)').all().some(c => c.name === 'owner_id')) db.exec("ALTER TABLE films ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'local'")
    db.prepare("UPDATE films SET owner_id=? WHERE owner_id='local'").run(id)
  }
  console.log('Account saved. Previous sessions for this account have been revoked.')
} catch (error) { console.error(error.message); process.exitCode = 1 }
finally { db?.close() }
