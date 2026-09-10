import { z } from 'zod';
import { uid, now } from './store.mjs';
import { createTask, enqueue, policyOf, state, wake, protectedCategories } from './operations.mjs';
import { activityNames, configurePersonal, syncGoals, liaison, projectPeople, createExperiment, addTime, startTimer, stopTimer, timerBody, timeBody, personalMetrics, decisionInbox, recordReview, assessGoal, addBaseline, applyImprovement, recordSignal } from './personal.mjs';

const text=z.string().trim().min(1).max(4000);
export function resolveDecisionGroup(store,scope,key,input){
  const b=z.object({action:z.enum(['approve','reject']),response:text}).strict().parse(input);
  const group=decisionInbox(store,scope).find(g=>g.id===key);if(!group)throw new Error('이미 처리했거나 이 프로젝트의 결정이 아닙니다.');
  return store.transaction(()=>group.decisionIds.map(id=>{
    const d=store.require('decision',scope,id),t=store.require('task',scope,d.taskId);
    if(!['waiting_info','waiting_approval'].includes(t.status))throw new Error('현재 답변을 기다리는 업무가 아닙니다. 새 상태를 확인하세요.');
    store.patch('decision',scope,id,{status:b.action==='approve'?'approved':'rejected',response:b.response,decidedAt:now(),decidedBy:'ceo'});
    if(b.action==='reject')return state(store,scope,t.id,'cancelled',b.response);
    if(d.type==='external'||protectedCategories.includes(t.category))return state(store,scope,t.id,'waiting_approval','승인 기록 저장 · 외부 작업은 대표의 직접 실행과 증거가 필요합니다.');
    const checkpoints={...t.checkpoints},cpKey=`${t.step||'po'}:${['po','cto'].includes(t.step||'po')?0:t.cycle||0}`;
    if(checkpoints[cpKey]){checkpoints[`${cpKey}:decision:${id}`]=checkpoints[cpKey];delete checkpoints[cpKey];}
    const result=state(store,scope,t.id,'queued','대표 결정 반영',{scopeApproved:d.type==='scope'?true:t.scopeApproved,response:[t.response||'',b.response].join('\n'),checkpoints});
    enqueue(store,scope,{id:`task:${t.id}`,kind:'task',taskId:t.id});wake(store,scope,'대표 답변');return result;
  }));
}

export function reviewResult(store,scope,id,input){
  const t=store.require('task',scope,id);
  if(!['review','completed'].includes(t.status)||t.verification!=='passed'||!t.evidence)throw new Error('검증 근거가 있는 결과를 먼저 확인하세요.');
  if(input.outcome==='accepted'&&t.status==='completed')throw new Error('이미 수용한 결과입니다.');
  if(input.outcome==='changes'&&!['error','requirements_change'].includes(input.cause))throw new Error('오류 수정과 요구사항 변경을 구분하세요.');
  return store.transaction(()=>{
    const review=recordReview(store,scope,t,input);
    if(review.outcome==='accepted')return {review,task:state(store,scope,id,'completed','대표가 결과 수용',{acceptedAt:now(),reviewStatus:'accepted'})};
    const {title,description,kind,category,priority,goalId,acceptance,materials,requiredRoles,purpose}=t;
    const task=createTask(store,scope,{title:`수정: ${title}`.slice(0,200),description:`원래 요청: ${description}\n대표 피드백: ${review.notes}\n이전 결과: ${t.result?.repository||t.evidence}`,kind,category,priority,goalId,acceptance,materials,requiredRoles,purpose:purpose||'work'},{parentTaskId:id,reworkCause:review.cause,teamMode:t.teamMode,goalSnapshot:t.goalSnapshot});
    store.put('rework',scope,{id:uid(),parentTaskId:id,taskId:task.id,cause:review.cause,wasCompleted:t.status==='completed',reviewId:review.id,createdAt:now()});
    state(store,scope,id,'reopened','대표 피드백에 따른 후속 업무 생성',{reopenedTaskId:task.id});
    return {review,task};
  });
}

