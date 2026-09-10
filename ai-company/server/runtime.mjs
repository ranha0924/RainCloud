import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { CodexClient } from './codex.mjs';
import { uid,now,roles } from './store.mjs';
import { command } from './process.mjs';
import { prepareWorkspace,developerWorkspace,commitDeveloper,integrate,resultDiff } from './workspaces.mjs';
import { hash, syncExperiences } from './experience.mjs';
import { scopeRules } from './personal.mjs';

export const stages=['po','cto','backend','frontend','qa'];
export const reportSchema={type:'object',additionalProperties:false,properties:{summary:{type:'string'},handoff:{type:'string'},passed:{type:'boolean'}},required:['summary','handoff','passed']};
const redact=value=>JSON.parse(JSON.stringify(value).replace(/sk-[A-Za-z0-9_-]{16,}/g,'[REDACTED]').replace(/Bearer\s+[A-Za-z0-9._-]{16,}/g,'Bearer [REDACTED]'));
export class Runtime{
  constructor(store,{clientFactory=cwd=>new CodexClient(cwd)}={}){this.store=store;this.clientFactory=clientFactory;this.active=new Map();}
  usage(scope){const runs=this.store.list('run',scope);return {runs:runs.length,tokens:runs.reduce((n,r)=>n+(r.accountedTokens??r.usage?.last?.totalTokens??0),0),unknown:runs.filter(r=>r.status!=='running'&&!r.usage).length,cost:null,costBasis:'금액 미제공 · 실제 보고된 토큰과 호출 수로 제한'};}
  budget(scope){
    const settings=this.store.require('settings','company','main');if(settings.stopped)throw new Error('전체 중지 상태입니다. 운영 설정에서 다시 허용하세요.');
    const all=[{id:'company'},...this.store.list('project','company')].map(p=>this.usage(p.id));
    if(all.reduce((n,u)=>n+u.runs,0)>=settings.maxRuns||all.reduce((n,u)=>n+u.tokens,0)>=(settings.tokenBudget??Infinity))throw new Error('회사 전체 실행 예산을 소진했습니다.');
    if(scope!=='company'){const p=this.store.require('project','company',scope);const u=this.usage(scope);if(u.runs>=p.maxRuns||u.tokens>=(p.tokenBudget??Infinity))throw new Error('프로젝트 실행 예산을 소진했습니다.');}
  }
  employee(scope,id){const e=this.store.require('employee','company',id);if(scope!=='company'){const p=this.store.require('project','company',scope);if(!p.assignments.some(a=>a.employeeId===id))throw new Error('프로젝트에 배정되지 않은 직원입니다.');}return e;}
  instructions(scope,person,{includeMemory=true}={}){
    const s=this.store.require('settings','company','main');
    const p=scope==='company'?null:this.store.require('project','company',scope);
    const memory=(includeMemory?this.store.list('memory',scope).map(m=>m.text).join('\n').slice(-16000):'이 실행은 고정된 자료만 사용합니다.')+'\n'+scopeRules(this.store,scope,person.id);
    return `당신은 AI 회사의 가상 직원 ${person.name}, 직무 ${roles.find(r=>r.id===person.role)?.name}입니다. 한국어로 명확하게 소통하세요.\n성격: ${person.personality}\n업무 방식: ${person.workStyle}\n강점: ${person.strengths}\n약점: ${person.weaknesses}\n대표가 저장한 직원 지침: ${person.instructions||''}\n회사 규칙:\n${s.rules}\n현재 프로젝트: ${p?JSON.stringify({name:p.name,goal:p.goal,stack:p.stack}):'회사 공통 채용 및 운영'}\n현재 범위의 기억:\n${memory}\n현재 작업 디렉터리 밖의 프로젝트, 홈 폴더, 인증 파일, .env 및 비밀 정보에 접근하지 마세요. 다른 프로젝트의 기억이나 과거 대화를 가져오지 마세요. 외부 메시지 전송, 게시, 배포, push, 추가 에이전트 생성은 금지합니다. 명령/수정은 현재 디렉터리에서만 수행하세요. 프로필은 역할 연기이며 실제 사람인 척하지 마세요.`;
  }
  async agent({scope,person,prompt,cwd,writable=false,network=false,taskId,stage,conversationId,signal,threadId,onThread,onRun,onUsage,outputSchema,timeoutMs=600000,restrictedRead=false,context={}}){
    this.budget(scope);
    const p=scope==='company'?null:this.store.require('project','company',scope);
    const baseInstructions=context.instructions??this.instructions(scope,person);
    const instructions=baseInstructions+(process.platform==='win32'?'\nWindows 실행 참고: PowerShell 출력에서 한글이 깨져 보여도 원본 인코딩 오류로 단정하지 마세요. UTF-8 파일은 node의 fs.readFileSync(path, "utf8")와 console.log로 읽으면 됩니다. 제한된 PowerShell에서 .NET 메서드 호출은 실패할 수 있으므로 사용하지 마세요. 사전 조사와 도구 호출을 최소화하고 담당 단계의 작은 결과에 집중하세요.':'');
    const model=context.model??p?.model;
    const run=this.store.put('run',scope,{id:uid(),employeeId:person.id,employeeName:person.name,role:person.role,taskId,stage,conversationId,status:'running',createdAt:now(),cwd,threadId,model:model||'Codex 기본 모델',instructionVersion:hash(instructions),instructionSnapshot:instructions,purpose:context.purpose||(taskId?this.store.get('task',scope,taskId)?.purpose:undefined)||'work',evaluationId:context.evaluationId,trialId:context.trialId,experienceTitle:context.title,goal:context.goal,acceptance:context.acceptance});
    onRun?.(run.id);
    const prior=threadId?Math.max(0,...this.store.list('run',scope).filter(r=>r.id!==run.id&&r.threadId===threadId).map(r=>r.usage?.total?.totalTokens||0)):0;
    const recordUsage=usage=>{if(usage){this.store.patch('run',scope,run.id,{usage,accountedTokens:usage.total?Math.max(0,usage.total.totalTokens-prior):usage.last?.totalTokens||0});onUsage?.();}};
    const client=this.clientFactory(cwd,scope,context.isolation);
    try{
      await client.start();
      const response=await client.run({cwd,prompt,writable,network,threadId,model:model||undefined,signal,outputSchema,timeoutMs,restrictedRead,dynamicTools:context.dynamicTools,dynamicHandler:context.dynamicHandler,instructions,onThread:id=>{this.store.patch('run',scope,run.id,{threadId:id});onThread?.(id);},onEvent:event=>{
        if(event.method==='item/agentMessage/delta')return;
        this.store.event(scope,run.id,redact(event));
        if(event.method==='turn/started')this.store.patch('run',scope,run.id,{turnId:event.params.turn.id});
        if(event.method==='thread/tokenUsage/updated')recordUsage(event.params.tokenUsage);
        if(event.method==='item/completed'&&event.params.item?.type==='agentMessage')this.store.message(scope,person.name,event.params.item.text,{runId:run.id,senderId:person.id,recipientId:taskId?'team':'ceo',employeeId:person.id,taskId,channel:conversationId||'general',origin:'agent'});
      }});
      if(!response.text)throw new Error('에이전트가 최종 결과를 반환하지 않았습니다.');
      recordUsage(response.usage);
      this.store.patch('run',scope,run.id,{status:'completed',result:response.text,turnId:response.turnId,usage:response.usage,finishedAt:now()});
      return {runId:run.id,...response};
    }catch(e){this.store.patch('run',scope,run.id,{status:signal?.aborted?'interrupted':'failed',error:e.message,finishedAt:now()});throw e;}finally{client.close();syncExperiences(this.store,scope);}
  }
  assertIdle(){if(this.active.size)throw new Error('다른 실행이 진행 중입니다. 현재 실행이 끝난 뒤 시작하세요.');}
  startChat(scope,person,text,{candidate=false,channel='general'}={}){
    this.assertIdle();this.budget(scope);
    if(!candidate)this.employee(scope,person.id);
    const conversationId=`${candidate?'interview':'chat'}-${person.id}-${channel}`;
    const conv=this.store.get('conversation',scope,conversationId)||this.store.put('conversation',scope,{id:conversationId,personId:person.id});
    this.store.message(scope,'대표',text,{channel:conversationId,origin:'user',employeeId:person.id});
    const controller=new AbortController();this.active.set(conversationId,controller);
    const cwd=path.join(this.store.dir,'contexts',scope,person.id);
    const promise=(async()=>{await mkdir(cwd,{recursive:true});return this.agent({scope,person,prompt:text,cwd,conversationId,threadId:conv.threadId,signal:controller.signal,onThread:threadId=>this.store.patch('conversation',scope,conversationId,{threadId})});})();
    promise.catch(e=>this.store.message(scope,'운영 시스템',e.message,{channel:conversationId,origin:'system'})).finally(()=>this.active.delete(conversationId));
    return {conversationId};
  }
  startTask(scope,id){
    this.assertIdle();this.budget(scope);
    const p=this.store.require('project','company',scope);const task=this.store.require('task',scope,id);
    if(['running','review'].includes(task.status))throw new Error('이미 실행 중이거나 검토가 준비된 업무입니다.');
    if(!p.repository)throw new Error('프로젝트 설정에 Git 저장소 경로를 등록하세요.');
    if(!p.testCommand?.trim())throw new Error('프로젝트 설정에 QA 검증 명령을 등록하세요.');
    const team=Object.fromEntries(stages.map(role=>{const a=p.assignments.find(a=>this.store.get('employee','company',a.employeeId)?.role===role);if(!a)throw new Error(`${roles.find(r=>r.id===role).name} 직원을 채용하고 프로젝트에 배정하세요.`);if(['backend','frontend'].includes(role)&&a.permission!=='write')throw new Error(`${role} 직원에게 코드 쓰기 권한이 필요합니다.`);return [role,{...this.employee(scope,a.employeeId),permission:a.permission}];}));
    const controller=new AbortController();this.active.set(id,controller);
    this.store.patch('task',scope,id,{status:'running',error:null});
    this.pipeline(p,id,team,controller.signal).catch(e=>this.store.patch('task',scope,id,{status:controller.signal.aborted?'paused':'blocked',error:e.message})).finally(()=>this.active.delete(id));
    return this.store.require('task',scope,id);
  }
  async pipeline(p,id,team,signal){
    const task=()=>this.store.require('task',p.id,id);
    const workspace=await prepareWorkspace(this.store,p,task(),signal);
    for(const role of stages){
      if(signal.aborted)throw new Error('실행이 중지되었습니다.');
      let checkpoint=task().checkpoints?.[role];
      if(checkpoint?.status==='completed')continue;
      this.store.patch('task',p.id,id,{stage:role});
      const dev=['backend','frontend'].includes(role);
      const cwd=dev?await developerWorkspace(workspace,role,signal):workspace.repo;
      const save=value=>{const t=task();this.store.patch('task',p.id,id,{checkpoints:{...t.checkpoints,[role]:{...t.checkpoints?.[role],...value}}});};
      let testResult;
      if(role==='qa'){
        const start=now();
        const result=await command(process.platform==='win32'?'powershell.exe':'/bin/sh',process.platform==='win32'?['-NoProfile','-NonInteractive','-Command',p.testCommand]:['-c',p.testCommand],workspace.repo,{signal,timeout:180000,allowFailure:true});
        testResult={command:p.testCommand,exitCode:result.code,output:result.output,startedAt:start,finishedAt:now()};
        this.store.patch('task',p.id,id,{testResult,result:await resultDiff(workspace)});
      }
      const context=stages.map(r=>({role:r,result:task().checkpoints?.[r]?.report})).filter(x=>x.result);
      const representativeNotes=this.store.list('message',p.id).filter(m=>m.origin==='user'&&m.channel==='general').slice(-10).map(m=>m.text).join('\n');
      const objective={po:'요구사항을 정리하고 검증 가능한 인수 조건을 작성하세요. 코드를 수정하지 마세요.',cto:'PO 인수 조건을 바탕으로 백엔드와 프런트엔드에 구체적인 파일/작업 책임을 나눠 요청하세요. 코드는 수정하지 마세요.',backend:'CTO가 요청한 백엔드 부분만 실제 수정하세요. 역할에 맞는 작은 테스트를 실행하세요. git commit/checkout은 하지 마세요. 프런트엔드에 변경 계약을 전달하세요.',frontend:'CTO가 요청한 프런트엔드 부분만 실제 수정하세요. 통합된 백엔드 계약을 확인하고 작은 테스트를 실행하세요. git commit/checkout은 하지 마세요.',qa:'통합 변경을 인수 조건과 비교해 검토하세요. 첨부된 실제 테스트 종료 코드와 출력을 평가하세요. 테스트 실패, 변경 누락, 인수 조건 미충족이면 passed=false로 보고하세요. 코드는 수정하지 마세요.'}[role];
      if(!checkpoint?.report){
        const response=await this.agent({scope:p.id,person:team[role],prompt:`업무: ${task().title}\n요청: ${task().description}\n${objective}\n개발 변경 허용 경로: ${JSON.stringify(p.allowedPaths)}\n인계 기록: ${JSON.stringify(context)}\n이 프로젝트 일반 채널의 대표 메시지: ${representativeNotes}\n실제 테스트 결과: ${JSON.stringify(testResult||null)}\n최종 응답은 지정 JSON으로 작성하고 summary와 handoff는 한국어로 쓰세요. 실제 작업이 막히면 passed=false로 보고하세요.`,cwd,writable:dev,network:p.networkAccess,taskId:id,stage:role,signal,threadId:checkpoint?.threadId,outputSchema:reportSchema,onThread:threadId=>save({threadId})});
        let report;try{report=JSON.parse(response.text);}catch{throw new Error(`${role} 결과 JSON을 해석하지 못했습니다.`);}
        save({report,runId:response.runId});checkpoint=task().checkpoints[role];
      }
      if(checkpoint.report.passed!==true){save({report:null});throw new Error(`${role} 검증/작업 보완 필요: ${checkpoint.report.summary}`);}
      if(dev){const commit=checkpoint.commit||await commitDeveloper(workspace,cwd,role,p.allowedPaths,signal);save({commit});await integrate(workspace,commit,signal);}
      if(role==='qa'&&testResult.exitCode!==0){save({report:null});throw new Error('QA 검증 명령이 실패했습니다. 테스트 출력을 확인하세요.');}
      save({status:'completed'});
      this.store.put('memory',p.id,{id:`task-${id}-${role}`,text:`${task().title} / ${role}: ${checkpoint.report.handoff}`,sourceTaskId:id,createdAt:now()});
    }
    const result=await resultDiff(workspace);
    if(!result.files.length)throw new Error('실제 변경 파일이 없어 검토 완료로 표시하지 않았습니다.');
    this.store.patch('task',p.id,id,{status:'review',stage:'complete',result,finishedAt:now()});
    this.store.message(p.id,'운영 시스템',`검토 브랜치 ${result.branch}가 준비되었습니다. 변경 ${result.files.length}개 파일, QA 종료 코드 0.`,{taskId:id,origin:'system'});
  }
  stopAll(){this.store.patch('settings','company','main',{stopped:true});for(const controller of this.active.values())controller.abort();return {stopped:true,active:this.active.size};}
}
