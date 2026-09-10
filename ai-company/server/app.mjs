import express from 'express';
import { randomBytes,timingSafeEqual,createHash } from 'node:crypto';
import path from 'node:path';
import {realpath} from 'node:fs/promises';
import { z } from 'zod';
import { roles,uid,now } from './store.mjs';
import { CodexClient } from './codex.mjs';
import { inspectRepository,safeRelative } from './workspaces.mjs';
import { operationSchema,policyOf,operationSummary,createTask,enqueue,state,wake,protectedCategories } from './operations.mjs';
import { experienceRoutes } from './experience-api.mjs';
import { personalRoutes } from './personal-api.mjs';
import { recordReview } from './personal.mjs';

const text=z.string().trim().min(1).max(20000);
const assignment=z.object({employeeId:z.string().uuid(),permission:z.enum(['read','write'])});
const projectSchema=z.object({name:text.max(80),goal:z.string().max(10000).default(''),repository:z.string().max(2000).default(''),stack:z.string().max(500).default(''),testCommand:z.string().max(3000).default(''),model:z.string().max(100).default(''),maxRuns:z.number().int().min(1).max(10000).default(30),tokenBudget:z.number().int().min(1000).max(100000000).nullable().default(300000),networkAccess:z.boolean().default(false),allowedPaths:z.array(z.string().refine(p=>p==='.'||safeRelative(p),'상대 경로만 입력하세요.')).min(1).default(['.']),assignments:z.array(assignment).default([])}).strict();
const safeEqual=(a,b)=>{const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length&&timingSafeEqual(left,right);};

