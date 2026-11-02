import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { prepareStageExperiment, runStageExperiment, verifyStageExperiment, writeStageReport, saveStageReview, serveStageReport, stageBenchmarkCLI } from '../benchmarks/stage-bench.mjs'
import { gradeRecognition, matchObjects, assertionErrors } from '../benchmarks/stage-bench-grade.mjs'
import { fixtureProjection } from '../benchmarks/stage-bench-cases.mjs'
import { PERCEPTION_SCHEMA } from '../src/pipeline/plan-schema.mjs'
import { read, save } from '../benchmarks/planning-data.mjs'
import { stubModel } from './support/stub-model.mjs'
import { openDrawingBrowser } from '../benchmarks/drawing-chrome.mjs'

const fakeBrowser = async () => ({ smoke: async () => ({ frames: 12 }), close: async () => {} })
const options = { models: ['muse-spark-1.3'], efforts: ['low'], browserFactory: fakeBrowser }
function temporary(t) { const dir = mkdtempSync(join(tmpdir(), 'stage-bench-test-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir }
async function single(t, stage, caseId) {
  const root = temporary(t), suite = join(root,'suite'), out = join(root,'experiment')
  await prepareStageExperiment(suite, { ...options, stage })
  const m = read(join(suite,'manifest.json')); m.cases = m.cases.filter(c => c.id === caseId)
  save(join(suite,'manifest.json'), m)
  await prepareStageExperiment(out, { ...options, stage, suite })
  return { root, out, c: read(join(out,'cases',caseId,'case.json')) }
}
test('recognition matches instances one-to-one and catches wrong routing, duplicates and invented confirmation', () => {
  const c = { photo:{width:200,height:100},expected:{mode:'physical',objects:[{b:[0,0,50,50],segment:'board'},{b:[70,0,50,50],segment:'board'}]} }
  const objects = c.expected.objects.map((o,i) => ({...o,k:`board-${i ? 'b' : 'a'}`,n:'board',cm:50,measurements:{cm:{status:'estimated',source:'single photo estimate'}}}))
  const grade = value => gradeRecognition(JSON.stringify(value),c)
  assert.equal(grade({mode:'physical',objects}).machine,'pass')
  assert.equal(grade({mode:'physical',objects:[objects[0],objects[0]]}).machine,'fail')
  assert.equal(grade({mode:'problem',objects:[]}).machine,'fail')
  objects[0].measurements.cm.status = 'confirmed'
  assert.equal(grade({mode:'physical',objects}).machine,'fail')
  assert.equal(gradeRecognition('{',c).machine,'fail')
  // A greedy nearest match would leave the second expected instance unmatched.
  assert.equal(matchObjects([{b:[0,0,100,100],segment:'x'},{b:[30,0,100,100],segment:'x'}],[{b:[10,0,100,100],segment:'x'},{b:[-20,0,100,100],segment:'x'}],0.5).length,2)
})
test('revision assertions enforce edits and preservation, and reject unsupported predicates', () => {
  const before = { title:'Before',steps:[{do:[{v:'place'}],c:'old'}] }, after = structuredClone(before); after.title = 'After'
  assert.deepEqual(assertionErrors(after,before,[{op:'equals',path:'/title',value:'After'},{op:'preserve',path:'/steps'}]),[])
  after.steps[0].do[0].v = 'cut'
  assert.equal(assertionErrors(after,before,[{op:'preserve',path:'/steps/0/do'}]).length,1)
  assert.equal(assertionErrors(after,before,[{op:'change',path:'/steps/0/c'}]).length,1)
  assert.deepEqual(assertionErrors({a:{y:2,x:1}},{a:{x:1,y:2}},[{op:'preserve',path:'/a'}]),[])
  assert.throws(() => assertionErrors(after,before,[{op:'invented',path:'/title'}]),/Unsupported/)
})
test('partial recognition labels do not penalize additional objects or estimate full precision', () => {
  const object = (k,x) => ({k,n:'wooden board',segment:'wooden board',b:[x,0,40,40],cm:50,measurements:{cm:{status:'estimated',source:'photo estimate'}}})
  const c={photo:{width:200,height:100},expected:{mode:'physical',coverage:'partial',objects:[{segment:'wooden board',b:[0,0,40,40]}]}}
  let grade=gradeRecognition(JSON.stringify({mode:'physical',objects:[object('board-a',0),object('board-b',80)]}),c)
  assert.equal(grade.machine,'pass');assert.equal(grade.metrics.precision,null);assert.equal(grade.metrics.unjudgedPredictions,1)
  assert.match(grade.limitation,/Partial labels/)
  grade=gradeRecognition(JSON.stringify({mode:'physical',objects:[object('board-b',80)]}),c)
  assert.equal(grade.machine,'fail');assert.equal(grade.metrics.recall,0)
  c.expected.coverage='complete'
  assert.equal(gradeRecognition(JSON.stringify({mode:'physical',objects:[object('board-a',0),object('board-b',80)]}),c).machine,'fail')
})
test('all seed suites prepare offline, contain known bad repairs, and freeze inputs and task schedules', async t => {
  const root = temporary(t)
  for (const stage of ['recognition','repair','revisions']) {
    const out = join(root,stage), result = await prepareStageExperiment(out,{...options,stage})
    assert.equal(result.tasks.length,stage === 'recognition' ? 5 : stage === 'repair' ? 14 : 16)
    assert.equal(result.manifest.callsPerTrial,1); verifyStageExperiment(out)
    assert.ok(writeStageReport(out).groups.every(g => g.passAt1 == null))
    if (stage === 'repair') assert.ok(result.manifest.cases.every(c => read(join(out,'cases',c.id,'case.json')).diagnostics.length))
    const f = join(out,'cases',result.manifest.cases[0].id,'case.json'), original = readFileSync(f)
    writeFileSync(f,'{}'); assert.throws(() => verifyStageExperiment(out),/Frozen inputs/); writeFileSync(f,original)
    const tasks = read(join(out,'tasks.json')); tasks[0].effort='max'; save(join(out,'tasks.json'),tasks)
    assert.throws(() => verifyStageExperiment(out),/task schedule/)
  }
  await assert.rejects(() => stageBenchmarkCLI(['run','--out',root]),/exactly one/)
  await assert.rejects(() => prepareStageExperiment(join(root,'invalid'),{...options,stage:'repair',efforts:['nonsense']}),/supported/)
})
test('recognition uses the production schema over local HTTP; qualified and reviewed results alone enter pass rates', async t => {
  const {out,c} = await single(t,'recognition','wood8-inventory')
  const answer = fixtureProjection({mode:'physical',objects:c.inventory},PERCEPTION_SCHEMA), seen=[]
  const stub=await stubModel({answers:{PhotoPerception:answer},seen}); t.after(stub.close)
  let report=await runStageExperiment(out,{callOptions:{baseURL:stub.url,apiKey:'local-test'}})
  assert.equal(seen.length,1); assert.equal(seen[0].name,'PhotoPerception'); assert.equal(seen[0].effort,'low')
  assert.equal(report.rows[0].grade.machine,'pass'); assert.equal(report.groups[0].scheduled,0)
  saveStageReview(out,{kind:'case',id:c.id,verdict:'pass',reason:'Independently checked instances and boxes.'})
  report=writeStageReport(out); assert.equal(report.groups[0].scheduled,1); assert.equal(report.groups[0].passAt1,null)
  report=saveStageReview(out,{id:report.rows[0].id,verdict:'pass',reason:'All expected visible boards identified.'})
  assert.equal(report.groups[0].passAt1,1); assert.ok(report.groups[0].wilson95); assert.ok(report.groups[0].costPerPass>0)
  await assert.rejects(() => runStageExperiment(out),/already started|task schedule/)
})
test('repair sends the frozen bad plan and diagnostics exactly once, with no planning or perception call', async t => {
  const {out,c}=await single(t,'repair','wood8-unknown-reference'), seen=[]
  const witness=read(join(out,'cases',c.id,'witness.json'))
  const stub=await stubModel({answers:{InstructionPlan:witness},seen});t.after(stub.close)
  const report=await runStageExperiment(out,{browserFactory:fakeBrowser,callOptions:{baseURL:stub.url,apiKey:'local-test'}})
  assert.equal(seen.length,1);assert.equal(seen[0].name,'InstructionPlan')
  assert.match(seen[0].prompt,/missing-benchmark-object/);assert.match(seen[0].prompt,/Diagnostics:/)
  assert.equal(report.rows[0].grade.machine,'pass',JSON.stringify(report.rows[0].grade.errors))
})
test('revisions run the real planner with previous context, frozen inventory and no automatic repair', async t => {
  const {out,c}=await single(t,'revisions','wood8-rename'), answer=structuredClone(c.baseline), seen=[]
  answer.title='wood8 at home'
  const stub=await stubModel({answers:{InstructionPlan:answer},seen});t.after(stub.close)
  const report=await runStageExperiment(out,{browserFactory:fakeBrowser,callOptions:{baseURL:stub.url,apiKey:'local-test'}})
  assert.equal(seen.length,1);assert.equal(seen[0].name,'InstructionPlan');assert.match(seen[0].prompt,/previous generated manual/)
  assert.equal(report.rows[0].grade.machine,'pass',JSON.stringify(report.rows[0].grade.errors))
})
test('provider failures count, unknown costs remain unknown, and human approval cannot override failed gates', async t => {
  const {out,c}=await single(t,'recognition','wood8-inventory')
  saveStageReview(out,{kind:'case',id:c.id,verdict:'pass',reason:'Verified labels.'})
  let calls=0
  let report=await runStageExperiment(out,{caller:async () => {calls++;throw new Error('Provider timeout')}})
  assert.equal(calls,1);assert.equal(report.groups[0].passAt1,0);assert.equal(report.groups[0].unknownCosts,1);assert.equal(report.groups[0].costPerPass,null)
  report=saveStageReview(out,{id:report.rows[0].id,verdict:'pass',reason:'Cannot override automatic failure.'})
  assert.equal(report.rows[0].outcome,'fail');assert.equal(report.groups[0].passAt1,0)
})
test('a repair cannot pass by echoing a faulty plan that deterministic settling would fix', async t => {
  const {out,c}=await single(t,'repair','lego-pile-detached-placement')
  const report=await runStageExperiment(out,{browserFactory:fakeBrowser,caller:async()=>({text:JSON.stringify(c.baseline),cost:null})})
  assert.equal(report.rows[0].grade.machine,'fail')
  assert.ok(report.rows[0].grade.errors.some(e=>e.includes('Raw repair')))
})
test('real revision requests honor later constraints and can correct stale object identity without another perception request', async t => {
  for (const id of ['wood8-constraint-history','wood8-identity-correction']) {
    const {out,c}=await single(t,'revisions',id), answer=structuredClone(c.baseline),seen=[]
    answer.objects=structuredClone(c.inventory)
    if (id.endsWith('history')) answer.title='wood8 at home'
    const stub=await stubModel({answers:{InstructionPlan:answer},seen});t.after(stub.close)
    const report=await runStageExperiment(out,{browserFactory:fakeBrowser,callOptions:{baseURL:stub.url,apiKey:'local-test'}})
    assert.equal(seen.length,1)
    assert.equal(report.rows[0].grade.machine,'pass',JSON.stringify(report.rows[0].grade.errors))
    if (id.endsWith('history')) assert.match(seen[0].prompt,/Weekend project/)
    else assert.match(seen[0].prompt,/incorrect previous identification/)
  }
})
test('browser infrastructure failures stop before spending and persist interrupted progress', async t => {
  const {out}=await single(t,'repair','wood8-unknown-reference')
  let calls=0
  await assert.rejects(()=>runStageExperiment(out,{browserFactory:async()=>{throw new Error('Chrome unavailable')},caller:async()=>{calls++}}),/Chrome unavailable/)
  assert.equal(calls,0);assert.equal(read(join(out,'manifest.json')).execution,null)
  const broken=async()=>({smoke:async()=>{const e=new Error('Browser disconnected');e.code='BENCH_BROWSER';throw e},close:async()=>{}})
  const witness=read(join(out,'cases/wood8-unknown-reference/witness.json'))
  await assert.rejects(()=>runStageExperiment(out,{browserFactory:broken,caller:async()=>{calls++;return{text:JSON.stringify(witness)}}}),/playback unavailable/)
  assert.equal(calls,1);assert.equal(read(join(out,'results.json')).length,1)
  await assert.rejects(()=>runStageExperiment(out),/already started|task schedule/)
})
test('mock results never become model success rates; local review page hides labels and protects writes', async t => {
  const {out}=await single(t,'recognition','wood8-inventory')
  let report=await runStageExperiment(out,{mock:true})
  saveStageReview(out,{kind:'case',id:report.cases[0].id,verdict:'pass',reason:'Checked labels.'})
  report=saveStageReview(out,{id:report.rows[0].id,verdict:'pass',reason:'Checked mock.'})
  assert.equal(report.mode,'mock');assert.equal(report.groups[0].passAt1,null)
  const service=await serveStageReport(out);t.after(service.close)
  const blind=await fetch(service.url+'/api/report').then(r=>r.json())
  assert.equal(blind.groups.length,0);assert.equal(blind.rows[0].model,undefined);assert.equal(blind.rows[0].cost,undefined)
  assert.equal((await fetch(service.url+'/api/review',{method:'POST',body:'{}'})).status,403)
  const saved=await fetch(service.url+'/api/review',{method:'POST',headers:{'X-Bench-Token':blind.token},body:JSON.stringify({id:blind.rows[0].id,verdict:'fail',reason:'Review changed.'})})
  assert.equal(saved.status,200);assert.equal(read(join(out,'reviews.json')).attempts[blind.rows[0].id].verdict,'fail')
  assert.equal((await fetch(service.url+'/photo/not-a-case.png')).status,404)
  const browser=await openDrawingBrowser(service.url,undefined,{renderModule:null});t.after(browser.close)
  await browser.evaluate(`new Promise(resolve=>{const n=document.getElementById('attempt');if(n.options.length)return resolve(true);const o=new MutationObserver(()=>{if(n.options.length){o.disconnect();resolve(true)}});o.observe(n,{childList:true})})`)
  assert.match(await browser.evaluate(`document.getElementById('meta').textContent`),/hidden/)
  await browser.viewport(390,844)
  assert.equal(await browser.evaluate(`document.documentElement.scrollWidth<=innerWidth`),true)
})
