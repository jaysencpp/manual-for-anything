// Segmentation against a local stub of the Responses API (no network, no tokens).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import sharp from 'sharp'
import { associate, coloursDistinguish, looksLike, maskEvidence, namedColour, namedShade, overlap, settleColours, shadeCost } from '../src/pipeline/mask-selection.mjs'
import { Segmenter, segmentPhoto, principalAxis, rotated } from '../src/pipeline/segment.mjs'

// The protocol's own example record: a 5 × 5 box at (10, 20) and its one_bit mask.
const record = id => `${id}<|box;x1=10;y1=20;x2=14;y2=24;w=100;h=80|><|mask;x=0;y=0;data=5,5,!!!!!(QO(0lu8?|>`
const EXPECTED = [1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 0, 0, 0, 1]
const photo = { width: 100, height: 80, jpeg: Buffer.from('jpeg') }

async function stub(t, respond) {
  const seen = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null
      seen.push({ url: req.url, auth: req.headers.authorization, body: parsed })
      respond(req, res, parsed, seen.length)
    })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  return { seen, base: `http://127.0.0.1:${server.address().port}`, env: { META_BASE_URL: `http://127.0.0.1:${server.address().port}/v1/`, MODEL_API_KEY: 'test-key' } }
}
const answer = (res, text) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text }] }] })) }
const samples = (req, res, body) => {
  const text = body.input[0].content[0].text
  answer(res, text === 'nothing' ? '' : `<0f>${(text.startsWith('<0f>') ? [1] : [0, 1]).map(record).join(',')}`)
}

test('find places box-local masks in the photo and sends the expected request', async t => {
  const { seen, env } = await stub(t, samples)
  const found = await new Segmenter(photo, { env }).find('board')
  assert.equal(found.masks.length, 2)
  assert.deepEqual(found.boxes[0], [10, 20, 15, 25])
  const placed = []
  for (let y = 20; y < 25; y++) for (let x = 10; x < 15; x++) placed.push(found.masks[0][y * 100 + x])
  assert.deepEqual(placed, EXPECTED)
  assert.equal(found.masks[0].reduce((a, v) => a + v, 0), EXPECTED.reduce((a, v) => a + v, 0))
  assert.equal(seen.at(-1).url, '/v1/responses'); assert.equal(seen.at(-1).auth, 'Bearer test-key'); assert.equal(seen.at(-1).body.model, 'sam-3.1')
  assert.match(seen.at(-1).body.input[0].content[1].image_url, /^data:image\/jpeg;base64,/)
})

test('nothing found is empty, not an error', async t => {
  const { env } = await stub(t, samples)
  assert.deepEqual((await new Segmenter(photo, { env }).find('nothing')).masks, [])
})

test('boxes ask once and come back in order', async t => {
  const { seen, env } = await stub(t, samples)
  const { masks } = await new Segmenter(photo, { env }).byBoxes([[8, 18, 17, 27], [40, 40, 60, 60]])
  assert.match(seen.at(-1).body.input[0].content[0].text, /<\|box;x1=8;y1=18;x2=16;y2=26;w=100;h=80\|>/)
  assert.ok(masks[0].some(Boolean)); assert.ok(!masks[1].some(Boolean))
})

test('more boxes than one request allows go out in batches and come back in order', async t => {
  const { seen, env } = await stub(t, (req, res, body) => {
    const ids = [...body.input[0].content[0].text.matchAll(/(\d+)<\|box/g)].map(m => +m[1])
    if (ids.length > 16) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: `${ids.length} objects exceed this model's limit of 16` } })) }
    answer(res, ids.includes(18) ? `<0f>${record(18)}` : '')
  })
  const boxes = Array.from({ length: 28 }, (_, i) => [i, 0, i + 5, 5])
  const { masks, scores } = await new Segmenter(photo, { env }).byBoxes(boxes)
  assert.equal(seen.length, 2)
  assert.equal(masks.length, 28)
  masks.forEach((mask, i) => assert.equal(mask.some(Boolean), i === 17, `box ${i}`))
  assert.equal(scores[17], 1)
})

