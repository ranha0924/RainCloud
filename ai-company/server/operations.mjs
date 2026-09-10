import { z } from 'zod';
import { uid, now } from './store.mjs';
import { Runtime } from './runtime.mjs';
import { goalSnapshot, enrichDecision } from './personal.mjs';

export const categories=['bugfix','documentation','ui','database','requirements','marketing','accounting','hr','feature','direction','external_send','spend','deploy','delete_data','permissions'];
export const protectedCategories=['external_send','spend','deploy','delete_data','permissions'];
export const operationSchema=z.object({
  objectives:z.array(z.object({id:z.string().min(1).max(100),text:z.string().min(1).max(5000),acceptance:z.string().min(1).max(5000),priority:z.number().int().min(1).max(5)})).max(20).default([]),
  allowedCategories:z.array(z.enum(categories)).default(['bugfix','documentation']),
  scope:z.string().max(10000).default(''),
  maxConcurrent:z.number().int().min(1).max(4).default(1),
  maxRetries:z.number().int().min(0).max(5).default(1),
  taskMinutes:z.number().min(0.01).max(240).default(20),
  turnMinutes:z.number().min(0.01).max(30).default(5),
  maxTaskCalls:z.number().int().min(1).max(100).default(16),
  sessionMinutes:z.number().min(0.01).max(1440).default(120),
  checkMinutes:z.number().min(1).max(1440).default(30),
  maxTasksPerPlan:z.number().int().min(1).max(10).default(3),
  maxMessageHops:z.number().int().min(1).max(20).default(6),
}).strict();
export const policyOf=p=>operationSchema.parse(p.operation||{});
export const taskSchema=z.object({title:z.string().trim().min(1).max(200),description:z.string().trim().min(1).max(20000),kind:z.enum(['code','research']).default('code'),category:z.enum(categories).default('bugfix'),priority:z.number().int().min(1).max(5).default(3),goalId:z.string().max(100).default(''),acceptance:z.array(z.string().max(3000)).max(30).default([]),dependsOn:z.array(z.string()).max(30).default([]),materials:z.array(z.string().max(200)).max(30).default([]),requiredRoles:z.array(z.string()).max(11).default([])}).strict();
export const terminal=new Set(['review','completed','failed','cancelled','reopened']);
export function state(store,scope,id,status,reason='',extra={}){
  const task=store.require('task',scope,id);
  if(task.status!==status)for(const d of store.list('decision',scope))if(d.taskId===id&&d.status==='pending')store.patch('decision',scope,d.id,{status:'superseded',resolvedAt:now(),resolutionReason:reason||`업무 상태 변경: ${status}`});
  const history=[...(task.stateHistory||[]),{from:task.status,to:status,reason,time:now()}];
  const clearRequest=(['waiting_info','waiting_approval'].includes(task.status)&&status!==task.status)||(extra.step&&extra.step!==task.step);
  return store.patch('task',scope,id,{status,reason,error:['failed','waiting_info','waiting_approval'].includes(status)?reason:null,stateHistory:history,...(clearRequest?{decisionRequest:null}:{}),...extra});
}
export function decision(store,scope,task,type,reason,options=['범위를 명확히 한 뒤 재개','보류 또는 취소']){
  const id=`${task.id}:${type}:${task.cycle||0}:${task.step||'po'}`;
  const old=store.get('decision',scope,id);if(old?.status==='pending')return old;
  return enrichDecision(store,scope,{id,projectId:scope,taskId:task.id,type,reason,options,status:'pending',createdAt:now()},task.decisionRequest||{});
}
export function wake(store,scope,reason){
  if(scope==='company')return;
  const p=store.require('project','company',scope);
  store.patch('project','company',scope,{wakeVersion:(p.wakeVersion||0)+1,wakeReason:reason});
}
export function createTask(store,scope,input,extra={}){
  const {purpose='work',...rest}=input;
  if(!['work','practice'].includes(purpose))throw new Error('실제 업무 또는 연습을 선택하세요. 평가는 비교 평가에서 생성합니다.');
  const body={...taskSchema.parse(rest),purpose};
  for(const id of body.dependsOn)store.require('task',scope,id);
  for(const id of body.materials)store.require('material',scope,id);
  const snapshot=body.goalId?goalSnapshot(store,scope,body.goalId):null;
  const task=store.put('task',scope,{...body,id:uid(),projectId:scope,status:'queued',stage:'po',step:'po',cycle:0,checkpoints:{},goalSnapshot:snapshot,createdAt:now(),...extra});
  wake(store,scope,'업무 생성');return task;
}
export function enqueue(store,scope,job){
  const old=store.get('job',scope,job.id);
  if(old&&['queued','running','completed'].includes(old.status))return old;
  return store.put('job',scope,{createdAt:now(),attempts:0,...old,...job,status:'queued',reason:''});
}

