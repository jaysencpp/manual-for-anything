import { chromePresent } from '../benchmarks/drawing-chrome.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { gradePlan, schemaProblems, inventoryProblems, caseProblems } from '../benchmarks/planning-grade.mjs'
import { openPlanningBrowser } from '../benchmarks/planning-browser.mjs'

export function fixture(name) {
  const read = path => JSON.parse(readFileSync(new URL(`../examples/fixtures/${name}/${path}`, import.meta.url)))
  const screens = read('screens/screens.json')
  return { candidate: read('script.json'), photo: { width: screens.photo.width, height: screens.photo.height },
    cut: { geometry: read('screens/geometry.json'), sizes: Object.fromEntries(Object.entries(screens).filter(([k]) => k !== 'photo').map(([k, s]) => [k, { width: s.width, height: s.height }])) } }
}

test('schema grading catches missing required fields, extra fields and type/enum/range errors', () => {
  assert.ok(schemaProblems({ mode: 'physical' }).some(e => e.includes('objects')))
  assert.deepEqual(schemaProblems({ a: [2] }, { type: 'object', properties: { a: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1 } }, required: ['a'], additionalProperties: false }), [])
  assert.ok(schemaProblems({ a: [0], extra: true }, { type: 'object', properties: { a: { type: 'array', items: { type: 'integer', minimum: 1 } } }, additionalProperties: false }).length === 2)
  assert.throws(() => schemaProblems({}, { allOf: [] }), /Unsupported schema/)
})
test('frozen inventory and explicit task assertions reject silent task changes', () => {
  const { candidate } = fixture('paper-plane'), inventory = structuredClone(candidate.objects)
  assert.deepEqual(inventoryProblems(candidate, inventory), [])
  assert.equal(inventoryProblems({ objects: 'broken' }, inventory).length, 1)
  assert.equal(inventoryProblems({ objects: [null] }, inventory).length, 1)
  candidate.objects[0].measurements = Object.fromEntries(Object.entries(candidate.objects[0].measurements).reverse().map(([k, v]) => [k, Object.fromEntries(Object.entries(v).reverse())]))
  assert.deepEqual(inventoryProblems(candidate, inventory), [], 'JSON key order does not change measurement identity')
  candidate.objects[0].cm++
  assert.equal(inventoryProblems(candidate, inventory).length, 1)
  assert.ok(caseProblems(candidate, { requiredObjects: ['missing'], requiredVerbs: ['heat'] }).length === 2)
  assert.throws(() => caseProblems(candidate, { madeUpAssertion: true }), /Unknown case/)
})
test('unknown references, soft contradictions, and unreviewed plans cannot receive strict passes', async () => {
  const broken = fixture('paper-plane')
  broken.candidate.steps[0].do[0].k = 'invented-paper'
  const bad = await gradePlan(broken)
  assert.equal(bad.machine, 'fail'); assert.equal(bad.strict, 'fail')
  assert.ok(bad.findings.some(f => f.code === 'unknown-reference'))
  const noBrowser = await gradePlan(fixture('paper-plane'))
  assert.notEqual(noBrowser.strict, 'pass')
  const malformed = await gradePlan({ ...fixture('paper-plane'), rawText: '{broken' })
  assert.equal(malformed.machine, 'fail'); assert.equal(malformed.rawFirstResponseValid, false)
})
test('saved physical plans are graded through production geometry, compilation and sampled real Chrome playback', { skip: !chromePresent, timeout: 45000 }, async t => {
  const browser = await openPlanningBrowser(); t.after(browser.close)
  let passes = 0
  for (const name of ['wood8', 'lego-pile', 'groceries', 'yarn', 'paper-plane', 'wire-bracelet']) {
    const result = await gradePlan({ ...fixture(name), smoke: browser.smoke })
    t.diagnostic(`${name}: ${result.machine}; ${result.findings.map(f => `${f.stage}: ${f.message}`).join('; ').slice(0, 450)}`)
    assert.notEqual(result.strict, 'pass', 'Unreviewed examples must never become strict passes')
    if (result.machine === 'pass') {
      passes++
      assert.ok(result.grades.execution.frames > 0)
      const reviewed = await gradePlan({ ...fixture(name), smoke: browser.smoke, review: { verdict: 'pass', reason: 'Test reviewer acceptance' } })
      assert.equal(reviewed.strict, 'pass')
    }
  }
  assert.ok(passes > 0, 'At least one existing feasible example must survive the smoke check')
})
