import { randomBytes, randomUUID, createHash, scrypt as derive, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(derive)
const options = { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 }
const digest = value => createHash('sha256').update(value).digest('hex')
const lifetime = 7 * 86400
export const usernameKey = value => typeof value === 'string' ? value.trim().toLowerCase() : ''
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 15 || password.length > 256) throw Error('Use a password of 15–256 characters.')
  const salt = randomBytes(16).toString('hex')
  return `${salt}:${(await scrypt(password, salt, 64, options)).toString('hex')}`
}

export class Accounts {
  constructor(db) {
    this.db = db
    db.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS login_limits (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, until INTEGER NOT NULL);`)
  }
  async provision(username, password) {
    username = usernameKey(username)
    if (!/^[a-z0-9][a-z0-9_.@+-]{2,99}$/.test(username)) throw Error('Use a username of 3–100 letters, numbers, or . _ @ + -')
    const encoded = await hashPassword(password)
    const id = this.db.prepare('SELECT id FROM users WHERE username=?').get(username)?.id || randomUUID()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('INSERT INTO users VALUES(?,?,?) ON CONFLICT(username) DO UPDATE SET password=excluded.password').run(id, username, encoded)
      this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(id)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return id
  }
}

export class Authentication extends Accounts {
  constructor(db, env) {
    super(db)
    this.mode = env.AUTH_MODE || (env.NODE_ENV === 'production' ? 'password' : 'local')
    if (!['local', 'password'].includes(this.mode)) throw Error('AUTH_MODE must be local or password')
    if (env.NODE_ENV === 'production' && this.mode !== 'password') throw Error('Production requires password authentication')
    this.origin = env.APP_ORIGIN ? new URL(env.APP_ORIGIN).origin : null
    this.secure = this.origin?.startsWith('https:') || false
    if (this.mode === 'password') {
      if (!this.origin) throw Error('Password authentication requires APP_ORIGIN (the public app URL)')
      const url = new URL(this.origin)
      if (!this.secure && (env.NODE_ENV === 'production' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw Error('APP_ORIGIN must use HTTPS (except loopback development)')
      if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) throw Error('Create an account first: node scripts/account.mjs <username>')
    }
    this.cookieName = this.secure ? '__Host-manual_session' : 'manual_session'
    this.streams = new Map()
  }
  token(req) {
    const value = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(this.cookieName + '='))?.slice(this.cookieName.length + 1)
    return value && /^[a-f0-9]{64}$/.test(value) ? digest(value) : null
  }
  user(req) {
    if (this.mode === 'local') return { id: 'local', username: 'Local development' }
    const hash = this.token(req)
    return hash ? this.db.prepare('SELECT users.id,users.username FROM sessions JOIN users ON users.id=sessions.user_id WHERE hash=? AND expires>?').get(hash, Date.now()) || null : null
  }
  validOrigin(req) {
    if (req.headers['sec-fetch-site'] === 'cross-site') return false
    if (this.mode === 'password') return req.headers.origin === this.origin
    return !req.headers.origin || req.headers.origin === `http://${req.headers.host}`
  }
  cookie(token, age = lifetime) {
    return `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${this.secure ? '; Secure' : ''}`
  }
  async login(username, password) {
    username = usernameKey(username)
    if (typeof password !== 'string' || password.length > 256 || username.length > 100) return { status: 400, error: 'Enter your username and password.' }
    const now = Date.now()
    this.db.prepare('DELETE FROM login_limits WHERE until<=?').run(now)
    // One derivation at a time bounds CPU. There is deliberately no shared attempt counter: it would let anyone lock
    // out every account. Per-address limits belong at the reverse proxy.
    if (this.busy) return { status: 429, error: 'Sign-in is busy. Try again in a moment.' }
    const key = `user:${username}`
    if ((this.db.prepare('SELECT attempts FROM login_limits WHERE key=?').get(key)?.attempts || 0) >= 10) {
      return { status: 429, error: 'Too many sign-in attempts. Try again in 15 minutes.' }
    }
    this.db.prepare('INSERT INTO login_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1').run(key, now + 15 * 60000)
    this.busy = true
    try {
      const user = this.db.prepare('SELECT * FROM users WHERE username=?').get(username)
      // Unknown users still perform the same expensive password derivation.
      const [salt, encoded] = (user?.password || `${'0'.repeat(32)}:${'0'.repeat(128)}`).split(':')
      const candidate = await scrypt(password, salt, 64, options)
      const denied = { status: 401, error: 'Incorrect username or password.' }
      if (!timingSafeEqual(candidate, Buffer.from(encoded, 'hex')) || !user) return denied
      // An operator may reset the account while scrypt is in flight. An old
      // password must not create a fresh session after that reset has committed.
      // Serialize the recheck and session insert with the CLI reset transaction.
      this.db.exec('BEGIN IMMEDIATE')
      try {
        if (this.db.prepare('SELECT password FROM users WHERE id=?').get(user.id)?.password !== user.password) {
          this.db.exec('ROLLBACK'); return denied
        }
        this.db.prepare('DELETE FROM login_limits WHERE key=?').run(key)
        this.db.prepare('DELETE FROM sessions WHERE expires<=?').run(now)
        const token = randomBytes(32).toString('hex')
        this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token), user.id, now + lifetime * 1000)
        this.db.exec('COMMIT')
        return { token }
      } catch (error) { this.db.exec('ROLLBACK'); throw error }
    } finally { this.busy = false }
  }
  logout(req) {
    const hash = this.token(req)
    if (!hash) return
    this.db.prepare('DELETE FROM sessions WHERE hash=?').run(hash)
    for (const res of this.streams.get(hash) || []) res.end()
  }
  watch(req, res, authorize = () => {}) {
    if (this.mode === 'local') return
    const hash = this.token(req)
    const streams = this.streams.get(hash) || new Set()
    this.streams.set(hash, streams); streams.add(res)
    const timer = setInterval(() => {
      try { if (!this.user(req)) return res.end(); authorize() } catch { res.end() }
    }, 30000)
    timer.unref()
    res.on('close', () => { clearInterval(timer); streams.delete(res); if (!streams.size) this.streams.delete(hash) })
  }
}
