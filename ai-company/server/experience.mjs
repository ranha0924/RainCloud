import { createHash } from 'node:crypto';
import { z } from 'zod';
import { uid, now } from './store.mjs';

export const hash = value => createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export const purposes=['work','practice','evaluation','unclassified'];
export const purposeNames={work:'실제 업무',practice:'연습',evaluation:'평가',unclassified:'이전 기록 · 분류 미확인'};
// Cross-project releases are assembled exclusively from this reviewed vocabulary.
// Free-form source text, code, paths and customer data never enter a release.
export const checks={
  expiry:'세션 유효 시간의 직전·동일 시각·직후 경계를 각각 재현한다.',
  revocation:'로그아웃·회수된 세션이 재사용되지 않는지 재현한다.',
  fail_closed:'필수 인증 정보가 없거나 유효하지 않으면 접근이 거절되는지 확인한다.',
  role:'인증 성공과 권한 충족을 별개로 확인하고 낮은 권한의 접근을 검증한다.',
  tenant:'사용자와 자원의 프로젝트 또는 조직 범위가 일치해야 하는지 확인한다.',
  audience:'토큰의 대상 서비스와 현재 요청 서비스가 일치하는지 확인한다.',
  regression:'수정 전 실패·수정 후 성공과 정상 사례의 회귀 검증을 모두 보관한다.',
};
const words=text=>new Set(String(text).toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu)||[]);
const generic=new Set(['qa','test','the','and','업무','검증']);
const overlap=(a,b)=>[...words(a)].filter(w=>!generic.has(w)&&words(b).has(w)).length;
export const guidelineBody=z.object({situation:z.string().min(1).max(2000),problem:z.string().min(1).max(2000),change:z.string().min(1).max(2000),outcome:z.string().min(1).max(2000),applyWhen:z.string().min(1).max(2000),doNotApply:z.string().min(1).max(2000),tags:z.array(z.string().min(1).max(60)).min(1).max(15),checkCodes:z.array(z.enum(Object.keys(checks))).max(7).default([])}).strict();
export const feedbackBody=z.object({text:z.string().min(1).max(6000),problem:z.string().max(2000).default(''),correction:z.string().max(2000).default(''),applyWhen:z.string().max(2000).default(''),doNotApply:z.string().max(2000).default(''),correctionRunId:z.string().optional(),humanVerified:z.boolean().default(false),reviewMinutes:z.number().min(0).max(10000).nullable().default(null)}).strict();

