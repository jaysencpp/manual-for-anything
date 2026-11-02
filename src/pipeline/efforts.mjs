export function stageEfforts(args, env = process.env) {
  const flag = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
  const base = flag('--effort', args.includes('--no-thinking') ? 'minimal' : 'low')
  const defaults = { plan: base, perception: 'minimal', repair: 'low', drawing: 'minimal', catalogue: 'low' }
  const result = { base }
  for (const [stage, fallback] of Object.entries(defaults)) result[stage] = flag(`--${stage}-effort`, env[`${stage.toUpperCase()}_EFFORT`] || fallback)
  for (const [stage, value] of Object.entries(result)) if (!['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)) throw new Error(`Invalid ${stage} effort: ${value}`)
  if (args.includes('--no-thinking')) for (const stage of Object.keys(result)) result[stage] = 'minimal'
  return result
}

export const effortArgs = (efforts) => Object.entries(efforts).filter(([stage]) => stage !== 'base').flatMap(([stage, value]) => [`--${stage}-effort`, value])