export function personalRoutes(app,store,runtime){
  const scope=req=>{const s=req.params.scope;if(s!=='company')store.require('project','company',s);return s;};
  const project=req=>{const s=scope(req);if(s==='company')throw new Error('프로젝트를 선택하세요.');return s;};
  const base='/api/scopes/:scope/personal';
  app.get(base,(req,res)=>{
    const s=scope(req),p=s==='company'?null:store.require('project','company',s);if(p)syncGoals(store,p);
    const tasks=store.list('task',s),timer=store.get('timer','company','main');
    res.json({settings:p?.personal||{},metrics:personalMetrics(store,s),activities:activityNames,inbox:p?decisionInbox(store,s):[],timer:timer?.scope===s?timer:timer?.status==='running'?{status:'other_scope'}:null,
      employees:p?projectPeople(store,s).map(e=>({id:e.id,name:e.name,role:e.role,tasks:tasks.filter(t=>t.assignedEmployeeId===e.id||t.teamPlan?.ownerId===e.id).map(t=>({id:t.id,title:t.title,status:t.status,stage:t.stage})),coordinator:liaison(store,p)?.id===e.id,technicalCoordinator:liaison(store,p,true)?.id===e.id})):[],
      tasks,meetings:store.list('meeting',s),signals:store.list('operationSignal',s),notifications:store.list('notification',s).filter(n=>!n.read),usage:runtime.usage(s),stopped:store.require('settings','company','main').stopped});
  });
  app.put(base+'/settings',(req,res)=>res.json(configurePersonal(store,project(req),req.body)));
  app.post(base+'/experiment',(req,res)=>res.status(201).json(createExperiment(store,project(req),req.body)));
  app.post(base+'/goals',(req,res)=>{
    const s=project(req),p=store.require('project','company',s),policy=policyOf(p);
    const b=z.object({text,acceptance:text,priority:z.number().int().min(1).max(5),taskType:z.string().min(1).max(100),size:z.enum(['small','medium','large'])}).strict().parse(req.body);
    if(policy.objectives.length>=20)throw new Error('목표는 최대 20개입니다. 기존 목표를 정리하세요.');
    const id=uid(),g={id,text:b.text,acceptance:b.acceptance,priority:b.priority};
    const saved=store.patch('project','company',s,{personal:{...p.personal},operation:{...policy,objectives:[...policy.objectives,g]},operationEnabled:false,paused:true,operationRevision:(p.operationRevision||0)+1,operationReason:'새 목표 저장 · 자율 운영에서 목표·범위·한도를 확인하고 재개하세요.'});
    syncGoals(store,saved);store.put('goalContext',s,{id,taskType:b.taskType,size:b.size,createdAt:now()});
    store.message(s,'대표',`${b.text}\n완료 기준: ${b.acceptance}`,{senderId:'ceo',recipientId:liaison(store,saved)?.id||'po',goalId:id,origin:'user'});
    wake(store,s,'대표 목표 등록');res.status(201).json(g);
  });
  app.post(base+'/time',(req,res)=>res.status(201).json(addTime(store,scope(req),req.body)));
  app.post(base+'/timer/start',(req,res)=>res.json(startTimer(store,scope(req),timerBody.parse(req.body))));
  app.post(base+'/timer/stop',(req,res)=>res.json(stopTimer(store,scope(req),z.object({minutes:z.number().min(0).max(10080).optional(),note:z.string().max(3000).optional()}).strict().parse(req.body))));
  app.post(base+'/time/:id/void',(req,res)=>{const s=scope(req);const {reason}=z.object({reason:text}).strict().parse(req.body);res.json(store.patch('intervention',s,req.params.id,{voided:true,voidReason:reason,voidedAt:now()}));});
  app.post(base+'/coverage',(req,res)=>{const s=scope(req),b=z.object({date:timeBody.shape.date,complete:z.boolean()}).strict().parse(req.body);res.json(store.put('timeCoverage',s,{id:b.date,...b,confirmedAt:now(),confirmedBy:'ceo'}));});
  app.post(base+'/decisions/:id',(req,res)=>res.json(resolveDecisionGroup(store,project(req),req.params.id,req.body)));
  app.post(base+'/results/:id',(req,res)=>res.json(reviewResult(store,project(req),req.params.id,req.body)));
  app.post(base+'/goals/:id/assess',(req,res)=>res.json(assessGoal(store,project(req),req.params.id,req.body)));
  app.post(base+'/baseline',(req,res)=>res.status(201).json(addBaseline(store,project(req),req.body)));
  app.put(base+'/improvements/:id',(req,res)=>res.json(applyImprovement(store,project(req),req.params.id,req.body)));
  app.post(base+'/notifications/:id/read',(req,res)=>res.json(store.patch('notification',project(req),req.params.id,{read:true,readAt:now()})));
  app.post(base+'/signals',(req,res)=>{const s=project(req);const b=z.object({kind:z.enum(['question','recovery','feedback']),text,taskId:z.string().optional(),employeeId:z.string().optional()}).strict().parse(req.body);if(b.taskId)store.require('task',s,b.taskId);if(b.employeeId)runtime.employee(s,b.employeeId);res.status(201).json(recordSignal(store,s,b));});
  app.post(base+'/meetings',(req,res)=>{
    const s=project(req),b=z.object({agenda:text,participantIds:z.array(z.string()).min(1).max(11),taskId:z.string().default('')}).strict().parse(req.body);
    const people=[...new Set(b.participantIds)].map(id=>runtime.employee(s,id));if(b.taskId)store.require('task',s,b.taskId);
    const meeting=store.put('meeting',s,{id:uid(),...b,participantIds:people.map(e=>e.id),status:'draft',createdAt:now()});res.status(201).json(meeting);
  });
  app.post(base+'/meetings/:id/start',(req,res)=>{
    const s=project(req),m=store.require('meeting',s,req.params.id);if(m.status!=='draft')throw new Error('이미 시작했거나 끝난 회의입니다.');runtime.budget(s);
    const people=m.participantIds.map(id=>runtime.employee(s,id));
    store.transaction(()=>{for(const e of people){const message=store.message(s,'대표',`회의 안건: ${m.agenda}\n담당 직무 관점의 확인·추천·다른 선택지와 필요한 업무를 짧게 보고하세요.`,{channel:'meeting-'+m.id,senderId:'ceo',recipientId:e.id,taskId:m.taskId||undefined,meetingId:m.id,origin:'user'});enqueue(store,s,{id:'message:'+message.id,kind:'chat',messageId:message.id,personId:e.id,taskId:m.taskId||undefined,conversationId:'meeting-'+m.id,meetingId:m.id});}store.patch('meeting',s,m.id,{status:'open',startedAt:now()});});
    res.json(store.require('meeting',s,m.id));
  });
  app.post(base+'/meetings/:id/close',(req,res)=>{
    const s=project(req),m=store.require('meeting',s,req.params.id),b=z.object({decisions:text,actions:z.array(z.object({employeeId:z.string(),taskId:z.string(),responsibility:text})).max(30)}).strict().parse(req.body);
    if(m.status!=='open')throw new Error('진행 중인 회의를 선택하세요.');
    if(store.list('job',s).some(j=>j.meetingId===m.id&&['queued','running'].includes(j.status)))throw new Error('참여 직원의 응답이 끝난 뒤 회의를 정리하세요.');
    for(const a of b.actions){runtime.employee(s,a.employeeId);store.require('task',s,a.taskId);}
    res.json(store.patch('meeting',s,m.id,{...b,status:'closed',closedAt:now()}));
  });
}
