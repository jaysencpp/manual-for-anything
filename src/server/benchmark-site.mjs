import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' }
export function serveBenchmarkPage(req, res, path) {
  // Keep existing shared links and asset URLs working.
  path = path.replace(/^\/benchmarks(?=\/|\.|$)/, '/comparisons')
  let file
  const planningRun = /^\/comparisons\/plans\/runs\/([a-z][a-z0-9-]*)\/(api\/report|api\/attempt\/[a-z0-9-]+|photo\/[a-z0-9-]+\.png)$/.exec(path)
  if (planningRun) {
    const [, id, resource] = planningRun
    const root = join(here, '../../benchmarks/published-plans')
    const index = existsSync(join(root, 'index.json')) ? JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')) : { runs: [] }
    if (index.runs.some(run => run.id === id)) {
      const relative = resource === 'api/report' ? 'report.json' : resource.startsWith('api/attempt/') ? `attempts/${resource.split('/').at(-1)}.json` : `photos/${resource.split('/').at(-1)}`
      file = join(root, 'runs', id, relative)
    }
  }
  else if (path === '/comparisons/plans/api/runs') file = join(here, '../../benchmarks/published-plans/index.json')
  else if (/^\/comparisons\/plans\/?$/.test(path)) file = join(here, '../../benchmarks/planning-review.html')
  else if (path === '/planning-review.mjs') file = join(here, '../../benchmarks/planning-review.mjs')
  else if (path === '/comparisons/plans/api/report') file = join(here, '../../benchmarks/published-plans/report.json')
  else if (/^\/comparisons\/plans\/api\/attempt\/[a-z0-9-]+$/.test(path)) file = join(here, '../../benchmarks/published-plans/attempts', `${path.split('/').at(-1)}.json`)
  else if (/^\/comparisons\/plans\/photo\/[a-z0-9-]+\.png$/.test(path)) file = join(here, '../../benchmarks/published-plans/photos', path.split('/').at(-1))
  else if (/^\/comparisons\/?$/.test(path)) file = join(here, '../../public/benchmarks.html')
  else if (['/comparisons.js', '/comparisons.css'].includes(path)) file = join(here, '../../public', path.slice(1).replace('comparisons', 'benchmarks'))
  else if (path === '/comparisons-shared.css') file = join(here, '../../public/comparisons-shared.css')
  else if (path === '/comparisons/data/index.json') file = join(here, '../../benchmarks/published/index.json')
  else {
    const match = /^\/comparisons\/data\/([a-z][a-z0-9-]*)\/(case\.json|reference\.png|(?:minimal|low|medium|high|xhigh|max)-[1-9][0-9]*\.(?:png|svg))$/.exec(path)
    if (match) file = join(here, '../../benchmarks/published', match[1], match[2])
    else if (!path.startsWith('/comparisons/')) return false
  }
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return true }
  if (!file || !existsSync(file)) { res.writeHead(404); res.end('Comparison not found'); return true }
  res.writeHead(200, { 'Content-Type': mime[extname(file)], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self'${path.includes('/plans') ? " 'unsafe-inline'" : ''}; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'` })
  res.end(req.method === 'HEAD' ? undefined : readFileSync(file))
  return true
}