test('redirects never reach their destination with credentials', async t => {
  const captured = await stub(t, (req, res) => { res.writeHead(200); res.end('{}') })
  for (const code of [301, 302, 303, 307, 308]) {
    const redirect = await stub(t, (req, res) => { res.writeHead(code, { Location: `${captured.base}/capture` }); res.end() })
    await assert.rejects(new Segmenter(photo, { env: redirect.env }).find('board'), new RegExp(`SAM API HTTP ${code}`))
    assert.equal(redirect.seen.length, 1)
  }
  assert.equal(captured.seen.length, 0)
})

test('production rejects an insecure endpoint override', () => {
  assert.throws(() => new Segmenter(photo, { env: { NODE_ENV: 'production', META_BASE_URL: 'http://example.invalid/', MODEL_API_KEY: 'k' } }), /must use HTTPS/)
})

test('a gateway timeout retries, and a key in an error message is redacted', async t => {
  const { seen, env } = await stub(t, (req, res, body, n) => {
    if (n === 1) { res.writeHead(504); return res.end() }
    samples(req, res, body)
  })
  assert.equal((await new Segmenter(photo, { env }).find('board')).masks.length, 2)
  assert.equal(seen.length, 2)
  const failing = await stub(t, (req, res) => { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'bad key test-key' } })) })
  await assert.rejects(new Segmenter(photo, { env: failing.env }).find('board'), error => { assert.match(error.message, /401: bad key \*\*\*/); return true })
  assert.equal(failing.seen.length, 1, 'authentication errors are not retried')
})

