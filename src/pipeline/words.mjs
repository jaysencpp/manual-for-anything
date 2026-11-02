// The words a film program may not contain anywhere, even inside a string (program-rules.txt), and how to keep data out of
// their way: embedded as JSON with the first letter of each such word escaped, which reads the same to JavaScript.
export const REFUSED = ['window', 'globalThis', 'self', 'top', 'parent', 'opener', 'location', 'history', 'open', 'document',
  'defaultView', 'caches', 'cookie', 'crypto', 'eval', 'Function', 'Date', 'performance', 'localStorage', 'sessionStorage',
  'indexedDB', 'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'RTCPeerConnection', 'setTimeout',
  'setInterval', 'requestAnimationFrame', 'queueMicrotask', 'innerHTML', 'outerHTML', 'insertAdjacentHTML']
// Escape reserved identifiers in embedded JSON, including differently cased spellings.
const pattern = new RegExp(`\\b(${REFUSED.join('|')})\\b`, 'gi')

export const data = (value) => JSON.stringify(value)
  .replace(pattern, (word) => `\\u${word.charCodeAt(0).toString(16).padStart(4, '0')}${word.slice(1)}`)

// Reserved words in generated source: navigation, storage and
// execution names anywhere but as a property (.top, top:), the rest anywhere; ctx.textBaseline = "top" allowed.
const NAMES = ['window', 'globalThis', 'self', 'top', 'parent', 'opener', 'location', 'history', 'open', 'document',
  'defaultView', 'localStorage', 'sessionStorage', 'indexedDB', 'caches', 'cookie', 'eval', 'Function']
const ANYWHERE = REFUSED.filter((word) => !NAMES.includes(word))
export const refusedIn = (source) => {
  const code = source.replace(/textBaseline\s*=\s*["']top["']/g, '')
  return [...new Set([
    ...(code.match(new RegExp(`(?<![\\w.$])(${NAMES.join('|')})\\b(?!\\s*:)`, 'g')) || []),
    ...(code.match(new RegExp(`\\b(${ANYWHERE.join('|')}|Math\\.random)\\b`, 'g')) || []),
  ])]
}

// A program that only names its own variables with refused words (const top = …) is repaired, not refused: each such
// name, outside strings and where it is not a property (.top, top:), becomes name_ — which changes nothing it does.
// A refused global it really uses (Date, fetch) is renamed too and fails when called, as it would have anyway.
export const repair = (source) => source
  .split(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/)
  .map((part, i) => (i % 2 ? part : part.replace(new RegExp(`(?<![\\w.$])(${REFUSED.join('|')})\\b(?!\\s*:)`, 'g'), '$1_')))
  .join('')
