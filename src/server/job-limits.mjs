// One server process owns admission; SQLite preserves usage allowances across restarts.
export function positiveInteger(env, key, fallback, max = 1000000) {
  const value = env[key] === undefined ? fallback : Number(env[key])
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw Error(`${key} must be an integer from 1 to ${max}`)
  return value
}

export class JobLimits {
  constructor(db, env = {}, now = Date.now) {
    this.db = db; this.now = now; this.active = 0; this.owners = new Map()
    this.global = positiveInteger(env, 'MAX_ACTIVE_JOBS', 2)
    this.perUser = positiveInteger(env, 'MAX_ACTIVE_JOBS_PER_USER', 1)
    this.timeoutMs = positiveInteger(env, 'JOB_TIMEOUT_SECONDS', 900, 86400) * 1000
    this.allowances = {
      live: [positiveInteger(env, 'DAILY_JOBS', 100), positiveInteger(env, 'DAILY_JOBS_PER_USER', 20), 86400000],
      example: [positiveInteger(env, 'HOURLY_EXAMPLES', 120), positiveInteger(env, 'HOURLY_EXAMPLES_PER_USER', 30), 3600000],
    }
    db.exec(`CREATE TABLE IF NOT EXISTS job_allowances (
      kind TEXT NOT NULL, scope TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL,
      PRIMARY KEY(kind,scope,expires));`)
  }
  reserve(owner, kind) {
    const reject = (message, retryAfter) => { throw Object.assign(Error(message), { status: 429, retryAfter }) }
    // Saved replays make no model calls and must not occupy paid generation slots.
    const generation = kind === 'live'
    if (generation && (this.active >= this.global || (this.owners.get(owner) || 0) >= this.perUser))
      reject('A manual is already being made. Please try again when it finishes.', 30)
    const [globalLimit, userLimit, windowMs] = this.allowances[kind], now = this.now()
    const expires = (Math.floor(now / windowMs) + 1) * windowMs
    const scopes = [['global', globalLimit], [`user:${owner}`, userLimit]]
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM job_allowances WHERE expires<=?').run(now)
      for (const [scope, limit] of scopes) {
        const used = this.db.prepare('SELECT used FROM job_allowances WHERE kind=? AND scope=? AND expires=?').get(kind, scope, expires)?.used || 0
        if (used >= limit) reject('This server or account has reached its manual allowance. Please try again later.', Math.ceil((expires - now) / 1000))
      }
      for (const [scope] of scopes) this.db.prepare(`INSERT INTO job_allowances VALUES(?,?,?,1)
        ON CONFLICT(kind,scope,expires) DO UPDATE SET used=used+1`).run(kind, scope, expires)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    if (generation) { this.active++; this.owners.set(owner, (this.owners.get(owner) || 0) + 1) }
    let released = false
    const lease = {
      job: null,
      attach: job => { lease.job = job; job.admission = lease },
      release: () => {
        if (released) return
        released = true
        if (generation) {
          this.active--; const count = this.owners.get(owner) - 1
          if (count) this.owners.set(owner, count); else this.owners.delete(owner)
        }
        // Invalid requests refund the allowance; started/failed jobs still count.
        if (!lease.job) for (const [scope] of scopes) this.db.prepare(`UPDATE job_allowances SET used=MAX(0,used-1)
          WHERE kind=? AND scope=? AND expires=?`).run(kind, scope, expires)
      },
    }
    return lease
  }
}
