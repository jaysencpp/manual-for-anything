// Model answers that are almost JSON, mended without asking the model again. Two kinds:
//  - mistakes that have one reading, mended for every answer: a key whose closing quote is escaped ("cm\":15, seen in a
//    plan that then ran on into whitespace), a comma before a closing bracket, a raw line break or tab inside a string;
//  - an answer that stops part way (it ran on into whitespace and was cut off, or the stream ended): with `truncated`,
//    what was written is kept up to the last whole value, and every bracket still open is closed. Only for answers that
//    are checked after (the plan: validate.mjs), since what was cut off is simply missing.
// mendJson(text, { truncated }) → the mended text, or null when nothing would parse.

const CLOSER = { '{': '}', '[': ']' }

// One pass over the text: the mistakes with one reading mended. Returns the text, and whether it ended inside a string.
function mend(text) {
  let out = '', inString = false, key = false
  const stack = []
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') {
        // (a key never holds a quote: an escaped one followed by its colon ends the key)
        if (key && text[i + 1] === '"' && /^\s*:/.test(text.slice(i + 2, i + 40))) { out += '"'; inString = false; i++; continue }
        if (i + 1 >= text.length) break
        out += c + text[i + 1]; i++; continue
      }
      if (c === '"') { out += c; inString = false; continue }
      out += c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : c
      continue
    }
    if (c === '"') {
      // (a string in an object, after its opening brace or a comma, is a key)
      key = stack.at(-1) === '{' && /[{,]\s*$/.test(out)
      inString = true; out += c; continue
    }
    if (c === '{' || c === '[') { stack.push(c); out += c; continue }
    if (c === '}' || c === ']') { out = out.replace(/,\s*$/, ''); stack.pop(); out += c; if (!stack.length) return { out, inString: false, open: [] }; continue }
    out += c
  }
  return { out, inString, open: stack }
}

// Closes a text cut off part way: a dangling comma or key, every open bracket. A value it ends in may itself be cut
// short ("Tw" of "Two", 1 of 15) and is not kept, unless `whole` (the text stops before a comma: what precedes it is
// complete) — null then, and the caller cuts back further.
function close(text, whole) {
  const { out, inString, open } = mend(text)
  if (inString && !whole) return null
  let s = (inString ? `${out}"` : out).replace(/,\s*$/, '')
  if (open.at(-1) === '{') s = s.replace(/([{,])\s*"[^"\\]*"\s*:?\s*$/, '$1').replace(/,\s*$/, '')
  if (!whole && !/[{}[\]]$/.test(s)) return null
  return s + open.map((c) => CLOSER[c]).reverse().join('')
}

const parses = (s) => { try { JSON.parse(s); return true } catch { return false } }

export function mendJson(text, { truncated = false } = {}) {
  const raw = String(text).trim().replace(/^```(json)?|```$/g, '').trim()
  const start = raw.search(/[{[]/)
  if (start < 0) return null
  const body = raw.slice(start).trimEnd(), mended = mend(body)
  if (!mended.open.length && !mended.inString && parses(mended.out)) return mended.out
  if (!truncated) return null
  // (cut back to each earlier comma in turn until what is left closes into JSON)
  let end = body.length
  for (let tries = 0; tries < 200 && end > 0; tries++) {
    const candidate = close(body.slice(0, end), end < body.length)
    if (candidate != null && parses(candidate)) return candidate
    end = body.lastIndexOf(',', end - 1)
  }
  return null
}