export function createApp(store,runtime){
  const app=express();app.disable('x-powered-by');const session=randomBytes(32).toString('hex');
  // Cookies share a host across ports; independent data stores need distinct names.
  const sessionCookie='company_session_'+createHash('sha256').update(path.resolve(store.dir)).digest('hex').slice(0,16);
  app.use((req,res,next)=>{
    const host=req.headers.host||'';
    if(!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host))return res.status(403).json({error:'로컬 호스트만 허용합니다.'});
    if(req.headers.origin&&req.headers.origin!==`http://${host}`)return res.status(403).json({error:'다른 출처의 요청은 허용하지 않습니다.'});
    if(req.headers['sec-fetch-site']==='cross-site')return res.status(403).json({error:'교차 사이트 요청을 차단했습니다.'});
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');next();
  });
  app.get('/api/session',(req,res)=>{res.setHeader('Cache-Control','no-store');res.cookie(sessionCookie,session,{httpOnly:true,sameSite:'strict',path:'/'});res.json({ok:true});});
  app.use('/api',(req,res,next)=>{
    const cookie=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(sessionCookie+'='))?.slice(sessionCookie.length+1)||'';
    const bearer=(req.headers.authorization||'').replace(/^Bearer /,'');
    if(!safeEqual(cookie,session)&&!(process.env.COMPANY_API_TOKEN&&safeEqual(bearer,process.env.COMPANY_API_TOKEN)))return res.status(401).json({error:'앱을 새로고침해 로컬 세션을 시작하세요.'});
    res.setHeader('Cache-Control','no-store');next();
  });
  app.use(express.json({limit:'256kb'}));
  experienceRoutes(app,store,runtime);
  personalRoutes(app,store,runtime);
  const scope=req=>{const id=req.params.scope;if(id!=='company')store.require('project','company',id);return id;};
  app.get('/api/bootstrap',(req,res)=>{const beat=store.get('runner','company','main');res.json({roles,settings:store.require('settings','company','main'),projects:store.list('project','company'),employees:store.list('employee','company'),candidates:store.list('candidate','company'),active:[...runtime.active.keys()],runner:beat?{...beat,online:Date.now()-Date.parse(beat.heartbeat)<15000&&beat.state==='online'}:{online:false},usage:runtime.usage('company')});});
  app.get('/api/scopes/:scope',(req,res)=>{const s=scope(req);res.json({tasks:store.list('task',s),messages:store.list('message',s).slice(-500),runs:store.list('run',s),memories:store.list('memory',s),materials:store.list('material',s),decisions:store.list('decision',s),operation:s==='company'?null:operationSummary(store,store.require('project','company',s)),usage:runtime.usage(s)});});
  app.post('/api/projects',async(req,res)=>{
    const p=projectSchema.parse(req.body);
    if(p.repository){const info=await inspectRepository(p.repository);p.repository=info.root;}
    for(const a of p.assignments)store.require('employee','company',a.employeeId);
    res.status(201).json(store.put('project','company',{...p,id:uid(),createdAt:now()}));
  });
  app.put('/api/projects/:id',async(req,res)=>{
    runtime.assertIdle();const old=store.require('project','company',req.params.id);const p=projectSchema.parse(req.body);
    for(const a of p.assignments)store.require('employee','company',a.employeeId);
    if(p.repository){const info=await inspectRepository(p.repository);p.repository=info.root;}
    if(p.repository!==old.repository&&store.list('task',old.id).some(t=>t.workspace))throw new Error('작업 공간이 생성된 프로젝트의 저장소는 변경할 수 없습니다. 새 프로젝트로 등록하세요.');
    res.json(store.patch('project','company',old.id,{...p,operationEnabled:false,paused:!!old.operation,operationState:'paused',operationReason:'프로젝트 설정 변경 · 적용 범위와 한도를 확인하고 재개하세요.',operationRevision:(old.operationRevision||0)+1}));
  });
  app.post('/api/projects/:id/inspect',async(req,res)=>{const p=store.require('project','company',req.params.id);res.json(await inspectRepository(p.repository));});
  app.post('/api/candidates/:id/hire',(req,res)=>{
    const c=store.require('candidate','company',req.params.id);
    if(store.list('employee','company').some(e=>e.candidateId===c.id))throw new Error('이미 채용한 지원자입니다.');
    res.status(201).json(store.put('employee','company',{...c,id:uid(),candidateId:c.id,instructions:'',hiredAt:now()}));
  });
  app.patch('/api/employees/:id',(req,res)=>{runtime.assertIdle();const p=z.object({name:text.max(80),personality:text.max(1000),workStyle:text.max(2000),strengths:text.max(2000),weaknesses:text.max(2000),instructions:z.string().max(10000)}).strict().parse(req.body);res.json(store.patch('employee','company',req.params.id,p));});
  app.post('/api/candidates/:id/interview',(req,res)=>{const {message}=z.object({message:text}).parse(req.body);const c=store.require('candidate','company',req.params.id);res.status(202).json(runtime.startChat('company',c,message,{candidate:true}));});
  app.post('/api/candidates/compare',(req,res)=>{
    const {candidateIds,prompt}=z.object({candidateIds:z.array(z.string().uuid()).min(2).max(3),prompt:text}).parse(req.body);
    runtime.assertIdle();runtime.budget('company');const people=[...new Set(candidateIds)].map(id=>store.require('candidate','company',id));
    if(people.length<2)throw new Error('서로 다른 지원자 2명 이상을 선택하세요.');
    if(runtime.startCompare)return res.status(202).json(runtime.startCompare(people,prompt));
    const id=`compare-${uid()}`;const controller=new AbortController();runtime.active.set(id,controller);
    store.message('company','대표',`동일 과제 비교: ${prompt}`,{channel:id,origin:'user'});
    const job=(async()=>{const {mkdir}=await import('node:fs/promises');for(const person of people){if(controller.signal.aborted)break;const cwd=path.join(store.dir,'contexts','company',person.id);await mkdir(cwd,{recursive:true});await runtime.agent({scope:'company',person,prompt:`동일 과제 비교 면접입니다. 다른 지원자의 답변은 제공되지 않습니다. 다음 과제를 독립적으로 해결하고 접근 방법과 한계를 설명하세요.\n${prompt}`,cwd,conversationId:id,signal:controller.signal});}})();
    job.catch(e=>store.message('company','운영 시스템',e.message,{channel:id,origin:'system'})).finally(()=>runtime.active.delete(id));res.status(202).json({conversationId:id});
  });
  // Stable, project-explicit endpoint for future Jarvis callers.
  app.post('/api/scopes/:scope/employees/:id/messages',(req,res)=>{const s=scope(req);const {message,channel}=z.object({message:text,channel:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).default('general')}).parse(req.body);res.status(202).json(runtime.startChat(s,runtime.employee(s,req.params.id),message,{channel}));});
  app.post('/api/scopes/:scope/messages',(req,res)=>{
    const s=scope(req);
    const {message,taskId,recipientId,channel}=z.object({message:text,taskId:z.string().optional(),recipientId:z.string().optional(),channel:z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).default('general')}).parse(req.body);
    const meeting=channel.startsWith('meeting-')?store.require('meeting',s,channel.slice(8)):null;
    if(meeting&&meeting.status!=='open')throw new Error('진행 중인 회의에서 메시지를 보내세요.');
    if(meeting&&recipientId&&!meeting.participantIds.includes(recipientId))throw new Error('이 회의의 참여 직원을 선택하세요.');
    if(taskId)store.require('task',s,taskId);
    const recipients=meeting?(recipientId?[recipientId]:meeting.participantIds):(recipientId?[recipientId]:[]);
    // Validate every recipient before persisting anything; one removed assignee must not trigger a partial call.
    for(const id of recipients)runtime.employee(s,id);
    const m=store.transaction(()=>{
      const saved=store.message(s,'대표',message,{origin:'user',senderId:'ceo',taskId,recipientId,channel,...(meeting?{meetingId:meeting.id,recipientId:recipientId||'team'}:{})});
      if(meeting){for(const personId of recipients)enqueue(store,s,{id:'message:'+saved.id+':'+personId,kind:'chat',personId,messageId:saved.id,taskId:taskId||meeting.taskId||undefined,conversationId:channel,meetingId:meeting.id});}
      else if(recipientId)enqueue(store,s,{id:'message:'+saved.id,kind:'chat',personId:recipientId,messageId:saved.id,taskId,conversationId:'task-chat-'+(taskId||'general')+'-'+recipientId});
      wake(store,s,'대표 메시지 도착');return saved;
    });res.status(201).json(m);
  });
  app.post('/api/scopes/:scope/memories',(req,res)=>{const s=scope(req);const {text:content}=z.object({text}).parse(req.body);res.status(201).json(store.put('memory',s,{id:uid(),text:content,createdAt:now(),source:'대표'}));});
  app.post('/api/scopes/:scope/tasks',(req,res)=>{const s=scope(req);if(s==='company')throw new Error('업무를 등록하려면 프로젝트를 선택하세요.');res.status(201).json(createTask(store,s,req.body));});
  app.post('/api/scopes/:scope/tasks/:id/start',(req,res)=>res.status(202).json(runtime.startTask(scope(req),req.params.id)));
  app.get('/api/scopes/:scope/operation',(req,res)=>{const s=scope(req);res.json(operationSummary(store,store.require('project','company',s)));});
  app.put('/api/scopes/:scope/operation',(req,res)=>{const s=scope(req);const p=store.require('project','company',s);if(store.list('job',s).some(j=>j.status==='running'))throw new Error('이 프로젝트를 일시정지하고 실행 종료를 기다린 뒤 수정하세요.');const operation=operationSchema.parse(req.body);res.json(store.patch('project','company',s,{operation,operationEnabled:false,paused:true,operationState:'paused',operationReason:'설정 변경 후 범위와 한도를 확인하고 시작하세요.',operationRevision:(p.operationRevision||0)+1}));});
  app.post('/api/scopes/:scope/operation/start',(req,res)=>{
    const s=scope(req),p=store.require('project','company',s),policy=policyOf(p);const body=z.object({revision:z.number().int()}).parse(req.body);
    if(body.revision!==(p.operationRevision||0))throw new Error('운영 설정이 변경되었습니다. 최신 범위와 한도를 다시 확인하세요.');
    if(!policy.objectives.length||!policy.scope.trim())throw new Error('운영 목표·완료 기준과 허용 범위를 먼저 저장하세요.');
    runtime.budget(s);if(store.list('job',s).some(j=>j.status==='running'))throw new Error('현재 실행이 끝나면 재개하세요.');
    const consent={projectId:s,name:p.name,policy,allowedPaths:p.allowedPaths,assignments:p.assignments,model:p.model,maxRuns:p.maxRuns,tokenBudget:p.tokenBudget,confirmedAt:now(),revision:body.revision};
    store.patch('project','company',s,{operationEnabled:true,paused:false,operationState:'running',operationReason:'대표가 확인한 범위에서 운영',operationConsent:consent,stopAt:new Date(Date.now()+policy.sessionMinutes*60000).toISOString(),nextCheckAt:null});
    for(const t of store.list('task',s))if(t.status==='paused'){
      // Time/call limits are cumulative per task. Resuming does not reset them.
      state(store,s,t.id,'queued','대표가 운영 재개');enqueue(store,s,{id:`task:${t.id}`,kind:'task',taskId:t.id});
    }
    for(const j of store.list('job',s))if(j.status==='paused')enqueue(store,s,{...j});wake(store,s,'대표가 운영 시작/재개');res.json(consent);
  });
  app.post('/api/scopes/:scope/operation/pause',(req,res)=>{const s=scope(req);res.json(store.patch('project','company',s,{paused:true,operationState:'paused',operationReason:'대표가 일시정지'}));});
  app.post('/api/scopes/:scope/materials',(req,res)=>{const s=scope(req);if(s==='company')throw new Error('프로젝트를 선택하세요.');const body=z.object({title:text.max(200),text,source:z.string().max(2000).default('대표 제공 자료')}).strict().parse(req.body);const m=store.put('material',s,{id:uid(),...body,createdAt:now()});wake(store,s,'실제 자료 등록');res.status(201).json(m);});
  app.post('/api/scopes/:scope/tasks/:id/respond',(req,res)=>{
    const s=scope(req),t=store.require('task',s,req.params.id);const body=z.object({response:text,materials:z.array(z.string()).default([])}).parse(req.body);
    if(t.status!=='waiting_info')throw new Error('정보 대기 업무에만 답변할 수 있습니다.');for(const id of body.materials)store.require('material',s,id);
    const checkpoints={...t.checkpoints};const key=`${t.step||'po'}:${['po','cto'].includes(t.step||'po')?0:t.cycle||0}`;if(checkpoints[key]){checkpoints[`${key}:before-response:${Date.now()}`]=checkpoints[key];delete checkpoints[key];}
    state(store,s,t.id,'queued','대표 정보 제공',{response:[t.response||'',body.response].join('\n'),materials:[...new Set([...(t.materials||[]),...body.materials])],checkpoints});enqueue(store,s,{id:`task:${t.id}`,kind:'task',taskId:t.id});wake(store,s,'정보 대기 해제');res.json(store.require('task',s,t.id));
  });
  app.post('/api/scopes/:scope/decisions/:id/resolve',(req,res)=>{
    const s=scope(req),d=store.require('decision',s,req.params.id);const {action,response}=z.object({action:z.enum(['approve','reject']),response:text}).parse(req.body);if(d.status!=='pending')throw new Error('이미 처리한 결정입니다.');
    const t=store.require('task',s,d.taskId);if(!['waiting_info','waiting_approval'].includes(t.status))throw new Error('현재 답변 대기 중인 업무가 아닙니다.');store.patch('decision',s,d.id,{status:action==='approve'?'approved':'rejected',response,decidedAt:now(),decidedBy:'ceo'});
    if(action==='reject')state(store,s,t.id,'cancelled',response);
    else if(d.type==='external'||protectedCategories.includes(t.category))state(store,s,t.id,'waiting_approval','승인 기록을 저장했습니다. 외부 실행 커넥터가 없어 대표의 직접 실행과 증거 첨부가 필요합니다.');
    else {
      const checkpoints={...t.checkpoints};const key=`${t.step||'po'}:${['po','cto'].includes(t.step||'po')?0:t.cycle||0}`;
      if(checkpoints[key]){checkpoints[`${key}:before-decision:${Date.now()}`]=checkpoints[key];delete checkpoints[key];}
      state(store,s,t.id,'queued','대표 결정 반영',{scopeApproved:d.type==='scope'?true:t.scopeApproved,response:[t.response||'',response].join('\n'),checkpoints});enqueue(store,s,{id:`task:${t.id}`,kind:'task',taskId:t.id});
    }
    res.json(store.require('task',s,t.id));
  });
  app.post('/api/scopes/:scope/tasks/:id/cancel',(req,res)=>{const s=scope(req);const t=store.require('task',s,req.params.id);if(['review','completed'].includes(t.status))throw new Error('완료 결과는 취소하지 않습니다.');res.json(state(store,s,t.id,'cancelled','대표가 취소'));});
  app.post('/api/scopes/:scope/tasks/:id/accept',(req,res)=>{const s=scope(req);const t=store.require('task',s,req.params.id);if(t.status!=='review'||t.verification!=='passed'||!t.evidence)throw new Error('검증과 CTO 검토 증거가 있는 결과만 완료 처리할 수 있습니다.');recordReview(store,s,t,{outcome:'accepted',technicalIntervention:'unknown'});res.json(state(store,s,t.id,'completed','대표가 결과 확인',{reviewStatus:'accepted',acceptedAt:now()}));});
  app.get('/api/scopes/:scope/tasks/:id/evidence',async(req,res)=>{
    const s=scope(req),t=store.require('task',s,req.params.id);if(!t.evidence||!t.workspace?.dir)throw new Error('아직 완료 증거가 없습니다.');
    const root=await realpath(path.join(store.dir,'projects',s,'tasks')),workspace=await realpath(t.workspace.dir),file=await realpath(t.evidence);
    const inside=(parent,child)=>{const relative=path.relative(parent,child);return relative!==''&&!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep);};
    if(!inside(root,workspace)||!inside(workspace,file))throw new Error('이 업무의 검증 근거 경로가 아닙니다.');
    // The private store intentionally lives in .local; allow that directory only after scoped realpath checks.
    res.download(file,'evidence.json',{dotfiles:'allow'});
  });
  app.get('/api/scopes/:scope/runs/:id/events',(req,res)=>{const s=scope(req);store.require('run',s,req.params.id);res.json(store.events(s,req.params.id,Number(req.query.after)||0));});
  app.post('/api/stop',(req,res)=>res.json(runtime.stopAll()));
  app.post('/api/resume',(req,res)=>{runtime.assertIdle();res.json(store.patch('settings','company','main',{stopped:false}));});
  app.patch('/api/settings',(req,res)=>{runtime.assertIdle();const body=z.object({name:text.max(80),rules:text,maxRuns:z.number().int().min(1).max(10000),tokenBudget:z.number().int().min(1000).max(100000000).nullable()}).strict().parse(req.body);res.json(store.patch('settings','company','main',body));});
  app.get('/api/runtime/status',async(req,res)=>{
    const client=new CodexClient(store.dir);
    try{await client.start();const account=await client.request('account/read',{refreshToken:false});const rate=await client.request('account/rateLimits/read').catch(()=>null);const models=await client.request('model/list',{}).catch(()=>({data:[]}));res.json({connected:true,authType:account.account?.type||null,plan:account.account?.planType||null,rateLimits:rate,models:models.data?.map(m=>({id:m.id,model:m.model,name:m.displayName,isDefault:m.isDefault}))||[]});}catch(e){res.json({connected:false,error:e.message});}finally{client.close();}
  });
  app.use('/api',(req,res)=>res.status(404).json({error:'지원하지 않는 API입니다.'}));
  app.use((error,req,res,next)=>{res.status(error instanceof z.ZodError?400:409).json({error:error instanceof z.ZodError?error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('\n'):error.message});});
  return app;
}