export function syncExperiences(store,scope){
  for(const r of store.list('run',scope).filter(r=>r.taskId||r.evaluationId)){
    const t=r.taskId?store.get('task',scope,r.taskId):null;
    const evaluation=r.evaluationId?store.get('evaluation',scope,r.evaluationId):null;
    const trial=evaluation?.trials.find(t=>t.id===r.trialId);
    const cp=Object.values(t?.checkpoints||{}).find(c=>c.runId===r.id);
    const id=`run:${r.id}`,old=store.get('experience',scope,id);
    const independent=r.independentVerification||cp?.testResult||null;
    const observation={runStatus:r.status,taskStatus:t?.status||trial?.status||r.status,selfReport:r.result||null,error:r.error||trial?.error||r.validationInvalidated||null,verification:independent,artifact:r.artifact||t?.artifact||t?.result?.repository||r.cwd,files:t?.result?.files||[],commit:cp?.commit||t?.result?.head||null};
    const digest=hash(observation);
    if(old?.observationHash===digest){store.patch('experience',scope,id,{tokens:r.accountedTokens??r.usage?.last?.totalTokens??null,finishedAt:r.finishedAt,elapsedMs:r.finishedAt?Math.max(0,Date.parse(r.finishedAt)-Date.parse(r.createdAt)):null});continue;}
    const revisions=[...(old?.revisions||[]),{number:(old?.revisions?.length||0)+1,time:now(),...observation}];
    store.put('experience',scope,{...old,id,projectId:scope,employeeId:r.employeeId,taskId:r.taskId,runId:r.id,evaluationId:r.evaluationId,trialId:r.trialId,purpose:r.purpose||t?.purpose||'unclassified',title:t?.title||r.experienceTitle||r.stage,goal:t?.description||r.goal||'',acceptance:r.acceptance||t?.acceptance||[],model:r.model||'이전 기록 · 모델 미기록',instructionVersion:r.instructionVersion||'이전 기록 · 버전 미기록',instructionSnapshot:r.instructionSnapshot||null,createdAt:r.createdAt,finishedAt:r.finishedAt,elapsedMs:r.finishedAt?Math.max(0,Date.parse(r.finishedAt)-Date.parse(r.createdAt)):null,tokens:r.accountedTokens??r.usage?.last?.totalTokens??null,cost:null,costBasis:'미제공',visibility:'project',observationHash:digest,...observation,revisions});
  }
  return store.list('experience',scope);
}
export function addFeedback(store,scope,experienceId,input,author='ceo'){
  const e=store.require('experience',scope,experienceId),body=feedbackBody.parse(input);
  if(body.correctionRunId){const r=store.require('run',scope,body.correctionRunId);if(r.employeeId!==e.employeeId)throw new Error('같은 직원의 프로젝트 내 수정 실행을 연결하세요.');}
  return store.put('feedback',scope,{id:uid(),experienceId,projectId:scope,...body,author,createdAt:now()});
}
export function suggestGuideline(store,scope,experienceId,feedbackId){
  const e=store.require('experience',scope,experienceId),f=store.require('feedback',scope,feedbackId);
  if(f.experienceId!==e.id)throw new Error('다른 경험의 피드백입니다.');
  const corrected=f.correctionRunId?store.get('experience',scope,'run:'+f.correctionRunId):null;
  const verification=corrected?.verification||e.verification;
  const body={situation:(e.goal||e.title).slice(0,2000),problem:(f.problem||f.text).slice(0,2000),change:f.correction||'수정 내용과 검증 근거를 검토해 작성하세요.',outcome:verification?JSON.stringify(verification).slice(0,1800):'독립 검증 미확인',applyWhen:f.applyWhen||'적용할 조건을 검토해 작성하세요.',doNotApply:f.doNotApply||'적용 제외 조건을 검토해 작성하세요.',tags:['qa'],checkCodes:[]};
  const version={number:1,...guidelineBody.parse(body),sourceExperienceIds:[...new Set([e.id,...(corrected?[corrected.id]:[])])],sourceFeedbackIds:[f.id],createdAt:now(),status:'candidate',active:false};
  return store.put('guideline',scope,{id:uid(),projectId:scope,employeeId:e.employeeId,visibility:'project',current:1,versions:[version],createdAt:now()});
}
export function editGuideline(store,scope,id,input){
  const g=store.require('guideline',scope,id),prior=g.versions.at(-1),body=guidelineBody.parse(input);
  return store.patch('guideline',scope,id,{current:g.current+1,versions:[...g.versions,{...prior,...body,number:g.current+1,createdAt:now(),status:'candidate',active:false,reviewedAt:null}]});
}
export function reviewGuideline(store,scope,id,{version,status,active},author='ceo'){
  const g=store.require('guideline',scope,id),v=g.versions.at(-1);
  if(version!==g.current)throw new Error('지침 버전이 바뀌었습니다. 다시 검토하세요.');
  if(!['candidate','verified','retired'].includes(status)||typeof active!=='boolean')throw new Error('지침 상태가 올바르지 않습니다.');
  const evidence=v.sourceExperienceIds.map(id=>store.require('experience',scope,id));
  const feedback=v.sourceFeedbackIds.map(id=>store.require('feedback',scope,id));
  if(status==='verified'&&!evidence.some(e=>e.verification?.exitCode===0||e.verification?.confirmed===true)&&!feedback.some(f=>f.humanVerified))throw new Error('자기 보고만으로 검증할 수 없습니다. 독립 검증 또는 대표의 근거 확인이 필요합니다.');
  if(active&&status!=='verified')throw new Error('검증된 지침만 활성화할 수 있습니다.');
  const updated={...v,status,active,reviewedAt:now(),reviewedBy:author};
  // Content versions are immutable; decisions have a separate append-only audit trail.
  store.put('guidelineReview',scope,{id:uid(),guidelineId:id,version,status,active,author,createdAt:now()});
  return store.patch('guideline',scope,id,{enabled:active,versions:[...g.versions.slice(0,-1),updated]});
}
export function shareGuideline(store,scope,id,input,author='ceo'){
  const body=z.object({version:z.number().int(),targetProjectIds:z.array(z.string()).min(1).max(30),rightsConfirmed:z.literal(true),checkCodes:z.array(z.enum(Object.keys(checks))).min(1).max(7)}).strict().parse(input);
  const g=store.require('guideline',scope,id),v=g.versions.at(-1);
  if(v.number!==body.version||!v.active||v.status!=='verified')throw new Error('현재 활성화된 검증 버전만 공유할 수 있습니다.');
  for(const target of body.targetProjectIds){store.require('project','company',target);if(target===scope)throw new Error('다른 프로젝트를 선택하세요.');}
  return store.put('guidelineRelease',scope,{id:uid(),guidelineId:id,version:v.number,sourceProjectId:scope,targetProjectIds:[...new Set(body.targetProjectIds)],checkCodes:body.checkCodes,text:body.checkCodes.map(c=>checks[c]).join('\n'),rightsConfirmed:true,approvedBy:author,createdAt:now(),active:true});
}
export function permittedGuidelines(store,scope){
  const eligible=(s,v)=>v.sourceExperienceIds.every(id=>{const e=store.get('experience',s,id);return e&&['work','practice'].includes(e.purpose);});
  const local=store.list('guideline',scope).flatMap(g=>{const v=g.versions.at(-1);return v.active&&v.status==='verified'&&eligible(scope,v)?[{id:g.id,version:v.number,sourceProjectId:scope,local:true,...v}]:[];});
  const shared=store.list('project','company').filter(p=>p.id!==scope).flatMap(p=>store.list('guidelineRelease',p.id).filter(r=>r.active&&r.rightsConfirmed&&r.targetProjectIds.includes(scope)).flatMap(r=>{
    const g=store.get('guideline',p.id,r.guidelineId),v=g?.versions.at(-1);
    if(!v||!v.active||v.status!=='verified'||v.number!==r.version||!eligible(p.id,v))return [];
    return [{id:r.id,version:r.version,sourceProjectId:p.id,local:false,checkCodes:r.checkCodes,tags:['qa','login','session','auth','로그인','세션','권한',...r.checkCodes],situation:'일반 인증·권한 검증',problem:'경계 조건 누락',change:r.text,outcome:'원본 프로젝트의 검토를 거친 일반 점검 지침',applyWhen:'같은 인증·권한 계약을 검증할 때',doNotApply:'현재 프로젝트의 명시적 정책과 충돌하면 적용하지 않음'}];
  }));
  return [...local,...shared];
}
export function retrieveExperience(store,scope,employeeId,query,{limit=4,excludeEvaluationId,includePractice=true,topics}={}){
  const p=store.require('project','company',scope);if(!p.assignments.some(a=>a.employeeId===employeeId))throw new Error('프로젝트 직원 배정을 확인하세요.');
  // A benchmark has a declared topic. Common auth vocabulary in its input schema
  // must not make every authentication guideline relevant to every case.
  const permitted=permittedGuidelines(store,scope).filter(g=>!topics||topics.some(t=>g.checkCodes.includes(t)));
  let ranked=permitted.map(g=>({...g,score:overlap(query,[...g.tags,g.situation,g.applyWhen].join(' '))})).filter(g=>g.score>0).sort((a,b)=>b.score-a.score).slice(0,Math.min(limit,6));
  let characters=0;ranked=ranked.filter(g=>{const size=JSON.stringify(g).length;if(characters+size>16000)return false;characters+=size;return true;});
  const ids=new Set(ranked.filter(g=>g.local).flatMap(g=>g.sourceExperienceIds||[]));
  const experiences=store.list('experience',scope).filter(e=>ids.has(e.id)&&(!excludeEvaluationId||e.evaluationId!==excludeEvaluationId)&&e.purpose!=='evaluation'&&(includePractice||e.purpose==='work')&&(e.verification?.exitCode===0||e.verification?.confirmed===true)).slice(0,3).map(e=>({id:e.id,taskId:e.taskId,runId:e.runId,purpose:e.purpose,goal:e.goal.slice(0,1000),verification:{exitCode:e.verification.exitCode,confirmed:e.verification.confirmed,command:e.verification.command,output:(typeof e.verification.output==='string'?e.verification.output:JSON.stringify(e.verification.output||'')).slice(0,1200)},artifact:e.artifact}));
  return {guidelines:ranked,experiences,summary:ranked.length?`관련 활성 지침 ${ranked.length}개와 허용된 경험 ${experiences.length}개 선택`:'관련 경험 없음 · 기본 지침과 현재 프로젝트 자료로 진행',hash:hash({ranked,experiences})};
}
export function assertSelectionPermission(store,scope,selection){
  for(const selected of selection.guidelines){
    const release=selected.local?null:store.get('guidelineRelease',selected.sourceProjectId,selected.id);
    const guide=store.get('guideline',selected.sourceProjectId,selected.local?selected.id:release?.guidelineId||'');
    const version=guide?.versions.find(v=>v.number===selected.version);
    if(guide?.enabled===false||!version?.active||version.status!=='verified'||!selected.local&&(!release?.active||!release.rightsConfirmed||!release.targetProjectIds.includes(scope)))throw new Error('선택한 지침의 활성 버전 또는 공유 허가가 변경되었습니다. 최신 권한으로 새 업무/평가를 검토하세요.');
  }
}
export function recordApplication(store,scope,runId,selection,report){
  const applications=Array.isArray(report?.experienceApplications)?report.experienceApplications:[];
  const conflicts=Array.isArray(report?.experienceConflicts)?report.experienceConflicts:[];
  const allowed=new Set(selection.guidelines.map(g=>g.id));
  const entry=store.put('experienceUse',scope,{id:runId,runId,selection,applications:applications.filter(a=>allowed.has(a.id)),conflicts:conflicts.filter(c=>allowed.has(c.id)),usageBasis:'적용 설명은 직원 자기 보고 · 성능 효과는 비교 평가로 확인',createdAt:now()});
  for(const c of entry.conflicts){const g=selection.guidelines.find(g=>g.id===c.id);store.put('memoryReview',scope,{id:`${runId}:${c.id}`,guidelineId:c.id,version:g.version,reason:c.reason,status:'pending',createdAt:now()});if(g.local){const original=store.require('guideline',scope,g.id);store.patch('guideline',scope,g.id,{versions:original.versions.map(v=>v.number===g.version?{...v,active:false}:v)});}}
  return entry;
}
export function career(store,scope,employeeId){
  store.require('employee','company',employeeId);const experiences=syncExperiences(store,scope).filter(e=>e.employeeId===employeeId);
  const groups=Object.fromEntries(purposes.map(p=>{const items=experiences.filter(e=>e.purpose===p);return [p,{runs:items.length,completedTasks:[...new Set(items.filter(e=>e.taskStatus==='completed').map(e=>e.taskId).filter(Boolean))],experiences:items.map(e=>e.id),failures:items.filter(e=>e.runStatus==='failed'||e.taskStatus==='failed'||e.verification?.exitCode>0).map(e=>e.id)}];}));
  const ids=new Set(experiences.map(e=>e.id));return {employeeId,projectId:scope,groups,experiences,feedback:store.list('feedback',scope).filter(f=>ids.has(f.experienceId)),guidelines:store.list('guideline',scope).filter(g=>g.employeeId===employeeId),applications:store.list('experienceUse',scope).filter(u=>experiences.some(e=>e.runId===u.runId)),evaluations:store.list('evaluation',scope).filter(e=>e.employeeId===employeeId),publicSummary:store.get('careerPublic',scope,employeeId)||null,caution:'평가 조건별 기록입니다. 소수의 합성 과제로 일반적인 성능 향상을 단정하지 않습니다. 평가하지 않은 분야는 미평가입니다.'};
}
