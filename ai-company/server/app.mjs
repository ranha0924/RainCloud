import express from 'express';
import { randomBytes,timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { roles,uid,now } from './store.mjs';
import { CodexClient } from './codex.mjs';
import { inspectRepository,safeRelative } from './workspaces.mjs';

const text=z.string().trim().min(1).max(20000);
const assignment=z.object({employeeId:z.string().uuid(),permission:z.enum(['read','write'])});
const projectSchema=z.object({name:text.max(80),goal:z.string().max(10000).default(''),repository:z.string().max(2000).default(''),stack:z.string().max(500).default(''),testCommand:z.string().max(3000).default(''),model:z.string().max(100).default(''),maxRuns:z.number().int().min(1).max(10000).default(30),tokenBudget:z.number().int().min(1000).max(100000000).default(300000),networkAccess:z.boolean().default(false),allowedPaths:z.array(z.string().refine(p=>p==='.'||safeRelative(p),'상대 경로만 입력하세요.')).min(1).default(['.']),assignments:z.array(assignment).default([])}).strict();
const safeEqual=(a,b)=>{const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length&&timingSafeEqual(left,right);};

export function createApp(store,runtime){
  const app=express();app.disable('x-powered-by');const session=randomBytes(32).toString('hex');
  app.use((req,res,next)=>{
    const host=req.headers.host||'';
    if(!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host))return res.status(403).json({error:'로컬 호스트만 허용합니다.'});
    if(req.headers.origin&&req.headers.origin!==`http://${host}`)return res.status(403).json({error:'다른 출처의 요청은 허용하지 않습니다.'});
    if(req.headers['sec-fetch-site']==='cross-site')return res.status(403).json({error:'교차 사이트 요청을 차단했습니다.'});
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');next();
  });
  app.get('/api/session',(req,res)=>{res.setHeader('Cache-Control','no-store');res.cookie('company_session',session,{httpOnly:true,sameSite:'strict',path:'/'});res.json({ok:true});});
  app.use('/api',(req,res,next)=>{
    const cookie=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('company_session='))?.slice(16)||'';
    const bearer=(req.headers.authorization||'').replace(/^Bearer /,'');
    if(!safeEqual(cookie,session)&&!(process.env.COMPANY_API_TOKEN&&safeEqual(bearer,process.env.COMPANY_API_TOKEN)))return res.status(401).json({error:'앱을 새로고침해 로컬 세션을 시작하세요.'});
    res.setHeader('Cache-Control','no-store');next();
  });
  app.use(express.json({limit:'256kb'}));
  const scope=req=>{const id=req.params.scope;if(id!=='company')store.require('project','company',id);return id;};
  app.get('/api/bootstrap',(req,res)=>res.json({roles,settings:store.require('settings','company','main'),projects:store.list('project','company'),employees:store.list('employee','company'),candidates:store.list('candidate','company'),active:[...runtime.active.keys()],usage:runtime.usage('company')}));
  app.get('/api/scopes/:scope',(req,res)=>{const s=scope(req);res.json({tasks:store.list('task',s),messages:store.list('message',s).slice(-500),runs:store.list('run',s),memories:store.list('memory',s),usage:runtime.usage(s)});});
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
    res.json(store.patch('project','company',old.id,p));
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
    const id=`compare-${uid()}`;const controller=new AbortController();runtime.active.set(id,controller);
    store.message('company','대표',`동일 과제 비교: ${prompt}`,{channel:id,origin:'user'});
    const job=(async()=>{const {mkdir}=await import('node:fs/promises');for(const person of people){if(controller.signal.aborted)break;const cwd=path.join(store.dir,'contexts','company',person.id);await mkdir(cwd,{recursive:true});await runtime.agent({scope:'company',person,prompt:`동일 과제 비교 면접입니다. 다른 지원자의 답변은 제공되지 않습니다. 다음 과제를 독립적으로 해결하고 접근 방법과 한계를 설명하세요.\n${prompt}`,cwd,conversationId:id,signal:controller.signal});}})();
    job.catch(e=>store.message('company','운영 시스템',e.message,{channel:id,origin:'system'})).finally(()=>runtime.active.delete(id));res.status(202).json({conversationId:id});
  });
  // Stable, project-explicit endpoint for future Jarvis callers.
  app.post('/api/scopes/:scope/employees/:id/messages',(req,res)=>{const s=scope(req);const {message,channel}=z.object({message:text,channel:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).default('general')}).parse(req.body);res.status(202).json(runtime.startChat(s,runtime.employee(s,req.params.id),message,{channel}));});
  app.post('/api/scopes/:scope/messages',(req,res)=>{const s=scope(req);const {message}=z.object({message:text}).parse(req.body);res.status(201).json(store.message(s,'대표',message,{origin:'user'}));});
  app.post('/api/scopes/:scope/memories',(req,res)=>{const s=scope(req);const {text:content}=z.object({text}).parse(req.body);res.status(201).json(store.put('memory',s,{id:uid(),text:content,createdAt:now(),source:'대표'}));});
  app.post('/api/scopes/:scope/tasks',(req,res)=>{const s=scope(req);if(s==='company')throw new Error('개발 업무를 등록하려면 프로젝트를 선택하세요.');const body=z.object({title:text.max(200),description:text}).parse(req.body);res.status(201).json(store.put('task',s,{...body,id:uid(),status:'queued',stage:'po',checkpoints:{},createdAt:now()}));});
  app.post('/api/scopes/:scope/tasks/:id/start',(req,res)=>res.status(202).json(runtime.startTask(scope(req),req.params.id)));
  app.get('/api/scopes/:scope/runs/:id/events',(req,res)=>{const s=scope(req);store.require('run',s,req.params.id);res.json(store.events(s,req.params.id,Number(req.query.after)||0));});
  app.post('/api/stop',(req,res)=>res.json(runtime.stopAll()));
  app.post('/api/resume',(req,res)=>{runtime.assertIdle();res.json(store.patch('settings','company','main',{stopped:false}));});
  app.patch('/api/settings',(req,res)=>{runtime.assertIdle();const body=z.object({name:text.max(80),rules:text,maxRuns:z.number().int().min(1).max(10000),tokenBudget:z.number().int().min(1000).max(100000000)}).strict().parse(req.body);res.json(store.patch('settings','company','main',body));});
  app.get('/api/runtime/status',async(req,res)=>{
    const client=new CodexClient(store.dir);
    try{await client.start();const account=await client.request('account/read',{refreshToken:false});const rate=await client.request('account/rateLimits/read').catch(()=>null);const models=await client.request('model/list',{}).catch(()=>({data:[]}));res.json({connected:true,authType:account.account?.type||null,plan:account.account?.planType||null,rateLimits:rate,models:models.data?.map(m=>({id:m.id,model:m.model,name:m.displayName,isDefault:m.isDefault}))||[]});}catch(e){res.json({connected:false,error:e.message});}finally{client.close();}
  });
  app.use('/api',(req,res)=>res.status(404).json({error:'지원하지 않는 API입니다.'}));
  app.use((error,req,res,next)=>{res.status(error instanceof z.ZodError?400:409).json({error:error instanceof z.ZodError?error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('\n'):error.message});});
  return app;
}