// The HTTP process only writes durable commands; model work belongs to runner.mjs.
export class QueueGateway extends Runtime{
  get active(){return new Map([{id:'company'},...this.store.list('project','company')].flatMap(p=>this.store.list('job',p.id).filter(j=>j.status==='running').map(j=>[j.id,j])));}
  set active(_value){}
  assertIdle(){if(this.active.size)throw new Error('실행 중인 업무를 일시정지한 뒤 설정을 변경하세요.');}
  startTask(scope,id){
    const p=this.store.require('project','company',scope);if(p.paused)throw new Error('프로젝트가 일시정지되어 있습니다. 자율 운영 화면에서 적용 범위를 확인하고 재개하세요.');const t=this.store.require('task',scope,id);
    if(terminal.has(t.status))throw new Error('완료·검토·실패·취소 업무는 다시 실행하지 않습니다. 필요한 수정은 새 업무로 등록하세요.');
    if(['waiting_approval','waiting_info'].includes(t.status))throw new Error('결정함에서 답변하거나 필요한 정보를 추가하세요.');
    if(this.store.get('job',scope,`task:${id}`)?.status==='running')return t;
    this.budget(scope);state(this.store,scope,id,'queued','대표가 실행 요청');
    enqueue(this.store,scope,{id:`task:${id}`,kind:'task',taskId:id});return this.store.require('task',scope,id);
  }
  startChat(scope,person,text,{candidate=false,channel='general'}={}){
    this.budget(scope);if(!candidate)this.employee(scope,person.id);
    const conversationId=`${candidate?'interview':'chat'}-${person.id}-${channel}`;
    const m=this.store.message(scope,'대표',text,{channel:conversationId,origin:'user',senderId:'ceo',recipientId:person.id,employeeId:person.id});
    enqueue(this.store,scope,{id:`message:${m.id}`,kind:'chat',messageId:m.id,personId:person.id,candidate,conversationId});
    wake(this.store,scope,'동료 메시지 도착');return {conversationId};
  }
  startCompare(people,prompt){
    this.budget('company');const id=`compare-${uid()}`;
    this.store.message('company','대표',`동일 과제 비교: ${prompt}`,{channel:id,origin:'user'});
    for(const person of people){const m=this.store.message('company','대표',prompt,{channel:id,origin:'user',recipientId:person.id});enqueue(this.store,'company',{id:`message:${m.id}`,kind:'chat',candidate:true,personId:person.id,messageId:m.id,conversationId:id,independent:true});}
    return {conversationId:id};
  }
  stopAll(){this.store.patch('settings','company','main',{stopped:true});return {stopped:true,active:this.active.size};}
}

export function operationSummary(store,p){
  const tasks=store.list('task',p.id),jobs=store.list('job',p.id);
  const group=statuses=>tasks.filter(t=>statuses.includes(t.status)).map(t=>({id:t.id,title:t.title,status:t.status,reason:t.reason,stage:t.stage,result:t.result?.repository}));
  const beat=store.get('runner','company','main');
  const active=jobs.some(j=>j.status==='running');
  return {policy:policyOf(p),state:p.paused?'paused':active?'running':p.operationState||'paused',reason:p.paused?p.operationReason:active?'담당 직원이 업무를 진행하고 있습니다.':p.operationReason||'자율 운영을 시작하세요.',runner:beat?{...beat,online:Date.now()-Date.parse(beat.heartbeat)<15000&&beat.state==='online'}:null,
    completed:group(['review','completed']),failed:group(['failed']),waiting:group(['waiting_info','waiting_approval']),next:group(['queued']),active:group(['running']),
    decisions:store.list('decision',p.id).filter(d=>d.status==='pending'),jobs:jobs.map(({prompt,...j})=>j),lastPlan:p.lastPlan,reviewedSettings:p.operationConsent};
}
