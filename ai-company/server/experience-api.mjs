import { z } from 'zod';
import { uid, now } from './store.mjs';
import { syncExperiences, addFeedback, suggestGuideline, editGuideline, reviewGuideline, shareGuideline, retrieveExperience, career, checks } from './experience.mjs';
import { catalog, freezeEvaluation, startEvaluation, compareSummary, evaluationUsage } from './evaluation.mjs';

export function experienceRoutes(app,store,runtime){
  const scope=req=>{const s=req.params.scope;store.require('project','company',s);return s;};
  const base='/api/scopes/:scope';
  app.get(base+'/experience',(req,res)=>{const s=scope(req);res.json({experiences:syncExperiences(store,s),feedback:store.list('feedback',s),guidelines:store.list('guideline',s),releases:store.list('guidelineRelease',s),uses:store.list('experienceUse',s),reviews:store.list('memoryReview',s),checks});});
  app.post(base+'/experience/:id/feedback',(req,res)=>res.status(201).json(addFeedback(store,scope(req),req.params.id,req.body)));
  app.post(base+'/experience/:id/suggest',(req,res)=>{const {feedbackId}=z.object({feedbackId:z.string()}).strict().parse(req.body);res.status(201).json(suggestGuideline(store,scope(req),req.params.id,feedbackId));});
  app.put(base+'/guidelines/:id',(req,res)=>res.json(editGuideline(store,scope(req),req.params.id,req.body)));
  app.post(base+'/guidelines/:id/review',(req,res)=>{const body=z.object({version:z.number().int(),status:z.enum(['candidate','verified','retired']),active:z.boolean()}).strict().parse(req.body);res.json(reviewGuideline(store,scope(req),req.params.id,body));});
  app.post(base+'/guidelines/:id/share',(req,res)=>res.status(201).json(shareGuideline(store,scope(req),req.params.id,req.body)));
  app.post(base+'/releases/:id/revoke',(req,res)=>res.json(store.patch('guidelineRelease',scope(req),req.params.id,{active:false,revokedAt:now()})));
  app.post(base+'/experience/search',(req,res)=>{const b=z.object({employeeId:z.string(),query:z.string().min(1).max(8000)}).strict().parse(req.body);res.json(retrieveExperience(store,scope(req),b.employeeId,b.query));});
  app.post(base+'/memory-reviews/:id/resolve',(req,res)=>{const s=scope(req),b=z.object({resolution:z.string().min(1).max(2000)}).strict().parse(req.body);res.json(store.patch('memoryReview',s,req.params.id,{status:'resolved',resolution:b.resolution,decidedBy:'ceo',decidedAt:now()}));});
  app.get(base+'/employees/:id/career',(req,res)=>{const s=scope(req);runtime.employee(s,req.params.id);res.json(career(store,s,req.params.id));});
  app.post(base+'/employees/:id/public-summary',(req,res)=>{
    const s=scope(req),id=req.params.id;runtime.employee(s,id);z.object({rightsConfirmed:z.literal(true)}).strict().parse(req.body);const c=career(store,s,id);
    // Only aggregate facts, no free-form project names, documents, feedback, paths, or private source IDs.
    res.json(store.put('careerPublic',s,{id,employeeId:id,workCompleted:c.groups.work.completedTasks.length,practiceRuns:c.groups.practice.runs,evaluationRuns:c.groups.evaluation.runs,statement:'평가되지 않은 분야와 일반적인 성능 우위는 주장하지 않습니다.',approvedBy:'ceo',approvedAt:now(),active:true}));
  });
  app.delete(base+'/employees/:id/public-summary',(req,res)=>res.json(store.patch('careerPublic',scope(req),req.params.id,{active:false,revokedAt:now()})));
  app.get('/api/qa-catalog',(req,res)=>res.json(catalog()));
  app.get(base+'/evaluations',(req,res)=>{const s=scope(req);res.json(store.list('evaluation',s).map(e=>({...e,summary:compareSummary(e),usage:evaluationUsage(store,s,e.id)})));});
  app.post(base+'/evaluations',async(req,res)=>res.status(201).json(await freezeEvaluation(store,runtime,scope(req),req.body)));
  app.post(base+'/evaluations/:id/start',(req,res)=>res.status(202).json(startEvaluation(store,runtime,scope(req),req.params.id)));
  app.post(base+'/evaluations/:id/pause',(req,res)=>res.json(store.patch('evaluation',scope(req),req.params.id,{status:'paused',reason:'대표가 평가 일시정지'})));
  app.post(base+'/evaluations/:id/cancel',(req,res)=>res.json(store.patch('evaluation',scope(req),req.params.id,{status:'cancelled',reason:'대표가 평가 취소'})));
  app.post(base+'/evaluations/:id/human-review',(req,res)=>{
    const s=scope(req),e=store.require('evaluation',s,req.params.id);const b=z.object({trialId:z.string(),reviewMinutes:z.number().min(0).max(10000).nullable(),correctionMinutes:z.number().min(0).max(10000).nullable(),confirmed:z.boolean().nullable(),notes:z.string().max(5000)}).strict().parse(req.body);
    if(!e.trials.some(t=>t.id===b.trialId&&t.status==='completed'))throw new Error('완료된 평가 실행을 선택하세요.');
    const record={id:uid(),...b,author:'ceo',createdAt:now()};res.json(store.patch('evaluation',s,e.id,{humanMeasurements:[...(e.humanMeasurements||[]),record]}));
  });
  app.get(base+'/evaluations/:id/trials/:trialId/artifact',(req,res)=>{const e=store.require('evaluation',scope(req),req.params.id),t=e.trials.find(t=>t.id===req.params.trialId);if(!t?.artifact)throw new Error('결과물이 아직 없습니다.');res.download(t.artifact,'qa-result.json');});
}
