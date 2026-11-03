// Durable file bytes. SQLite stores references; Azure credentials never reach the browser.
import { readFile, writeFile, mkdir, link, readdir, rm } from 'node:fs/promises'
import { join, dirname, relative, sep, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json', '.js': 'text/javascript', '.txt': 'text/plain' }
export function safePath(path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.includes('\0') || path.split('/').some(p => !p || p === '.' || p === '..')) throw Error('Invalid stored file path')
  return path
}
const blobKey = digest => {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw Error('Invalid file digest')
  return `objects/${digest}`
}

export class LocalFiles {
  constructor(root) { this.root = resolve(root); this.identity = 'local' }
  async init() { await mkdir(this.root, { recursive: true }) }
  async put(digest, bytes) {
    const file = join(this.root, blobKey(digest)); await mkdir(dirname(file), { recursive: true })
    const temp = `${file}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, bytes)
      // Publish complete, immutable bytes without replacing another replay's blob.
      // Concurrent renames over the same destination can fail on Windows.
      try { await link(temp, file) } catch (error) { if (error.code !== 'EEXIST') throw error }
    } finally { await rm(temp, { force: true }) }
  }
  async get(digest) { return readFile(join(this.root, blobKey(digest))) }
}

export class AzureFiles {
  constructor(container) { this.container = container; this.identity = `azure:${container.url.split('?')[0]}` }
  async init() {
    let properties
    try { properties = await this.container.getProperties() }
    catch (error) {
      if (error.statusCode !== 404) throw Error('Could not access the Azure file container')
      await this.container.createIfNotExists() // New containers are private; never change account/CORS policy.
      properties = await this.container.getProperties()
    }
    if (properties.blobPublicAccess) throw Error('The app file container must be private')
  }

  async put(digest, bytes, contentType) {
    try {
      await this.container.getBlockBlobClient(blobKey(digest)).uploadData(bytes, {
        conditions: { ifNoneMatch: '*' }, blobHTTPHeaders: { blobContentType: contentType },
      })
    } catch (error) { if (![409, 412].includes(error.statusCode)) throw Error('Azure file upload failed') }
  }
  async get(digest) {
    try { return await this.container.getBlobClient(blobKey(digest)).downloadToBuffer() }
    catch { throw Error('Azure file download failed') }
  }
}

export async function configuredFiles(env, dataDir) {
  const backend = env.FILE_STORAGE || (env.NODE_ENV === 'production' ? 'azure' : 'local')
  if (env.NODE_ENV === 'production' && backend !== 'azure') throw Error('Production file storage must use Azure')
  if (backend === 'local') return new LocalFiles(join(dataDir, 'files'))
  if (backend !== 'azure') throw Error('FILE_STORAGE must be local or azure')
  const connection = env.AZURE_STORAGE_CONNECTION_STRING
  if (!connection) throw Error('Azure storage needs AZURE_STORAGE_CONNECTION_STRING')
  const container = env.AZURE_STORAGE_CONTAINER || 'manual-files'
  if (!container.startsWith('manual-')) throw Error('Use a dedicated container for this app, named manual-…')
  const { BlobServiceClient } = await import('@azure/storage-blob')
  let client
  try { client = BlobServiceClient.fromConnectionString(connection).getContainerClient(container) }
  catch { throw Error('Invalid Azure storage configuration') }
  if (env.NODE_ENV === 'production' && !client.url.startsWith('https://')) throw Error('Production Azure storage requires HTTPS')
  return new AzureFiles(client)
}

// The pipeline works on a filesystem. Workspaces are a disposable cache, never the Azure source of truth.
export class FilmFiles {
  constructor(repository, files, { cacheParent = tmpdir(), maxCached = 8, maxRestoring = 4 } = {}) {
    this.repository = repository; this.files = files; this.maxCached = maxCached
    this.cache = mkdtempSync(join(cacheParent, 'manual-files-'))
    this.work = new Map(); this.loading = new Map(); this.saving = new Map()
    this.restoreSlots = maxRestoring; this.restoreQueue = []
  }
  allocate(id) {
    const path = join(this.cache, id)
    this.work.set(id, { path, active: true, touched: Date.now() }); return path
  }
  commit(id, dir, state, events, overrides = {}) {
    const next = (this.saving.get(id) || Promise.resolve()).catch(() => {}).then(async () => {
      const entries = [], seen = new Set()
      const walk = async path => {
        for (const entry of await readdir(path, { withFileTypes: true })) {
          const file = join(path, entry.name)
          if (entry.isSymbolicLink()) throw Error('Symbolic links cannot be stored')
          if (entry.isDirectory()) { await walk(file); continue }
          if (!entry.isFile()) continue
          const pathKey = safePath(relative(dir, file).split(sep).join('/')), bytes = overrides[pathKey] || await readFile(file)
          // A worker may be replacing a JSON artifact during a checkpoint. Keep the prior checkpoint if incomplete.
          if (pathKey.endsWith('.json')) JSON.parse(bytes.toString('utf8'))
          const digest = hash(bytes)
          const contentType = types[pathKey.slice(pathKey.lastIndexOf('.'))] || 'application/octet-stream'
          if (!seen.has(digest) && !this.repository.hasBlob(digest)) await this.files.put(digest, bytes, contentType)
          seen.add(digest)
          entries.push({ path: pathKey, hash: digest, size: bytes.length, contentType })
        }
      }
      await walk(dir)
      this.repository.save(id, state, events, entries)
    })
    this.saving.set(id, next)
    return next
  }
  async ensure(id) {
    const existing = this.work.get(id)
    if (existing) { existing.touched = Date.now(); return existing.path }
    if (this.loading.has(id)) return this.loading.get(id)
    const loading = (async () => {
      const path = join(this.cache, id)
      await this.restoreSlot()
      try {
        await mkdir(path, { recursive: true })
        const manifest = this.repository.files(id)
        for (let offset = 0; offset < manifest.length; offset += 4) await Promise.all(manifest.slice(offset, offset + 4).map(async file => {
          const bytes = await this.files.get(file.hash)
          if (hash(bytes) !== file.hash) throw Error('Stored file integrity check failed')
          const target = join(path, safePath(file.path)); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes)
        }))
        this.work.set(id, { path, active: false, touched: Date.now() }); return path
      } catch (error) { await rm(path, { recursive: true, force: true }); throw error }
      finally { this.releaseRestoreSlot() }
    })().finally(() => {
      this.loading.delete(id)
      // Keep the cache near its limit under bursts of opens, not only at the periodic prune.
      this.prune().catch(() => console.error('Could not prune the file cache'))
    })
    this.loading.set(id, loading); return loading
  }
  // Opening a stored film downloads its whole manifest: many at once would exhaust disk and memory.
  restoreSlot() {
    if (this.restoreSlots > 0) { this.restoreSlots--; return Promise.resolve() }
    return new Promise(resolve => this.restoreQueue.push(resolve))
  }
  releaseRestoreSlot() {
    const next = this.restoreQueue.shift()
    if (next) next(); else this.restoreSlots++
  }
  async read(id, path) {
    safePath(path)
    const cached = this.work.get(id)
    if (cached) {
      cached.touched = Date.now()
      try { return await readFile(join(cached.path, path)) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    const file = this.repository.file(id, path)
    if (!file) return null
    const bytes = await this.files.get(file.hash)
    if (hash(bytes) !== file.hash) throw Error('Stored file integrity check failed')
    return bytes
  }
  pin(id) { const w = this.work.get(id); if (w) w.pins = (w.pins || 0) + 1 }
  unpin(id) { const w = this.work.get(id); if (w) w.pins = Math.max(0, (w.pins || 0) - 1) }
  finished(id) { const entry = this.work.get(id); if (entry) entry.active = false }
  prune() {
    // Serialize directory removals and retain the operation so shutdown can wait
    // for the background prune started after a restore.
    return this.pruning = (this.pruning || Promise.resolve()).catch(() => {}).then(async () => {
      const idle = [...this.work].filter(([, w]) => !w.active && !w.pins).sort((a, b) => a[1].touched - b[1].touched)
      for (const [id, entry] of idle.slice(0, Math.max(0, idle.length - this.maxCached))) {
        this.work.delete(id); await rm(entry.path, { recursive: true, force: true })
      }
    })
  }
  async close() {
    await Promise.allSettled([...this.saving.values(), ...this.loading.values()])
    await this.pruning
    await rm(this.cache, { recursive: true, force: true })
  }
}
