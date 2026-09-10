import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { z } from 'zod';
import { uid, now } from './store.mjs';
import { hash, retrieveExperience, recordApplication, syncExperiences, assertSelectionPermission } from './experience.mjs';
import { benchmarkCases, practiceCase, checklist, fixtureVersion, publicCase, verifyFixtures, judge, actual } from './qa-fixtures.mjs';
import { enqueue } from './operations.mjs';

const shape={type:'object',additionalProperties:false};
const str={type:'string'};
const object = properties => ({...shape, properties, required: Object.keys(properties)});
const nullable = type => ({type:[type,'null']});
export const qaSchema=object({
  summary:str,
  findings:{type:'array',items:object({title:str,input:object({
    authenticated:nullable('boolean'),revoked:nullable('boolean'),now:nullable('integer'),expires:nullable('integer'),
    role:nullable('string'),tenant:nullable('string'),resourceTenant:nullable('string'),audience:nullable('string'),service:nullable('string'),
  }),expected:{type:'boolean'},reproduction:str})},
  experienceApplications:{type:'array',items:object({id:str,how:str})},
  experienceConflicts:{type:'array',items:object({id:str,reason:str})},
});
const inputSchema=z.object({authenticated:z.boolean().nullable().optional(),revoked:z.boolean().nullable().optional(),now:z.number().int().nullable().optional(),expires:z.number().int().nullable().optional(),role:z.enum(['viewer','admin','guest']).nullable().optional(),tenant:z.string().max(80).nullable().optional(),resourceTenant:z.string().max(80).nullable().optional(),audience:z.string().max(80).nullable().optional(),service:z.string().max(80).nullable().optional()}).strict();
const reportSchema=z.object({summary:z.string().max(8000),findings:z.array(z.object({title:z.string().max(1000),input:inputSchema,expected:z.boolean(),reproduction:z.string().max(4000)}).strict()).max(30),experienceApplications:z.array(z.object({id:z.string(),how:z.string().max(2000)})).max(10).default([]),experienceConflicts:z.array(z.object({id:z.string(),reason:z.string().max(2000)})).max(10).default([])}).strict();
export const trialTools=[
  {type:'function',name:'qa_read',description:'현재 과제의 고정 코드 또는 공개 계약을 읽습니다. 두 파일 외의 경로는 허용하지 않습니다.',inputSchema:object({file:{type:'string',enum:['subject.mjs','CONTRACT.md']}})},
  {type:'function',name:'qa_execute',description:'현재 과제의 authorize(input)를 실행하고 실제 반환값만 받습니다. 정답이나 점수는 제공하지 않습니다. null 필드는 생략됩니다.',inputSchema:object({input:qaSchema.properties.findings.items.properties.input})},
];
export function trialToolHandler(c,onTool=()=>{}){
  let calls=0;
  return async ({tool,arguments:args})=>{
    if(++calls>20)throw new Error('과제당 도구 호출 한도 20회 도달');
    let result;
    if(tool==='qa_read'){const {file}=z.object({file:z.enum(['subject.mjs','CONTRACT.md'])}).strict().parse(args);result=file==='subject.mjs'?c.source:c.requirement;}
    else if(tool==='qa_execute'){const {input}=z.object({input:inputSchema}).strict().parse(args);const clean=Object.fromEntries(Object.entries(input).filter(([,v])=>v!==null));result={input:clean,actual:actual(c,clean)};}
    else throw new Error('현재 평가에 허용되지 않은 도구입니다.');
    onTool({tool,arguments:args,result,time:now()});return result;
  };
}
export const evaluationBody=z.object({employeeId:z.string(),caseIds:z.array(z.string()).min(1).max(20),tokenLimit:z.number().int().min(1000).max(500000).default(120000),turnSeconds:z.number().int().min(10).max(300).default(60),model:z.string().min(1).max(100),checklist:z.array(z.string().min(1).max(1000)).min(1).max(30).optional(),label:z.string().min(1).max(100).default('QA 비교 평가')}).strict();

