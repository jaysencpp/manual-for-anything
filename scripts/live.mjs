// `npm run live`: photo uploads enabled. Asks for the API key the first time and saves it in .env.local.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { emitKeypressEvents } from 'node:readline'
import { fileURLToPath } from 'node:url'
import '../src/pipeline/model.mjs' // loads .env.local

const envFile = fileURLToPath(new URL('../.env.local', import.meta.url))

function askHidden(question) {
  process.stdout.write(question)
  return new Promise((done, fail) => {
    let value = ''
    emitKeypressEvents(process.stdin)
    process.stdin.setRawMode(true)
    process.stdin.resume()
    const keypress = (text, key) => {
      if (key?.ctrl && key.name === 'c') { finish(); fail(new Error('Cancelled.')) }
      else if (key?.name === 'return' || key?.name === 'enter') { finish(); done(value.trim()) }
      else if (key?.name === 'backspace') value = value.slice(0, -1)
      else if (text && !key?.ctrl && !key?.meta) value += text
    }
    const finish = () => { process.stdin.off('keypress', keypress); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n') }
    process.stdin.on('keypress', keypress)
  })
}

if (!process.env.MODEL_API_KEY && !process.env.META_API_KEY) {
  if (!process.stdin.isTTY) {
    console.error('Set MODEL_API_KEY in .env.local or the environment to make manuals from your own photos.')
    process.exit(1)
  }
  console.log('Making manuals from your own photos needs a Meta Model API key, and uploads make paid API calls.')
  const key = await askHidden('Paste your key (it stays on this computer, in .env.local): ').catch(() => process.exit(1))
  if (!key) { console.error('No key entered.'); process.exit(1) }
  const existing = existsSync(envFile) ? readFileSync(envFile, 'utf8').replace(/^MODEL_API_KEY=.*\r?\n?/m, '') : ''
  writeFileSync(envFile, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}MODEL_API_KEY=${key}\n`, { mode: 0o600 })
  chmodSync(envFile, 0o600)
  process.env.MODEL_API_KEY = key
  console.log('Saved. Starting…')
}
process.argv.push('--live')
await import('../src/server/server.mjs')
