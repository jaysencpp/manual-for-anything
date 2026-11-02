// Every hosted /api route must declare its access and HTTP methods here before it
// can reach a handler. Unlisted paths return 404; there is no public fallback.
const read = ['GET', 'HEAD']
const routes = [
  [/^\/api\/session$/, read, 'public'],
  [/^\/api\/login$/, ['POST'], 'public'],
  [/^\/api\/logout$/, ['POST'], 'public'], // Idempotent; only revokes the caller's cookie.
  [/^\/api\/config$/, read, 'public'],
  [/^\/api\/examples$/, read, 'public'],
  [/^\/api\/examples\/[\w-]+\/photo\.png$/, read, 'public'],
  [/^\/api\/films$/, [...read, 'POST'], 'session'],
  [/^\/api\/films\/(\w+)\/(about|program|photo|prelude)$/, read, 'owner'],
  [/^\/api\/films\/(\w+)\/screens\/[^/]+\.png$/, read, 'owner'],
  [/^\/api\/films\/(\w+)\/events$/, ['GET'], 'owner'],
  [/^\/api\/films\/(\w+)\/artwork$/, [...read, 'POST'], 'owner'],
  [/^\/api\/films\/(\w+)\/(retry|refine|films)$/, ['POST'], 'owner'],
]

export function apiAccess(path) {
  for (const [pattern, methods, access] of routes) {
    const match = pattern.exec(path)
    if (match) return { methods, access, filmId: access === 'owner' ? match[1] : null }
  }
  return null
}