test('the cut-out pipeline writes every file and preserves the missing-mask fallback', async t => {
  const { env } = await stub(t, samples)
  const dir = mkdtempSync(join(tmpdir(), 'segment-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'photo.png')
  await sharp({ create: { width: 100, height: 80, channels: 3, background: 'tan' } }).png().toFile(file)
  const result = await segmentPhoto(file, { objects: [
    { key: 'board', name: 'board', segment: 'board', box: [8, 18, 10, 10] },
    { key: 'missing', name: 'nothing', box: [50, 40, 10, 10] },
  ] }, dir, { env })
  const read = name => JSON.parse(readFileSync(join(dir, name), 'utf8'))
  const screens = read('screens.json'), geometry = read('geometry.json'), evidence = read('perception.json')
  assert.deepEqual(Object.keys(screens), ['board', 'missing']); assert.deepEqual(Object.keys(geometry), ['board', 'missing'])
  assert.match(result.log, /no mask found, cut out as the box/)
  assert.ok(evidence.missing.warnings.length); assert.equal(evidence.board.method, 'semantic')
  assert.equal(geometry.board.color, '#d2b48c')
  for (const [key, size] of Object.entries(screens)) {
    const meta = await sharp(join(dir, `${key}.png`)).metadata()
    assert.equal(meta.channels, 4); assert.equal(meta.width, size.width); assert.equal(meta.height, size.height)
  }
})

// Two instances of one class: a 5 × 5 mask on the photo's left half and one on its right half.
const twoInstances = (req, res, body) => {
  const text = body.input[0].content[0].text
  const at = (id, x) => `${id}<|box;x1=${x};y1=20;x2=${x + 4};y2=24;w=100;h=80|><|mask;x=0;y=0;data=5,5,!!!!!(QO(0lu8?|>`
  answer(res, text === 'brick' ? `<0f>${at(1, 10)},${at(2, 60)}` : '')
}
async function redAndBluePhoto(t) {
  const dir = mkdtempSync(join(tmpdir(), 'segment-colours-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'photo.png')
  await sharp({ create: { width: 100, height: 80, channels: 3, background: '#d62128' } })
    .composite([{ input: { create: { width: 50, height: 80, channels: 3, background: '#0a68c8' } }, left: 50, top: 0 }]).png().toFile(file)
  return { dir, file, read: name => JSON.parse(readFileSync(join(dir, name), 'utf8')) }
}

test('objects take the cut-outs of their named colours when their boxes sit on each other', async t => {
  const { env } = await stub(t, twoInstances), { dir, file, read } = await redAndBluePhoto(t)
  const result = await segmentPhoto(file, { objects: [
    { key: 'red-brick', name: 'red plastic brick', segment: 'brick', box: [55, 15, 15, 15] },
    { key: 'blue-brick', name: 'blue plastic brick', segment: 'brick', box: [5, 15, 15, 15] },
  ] }, dir, { env })
  const geometry = read('geometry.json')
  assert.equal(geometry['red-brick'].color, '#d62128'); assert.equal(geometry['blue-brick'].color, '#0a68c8')
  assert.deepEqual(result.colourMismatches, [])
  assert.match(result.log, /matched by colour instead of box/)
})

test('an object with no instance of its named colour keeps its match and reports it', async t => {
  const { env } = await stub(t, twoInstances), { dir, file, read } = await redAndBluePhoto(t)
  const result = await segmentPhoto(file, { objects: [
    { key: 'green-brick', name: 'green plastic brick', segment: 'brick', box: [55, 15, 15, 15] },
    { key: 'red-brick', name: 'red plastic brick', segment: 'brick', box: [5, 15, 15, 15] },
  ] }, dir, { env })
  assert.deepEqual(result.colourMismatches, ['green-brick'])
  assert.equal(read('geometry.json')['green-brick'].color, '#0a68c8')
  assert.equal(read('geometry.json')['red-brick'].color, '#d62128')
  assert.match(read('perception.json')['green-brick'].warnings.join(), /named green, but its cut-out does not look green/)
})

test('a class that matches nothing tries a simpler term before falling back to boxes', async t => {
  const { seen, env } = await stub(t, twoInstances), { dir, file, read } = await redAndBluePhoto(t)
  const result = await segmentPhoto(file, { objects: [
    { key: 'red-brick', name: 'red plastic brick', segment: 'plastic brick', box: [5, 15, 15, 15] },
    { key: 'blue-brick', name: 'blue plastic brick', segment: 'plastic brick', box: [55, 15, 15, 15] },
  ] }, dir, { env })
  assert.ok(seen.some(request => request.body.input[0].content[0].text === 'brick'))
  assert.match(result.log, /class "plastic brick": 0 found, 0 confident/)
  assert.match(result.log, /class "brick" instead: 2 found, 2 confident/)
  assert.equal(read('perception.json')['red-brick'].method, 'semantic')
  assert.deepEqual(result.colourMismatches, [])
})

test('colours are checked on cut-outs that fell back to their boxes', async t => {
  const { env } = await stub(t, twoInstances), { dir, file, read } = await redAndBluePhoto(t)
  const result = await segmentPhoto(file, { objects: [
    { key: 'right', name: 'red plastic block', segment: 'plastic block', box: [5, 15, 15, 15] },
    { key: 'wrong', name: 'yellow plastic block', segment: 'plastic block', box: [55, 15, 15, 15] },
  ] }, dir, { env })
  assert.equal(read('perception.json').right.method, 'box')
  assert.deepEqual(result.colourMismatches, ['wrong'])
})

test('names only compare colours when colour tells a class apart', async t => {
  const { env } = await stub(t, twoInstances), { dir, file, read } = await redAndBluePhoto(t)
  const result = await segmentPhoto(file, { objects: [
    { key: 'green-brick', name: 'green plastic brick', segment: 'brick', box: [55, 15, 15, 15] },
    { key: 'other-brick', name: 'plastic brick', segment: 'brick', box: [5, 15, 15, 15] },
  ] }, dir, { env })
  assert.deepEqual(result.colourMismatches, [])
  assert.equal(read('geometry.json')['green-brick'].color, '#0a68c8')
})

test('colour names read from object names and photo colours', () => {
  assert.equal(namedColour('light green plastic building brick'), 'green')
  assert.equal(namedColour('Blue-handled scissors'), null)
  assert.equal(namedColour('dark bottle with white cap behind Crown Royal'), null)
  assert.equal(namedColour('blue bag behind bananas'), 'blue')
  assert.equal(namedColour('gray stone'), 'grey')
  assert.equal(namedColour('wooden board'), null)
  assert.equal(coloursDistinguish(['red brick', 'light green brick']), true)
  assert.equal(coloursDistinguish(['red brick', 'red brick', 'brick']), false)
  // The average colours of the bricks SAM cut out of a real photo.
  const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
  for (const [word, colour, expected] of [['yellow', '#eeb507', true], ['red', '#eeb507', false], ['green', '#05ba06', true], ['blue', '#5090bc', true],
    ['green', '#5090bc', false], ['red', '#d62128', true], ['yellow', '#d62128', false], ['blue', '#0a68c8', true], ['orange', '#0a68c8', false]])
    assert.equal(looksLike(word, hex(colour)), expected, `${word} ${colour}`)
  assert.equal(looksLike('white', [240, 240, 235]), true); assert.equal(looksLike('black', [20, 20, 22]), true); assert.equal(looksLike('grey', [120, 120, 125]), true)
  assert.equal(looksLike('red', [120, 120, 125]), false)
})

const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
const corners = ([x, y, w, h]) => [x, y, x + w, y + h]

test('shades are read from names and compared within a colour', () => {
  assert.equal(namedColour('lime green plastic building brick at the upper left'), 'green')
  assert.equal(namedColour('lime plastic brick'), 'green')
  assert.equal(namedShade('lime green plastic building brick at the upper left'), 'lime')
  assert.equal(namedShade('light green brick'), 'lime')
  assert.equal(namedShade('green plastic building brick at the top center'), 'green')
  assert.equal(namedShade('light blue brick'), 'light blue')
  assert.equal(namedShade('dark red masonry brick'), 'dark red')
  assert.equal(namedShade('wooden board'), null)
  assert.equal(coloursDistinguish(['lime brick', 'green brick']), true)
  assert.equal(coloursDistinguish(['green brick', 'green block']), false)
  assert.ok(shadeCost('lime brick', hex('#82ba08')) < shadeCost('lime brick', hex('#05ba06')))
  assert.ok(shadeCost('green brick', hex('#05ba06')) < shadeCost('green brick', hex('#82ba08')))
  assert.ok(shadeCost('orange brick', hex('#d55506')) < shadeCost('orange brick', hex('#b46908')))
  assert.ok(shadeCost('light blue brick', hex('#5090bc')) < shadeCost('light blue brick', hex('#0a68c8')))
  assert.ok(shadeCost('dark red brick', hex('#6a1c2e')) < shadeCost('dark red brick', hex('#d62128')))
})

test('a real run with similar colours gives every brick its own shade', () => {
  // A paid run on the tower photo: the model's boxes, and SAM's instances with their average colours. By position alone
  // and by colour family, lime and green were swapped, and so were orange and the small yellow.
  const bricks = [
    ['red plastic building brick on the left', [39, 168, 191, 116], [22, 89, 100, 79], '#b60b05'],
    ['lime green plastic building brick at the upper left', [131, 101, 192, 128], [81, 37, 76, 79], '#82ba08'],
    ['green plastic building brick at the top center', [276, 42, 198, 138], [148, 10, 161, 112], '#05ba06'],
    ['light blue plastic building brick at the upper right', [262, 130, 190, 125], [247, 59, 146, 79], '#5090bc'],
    ['yellow plastic building brick leaning in the left foreground', [108, 150, 260, 166], [53, 87, 159, 177], '#eeb507'],
    ['orange plastic building brick in the center', [185, 195, 130, 120], [185, 103, 64, 83], '#d55506'],
    ['yellow plastic building brick in the center right', [248, 225, 105, 85], [247, 132, 62, 83], '#b46908'],
    ['red plastic building brick leaning in the right foreground', [268, 198, 203, 110], [267, 114, 172, 162], '#d62128'],
    ['blue plastic building brick on the right', [375, 205, 95, 100], [372, 126, 88, 80], '#0a68c8'],
    ['blue plastic building brick at the bottom center', [172, 225, 105, 85], [168, 180, 82, 90], '#06519f'],
  ]
  // (segmentPhoto pads each box by 6 pixels within the 474 × 316 photo before matching)
  const padded = ([x, y, w, h]) => [Math.max(0, x - 6), Math.max(0, y - 6), Math.min(474, x + w + 6), Math.min(316, y + h + 6)]
  const names = bricks.map(b => b[0]), requests = bricks.map(b => padded(b[1])), candidates = bricks.map(b => corners(b[2]))
  const scores = bricks.map(() => 0.97), colours = bricks.map(b => hex(b[3]))
  const { assigned, mismatched } = settleColours(names, requests, candidates, scores, colours, associate(requests, candidates, scores))
  assert.deepEqual(names.map((_, i) => bricks[assigned[i]][3]), bricks.map(b => b[3]))
  assert.deepEqual(mismatched, [])
})

test('two objects of one shade stay with their box matches', () => {
  const candidates = [[0, 0, 10, 10], [100, 0, 110, 10]], red = hex('#d62128'), darker = hex('#b60b05')
  const { assigned, moved } = settleColours(['red brick', 'red block', 'blue brick'], [[100, 0, 110, 10], [0, 0, 10, 10], [50, 0, 60, 10]], [...candidates, [50, 0, 60, 10]], [0.9, 0.9, 0.9], [red, darker, hex('#0a68c8')], { 0: 1, 1: 0, 2: 2 })
  assert.deepEqual(assigned, { 0: 1, 1: 0, 2: 2 })
  assert.deepEqual(moved, [])
})

test('of two objects in one shade, a clearly larger box takes the clearly larger instance', () => {
  const small = [0, 0, 20, 20], large = [100, 0, 180, 80], yellow = hex('#eeb507'), amber = hex('#b46908')
  const swapped = settleColours(['yellow brick', 'yellow block', 'blue brick'], [[0, 0, 60, 60], [100, 0, 120, 20], [300, 0, 310, 10]], [small, large, [300, 0, 310, 10]], [0.9, 0.9, 0.9], [amber, yellow, hex('#0a68c8')], { 0: 0, 1: 1, 2: 2 })
  assert.deepEqual(swapped.assigned, { 0: 1, 1: 0, 2: 2 })
  const similar = settleColours(['yellow brick', 'yellow block', 'blue brick'], [[0, 0, 60, 60], [100, 0, 165, 60], [300, 0, 310, 10]], [small, large, [300, 0, 310, 10]], [0.9, 0.9, 0.9], [amber, yellow, hex('#0a68c8')], { 0: 0, 1: 1, 2: 2 })
  assert.deepEqual(similar.assigned, { 0: 0, 1: 1, 2: 2 }, 'boxes of similar size keep their matches')
})

test('objects without a colour keep their matches while shades sort themselves out', () => {
  const candidates = [[0, 0, 10, 10], [100, 0, 110, 10], [200, 0, 210, 10]], scores = [0.9, 0.9, 0.9]
  const colours = [hex('#05ba06'), hex('#82ba08'), hex('#888888')]
  const { assigned } = settleColours(['lime brick', 'green brick', 'plain brick'], [[0, 0, 10, 10], [100, 0, 110, 10], [200, 0, 210, 10]], candidates, scores, colours, { 0: 0, 1: 1, 2: 2 })
  assert.deepEqual(assigned, { 0: 1, 1: 0, 2: 2 })
})

test('a closer shade left free is taken over a poorer one', () => {
  const candidates = [[0, 0, 10, 10], [100, 0, 110, 10], [200, 0, 210, 10]]
  const { assigned, moved } = settleColours(['lime brick', 'red brick'], [[0, 0, 10, 10], [200, 0, 210, 10]], candidates, [0.9, 0.9, 0.9], [hex('#05ba06'), hex('#82ba08'), hex('#d62128')], { 0: 0, 1: 2 })
  assert.deepEqual(assigned, { 0: 1, 1: 2 })
  assert.deepEqual(moved, [0])
})

test('a colour match prefers the nearest free instance and takes each once', () => {
  const candidates = [[0, 0, 10, 10], [100, 0, 110, 10], [200, 0, 210, 10]], scores = [0.9, 0.9, 0.9]
  const red = [214, 33, 40], blue = [10, 104, 200]
  const moved = settleColours(['red brick', 'red brick', 'blue brick'], [[95, 0, 115, 10], [190, 0, 215, 10], [0, 0, 10, 10]], candidates, scores, [blue, red, red],
    { 0: 1, 1: 0, 2: 2 })
  assert.deepEqual(moved.assigned, { 0: 1, 1: 2, 2: 0 })
  assert.deepEqual(moved.mismatched, [])
  const low = settleColours(['red brick', 'blue brick'], [[0, 0, 10, 10], [100, 0, 110, 10]], candidates, [0.9, 0.9, 0.2], [blue, blue, red], { 0: 0, 1: 1 })
  assert.deepEqual(low.mismatched, [0], 'a low-confidence instance is not taken')
  assert.deepEqual(low.assigned, { 0: 0, 1: 1 })
})

test('a long slanted object is found along its axis and turned level about its middle', () => {
  const width = 200, height = 200, turn = Math.PI / 6, rgba = new Uint8Array(width * height * 4), xs = [], ys = []
  for (let d = -80; d <= 80; d += 0.25) for (let w = -4; w <= 4; w += 0.25) {
    const x = Math.round(100 + d * Math.cos(turn) - w * Math.sin(turn)), y = Math.round(100 + d * Math.sin(turn) + w * Math.cos(turn))
    rgba.fill(255, (y * width + x) * 4, (y * width + x) * 4 + 4); xs.push(x); ys.push(y)
  }
  const { axis, large, small } = principalAxis(xs, ys)
  assert.ok(Math.abs(Math.abs(Math.atan2(axis[1], axis[0])) - turn) < 0.01); assert.ok(large > 20 * small)
  const level = rotated(rgba, width, height, turn, [100.5, 100.5]), rows = new Set(), columns = new Set()
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (level[(y * width + x) * 4 + 3] > 128) { rows.add(y); columns.add(x) }
  assert.ok(rows.size <= 12, `${rows.size} rows`); assert.ok(columns.size >= 155, `${columns.size} columns`)
})

test('distinct objects cannot receive the same mask', () => {
  assert.deepEqual(associate([[0, 0, 100, 100], [70, 0, 170, 100]], [[75, 0, 165, 100], [0, 0, 90, 100]], [0.95, 0.9]), { 0: 1, 1: 0 })
})
test('low-confidence or unrelated masks do not replace the box result', () => {
  assert.deepEqual(associate([[0, 0, 10, 10]], [[100, 100, 110, 110], [0, 0, 10, 10]], [1, 0.2]), {})
})
test('a mask already used by another object is excluded', () => {
  assert.deepEqual(associate([[0, 0, 10, 10]], [[0, 0, 10, 10]], [0.99], [0]), {})
})
test('geometry outweighs small confidence differences', () => {
  assert.deepEqual(associate([[0, 0, 10, 10]], [[0, 0, 10, 10], [5, 5, 15, 15]], [0.7, 0.99]), { 0: 0 })
})
test('a box off by about its size still takes its class instance, and the nearest of two is taken once', () => {
  assert.deepEqual(associate([[244, 200, 897, 305]], [[250, 350, 930, 490]], [0.9]), { 0: 0 })
  assert.deepEqual(associate([[0, 0, 100, 100], [300, 0, 400, 100]], [[320, 120, 420, 220], [10, 120, 110, 220]], [0.9, 0.9]), { 0: 1, 1: 0 })
})
test('overlap handles empty and identical boxes', () => {
  assert.equal(overlap([0, 0, 10, 10], [0, 0, 10, 10]), 1); assert.equal(overlap([0, 0, 0, 0], [0, 0, 0, 0]), 0)
})
test('confident segmentation never confirms identity or scale; disagreement stays visible', () => {
  const good = maskEvidence([0, 0, 10, 10], [0, 0, 10, 10], 0.99, 'semantic')
  assert.equal(good.boxIoU, 1); assert.equal(good.identityVerified, false); assert.equal(good.scaleVerified, false); assert.deepEqual(good.warnings, [])
  assert.equal(maskEvidence([0, 0, 10, 10], [100, 100, 110, 110], 0.2, 'box').warnings.length, 2)
})

test('npm run live explains a missing key instead of starting without one', async () => {
  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/live.mjs', import.meta.url))], { env: { ...process.env, MODEL_API_KEY: '', META_API_KEY: '' }, input: '', encoding: 'utf8' })
  assert.equal(result.status, 1); assert.match(result.stderr, /MODEL_API_KEY/)
})
