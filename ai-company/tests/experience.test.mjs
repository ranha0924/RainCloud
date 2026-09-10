import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store, uid, now } from '../server/store.mjs';
import { Runner } from '../server/scheduler.mjs';
import { QueueGateway, policyOf } from '../server/operations.mjs';
import { syncExperiences, addFeedback, suggestGuideline, editGuideline, reviewGuideline, shareGuideline, retrieveExperience, career, recordApplication, assertSelectionPermission, hash } from '../server/experience.mjs';
import { freezeEvaluation, startEvaluation, compareSummary, catalog, trialToolHandler } from '../server/evaluation.mjs';
import { benchmarkCases, practiceCase, publicCase, verifyFixtures, judge } from '../server/qa-fixtures.mjs';
import { createApp } from '../server/app.mjs';

async function fixture(options={}){
  const dir=await mkdtemp(path.join(os.tmpdir(),'rain-experience-test-')),store=new Store(path.join(dir,'data'));
  const person=store.put('employee','company',{...store.list('candidate','company').find(c=>c.role==='qa'),id:uid(),instructions:'基本 QA'});
  const p=store.put('project','company',{id:uid(),name:'Test A',model:'fixture-model',repository:'',assignments:[{employeeId:person.id,permission:'read'}],maxRuns:100,tokenBudget:1000000,operation:{...policyOf({}),turnMinutes:1},operationEnabled:false});
  const other=store.put('project','company',{...p,id:uid(),name:'Test B'});const calls=[];
  const client={start:async()=>{},close(){},request:async()=>({thread:{turns:[]}}),run:async o=>{
    calls.push(o);o.onThread(uid());const turnId=uid();o.onEvent({method:'turn/started',params:{turn:{id:turnId}}});
    if(options.run)return options.run(o);
    await o.dynamicHandler({tool:'qa_read',arguments:{file:'subject.mjs'}});await o.dynamicHandler({tool:'qa_read',arguments:{file:'CONTRACT.md'}});await o.dynamicHandler({tool:'qa_execute',arguments:{input:{authenticated:true,now:1000,expires:1000}}});
    const source=await readFile(path.join(o.cwd,'subject.mjs'),'utf8');
    const findings=source.includes('<=')?[{title:'boundary one',input:{authenticated:true,now:1000,expires:1000},expected:false,reproduction:'authorize at expiration'}]:[];
    return {text:JSON.stringify({summary:'fixture only',findings,experienceApplications:[],experienceConflicts:[]}),turnId,usage:{total:{totalTokens:10},last:{totalTokens:10}}};
  }};
  const runner=new Runner(store,{clientFactory:()=>client}),gateway=new QueueGateway(store);
  return {store,p,other,person,runner,gateway,calls,dir};
}
async function drain(f,id){for(let n=0;n<1000;n++){await f.runner.tick();await new Promise(r=>setTimeout(r,5));const e=f.store.require('evaluation',f.p.id,id);if(['completed','failed','paused'].includes(e.status)&&!f.runner.executions.size)return e;}throw new Error('queue timeout');}
function seed(f){
  const run=f.store.put('run',f.p.id,{id:uid(),employeeId:f.person.id,purpose:'practice',evaluationId:'practice',experienceTitle:'session expiry',goal:'login session expiry 경계',stage:'qa',model:'fixture-model',instructionVersion:'v1',status:'completed',result:'self report only',createdAt:now(),finishedAt:now(),independentVerification:{exitCode:0,confirmed:true,output:'expiry boundary independently reproduced'},cwd:f.dir});
  syncExperiences(f.store,f.p.id);const e=f.store.require('experience',f.p.id,'run:'+run.id);
  const feedback=addFeedback(f.store,f.p.id,e.id,{text:'expires 경계 회귀 검증',problem:'경계 누락',correction:'동일 시각 거절 검증',applyWhen:'session expiry',doNotApply:'경계 포함 정책은 별도 계약 확인'},'test-fixture');
  const guide=suggestGuideline(f.store,f.p.id,e.id,feedback.id);
  const body={situation:'session expiry',problem:'missed boundary',change:'customer-secret sk-protected-private-code',outcome:'reproduced',applyWhen:'session login auth expiry',doNotApply:'other explicit contract',tags:['expiry','session','qa'],checkCodes:['expiry']};
  editGuideline(f.store,f.p.id,guide.id,body);reviewGuideline(f.store,f.p.id,guide.id,{version:2,status:'verified',active:true},'test-fixture');return {run,e,guide,body};
}
test('experience separates self report, verification, feedback, revisions, and career purpose',async()=>{
  const f=await fixture(),s=seed(f);let c=career(f.store,f.p.id,f.person.id);assert.equal(c.groups.work.runs,0);assert.equal(c.groups.practice.runs,1);assert.equal(c.groups.evaluation.runs,0);assert.equal(c.experiences[0].model,'fixture-model');
  f.store.patch('run',f.p.id,s.run.id,{status:'failed',error:'revision failed'});syncExperiences(f.store,f.p.id);assert.equal(f.store.require('experience',f.p.id,s.e.id).revisions.length,2);assert.equal(f.store.require('experience',f.p.id,s.e.id).selfReport,'self report only');
  const r=f.store.put('run',f.p.id,{...s.run,id:uid(),independentVerification:null});syncExperiences(f.store,f.p.id);const fb=addFeedback(f.store,f.p.id,'run:'+r.id,{text:'looks good'});const g=suggestGuideline(f.store,f.p.id,'run:'+r.id,fb.id);assert.throws(()=>reviewGuideline(f.store,f.p.id,g.id,{version:1,status:'verified',active:true}),/자기 보고/);f.store.close();
});
test('private experience cannot cross projects; reviewed release has no source code or document text',async()=>{
  const f=await fixture(),s=seed(f);f.store.put('memory',f.p.id,{id:'private',text:'SECRET ORACLE'});
  assert.equal(retrieveExperience(f.store,f.other.id,f.person.id,'session expiry').guidelines.length,0);
  assert.throws(()=>shareGuideline(f.store,f.p.id,s.guide.id,{version:2,targetProjectIds:[f.other.id],checkCodes:['expiry'],rightsConfirmed:false}));
  const release=shareGuideline(f.store,f.p.id,s.guide.id,{version:2,targetProjectIds:[f.other.id],checkCodes:['expiry'],rightsConfirmed:true});
  const found=retrieveExperience(f.store,f.other.id,f.person.id,'session expiry');assert.equal(found.guidelines.length,1);assert.equal(found.experiences.length,0);assert.ok(!JSON.stringify(found).includes('customer-secret'));assert.ok(!JSON.stringify(found).includes(s.e.id));assert.ok(!JSON.stringify(release).includes('private-code'));assertSelectionPermission(f.store,f.other.id,found);f.store.patch('guidelineRelease',f.p.id,release.id,{active:false});assert.throws(()=>assertSelectionPermission(f.store,f.other.id,found),/공유 허가/);
  editGuideline(f.store,f.p.id,s.guide.id,{...s.body,change:'new version'});assert.equal(retrieveExperience(f.store,f.other.id,f.person.id,'session expiry').guidelines.length,0);assert.equal(f.store.require('guideline',f.p.id,s.guide.id).versions[1].change,s.body.change);assert.throws(()=>retrieveExperience(f.store,f.other.id,'not-assigned','qa'));f.store.close();
});
test('conflicting selected instruction is recorded and local activation is suspended',async()=>{
  const f=await fixture(),s=seed(f),selection=retrieveExperience(f.store,f.p.id,f.person.id,'qa expiry');recordApplication(f.store,f.p.id,s.run.id,selection,{experienceApplications:[{id:s.guide.id,how:'boundary input'}],experienceConflicts:[{id:s.guide.id,reason:'new contract allows equality'},{id:'forged',reason:'bad'}]});assert.equal(f.store.list('memoryReview',f.p.id).length,1);assert.equal(retrieveExperience(f.store,f.p.id,f.person.id,'qa expiry').guidelines.length,0);f.store.close();
});
test('12 held-out tasks include normal and transfer cases; oracle deduplicates paraphrases and rejects wrong allegations',()=>{
  assert.equal(benchmarkCases.length,12);assert.ok(!benchmarkCases.some(c=>c.id===practiceCase.id||c.source===practiceCase.source));assert.equal(verifyFixtures().filter(c=>!c.knownDefect).length,4);assert.equal(benchmarkCases.filter(c=>c.domain.includes('전이')).length,6);
  const c=benchmarkCases[0],finding={title:'x',input:c.witness,expected:false,reproduction:'call at boundary'};const m=judge(c,{findings:[finding,{...finding,title:'different phrase'},{...finding,input:{authenticated:false,expires:0,now:100},expected:true}]});assert.equal(m.found,1);assert.equal(m.missed,0);assert.equal(m.falsePositives,1);assert.equal(m.reviewMinutes,null);assert.ok(!JSON.stringify(catalog()).includes('witness'));assert.ok(!JSON.stringify(publicCase(c)).includes('oracle'));
});
test('A/B/C freeze identical model snapshots tools limits; isolated transcripts; later knowledge cannot leak',async()=>{
  const f=await fixture(),s=seed(f);const e=await freezeEvaluation(f.store,f.gateway,f.p.id,{employeeId:f.person.id,caseIds:['auth-01','auth-02'],model:'fixture-model',tokenLimit:1000,turnSeconds:30});
  const before=e.frozenHash;f.store.put('memory',f.p.id,{id:'leak',text:'HIDDEN-ANSWER'});editGuideline(f.store,f.p.id,s.guide.id,{...s.body,change:'FUTURE-CONTAMINATION'});
  startEvaluation(f.store,f.gateway,f.p.id,e.id);const done=await drain(f,e.id);assert.equal(done.status,'completed',done.reason);assert.equal(f.calls.length,6);assert.equal(hash(done.frozen),before);assert.equal(new Set(f.calls.map(c=>c.cwd)).size,6);
  for(const c of f.calls){assert.equal(c.model,'fixture-model');assert.equal(c.writable,false);assert.equal(c.network,false);assert.equal(c.threadId,undefined);assert.equal(c.timeoutMs,30000);assert.ok(!c.instructions.includes('HIDDEN-ANSWER'));assert.ok(!c.instructions.includes('FUTURE-CONTAMINATION'));}
  for(const t of done.trials){const call=f.calls.find(c=>c.cwd===t.cwd);assert.equal(call.instructions.includes('customer-secret'),t.condition==='C');assert.equal(call.instructions.includes('확정 체크리스트'),t.condition!=='A');assert.equal(hash([await readFile(path.join(t.cwd,'subject.mjs'),'utf8'),await readFile(path.join(t.cwd,'CONTRACT.md'),'utf8')]),t.snapshotHash);}
  const summary=compareSummary(done);assert.equal(summary.sampleSize,2);for(const c of Object.values(summary.conditions)){assert.equal(c.found,1);assert.equal(c.falsePositives,0);assert.equal(c.reviewMinutes,null);}
  assert.throws(()=>startEvaluation(f.store,f.gateway,f.p.id,e.id),/종료/);assert.equal(career(f.store,f.p.id,f.person.id).groups.evaluation.runs,6);f.store.close();
});
test('evaluation cancellation, company stop and token caps govern actual dispatch without budget reset',async()=>{
  const f=await fixture({run:async o=>new Promise((resolve,reject)=>{o.signal.addEventListener('abort',()=>reject(new Error('stopped')),{once:true});o.onEvent({method:'thread/tokenUsage/updated',params:{tokenUsage:{total:{totalTokens:1100},last:{totalTokens:1100}}}});})});
  const e=await freezeEvaluation(f.store,f.gateway,f.p.id,{employeeId:f.person.id,caseIds:['auth-01'],model:'fixture-model',tokenLimit:1000,turnSeconds:30});startEvaluation(f.store,f.gateway,f.p.id,e.id);const done=await drain(f,e.id);assert.equal(done.status,'paused');assert.equal(f.calls.length,1);assert.equal(f.runner.usage(f.p.id).tokens,1100);assert.throws(()=>startEvaluation(f.store,f.gateway,f.p.id,e.id),/소진/);f.store.close();
});
test('HTTP feedback and evaluation routes enforce scope and leave human measurements unset',async()=>{
  const f=await fixture(),s=seed(f);const server=createApp(f.store,f.gateway).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url=`http://127.0.0.1:${server.address().port}`;const session=await fetch(url+'/api/session'),cookie=session.headers.get('set-cookie').split(';')[0];
  const req=(route,body)=>fetch(url+'/api'+route,{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const cross=await req(`/scopes/${f.other.id}/experience/${encodeURIComponent(s.e.id)}/feedback`,{text:'cross'});assert.equal(cross.status,409);
  const response=await req(`/scopes/${f.p.id}/experience/${encodeURIComponent(s.e.id)}/feedback`,{text:'verified feedback'});assert.equal(response.status,201);assert.equal((await response.json()).reviewMinutes,null);
  await new Promise(r=>server.close(r));f.store.close();
});
test('QA tools expose only frozen public inputs, never another project, oracle, arbitrary path or command',async()=>{
  const handler=trialToolHandler(publicCase(benchmarkCases[0]));
  for(const request of [{tool:'qa_read',arguments:{file:'../answer.json'}},{tool:'qa_read',arguments:{file:'subject.mjs',projectId:'another'}},{tool:'qa_execute',arguments:{input:{authenticated:true},caseId:'auth-09'}},{tool:'shell',arguments:{command:'read secrets'}}])await assert.rejects(()=>handler(request));
  const result=await handler({tool:'qa_execute',arguments:{input:{authenticated:true,now:1000,expires:1000}}});assert.deepEqual(result,{input:{authenticated:true,now:1000,expires:1000},actual:true});assert.ok(!JSON.stringify(result).includes('oracle'));
});
test('a model report without actual read and execution evidence is a failed evaluation, never a score',async()=>{
  const f=await fixture({run:async()=>({text:JSON.stringify({summary:'tools unavailable',findings:[],experienceApplications:[],experienceConflicts:[]}),usage:{total:{totalTokens:10}}})});
  const e=await freezeEvaluation(f.store,f.gateway,f.p.id,{employeeId:f.person.id,caseIds:['auth-02'],model:'fixture-model',tokenLimit:1000,turnSeconds:30});startEvaluation(f.store,f.gateway,f.p.id,e.id);const done=await drain(f,e.id);assert.equal(done.status,'failed');assert.equal(done.trials[0].metrics,undefined);assert.equal(compareSummary(done).conditions.A.evaluated,0);assert.equal(f.calls.length,1);f.store.close();
});
test('evaluation recovery reuses a completed response and tool evidence without repeating that model turn',async()=>{
  const f=await fixture(),e=await freezeEvaluation(f.store,f.gateway,f.p.id,{employeeId:f.person.id,caseIds:['auth-01'],model:'fixture-model',tokenLimit:1000,turnSeconds:30});
  startEvaluation(f.store,f.gateway,f.p.id,e.id);const t=e.trials[0],run=f.store.put('run',f.p.id,{id:uid(),evaluationId:e.id,trialId:t.id,employeeId:f.person.id,purpose:'evaluation',status:'completed',result:JSON.stringify({summary:'saved',findings:[{title:'boundary',input:{authenticated:true,now:1,expires:1},expected:false,reproduction:'at expiry'}],experienceApplications:[],experienceConflicts:[]}),createdAt:now(),finishedAt:now(),accountedTokens:10});
  f.store.patch('evaluation',f.p.id,e.id,{status:'running',trials:e.trials.map(x=>x.id===t.id?{...x,status:'running',runId:run.id}:x)});f.store.patch('job',f.p.id,`evaluation:${e.id}`,{status:'running'});
  for(const event of [{tool:'qa_read',arguments:{file:'subject.mjs'}},{tool:'qa_read',arguments:{file:'CONTRACT.md'}},{tool:'qa_execute',arguments:{input:{}}}])f.store.event(f.p.id,run.id,{method:'company/evaluationTool',params:event});
  await f.runner.recover();const done=await drain(f,e.id);assert.equal(done.status,'completed');assert.equal(f.calls.length,2);assert.equal(done.trials[0].runId,run.id);assert.equal(done.trials[0].metrics.found,1);f.store.close();
});

test('verified real work without an evaluation ID is retrieved locally and never shared as a raw experience',async()=>{
  const f=await fixture(),s=seed(f);
  f.store.put('experience',f.p.id,{...f.store.require('experience',f.p.id,s.e.id),purpose:'work',evaluationId:undefined,taskId:'real-work'});
  const selected=retrieveExperience(f.store,f.p.id,f.person.id,'session expiry');
  assert.deepEqual(selected.experiences.map(e=>e.id),[s.e.id]);
  assert.equal(selected.experiences[0].purpose,'work');
  f.store.patch('experience',f.p.id,s.e.id,{evaluationId:'excluded'});
  assert.equal(retrieveExperience(f.store,f.p.id,f.person.id,'session expiry',{excludeEvaluationId:'excluded'}).experiences.length,0);
  shareGuideline(f.store,f.p.id,s.guide.id,{version:2,targetProjectIds:[f.other.id],checkCodes:['expiry'],rightsConfirmed:true});
  assert.equal(retrieveExperience(f.store,f.other.id,f.person.id,'session expiry').experiences.length,0);
  assert.throws(()=>retrieveExperience(f.store,f.other.id,'unassigned','session expiry'));
  f.store.close();
});

test('fixed evaluation topic prevents unrelated expiry guidance leaking into role tasks through generic auth terms',async()=>{
  const f=await fixture();seed(f);
  const e=await freezeEvaluation(f.store,f.gateway,f.p.id,{employeeId:f.person.id,caseIds:['auth-01','auth-04'],model:'fixture-model',tokenLimit:1000,turnSeconds:30});
  assert.equal(e.frozen.selections['auth-01'].guidelines.length,1);
  assert.equal(e.frozen.selections['auth-04'].guidelines.length,0);
  assert.equal(e.frozen.selections['auth-04'].experiences.length,0);
  f.store.close();
});
test('multiple evaluation jobs share the project queue without task IDs or mixed workspaces',async()=>{
  const f=await fixture();f.store.patch('project','company',f.p.id,{operation:{...policyOf(f.p),maxConcurrent:2}});
  const first=await freezeEvaluation(f.store,f.gateway,f.p.id,{employeeId:f.person.id,caseIds:['auth-01'],model:'fixture-model',tokenLimit:1000,turnSeconds:30});
  const second=await freezeEvaluation(f.store,f.gateway,f.p.id,{employeeId:f.person.id,caseIds:['auth-02'],model:'fixture-model',tokenLimit:1000,turnSeconds:30});
  startEvaluation(f.store,f.gateway,f.p.id,first.id);startEvaluation(f.store,f.gateway,f.p.id,second.id);
  assert.equal((await drain(f,first.id)).status,'completed');assert.equal((await drain(f,second.id)).status,'completed');assert.equal(f.calls.length,6);assert.equal(new Set(f.calls.map(c=>c.cwd)).size,6);f.store.close();
});
