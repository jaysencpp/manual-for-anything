// Meta Model API client. Images are explicit attachments, not tool calls.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { createParser } from 'eventsource-parser'
export { json } from './json.mjs'

const local = new URL('../../.env.local', import.meta.url)
if (existsSync(local)) for (const [key, value] of Object.entries(parseEnv(readFileSync(local, 'utf8')))) {
  if (process.env[key] == null) process.env[key] = value
}

const SYSTEM = 'You are one model call in an instruction-film application. Follow the user prompt exactly. Return only the requested JSON, with no preamble or code fences. Images named in the prompt are attached and labelled with their filenames. Inspect the images before answering. You have no tools or filesystem access.'
// Published standard rates, USD per million tokens, checked 2026-10-27. These are estimates, not billing records.
const RATES = { 'muse-wonder-1.0': [4, 0.2, 20], 'muse-spark-1.3': [1.25, 0.15, 4.25], 'muse-spark-1.2': [1.25, 0.15, 4.25] }
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

export function configuration(options = {}) {
  const provider = options.provider ?? process.env.MODEL_PROVIDER ?? 'meta'
  if (provider !== 'meta') throw new Error(`Unsupported model provider: ${provider}. Only Meta is supported.`)
  return { provider: 'meta', model: options.model ?? (process.env.META_MODEL || 'muse-wonder-1.0') }
}

export function estimatedCost(model, usage) {
  if (!RATES[model] || !Number.isFinite(usage?.prompt_tokens) || !Number.isFinite(usage?.completion_tokens)) return null
  const [input, cached, output] = RATES[model], hit = usage.prompt_tokens_details?.cached_tokens || 0
  return ((usage.prompt_tokens - hit) * input + hit * cached + usage.completion_tokens * output) / 1e6
}

// SSE events can span network chunks, use CRLF, or contain multiple data lines. Decode UTF-8 incrementally.
export async function* events(body) {
  const decoder = new TextDecoder(), pending = []
  const parser = createParser({ onEvent: event => pending.push(event.data) })
  for await (const chunk of body) {
    parser.feed(decoder.decode(chunk, { stream: true }))
    yield* pending.splice(0)
  }
  // Preserve the client's existing tolerance for an unterminated final event.
  // generate() still requires a nonempty answer and an explicit stop finish reason.
  parser.feed(decoder.decode() + '\n\n')
  yield* pending
}

function attachment(dir, file) {
  const path = resolve(dir, file), mime = MIME[extname(path).toLowerCase()]
  if (!mime) throw new Error(`Unsupported image type: ${basename(file)}`)
  return [{ type: 'text', text: `Image file: ${basename(file)}` },
    { type: 'image_url', image_url: { url: `data:${mime};base64,${readFileSync(path).toString('base64')}` } }]
}

