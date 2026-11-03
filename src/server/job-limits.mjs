// One server process owns admission; SQLite preserves usage allowances across restarts.
export function positiveInteger(env, key, fallback, max = 1000000) {
  const value = env[key] === undefined ? fallback : Number(env[key])
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw Error(`${key} must be an integer from 1 to ${max}`)
  return value
}

export class JobLimits {
  // unmetered: a developer's own server, reachable only from their machine, has no usage allowances unless one is
  // set explicitly. The limits on jobs running at once stay, since they protect the machine.
  constructor(db, env = {}, now = Date.now, { unmetered = false } = {}) {
    this.db = db; this.now = now; this.active = 0; this.owners = new Map()
    this.global = positiveInteger(env, 'MAX_ACTIVE_JOBS', 2)
    this.perUser = positiveInteger(env, 'MAX_ACTIVE_JOBS_PER_USER', 1)
    this.timeoutMs = positiveInteger(env, 'JOB_TIMEOUT_SECONDS', 900, 86400) * 1000
    const allowance = (key, fallback) => unmetered && env[key] === undefined ? Infinity : positiveInteger(env, key, fallback)
    this.allowances = {
      live: [allowance('DAILY_JOBS', 100), allowance('DAILY_JOBS_PER_USER', 20), 86400000],
      example: [allowance('HOURLY_EXAMPLES', 120), allowance('HOURLY_EXAMPLES_PER_USER', 30), 3600000],
    }
    db.exec(`CREATE TABLE IF NOT EXISTS job_allowances (
      kind TEXT NOT NULL, scope TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL,
      PRIMARY KEY(kind,scope,expires));`)
  }
  reserve(owner, kind) {
    const reject = (message, retryAfter) => { throw Object.assign(Error(message), { status: 429, retryAfter }) }
    // Saved replays make no model calls and must not occupy paid generation slots.
    const generation = kind === 'live'
    if (generation && (this.owners.get(owner) || 0) >= this.perUser)
      reject('Your last manual is still being made. You can start another as soon as its film is ready to play.', 30)
    if (generation && this.active >= this.global)
      reject('The server is busy finishing other manuals. Please try again in a minute.', 30)
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
    let released = false, ownerReleased = !generation
    const lease = {
      job: null,
      attach: job => { lease.job = job; job.admission = lease },
      // Once the film plays, its owner may start another while the rest (catalogue, panels) finishes.
      // The server-wide slot stays held until the job ends, so paid work remains capped.
      releaseOwner: () => {
        if (ownerReleased) return
        ownerReleased = true
        const count = this.owners.get(owner) - 1
        if (count) this.owners.set(owner, count); else this.owners.delete(owner)
      },
      release: () => {
        if (released) return
        released = true
        lease.releaseOwner()
        if (generation) this.active--
        // Invalid requests refund the allowance; started/failed jobs still count.
        if (!lease.job) for (const [scope] of scopes) this.db.prepare(`UPDATE job_allowances SET used=MAX(0,used-1)
          WHERE kind=? AND scope=? AND expires=?`).run(kind, scope, expires)
      },
    }
    return lease
  }
}
