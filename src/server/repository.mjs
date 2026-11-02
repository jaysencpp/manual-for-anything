// Film identity, replay state and file manifests persist independently of the process and its work cache.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export class FilmRepository {
  constructor(file, storageIdentity) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(file)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS films (id TEXT PRIMARY KEY, status TEXT NOT NULL, state TEXT NOT NULL, events TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS files (film_id TEXT NOT NULL REFERENCES films(id) ON DELETE CASCADE,
        path TEXT NOT NULL, hash TEXT NOT NULL, size INTEGER NOT NULL, content_type TEXT NOT NULL,
        PRIMARY KEY(film_id,path));
      CREATE INDEX IF NOT EXISTS files_hash ON files(hash);`)
    // Existing installations belong to the automatic local development account.
    if (!this.db.prepare('PRAGMA table_info(films)').all().some(c => c.name === 'owner_id')) {
      this.db.exec("ALTER TABLE films ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'local'")
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS films_owner_created ON films(owner_id,created_at)')
    const identity = this.db.prepare("SELECT value FROM settings WHERE key='storage'").get()?.value
    if (identity && identity !== storageIdentity) { this.db.close(); throw Error('This SQLite database belongs to a different file store; use a separate data directory or migrate its files first') }
    this.db.prepare("INSERT OR IGNORE INTO settings VALUES ('storage',?)").run(storageIdentity)
  }
  get(id) {
    const row = this.db.prepare('SELECT state,events,status FROM films WHERE id=?').get(id)
    return row ? { id, status: row.status, state: JSON.parse(row.state), events: JSON.parse(row.events) } : null
  }
  save(id, state, events, files) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const status = state.status || (state.finished ? 'completed' : 'running')
      this.db.prepare(`INSERT INTO films(id,status,state,events,owner_id) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        status=excluded.status,state=excluded.state,events=excluded.events,updated_at=CURRENT_TIMESTAMP`).run(id, status, JSON.stringify(state), JSON.stringify(events), state.ownerId || 'local')
      if (files) {
        this.db.prepare('DELETE FROM files WHERE film_id=?').run(id)
        const put = this.db.prepare('INSERT INTO files VALUES(?,?,?,?,?)')
        for (const f of files) put.run(id, f.path, f.hash, f.size, f.contentType)
      }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  owner(id) { return this.db.prepare('SELECT owner_id FROM films WHERE id=?').get(id)?.owner_id }
  ownsFilm(id, owner) {
    // Check the complete source chain before restoring any files. Owner IDs in
    // the indexed column are authoritative; serialized state cannot grant access.
    const pending = [id], seen = new Set()
    const lookup = this.db.prepare('SELECT owner_id,state FROM films WHERE id=?')
    while (pending.length) {
      const next = pending.pop()
      if (seen.has(next)) continue
      if (seen.size >= 1000) return false
      seen.add(next)
      const row = lookup.get(next)
      if (!row || row.owner_id !== owner) return false
      const state = JSON.parse(row.state)
      for (const source of [state.rootId, state.previous]) if (source) pending.push(source)
    }
    return true
  }
  list(owner, { limit = 24, offset = 0 } = {}) {
    const rows = this.db.prepare('SELECT id,status,state,events,created_at FROM films WHERE owner_id=? ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?').all(owner, limit + 1, offset)
    return { films: rows.slice(0, limit).map(row => {
      const state = JSON.parse(row.state), events = JSON.parse(row.events)
      const script = events.findLast(e => e.type === 'script' || e.type === 'revised')
      const photoPath = state.example ? 'screens/photo.png' : 'script/photo.png'
      return { id: row.id, title: script?.title || (state.example ? 'Example manual' : 'Your manual'),
        sub: script?.sub || '', status: row.status, createdAt: row.created_at.replace(' ', 'T') + 'Z',
        photo: this.file(row.id, photoPath) ? `/api/films/${row.id}/photo` : null,
        previous: state.previous && this.ownsFilm(state.previous, owner) ? state.previous : null }
    }), more: rows.length > limit }
  }
  file(id, path) { return this.db.prepare('SELECT path,hash,size,content_type AS contentType FROM files WHERE film_id=? AND path=?').get(id, path) }
  files(id) { return this.db.prepare('SELECT path,hash,size,content_type AS contentType FROM files WHERE film_id=? ORDER BY path').all(id) }
  hasBlob(hash) { return !!this.db.prepare('SELECT 1 FROM files WHERE hash=? LIMIT 1').get(hash) }
  interruptRunning() {
    for (const { id } of this.db.prepare("SELECT id FROM films WHERE status='running'").all()) {
      const record = this.get(id), message = 'Generation was interrupted by a server restart. No model calls were retried.'
      this.save(id, { ...record.state, finished: true, status: 'interrupted' }, [...record.events, { type: 'failed', message }])
    }
  }
  close() { this.db.close() }
}
