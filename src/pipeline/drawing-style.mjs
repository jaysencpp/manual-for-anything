// Keep the experimental line hierarchy opt-in until broader visual comparisons justify a default change.
export function drawingStyle(args = [], environment = process.env) {
  const at = args.indexOf('--drawing-style')
  const style = at < 0 ? environment.DRAWING_STYLE || 'classic' : args[at + 1]
  if (!['classic', 'layered'].includes(style)) throw new Error('--drawing-style must be classic or layered')
  return style
}
