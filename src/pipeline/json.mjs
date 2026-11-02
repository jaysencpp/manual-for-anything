import { mendJson } from './jsonfix.mjs'

// (an answer that is almost JSON is mended first where only one reading makes sense: jsonfix.mjs; the error is the
// unmended text's, for a repair prompt to point at)
export const json = (text, options) => {
  try { return JSON.parse(text.trim().replace(/^```(json)?|```$/g, '').trim()) } catch (error) {
    const mended = mendJson(text, options)
    if (mended == null) throw error
    return JSON.parse(mended)
  }
}
