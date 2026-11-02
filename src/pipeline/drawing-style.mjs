// Use layered drawings by default; classic remains available as an explicit override.
export function drawingStyle(args = [], environment = process.env) {
  const at = args.indexOf('--drawing-style')
  const style = at < 0 ? environment.DRAWING_STYLE || 'layered' : args[at + 1]
  if (!['classic', 'layered'].includes(style)) throw new Error('--drawing-style must be classic or layered')
  return style
}