export function catalog(){return {version:fixtureVersion,checklist,cases:benchmarkCases.map(({id,domain,topic})=>({id,domain,topic})),criteria:'실제 authorize 반환값과 고정 계약 oracle 비교. 같은 사례의 동일 계약 결함은 한 번만 집계. 인간 검수 시간은 직접 입력. 정답은 Agent에게 제공하지 않습니다.'};}
function fail(status,message){return Object.assign(new Error(message),{evaluationStatus:status});}
export function evaluationUsage(store,scope,id){const runs=store.list('run',scope).filter(r=>r.evaluationId===id);return {calls:runs.length,tokens:runs.reduce((n,r)=>n+(r.accountedTokens||0),0),unknown:runs.filter(r=>!r.usage).length,cost:null};}
export async function freezeEvaluation(store,runtime,scope,input,{purpose='evaluation',caseOverride,actor='ceo'}={}){
  const body=evaluationBody.parse(input),p=store.require('project','company',scope),employee=runtime.employee(scope,body.employeeId);
  if(employee.role!=='qa')throw new Error('QA 직원을 선택하세요.');
  if(p.model&&p.model!==body.model)throw new Error('프로젝트에 설정된 모델을 선택하세요.');
  const sourceCases=caseOverride||benchmarkCases;
  const cases=[...new Set(body.caseIds)].map(id=>{const c=sourceCases.find(c=>c.id===id);if(!c)throw new Error('등록된 평가 과제를 선택하세요.');return publicCase(c);});
  verifyFixtures();syncExperiences(store,scope);
  const base=runtime.instructions(scope,employee,{includeMemory:false});
  // Freeze before any variant runs: no project memories, later feedback or answers are read by a trial.
  const selections=Object.fromEntries(cases.map(c=>[c.id,retrieveExperience(store,scope,employee.id,`${c.topic} ${c.requirement}`,{topics:[c.topic]})]));
  const frozen={retrievalVersion:'case-topic-1',batchToolAdvice:true,protocolVersion:'qa-tools-2',toolVersion:hash(trialTools),model:body.model,baseInstructions:base,instructionVersion:hash(base),employeeSnapshot:employee,checklist:{version:body.checklist?'custom-'+hash(body.checklist).slice(0,12):checklist.version,items:body.checklist||checklist.items},selections,cases,fixtureVersion,permissions:'qa_read (2 frozen files) + qa_execute (fixed function), 20 tools/trial; shell/network/MCP/browser disabled',turnSeconds:body.turnSeconds,tokenLimit:body.tokenLimit,maxCalls:cases.length*(purpose==='practice'?1:3),perTrialCalls:1,answerHash:hash(sourceCases.filter(c=>cases.some(x=>x.id===c.id)).map(c=>({id:c.id,oracle:String(c.oracle),witness:c.witness}))),createdAt:now()};
  const id=uid();const workspaceBase=path.join(store.dir,'evaluation-workspaces');await mkdir(workspaceBase,{recursive:true});const workspaceRoot=await mkdtemp(path.join(workspaceBase,'experiment-'));
  const trials=[];
  for(let n=0;n<cases.length;n++){
    // Counterbalanced order, committed before execution. A/B/C labels never enter prompts.
    const order=purpose==='practice'?['A']:[['A','B','C'],['B','C','A'],['C','A','B']][n%3];
    for(const condition of order){const c=cases[n];const trialId=uid(),cwd=path.join(workspaceRoot,trialId);await mkdir(cwd);await writeFile(path.join(cwd,'subject.mjs'),c.source);await writeFile(path.join(cwd,'CONTRACT.md'),c.requirement);trials.push({id:trialId,caseId:c.id,condition,cwd,status:'queued',snapshotHash:c.snapshotHash});}
  }
  return store.put('evaluation',scope,{id,projectId:scope,employeeId:employee.id,label:body.label,purpose,status:'frozen',frozen,frozenHash:hash(frozen),workspaceRoot,trials,createdAt:now(),createdBy:actor,humanMeasurements:[],summary:null});
}
export function startEvaluation(store,runtime,scope,id){
  const e=store.require('evaluation',scope,id);runtime.employee(scope,e.employeeId);runtime.budget(scope);
  if(['completed','cancelled'].includes(e.status))throw new Error('종료된 평가는 재실행하지 않습니다. 새 실험을 만드세요.');
  const p=store.require('project','company',scope);if(p.paused)throw new Error('프로젝트가 일시정지되어 있습니다.');
  const u=evaluationUsage(store,scope,id);if(u.tokens>=e.frozen.tokenLimit||u.calls>=e.frozen.maxCalls)throw new Error('이 평가의 고정 실행 한도를 소진했습니다.');
  store.patch('evaluation',scope,id,{status:'queued',reason:'대표가 고정 조건 확인 후 실행 요청'});
  enqueue(store,scope,{id:`evaluation:${id}`,kind:'evaluation',evaluationId:id});return store.require('evaluation',scope,id);
}
export function compareSummary(e){
  const conditions={};for(const condition of ['A','B','C']){
    const trials=e.trials.filter(t=>t.condition===condition),done=trials.filter(t=>t.status==='completed'&&t.metrics);
    const measured=e.humanMeasurements||[];
    conditions[condition]={assigned:trials.length,evaluated:done.length,failed:trials.filter(t=>t.status==='failed').length,found:done.reduce((n,t)=>n+t.metrics.found,0),missed:done.reduce((n,t)=>n+t.metrics.missed,0),falsePositives:done.reduce((n,t)=>n+t.metrics.falsePositives,0),reported:done.reduce((n,t)=>n+t.metrics.reported,0),reproduced:done.reduce((n,t)=>n+t.metrics.reproduced,0),elapsedMs:trials.reduce((n,t)=>n+(t.elapsedMs||0),0),tokens:trials.reduce((n,t)=>n+(t.tokens||0),0),unknownUsage:trials.filter(t=>t.status!=='queued'&&t.tokens==null).length,cost:null,humanMeasured:done.filter(t=>measured.some(m=>m.trialId===t.id)).length,reviewMinutes:done.some(t=>measured.some(m=>m.trialId===t.id&&m.reviewMinutes!==null))?done.reduce((n,t)=>n+(measured.filter(m=>m.trialId===t.id).at(-1)?.reviewMinutes||0),0):null,transferCases:done.filter(t=>e.frozen.cases.find(c=>c.id===t.caseId)?.domain.includes('전이')).map(t=>t.id)};
  }
  const matched=e.frozen.cases.filter(c=>['A','B','C'].every(condition=>e.trials.some(t=>t.caseId===c.id&&t.condition===condition&&t.status==='completed'))).map(c=>c.id);
  return {conditions,matchedCases:matched,sampleSize:matched.length,conclusion:matched.length?'측정된 과제 범위의 관찰 결과입니다. 성능 우위를 자동 판정하지 않습니다.':'A/B/C가 모두 완료된 과제가 없어 비교 불가',model:e.frozen.model,instructionVersion:e.frozen.instructionVersion,checklistVersion:e.frozen.checklist.version,frozenHash:e.frozenHash,date:e.finishedAt||e.createdAt};
}