export async function generate(dir, prompt, options = {}) {
  const config = configuration(options), started = performance.now()
  let firstTokenSeconds = null
  const onText = (text) => {
    if (text && firstTokenSeconds == null) firstTokenSeconds = (performance.now() - started) / 1000
    options.onText?.(text)
  }
  const key = options.apiKey ?? (process.env.MODEL_API_KEY || process.env.META_API_KEY)
  if (!key) throw new Error('Set MODEL_API_KEY in the project .env.local file or environment before calling Meta.')
  const effort = options.noThinking ? 'minimal' : options.effort || 'low'
  if (!['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new Error(`Unsupported Meta reasoning effort: ${effort}`)
  // (MODEL_BASE_URL: another endpoint speaking the same API, e.g. a local stub for trying the web app without spending)
  const endpoint = new URL(options.baseURL || process.env.MODEL_BASE_URL || 'https://api.meta.ai/v1/')
  if (!endpoint.pathname.endsWith('/')) endpoint.pathname += '/'
  // Redirects must not carry credentials to another endpoint.
  const request = { model: config.model, reasoning_effort: effort, max_tokens: options.maxTokens ?? 16384,
    stream: true, stream_options: { include_usage: true }, response_format: options.responseFormat ?? { type: 'json_object' },
    messages: [{ role: 'developer', content: SYSTEM }, { role: 'user', content: [
      { type: 'text', text: prompt }, ...(options.images || []).flatMap((file) => attachment(dir, file)),
    ] }] }
  const artifact = (options.out || 'out.json').replace(/\.json$/, '')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${artifact}.request.json`), JSON.stringify({ model: config.model, effort, maxTokens: request.max_tokens,
    responseFormat: request.response_format, prompt, images: options.images || [] }, null, 1))
  let attempts = 0
  while (true) {
    attempts++
    let text = '', usage = null, finish = null, responseModel = config.model, retryable = false, retryAfter = 0
    try {
      const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 180000), ...(options.signal ? [options.signal] : [])])
      const response = await fetch(new URL('chat/completions', endpoint), {
        method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(request),
      })
      if (!response.ok) {
        retryable = [408, 409, 429, 500, 502, 503, 504, 529].includes(response.status)
        const after = response.headers.get('retry-after')
        retryAfter = after ? Math.max(0, Number.isFinite(+after) ? +after * 1000 : Date.parse(after) - Date.now()) : 0
        // Never the whole response body (an error may echo a credential or the request's image): only the API's own error
        // message, short, the key masked and anything like encoded data cut out, so a 400 says why.
        let why = ''
        try {
          const body = (await response.text()).slice(0, 4000)
          let message = body; try { const j = JSON.parse(body); message = j?.error?.message ?? j?.message ?? j?.detail ?? '' } catch {}
          why = String(message).split(key).join('***').replace(/[A-Za-z0-9+/=_-]{40,}/g, '…').replace(/\s+/g, ' ').trim().slice(0, 200)
        } catch {}
        const error = new Error(`Meta API HTTP ${response.status}${response.status === 401 ? ': check MODEL_API_KEY' : response.status === 404 ? `: check model ${config.model}` : ''}${why ? ` (${why})` : ''}`)
        error.status = response.status
        throw error
      }
      if (!response.body) throw new Error('Meta returned an empty response body')
      for await (const data of events(response.body)) {
        if (data === '[DONE]') break
        const event = JSON.parse(data)
        if (event.error) throw new Error('Meta returned an error in the response stream')
        if (event.model) responseModel = event.model
        if (event.usage) usage = event.usage
        const choice = event.choices?.[0]
        if (choice?.delta?.refusal) throw new Error('Meta declined this request')
        if (typeof choice?.delta?.content === 'string' && choice.delta.content) {
          text += choice.delta.content; onText(text)
          options.signal?.throwIfAborted() // (stopped from onText: read no more of what is already buffered)
        }
        if (choice?.finish_reason) finish = choice.finish_reason
      }
      if (finish !== 'stop' || !text.trim()) throw new Error(`Meta response incomplete (finish reason: ${finish || 'missing'})`)
      const seconds = (performance.now() - started) / 1000, cost = estimatedCost(config.model, usage)
      const result = { text, provider: 'meta', model: responseModel, seconds, firstTokenSeconds,
        output: usage?.completion_tokens ?? null, thinking: usage?.completion_tokens_details?.reasoning_tokens ?? null,
        usage, cost, costEstimated: cost != null, attempts }
      mkdirSync(dir, { recursive: true })
      // Keep the saved-result shape understood by face recovery and the existing run artifacts.
      writeFileSync(join(dir, options.out || 'out.json'), JSON.stringify({ ...result, text: undefined, type: 'result', is_error: false,
        result: text, duration_ms: seconds * 1000, total_cost_usd: cost,
        usage: { ...usage, input_tokens: usage?.prompt_tokens ?? null, output_tokens: usage?.completion_tokens ?? null } }, null, 1))
      return result
    } catch (error) {
      writeFileSync(join(dir, `${artifact}.error-${attempts}.json`), JSON.stringify({ status: error.status ?? null,
        aborted: !!options.signal?.aborted, hasPartialOutput: !!text, seconds: (performance.now() - started) / 1000, attempts }, null, 1))
      if (text || usage || options.signal?.aborted) writeFileSync(join(dir, `${artifact}.partial.json`), JSON.stringify({
        result: text, aborted: !!options.signal?.aborted, seconds: (performance.now() - started) / 1000,
        firstTokenSeconds, usage, finishReason: finish, cost: estimatedCost(config.model, usage), attempts,
      }, null, 1))
      const network = error instanceof TypeError && !error.status
      // Never replay a partially published answer: consumers may already have started segmentation.
      if (text || options.signal?.aborted || (!retryable && !network) || attempts > (options.retries ?? 2)) throw error
      const backoff = Math.max(retryAfter, 500 * 2 ** (attempts - 1) + Math.random() * 250)
      if (backoff > 30000) throw error
      options.onRetry?.({ attempt: attempts, delayMs: backoff, status: error.status ?? null })
      await delay(backoff, undefined, { signal: options.signal })
    }
  }
}
