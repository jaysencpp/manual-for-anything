// Rebuilds src/kit/kit.js, the program kit a film program reaches as env.kit, from src/kit/programKit.ts.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { programKitSource } from '../src/kit/programKit.ts'

writeFileSync(fileURLToPath(new URL('../src/kit/kit.js', import.meta.url)), programKitSource)