export class EvaluationRunner{
  constructor(runner){this.runner=runner;this.store=runner.store;}
  control(scope,id){const e=this.store.require('evaluation',scope,id),u=evaluationUsage(this.store,scope,id);if(['paused','cancelled'].includes(e.status))return e.reason||e.status;if(u.tokens>=e.frozen.tokenLimit)return '평가 토큰 한도 도달';return '';}
  async step(scope,job,signal){
    let e=this.store.require('evaluation',scope,job.evaluationId);const reason=this.control(scope,e.id);if(reason)throw fail('paused',reason);
    if(e.frozen.protocolVersion!=='qa-tools-2'||e.frozen.toolVersion!==hash(trialTools))throw fail('failed','고정 평가 도구 버전이 다릅니다. 이전 버전을 복원하거나 새 실험을 만드세요.');
    if(hash(e.frozen)!==e.frozenHash)throw fail('failed','평가 고정 조건 해시 불일치');
    this.runner.employee(scope,e.employeeId);
    const trial=e.trials.find(t=>['queued','running','interrupted'].includes(t.status));if(!trial){this.store.patch('evaluation',scope,e.id,{status:'completed',summary:compareSummary(e),finishedAt:now()});return;}
    const patch=value=>{e=this.store.require('evaluation',scope,e.id);this.store.patch('evaluation',scope,e.id,{trials:e.trials.map(t=>t.id===trial.id?{...t,...value}:t)});};
    const c=e.frozen.cases.find(c=>c.id===trial.caseId);
    const diskSource=await readFile(path.join(trial.cwd,'subject.mjs'),'utf8'),diskContract=await readFile(path.join(trial.cwd,'CONTRACT.md'),'utf8');
    if(hash([diskSource,diskContract])!==trial.snapshotHash)throw fail('failed','평가 스냅샷이 변경되었습니다.');
    const selection=trial.condition==='C'?e.frozen.selections[c.id]:{guidelines:[],experiences:[],summary:'경험 미제공'};
    if(trial.condition==='C')assertSelectionPermission(this.store,scope,selection);
    const instructions=e.frozen.baseInstructions+'\n고정 QA 평가입니다. 현재 폴더의 두 파일만 검토하세요. 다른 대화·경험·결과·정답을 찾지 마세요. 결함에는 실제 입력과 재현 절차를 포함하세요. 입력의 null 필드는 생략된 값으로 처리됩니다. 코드 수정·외부 도구·추가 에이전트는 금지합니다.'+(trial.condition!=='A'?'\n확정 체크리스트:\n'+e.frozen.checklist.items.join('\n'):'')+(trial.condition==='C'?'\n선택된 검증 경험과 지침:\n'+JSON.stringify(selection):'');
    let response,run;
    if(trial.runId){run=this.store.require('run',scope,trial.runId);if(run.recoveryPending)response=await this.runner.workflow.recoverResponse({id:scope},{},'',{runId:run.id});else if(run.status==='completed')response={runId:run.id,text:run.result};
      if(!response){patch({status:'failed',error:'중단된 평가 턴. 동일 실험에서 재호출하지 않음'});return;}}
    if(!response){
      if(evaluationUsage(this.store,scope,e.id).calls>=e.frozen.maxCalls)throw fail('paused','평가 모델 호출 한도 도달');
      patch({status:'running',startedAt:now()});this.store.patch('evaluation',scope,e.id,{status:'running'});
      try{response=await this.runner.executeAgent({scope,person:e.frozen.employeeSnapshot,cwd:trial.cwd,stage:'qa-evaluation',conversationId:`evaluation-${trial.id}`,signal,writable:false,outputSchema:qaSchema,timeoutMs:e.frozen.turnSeconds*1000,
        context:{model:e.frozen.model,instructions,purpose:e.purpose,evaluationId:e.id,trialId:trial.id,title:`${c.id} · ${trial.condition}`,goal:c.requirement,acceptance:['계약 위반만 재현 가능한 입력으로 보고','정상 사례는 findings=[]'],isolation:{toolOnly:true},dynamicTools:trialTools,dynamicHandler:trialToolHandler(c,event=>{const current=this.store.require('evaluation',scope,e.id).trials.find(x=>x.id===trial.id);this.store.event(scope,current.runId,{method:'company/evaluationTool',params:event});})},
        onRun:runId=>{patch({runId});if(trial.condition==='C')recordApplication(this.store,scope,runId,selection,null);},onThread:threadId=>patch({threadId}),onUsage:()=>{const reason=this.control(scope,e.id);if(reason){const active=this.runner.executions.get(job.id);active?.controller.abort(reason);}},
        prompt:`${e.frozen.batchToolAdvice?'독립적인 읽기와 테스트 입력은 가능한 한 하나의 코드 도구 블록에 묶어 처리하세요. 결과 확보 후 짧은 최종 JSON으로 종료하세요.':''} qa_read 도구로 subject.mjs와 CONTRACT.md를 읽고 공개 계약에 대한 QA를 수행하세요. qa_execute로 의심되는 입력을 실제 실행하세요. 일반 셸과 파일 탐색은 제공되지 않습니다. 최대 20회 도구 호출이 가능합니다. 각 사례는 독립적이며 결함이 없을 수도 있습니다. findings 입력의 쓰지 않는 필드는 null로 채우세요. ${trial.condition==='C'?'experienceApplications에 선택한 지침 id와 실제 활용 방법을, 충돌하면 experienceConflicts에 이유를 기록하세요.':'experienceApplications와 experienceConflicts는 빈 배열입니다.'}`});}
      catch(error){const latest=this.store.require('evaluation',scope,e.id).trials.find(t=>t.id===trial.id);run=latest.runId?this.store.get('run',scope,latest.runId):null;patch({status:signal.aborted?'interrupted':'failed',error:error.message,elapsedMs:run?.finishedAt?Date.parse(run.finishedAt)-Date.parse(run.createdAt):null,tokens:run?.accountedTokens??null});throw error;}
    }
    run=this.store.require('run',scope,response.runId);
    const stopped=this.control(scope,e.id);if(stopped)throw fail('paused',stopped);
    const toolEvents=this.store.events(scope,run.id).filter(e=>e.data.method==='company/evaluationTool').map(e=>e.data.params);
    const hasReads=['subject.mjs','CONTRACT.md'].every(file=>toolEvents.some(t=>t.tool==='qa_read'&&t.arguments.file===file));
    if(!hasReads||!toolEvents.some(t=>t.tool==='qa_execute')){
      patch({status:'failed',error:'필수 실제 자료 읽기·실행 도구의 근거 없음',tokens:run.accountedTokens??null,elapsedMs:run.finishedAt?Date.parse(run.finishedAt)-Date.parse(run.createdAt):null});
      throw fail('failed','실제 도구 실행이 없어 평가 점수를 산정하지 않았습니다.');
    }
    const report=reportSchema.parse(JSON.parse(response.text));
    for(const f of report.findings)f.input=Object.fromEntries(Object.entries(f.input).filter(([,v])=>v!==null));
    const privateCase=(e.purpose==='practice'?[practiceCase]:benchmarkCases).find(c=>c.id===trial.caseId);
    if(!privateCase||fixtureVersion!==e.frozen.fixtureVersion)throw fail('failed','고정된 평가 판정기 버전이 필요합니다.');
    const metrics=judge(privateCase,report);
    const artifactDir=path.join(this.store.dir,'evaluation-results',e.id);await mkdir(artifactDir,{recursive:true});const artifact=path.join(artifactDir,trial.id+'.json');
    await writeFile(artifact,JSON.stringify({evaluationId:e.id,trialId:trial.id,snapshotHash:trial.snapshotHash,runId:run.id,report,metrics},null,2));
    this.store.patch('run',scope,run.id,{artifact,independentVerification:{confirmed:true,exitCode:0,command:'fixed-contract-oracle',output:metrics,verifiedAt:now()}});
    if(trial.condition==='C')recordApplication(this.store,scope,run.id,selection,report);
    patch({status:'completed',report,metrics,artifact,runId:run.id,elapsedMs:run.finishedAt?Date.parse(run.finishedAt)-Date.parse(run.createdAt):null,tokens:run.accountedTokens??null,finishedAt:now()});
    syncExperiences(this.store,scope);e=this.store.require('evaluation',scope,e.id);const finished=e.trials.every(t=>['completed','failed'].includes(t.status));this.store.patch('evaluation',scope,e.id,{status:finished?'completed':'queued',summary:compareSummary(e),...(finished?{finishedAt:now()}:{})});
    this.store.message(scope,'QA 평가 실행기',`${c.id} ${trial.condition}: 확인 ${metrics.found}, 놓침 ${metrics.missed}, 오지적 ${metrics.falsePositives}`,{origin:'system',runId:run.id,evaluationId:e.id,trialId:trial.id,artifact});
  }
}
