// What a benchmark pins before it spends money: application code, benchmark code and prompts, by repository path.
import { readdirSync } from 'node:fs'
import { join, resolve, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const under = (folder, pattern) => readdirSync(join(repoRoot, folder), { recursive: true, withFileTypes: true })
  .filter(e => e.isFile() && pattern.test(e.name))
  .map(e => relative(repoRoot, join(e.parentPath, e.name)))
export const sourceFiles = () => [...under('src', /\.mjs$/), ...under('prompts', /\.txt$/),
  ...readdirSync(join(repoRoot, 'benchmarks')).filter(f => f.endsWith('.mjs')).map(f => `benchmarks/${f}`)].sort()
