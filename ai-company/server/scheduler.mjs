import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Runtime } from './runtime.mjs';
import { CodexClient } from './codex.mjs';
import { now } from './store.mjs';
import { policyOf, state, decision, enqueue, createTask, terminal, wake } from './operations.mjs';
import { Workflow, WorkflowWait, planSchema } from './workflow.mjs';
import { EvaluationRunner } from './evaluation.mjs';
import { syncExperiences } from './experience.mjs';
import { recordSignal } from './personal.mjs';

export class Runner extends Runtime{
  constructor(store,options={}){super(store,options);if(!options.clientFactory)this.clientFactory=(cwd,scope,isolation)=>this.scopedClient(cwd,scope,isolation);this.workflow=new Workflow(this);this.evaluations=new EvaluationRunner(this);this.executions=new Map();this.timer=null;this.closing=false;this.verify=options.verify||this.verifySandbox.bind(this);}
  scopedClient(cwd,scope,isolation){
    if(isolation?.toolOnly)return new CodexClient(cwd,{toolOnly:true});
    const within=(root,target)=>{const r=path.relative(path.resolve(root),path.resolve(target));return r===''||(!r.startsWith('..')&&!path.isAbsolute(r));};
    const others=this.store.list('project','company').filter(p=>p.id!==scope);
    const deniedRoots=[...others.flatMap(p=>[p.repository,path.join(this.store.dir,'projects',p.id),path.join(this.store.dir,'contexts',p.id)]).filter(x=>x&&!within(x,cwd)),...['company.sqlite','company.sqlite-wal','company.sqlite-shm'].map(f=>path.join(this.store.dir,f))];
    return new CodexClient(cwd,{deniedRoots});
  }
  async verifySandbox(command,cwd,options){const client=this.clientFactory(cwd,options.scope);try{await client.start();return await client.verify(command,cwd,options);}finally{client.close();}}
  async recover(){
    for(const p of [{id:'company'},...this.store.list('project','company')]){
      for(const run of this.store.list('run',p.id))if(run.status==='running')this.store.patch('run',p.id,run.id,{status:'interrupted',recoveryPending:true,error:'실행기 재시작: 실제 턴 상태를 확인한 뒤 복구합니다.'});
      for(const j of this.store.list('job',p.id))if(j.status==='running'){
        this.store.patch('job',p.id,j.id,{status:'queued',reason:'실행기 재시작 후 체크포인트 복구',owner:null});
        if(j.kind==='task'){const t=this.store.require('task',p.id,j.taskId);if(!terminal.has(t.status))state(this.store,p.id,t.id,'queued','저장된 Git/턴 상태를 확인한 뒤 재개',{elapsedMs:(t.elapsedMs||0)+Math.max(0,Date.parse(j.heartbeat||j.startedAt)-Date.parse(j.startedAt))});}
      }
      for(const t of this.store.list('task',p.id)){
        if(t.status==='running'&&!this.store.get('job',p.id,`task:${t.id}`)){state(this.store,p.id,t.id,'paused','이전 버전의 실행입니다. 저장된 결과를 확인한 뒤 수동으로 재개하세요.');}
      }
    }
    this.heartbeat();
  }
  heartbeat(){this.store.put('runner','company',{id:'main',pid:process.pid,heartbeat:now(),state:this.closing?'stopping':'online',active:[...this.executions.keys()]});}
  project(scope){return scope==='company'?null:this.store.require('project','company',scope);}
  controlReason(scope,taskId,startedAt=Date.now()){
    if(this.closing)return '실행기 종료';
    if(this.store.require('settings','company','main').stopped)return '전체 중지';
    const settings=this.store.require('settings','company','main');const all=[{id:'company'},...this.store.list('project','company')];
    if(all.reduce((n,s)=>n+this.usage(s.id).tokens,0)>=(settings.tokenBudget??Infinity))return '회사 토큰 한도 도달';
    const p=this.project(scope);if(!p)return '';
    if(p.paused)return '프로젝트 일시정지';
    if(p.operationEnabled&&p.stopAt&&Date.now()>=Date.parse(p.stopAt))return '자율 운영 최대 실행 시간 도달';
    const policy=policyOf(p);
    if(taskId){const t=this.store.require('task',scope,taskId);if(t.status==='cancelled')return '대표가 취소';if((t.elapsedMs||0)+Date.now()-startedAt>=policy.taskMinutes*60000)return '업무 최대 실행 시간 도달';}
    if(this.usage(scope).tokens>=(p.tokenBudget??Infinity))return '기록된 토큰 한도 도달';
    return '';
  }
  async executeAgent(options){
    const p=this.project(options.scope),policy=p?policyOf(p):{turnMinutes:5,maxTaskCalls:100};
    const reason=this.controlReason(options.scope,options.taskId);if(reason)throw new WorkflowWait('paused',reason);
    if(options.taskId&&this.store.list('run',options.scope).filter(r=>r.taskId===options.taskId).length>=policy.maxTaskCalls)throw new WorkflowWait('paused','업무 모델 호출 한도 도달');
    try{this.budget(options.scope);}catch(e){throw new WorkflowWait('paused',e.message);}
    return this.agent({...options,network:false,restrictedRead:true,timeoutMs:Math.min(options.timeoutMs||Infinity,policy.turnMinutes*60000),onUsage:()=>{
      const reason=this.controlReason(options.scope,options.taskId);if(reason){const active=[...this.executions.values()].find(a=>a.scope===options.scope&&(!options.taskId||a.job.taskId===options.taskId));active?.controller.abort(reason);}
      options.onUsage?.();
    }});
  }
  async savedAgent(scope,job,options){
    const current=this.store.require('job',scope,job.id);let recovered;
    if(current.runId){const r=this.store.require('run',scope,current.runId);if(r.status==='completed')recovered={text:r.result,runId:r.id};
      else if(r.recoveryPending)recovered=await this.workflow.recoverResponse({id:scope},{},'',{runId:r.id});}
    return recovered||this.executeAgent({...options,scope,threadId:current.threadId,onRun:runId=>this.store.patch('job',scope,job.id,{runId}),onThread:threadId=>{this.store.patch('job',scope,job.id,{threadId});options.onThread?.(threadId);}});
  }
  async plan(p,job,signal){
    const policy=policyOf(p);const person=this.workflow.team(p,'po');
    const materials=this.store.list('material',p.id);const tasks=this.store.list('task',p.id);
    if(!p.repository&&!materials.length)throw new WorkflowWait('waiting_info','목표를 검토할 실제 프로젝트 저장소 또는 자료가 필요합니다.');
    const cwd=p.repository||path.join(this.store.dir,'contexts',p.id,'planning');await mkdir(cwd,{recursive:true});
    const r=await this.savedAgent(p.id,job,{person,cwd,stage:'planning',signal,outputSchema:planSchema,prompt:`PO로서 실제 프로젝트 자료/파일을 확인하고 우선순위를 정하세요. 허용 범위 내 작은 업무만 자동 실행됩니다. 없는 정보는 추측하지 마세요. 동일 업무는 중복 생성하지 마세요. 신규 기능/방향 전환은 해당 category로 제안하세요. 할 일이 없으면 tasks=[]로 대기 이유를 설명하세요. 최대 ${policy.maxTasksPerPlan}개. priority 1이 가장 높습니다. key는 계획 내 고유 식별자, dependsOn은 같은 계획의 key 또는 기존 업무 id. goalId는 목표 id. materials는 실제 자료 id만.\n운영 목표 ${JSON.stringify(policy.objectives)}\n허용 범위 ${policy.scope}\n허용 분류 ${JSON.stringify(policy.allowedCategories)}\n자료 ${JSON.stringify(materials)}\n기존 업무 ${JSON.stringify(tasks.map(t=>({id:t.id,title:t.title,status:t.status,acceptance:t.acceptance,reason:t.reason})))}\n출력 summary/evidence/업무 설명은 한국어. evidence에는 직접 확인한 파일이나 자료명을 적으세요.`});
    const report=JSON.parse(r.text);if(!Array.isArray(report.tasks)||!Array.isArray(report.evidence)||typeof report.summary!=='string')throw new Error('PO 계획 형식 오류');
    if(report.tasks.length>policy.maxTasksPerPlan)throw new Error('PO 계획의 업무 개수가 허용 한도를 초과했습니다.');
    if(report.tasks.length&&!report.evidence.length)throw new WorkflowWait('waiting_info','PO 계획에 실제 근거 자료가 없습니다.');
    const keys=new Map();for(const x of report.tasks){if(keys.has(x.key))throw new Error('PO 업무 key 중복');keys.set(x.key,createHash('sha256').update(`${job.id}:${x.key}`).digest('hex').slice(0,32));if(!policy.objectives.some(g=>g.id===x.goalId))throw new Error('PO 업무의 목표가 등록된 목표와 다릅니다.');}
    const visiting=new Set(),visited=new Set();const visit=x=>{if(visiting.has(x.key))throw new Error('PO 업무 의존성 순환');if(visited.has(x.key))return;visiting.add(x.key);for(const d of x.dependsOn){const other=report.tasks.find(t=>t.key===d);if(other)visit(other);else this.store.require('task',p.id,d);}visiting.delete(x.key);visited.add(x.key);};report.tasks.forEach(visit);
    // Publish the whole plan atomically; a crash cannot leave duplicate/half-published tasks.
    this.store.transaction(()=>{
      for(const x of report.tasks){const id=keys.get(x.key);if(this.store.get('task',p.id,id))continue;
        const existing=tasks.find(t=>t.title===x.title&&t.goalId===x.goalId);if(existing){keys.set(x.key,existing.id);continue;}
        const {key,dependsOn,...body}=x;createTask(this.store,p.id,{...body,dependsOn:[]},{id,sourcePlan:job.id,sourceRunId:r.runId,teamMode:p.personal?'selected':undefined});
      }
      for(const x of report.tasks){const t=this.store.require('task',p.id,keys.get(x.key));if(t.sourcePlan===job.id)this.store.patch('task',p.id,t.id,{dependsOn:x.dependsOn.map(d=>keys.get(d)||d)});}
      this.store.patch('project','company',p.id,{lastPlan:{...report,runId:r.runId,createdAt:now()},plannedVersion:this.store.require('project','company',p.id).wakeVersion||0,nextCheckAt:new Date(Date.now()+policy.checkMinutes*60000).toISOString(),operationState:report.tasks.length?'running':'waiting',operationReason:report.summary});
      this.store.message(p.id,person.name,report.summary,{id:`plan:${job.id}`,origin:'agent',senderId:person.id,recipientId:'team',runId:r.runId});
    });
  }
  async chat(scope,job,signal){
    const person=job.candidate?this.store.require('candidate','company',job.personId):this.employee(scope,job.personId);
    const m=this.store.require('message',scope,job.messageId);const conversationId=job.conversationId;
    const cwd=path.join(this.store.dir,'contexts',scope,person.id,conversationId.replace(/[^a-zA-Z0-9_-]/g,'_'));await mkdir(cwd,{recursive:true});
    const privateConversation=job.meetingId?conversationId+':'+person.id:conversationId;
    const conv=this.store.get('conversation',scope,privateConversation)||this.store.put('conversation',scope,{id:privateConversation,personId:person.id});
    const current=this.store.require('job',scope,job.id);if(!current.threadId&&conv.threadId&&!job.independent)this.store.patch('job',scope,job.id,{threadId:conv.threadId});
    const response=await this.savedAgent(scope,job,{person,cwd,conversationId,taskId:job.taskId,signal,prompt:m.text+(job.meetingId?'\n회의 대화: '+JSON.stringify(this.store.list('message',scope).filter(x=>x.channel===conversationId).slice(-20)):''),onThread:threadId=>this.store.patch('conversation',scope,privateConversation,{threadId})});
    this.store.message(scope,person.name,response.text,{id:`reply:${job.id}`,channel:conversationId,senderId:person.id,recipientId:m.senderId||'ceo',taskId:m.taskId,runId:response.runId,origin:'agent'});
    if(m.taskId){const t=this.store.require('task',scope,m.taskId);if(t.status==='waiting_info'){const checkpoints={...t.checkpoints};const key=`${t.step||'po'}:${['po','cto'].includes(t.step||'po')?0:t.cycle||0}`;if(checkpoints[key]){checkpoints[`${key}:before-reply:${job.id}`]=checkpoints[key];delete checkpoints[key];}state(this.store,scope,t.id,'queued','동료 답변 도착',{response:[t.response||'',response.text].join('\n'),checkpoints});enqueue(this.store,scope,{id:`task:${t.id}`,kind:'task',taskId:t.id});}}
  }
  async tick(){
    if(this.ticking||this.closing)return;this.ticking=true;
    try{
      this.heartbeat();
      for(const x of this.executions.values()){
        const reason=this.controlReason(x.scope,x.job.taskId,x.startedAt);if(reason)x.controller.abort(reason);
        if(x.job.kind==='evaluation'){const reason=this.evaluations.control(x.scope,x.job.evaluationId);if(reason)x.controller.abort(reason);}
        this.store.patch('job',x.scope,x.job.id,{heartbeat:now()});
      }
      if(this.store.require('settings','company','main').stopped)return;
      const projects=this.store.list('project','company').filter(p=>!this.allowedScopes||this.allowedScopes.has(p.id));
      for(let p of projects){
        if(p.paused)continue;
        if(p.operationEnabled&&p.stopAt&&Date.now()>=Date.parse(p.stopAt)){this.store.patch('project','company',p.id,{paused:true,operationState:'paused',operationReason:'자율 운영 최대 실행 시간 도달'});continue;}
        if(p.operationEnabled){
          for(const t of this.store.list('task',p.id).filter(t=>t.status==='queued'))enqueue(this.store,p.id,{id:`task:${t.id}`,kind:'task',taskId:t.id});
          const pending=this.store.list('job',p.id).some(j=>['queued','running'].includes(j.status));
          const due=!p.nextCheckAt||Date.now()>=Date.parse(p.nextCheckAt)||p.plannedVersion!==(p.wakeVersion||0);
          if(!pending&&due&&policyOf(p).objectives.length){const signature=createHash('sha256').update(JSON.stringify([p.operationRevision||0,p.wakeVersion||0,p.nextCheckAt||'first'])).digest('hex').slice(0,16);enqueue(this.store,p.id,{id:`plan:${signature}`,kind:'plan'});}
          if(!pending&&!due)this.store.patch('project','company',p.id,{operationState:'waiting',operationReason:'진행 가능한 업무 없음 · 다음 점검 또는 새 자료 대기'});
        }
      }
      for(const p of [{id:'company'},...projects]){
        if(this.allowedScopes&&!this.allowedScopes.has(p.id))continue;
        const live=this.project(p.id);if(live?.paused)continue;
        const limit=live?policyOf(live).maxConcurrent:1;
        let count=[...this.executions.values()].filter(x=>x.scope===p.id).length;
        const jobs=this.store.list('job',p.id).filter(j=>j.status==='queued').sort((a,b)=>(this.store.get('task',p.id,a.taskId)?.priority||3)-(this.store.get('task',p.id,b.taskId)?.priority||3));
        for(const j of jobs){
          if(count>=limit||this.executions.size>=4)break;
          if(j.kind==='task'){
            const t=this.store.require('task',p.id,j.taskId);
            if(terminal.has(t.status)||['waiting_info','waiting_approval','paused'].includes(t.status)){this.store.patch('job',p.id,j.id,{status:terminal.has(t.status)?'completed':t.status});continue;}
            if(t.dependsOn?.some(id=>!['review','completed'].includes(this.store.require('task',p.id,id).status)))continue;
          }
          if(j.kind==='chat'&&[...this.executions.values()].some(x=>x.scope===p.id&&x.job.conversationId===j.conversationId))continue;
          // One runner lock owns the queue; BEGIN IMMEDIATE also excludes API writers during claim.
          const claimed=this.store.transaction(()=>{if(this.store.require('job',p.id,j.id).status!=='queued')return false;this.store.patch('job',p.id,j.id,{status:'running',owner:process.pid,startedAt:now(),heartbeat:now()});return true;});
          if(claimed){this.launch(p.id,j);count++;}
        }
      }
    }finally{this.ticking=false;}
  }
  launch(scope,job){
    const controller=new AbortController(),startedAt=Date.now();this.active.set(job.id,controller);this.executions.set(job.id,{scope,job,controller,startedAt});
    if(job.kind==='task')state(this.store,scope,job.taskId,'running','담당 직원 실행');
    const p=this.project(scope);const policy=p?policyOf(p):{maxRetries:1,taskMinutes:20};
    const t=job.taskId?this.store.require('task',scope,job.taskId):null;
    const timeout=setTimeout(()=>controller.abort('업무 최대 실행 시간 도달'),Math.max(1,policy.taskMinutes*60000-(t?.elapsedMs||0)));
    const promise=(async()=>{
      if(job.kind==='task')await this.workflow.step(p,job.taskId,controller.signal);
      else if(job.kind==='plan')await this.plan(p,job,controller.signal);
      else if(job.kind==='evaluation')await this.evaluations.step(scope,job,controller.signal);
      else await this.chat(scope,job,controller.signal);
      const latest=job.kind==='task'?this.store.require('task',scope,job.taskId):null;
      const evaluation=job.kind==='evaluation'?this.store.require('evaluation',scope,job.evaluationId):null;
      this.store.patch('job',scope,job.id,{status:latest?.status==='queued'||evaluation&&!['completed','cancelled'].includes(evaluation.status)?'queued':'completed',reason:'',attempts:0,finishedAt:now()});
    })().catch(e=>{
      const latest=this.store.require('job',scope,job.id);const task=job.kind==='task'?this.store.require('task',scope,job.taskId):null;
      let status='failed',reason=e.message;
      if(controller.signal.aborted){reason=String(controller.signal.reason||'실행 중단');status=task?.status==='cancelled'?'cancelled':this.closing?'queued':'paused';if(this.closing)for(const r of this.store.list('run',scope).filter(r=>r.status==='interrupted'&&r.taskId===job.taskId))this.store.patch('run',scope,r.id,{recoveryPending:true});}
      else if(e instanceof WorkflowWait)status=e.status;
      else if(job.kind==='evaluation')status=e.evaluationStatus||'failed';
      else if((latest.attempts||0)<policy.maxRetries){status='queued';if(task){const key=`${task.step||'po'}:${['po','cto'].includes(task.step||'po')?0:task.cycle||0}`;const cp=task.checkpoints?.[key];if(cp?.report)this.workflow.checkpoint(scope,task.id,key,{report:null,runId:null});if(cp?.runId&&!this.store.get('run',scope,cp.runId)?.turnId)this.workflow.checkpoint(scope,task.id,key,{threadId:null});}}
      this.store.patch('job',scope,job.id,{status,reason,attempts:(latest.attempts||0)+1,finishedAt:now()});
      if(job.kind==='evaluation')this.store.patch('evaluation',scope,job.evaluationId,{status,reason});
      if(task){state(this.store,scope,task.id,status,reason);const latestTask=this.store.require('task',scope,task.id);if(status==='waiting_approval'||status==='waiting_info'&&p?.personal&&!this.store.list('job',scope).some(j=>j.kind==='chat'&&j.taskId===task.id&&['queued','running'].includes(j.status)))decision(this.store,scope,latestTask,e.type||'info',reason);if(status==='failed')recordSignal(this.store,scope,{id:'failure:'+job.id+':'+(latest.attempts||0),kind:'recovery',text:reason,taskId:task.id});}
      if(p&&status==='paused'&&job.kind!=='evaluation')this.store.patch('project','company',scope,{operationState:'paused',operationReason:reason,paused:true});
      if(p&&job.kind==='plan')this.store.patch('project','company',scope,{operationState:status,operationReason:reason,nextCheckAt:new Date(Date.now()+policyOf(p).checkMinutes*60000).toISOString(),plannedVersion:p.wakeVersion||0});
      this.store.message(scope,'운영 실행기',reason,{taskId:job.taskId,origin:'system',jobId:job.id});
    }).finally(()=>{
      clearTimeout(timeout);
      if(job.taskId){const t=this.store.require('task',scope,job.taskId);this.store.patch('task',scope,t.id,{elapsedMs:(t.elapsedMs||0)+Date.now()-startedAt});}
      syncExperiences(this.store,scope);
      this.active.delete(job.id);this.executions.delete(job.id);
    });
    this.executions.get(job.id).promise=promise;
  }
  async start(){await this.recover();await this.tick();this.timer=setInterval(()=>this.tick().catch(e=>{this.store.put('runner','company',{id:'main',pid:process.pid,heartbeat:now(),state:'error',error:e.message});}),500);}
  async close(){this.closing=true;clearInterval(this.timer);for(const x of this.executions.values())x.controller.abort('실행기 종료');await Promise.all([...this.executions.values()].map(x=>x.promise));this.heartbeat();}
}
