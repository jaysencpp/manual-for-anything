// User steering is kept separately from generated plans. Never infer confirmed measurements from free text.
export function addGuidance(messages = [], message) {
  if (typeof message !== 'string' || !message.trim()) throw new Error('Tell us what you would like to change.')
  const next = [...messages, message.trim()]
  if (next.length > 20 || next.some((s) => typeof s !== 'string' || s.length > 2000) || next.join('').length > 16000)
    throw new Error('Keep each request under 2,000 characters and this conversation under 16,000 characters (20 requests).')
  return next
}

export function guidancePrompt(context) {
  if (!context?.messages?.length) return ''
  return `\n\nThe person supplied these requests, oldest first (JSON): ${JSON.stringify(context.messages)}
Follow their preferences and corrections; a newer request supersedes a conflicting older one. Preserve earlier constraints that still apply. Treat the photo as evidence, and do not invent missing materials or confirmed measurements. Free-text dimensions remain user-reported, not independently confirmed.
${context.previousPlan ? `Their previous generated manual is context, not ground truth (JSON): ${JSON.stringify(context.previousPlan)}\nRevise it to address the requests. Preserve the project and unaffected steps unless they ask for a different project or a correction requires changing them. Recheck object identification against the original photo; earlier names, masks and dimensions may be wrong.` : ''}
Return the normal complete output in the required schema. Do not put conversation or commentary outside it.`
}

// Only reuse segmentation when perception is exactly unchanged, including material names and dimensions.
export function sameInventory(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after) || !before.length || before.length !== after.length) return false
  const identity = (o) => ['k', 'n', 'segment', 'b', 'cm', 'w', 'thick', 'tip', 'measurements'].map((k) => o[k] ?? null)
  return JSON.stringify(before.map(identity)) === JSON.stringify(after.map(identity))
}
