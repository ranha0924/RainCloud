// Explicit model validation in the SAME company ledger as the earlier autonomous validation.
// Does not increase old project budgets or reset usage. Lab feedback is never labelled CEO feedback.
import path from 'node:path';
import { mkdir,writeFile } from 'node:fs/promises';
import { Store,uid,now } from '../server/store.mjs';
import { Runner } from '../server/scheduler.mjs';
import { QueueGateway,policyOf } from '../server/operations.mjs';
import { acquireServerLock } from '../server/lock.mjs';
import { freezeEvaluation,startEvaluation,compareSummary,evaluationUsage } from '../server/evaluation.mjs';
import { practiceCase,benchmarkCases } from '../server/qa-fixtures.mjs';
import { syncExperiences,addFeedback,suggestGuideline,editGuideline,reviewGuideline,shareGuideline,career } from '../server/experience.mjs';

const store=new Store(path.resolve(process.env.COMPANY_EXPERIENCE_DATA_DIR||'.local/autonomy-live-verified/data'));
const release=acquireServerLock(store.dir,'runner.lock');process.on('exit',release);
const runner=new Runner(store),gateway=new QueueGateway(store);const reportDir=path.resolve('.local/experience-validation');await mkdir(reportDir,{recursive:true});
const baseline={settings:store.require('settings','company','main'),usage:store.list('project','company').map(p=>({id:p.id,...runner.usage(p.id)}))};
let lab=store.get('experienceLab','company','main');
if(!lab){
  const qa=store.list('employee','company').find(e=>e.role==='qa');if(!qa)throw new Error('QA 직원이 필요합니다. 먼저 직접 채용하세요.');
  runner.budget('company');
  const p=store.put('project','company',{id:uid(),name:'QA 경험 실증 · 연습과 평가',repository:'',goal:'합성 인증 계약 QA의 경험 재사용 평가. 실제 업무 실적으로 집계하지 않음',model:'gpt-5.6-luna',maxRuns:50,tokenBudget:350000,assignments:[{employeeId:qa.id,permission:'read'}],allowedPaths:[],operation:{...policyOf({}),turnMinutes:2},operationEnabled:false,paused:false});
  const transfer=store.put('project','company',{...p,id:uid(),name:'QA 경험 전이 · 별도 테스트 프로젝트',maxRuns:24,tokenBudget:140000});
  lab=store.put('experienceLab','company',{id:'main',projectId:p.id,transferProjectId:transfer.id,employeeId:qa.id,createdAt:now(),baseline});
}
// Only the designated synthetic history is labelled retrospectively, preserving originals and content.
for(const p of store.list('project','company').filter(p=>p.id!==lab.projectId&&p.id!==lab.transferProjectId)){
  if(p.id!=='c2cf3a39-3752-4940-a3bb-0bc462553eb8')continue;
  for(const r of store.list('run',p.id))if(!r.purpose)store.patch('run',p.id,r.id,{purpose:'practice',purposeBasis:'Earlier explicitly synthetic validation fixture'});
  for(const t of store.list('task',p.id))if(!t.purpose)store.patch('task',p.id,t.id,{purpose:'practice'});
}
await runner.recover();
async function run(scope,e){
  startEvaluation(store,gateway,scope,e.id);let last='';const start=Date.now();
  for(;;){await runner.tick();await new Promise(r=>setTimeout(r,200));const current=store.require('evaluation',scope,e.id);const state=JSON.stringify({label:current.label,status:current.status,done:current.trials.filter(t=>t.status==='completed').length,total:current.trials.length,usage:evaluationUsage(store,scope,e.id),reason:current.reason});if(state!==last){console.log(state);last=state;}
    if(!runner.executions.size&&['completed','failed','paused','cancelled'].includes(current.status))return current;
    if(Date.now()-start>45*60000)throw new Error('Validation wall time limit');
  }
}
async function obtain(scope,label,caseIds,tokenLimit,purpose='evaluation'){
  let e=store.list('evaluation',scope).find(x=>x.label===label);
  if(!e)e=await freezeEvaluation(store,gateway,scope,{employeeId:lab.employeeId,caseIds,model:'gpt-5.6-luna',label,tokenLimit,turnSeconds:75},{purpose,actor:'implementation_validation',...(purpose==='practice'?{caseOverride:[practiceCase]}:{})});
  return e.status==='completed'?e:run(scope,e);
}
let failure;
try{
  const practice=await obtain(lab.projectId,'연습 02 · 실제 도구 연결',[practiceCase.id],50000,'practice');
  if(practice.status!=='completed'||practice.trials[0].status!=='completed')throw new Error('연습 실행 미완료: '+practice.reason);
  if(!lab.guidelineId){
    syncExperiences(store,lab.projectId);const experienceId='run:'+practice.trials[0].runId;
    const feedback=addFeedback(store,lab.projectId,experienceId,{text:'연습용 자동 검수 피드백: 실제 함수 실행과 고정 계약의 만료 경계를 비교했습니다. 다음 과제에서는 만료 직전·동일 시각·직후와 필수 만료 필드 유무를 명시적으로 비교하세요.',problem:'만료 경계와 누락된 필드를 정상 사례와 함께 검증해야 함',correction:'직전·동일·직후의 서로 다른 입력을 사용하고 현재 계약의 경계 정의를 먼저 확인',applyWhen:'session expiry 로그인 세션 만료 권한 검증',doNotApply:'현재 계약이 만료 시각 포함 또는 만료 없는 세션을 명시적으로 허용하는 경우',humanVerified:false},'implementation_validation');
    let g=suggestGuideline(store,lab.projectId,experienceId,feedback.id);
    g=editGuideline(store,lab.projectId,g.id,{situation:'로그인 세션의 expires/now 경계 및 필수 필드 검증',problem:'정상 로그인만 확인하면 만료 경계와 정보 누락을 놓칠 수 있음',change:'유효 직전·동일 시각·직후와 expires 누락을 독립 입력으로 실행해 현재 계약과 비교',outcome:`연습 과제의 실제 실행을 oracle로 검증: 발견 ${practice.trials[0].metrics.found}, 놓침 ${practice.trials[0].metrics.missed}. 일반 성능 향상은 아직 미평가.`,applyWhen:'session expiry fail_closed 로그인 세션 인증 검증',doNotApply:'현재 프로젝트가 다른 시간 단위·포함 경계·무기한 세션을 명시하면 계약을 우선한다.',tags:['qa','expiry','session','fail_closed','로그인','세션'],checkCodes:['expiry','fail_closed']});
    reviewGuideline(store,lab.projectId,g.id,{version:g.current,status:'verified',active:true},'implementation_validation');
    const shared=shareGuideline(store,lab.projectId,g.id,{version:g.current,targetProjectIds:[lab.transferProjectId],checkCodes:['expiry','fail_closed'],rightsConfirmed:true},'implementation_validation');
    lab=store.patch('experienceLab','company','main',{guidelineId:g.id,feedbackId:feedback.id,releaseId:shared.id});
  }
  if(process.argv.includes('--transfer-only')){
    const transfer=await obtain(lab.transferProjectId,'비교 검증 · 타 프로젝트 경계 · auth-08',['auth-08'],140000);
    if(transfer.status!=='completed')throw new Error('전이 사례 비교 미완료: '+transfer.reason);
  }else if(process.argv.includes('--sampled')){
    const normal=await obtain(lab.projectId,'비교 검증 · 정상 세션 · auth-02',['auth-02'],110000);
    if(normal.status!=='completed')throw new Error('정상 사례 비교 미완료: '+normal.reason);
    const transfer=await obtain(lab.transferProjectId,'비교 검증 · 타 프로젝트 경계 · auth-08',['auth-08'],110000);
    if(transfer.status!=='completed')throw new Error('전이 사례 비교 미완료: '+transfer.reason);
  }else{
    const pilot=await obtain(lab.projectId,'파일럿 02 · 실제 도구 A B C',['auth-01'],60000);
    if(pilot.status!=='completed')throw new Error('파일럿 미완료: '+pilot.reason);
  }
  if(process.argv.includes('--full')){
    const full=await obtain(lab.projectId,'본 평가 · Console A · 6과제',benchmarkCases.slice(0,6).map(c=>c.id),220000);
    if(full.status!=='completed')throw new Error('본 평가 미완료: '+full.reason);
    const transfer=await obtain(lab.transferProjectId,'전이 평가 · Portal B · 6과제',benchmarkCases.slice(6).map(c=>c.id),140000);
    if(transfer.status!=='completed')throw new Error('전이 평가 미완료: '+transfer.reason);
  }
}catch(error){failure=error.message;console.log('VALIDATION STOP:',failure);}
finally{
  await runner.close();const report={checkedAt:now(),failure:failure||null,lab,settings:store.require('settings','company','main'),companyUsage:[{id:'company'},...store.list('project','company')].map(p=>({id:p.id,...runner.usage(p.id)})),projects:[lab.projectId,lab.transferProjectId].map(scope=>({scope,profile:career(store,scope,lab.employeeId),evaluations:store.list('evaluation',scope).map(e=>({...e,summary:compareSummary(e),usage:evaluationUsage(store,scope,e.id)}))})),feedbackSource:'Lab automation for feature verification, not CEO review',humanTimeMeasured:false};
  await writeFile(path.join(reportDir,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({report:path.join(reportDir,'report.json'),failure,totalTokens:report.companyUsage.reduce((n,p)=>n+p.tokens,0)}));store.close();release();
}
if(failure)process.exitCode=1;
