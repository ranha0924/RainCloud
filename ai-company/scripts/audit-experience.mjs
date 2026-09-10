// Read-only diagnosis. No Runtime, Codex client, network, or model execution.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const args=Object.fromEntries(process.argv.slice(2).reduce((pairs,v,i,a)=>i%2?pairs:[...pairs,[v,a[i+1]]],[]));
if(!args['--data']||!args['--sessions']||!args['--output'])throw new Error('Required: --data DATA_DIR --sessions CODEX_SESSIONS_DIR --output OUTPUT_JSON');
const db=new DatabaseSync(path.join(args['--data'],'company.sqlite'),{readOnly:true});
try {
  const entities=db.prepare('SELECT kind,scope,id,data FROM entities ORDER BY kind,scope,id').all().map(r=>({...r,value:JSON.parse(r.data)}));
  const list=(kind,scope)=>entities.filter(r=>r.kind===kind&&(!scope||r.scope===scope)).map(r=>r.value);
  const get=(kind,scope,id)=>entities.find(r=>r.kind===kind&&r.scope===scope&&r.id===id)?.value;
  const savedEvaluations=list('evaluation');
  const directoryCache=new Map();
  function rollout(run){
    if(!run?.threadId||!run.createdAt)return null;
    const date=new Date(run.createdAt);const days=[0,86400000,-86400000].map(n=>new Date(+date+n).toISOString().slice(0,10).replaceAll('-','/'));
    for(const day of days){const dir=path.join(args['--sessions'],day);if(!directoryCache.has(dir))directoryCache.set(dir,fs.existsSync(dir)?fs.readdirSync(dir):[]);
      const file=directoryCache.get(dir).find(f=>f.endsWith(run.threadId+'.jsonl'));if(!file)continue;
      const filePath=path.join(dir,file);const records=fs.readFileSync(filePath,'utf8').trim().split('\n').map(JSON.parse);
      const meta=records.find(r=>r.type==='session_meta')?.payload;
      if(meta?.id!==run.threadId&&meta?.session_id!==run.threadId)throw new Error('Session identity mismatch');
      const developer=records.filter(r=>r.type==='response_item'&&r.payload.type==='message'&&r.payload.role==='developer').flatMap(r=>r.payload.content||[]).filter(c=>c.type==='input_text').map(c=>c.text);
      const appInstructions=developer.find(t=>t.startsWith('당신은 AI 회사의 가상 직원 '));
      const usage=records.filter(r=>r.type==='token_usage_record'&&r.payload.turn_id===run.turnId).map(r=>r.payload);
      const context=records.find(r=>r.type==='turn_context'&&r.payload.turn_id===run.turnId)?.payload;
      return {file:filePath,appInstructions:appInstructions??null,appInstructionHash:appInstructions?hash(appInstructions):null,
        savedInstructionPrefixMatches:run.instructionSnapshot&&appInstructions?appInstructions.startsWith(run.instructionSnapshot):null,
        snapshotEqualsLogged:run.instructionSnapshot&&appInstructions?appInstructions===run.instructionSnapshot:null,
        commonSystemHash:meta.base_instructions?hash(meta.base_instructions.text):null,
        otherDeveloperHashes:developer.filter(t=>t!==appInstructions).map(hash),
        dynamicTools:meta.dynamic_tools?.map(t=>t.name)||null,dynamicToolsHash:meta.dynamic_tools?hash(meta.dynamic_tools):null,
        model:context?.model??null,effort:context?.effort??null,permissions:context?.sandbox_policy??null,
        observedResponses:usage.length?new Set(usage.map(u=>u.response_id)).size:null,
        reportedResponseTokens:usage.length?usage.reduce((n,u)=>n+u.usage.total_tokens,0):null,
        providerRequestCount:null};
    }return null;
  }
  const evaluations=savedEvaluations.map(e=>({id:e.id,scope:e.projectId,label:e.label,purpose:e.purpose,status:e.status,reason:e.reason,
    frozenHash:e.frozenHash,frozenHashMatches:hash(e.frozen)===e.frozenHash,frozen:e.frozen,
    trials:e.trials.map(t=>{
      const run=t.runId?get('run',e.projectId,t.runId):null;
      const events=run?db.prepare('SELECT seq,time,data FROM events WHERE scope=? AND run=? ORDER BY seq').all(e.projectId,run.id).map(r=>({...r,data:JSON.parse(r.data)})):[];
      const log=rollout(run),selection=t.condition==='C'?e.frozen.selections[t.caseId]:{guidelines:[],experiences:[]};
      const tools=events.filter(r=>r.data.method==='company/evaluationTool').map(r=>r.data.params);
      return {id:t.id,condition:t.condition,caseId:t.caseId,status:t.status,runStatus:run?.status??null,runId:run?.id??null,threadId:run?.threadId??null,
        attempts:run?1:0,tokens:run?(run.accountedTokens??null):0,elapsedMs:run?.finishedAt&&run?.createdAt?Date.parse(run.finishedAt)-Date.parse(run.createdAt):null,
        inputTokens:run?.usage?.total?.inputTokens??null,cachedInputTokens:run?.usage?.total?.cachedInputTokens??null,outputTokens:run?.usage?.total?.outputTokens??null,
        error:t.error??run?.error??null,invalidated:run?.validationInvalidated??null,createdAt:run?.createdAt??null,finishedAt:run?.finishedAt??null,
        instructionVersion:run?.instructionVersion??null,instructionSnapshot:run?.instructionSnapshot??null,
        prompt:events.find(r=>r.data.method==='item/completed'&&r.data.params.item?.type==='userMessage')?.data.params.item.content??null,
        log,selection,selectionInLoggedInput:t.condition==='C'&&log?.appInstructions?log.appInstructions.includes(JSON.stringify(selection)):null,
        checklistInLoggedInput:log?.appInstructions?e.frozen.checklist.items.every(item=>log.appInstructions.includes(item)):null,
        toolReads:tools.filter(x=>x.tool==='qa_read'),toolExecutions:tools.filter(x=>x.tool==='qa_execute'),
        report:t.report??null,metrics:t.metrics??null,artifact:t.artifact??null,artifactHash:t.artifact&&fs.existsSync(t.artifact)?hash(fs.readFileSync(t.artifact,'utf8')):null,
        sourcePermissions:selection.guidelines.map(g=>{const release=!g.local?get('guidelineRelease',g.sourceProjectId,g.id):null;const guide=get('guideline',g.sourceProjectId,g.local?g.id:release?.guidelineId);const version=guide?.versions.find(v=>v.number===g.version);return {release,guideId:guide?.id,version,reviewHistory:list('guidelineReview',g.sourceProjectId).filter(r=>r.guidelineId===guide?.id&&r.version===g.version),feedback:version?.sourceFeedbackIds.map(id=>get('feedback',g.sourceProjectId,id)),sourceExperiences:version?.sourceExperienceIds.map(id=>get('experience',g.sourceProjectId,id))};})};
    })}));
  const sum=trials=>({attempts:trials.reduce((n,t)=>n+t.attempts,0),tokens:trials.reduce((n,t)=>n+(t.tokens??0),0),unknownTokenRuns:trials.filter(t=>t.attempts&&t.tokens===null).length,elapsedMs:trials.reduce((n,t)=>n+(t.elapsedMs??0),0),unknownElapsedRuns:trials.filter(t=>t.attempts&&t.elapsedMs===null).length,observedResponses:trials.reduce((n,t)=>n+(t.log?.observedResponses??0),0),unknownResponseRuns:trials.filter(t=>t.attempts&&t.log?.observedResponses==null).length});
  const allTrials=evaluations.flatMap(e=>e.trials);
  const report={checkedAt:new Date().toISOString(),newModelCalls:0,database:path.resolve(args['--data'],'company.sqlite'),settings:get('settings','company','main'),
    evidenceHash:hash(entities.filter(r=>['run','evaluation'].includes(r.kind)).map(r=>[r.kind,r.scope,r.id,r.data])),
    company:{attempts:list('run').length,tokens:list('run').reduce((n,r)=>n+(r.accountedTokens??0),0),unknownTokenRuns:list('run').filter(r=>r.accountedTokens==null).length},
    projects:list('project','company').map(p=>({id:p.id,name:p.name,maxRuns:p.maxRuns,tokenBudget:p.tokenBudget,paused:p.paused,assignments:p.assignments})),
    experiencePhase:sum(allTrials),evaluationOnly:sum(evaluations.filter(e=>e.purpose==='evaluation').flatMap(e=>e.trials)),practiceOnly:sum(evaluations.filter(e=>e.purpose==='practice').flatMap(e=>e.trials)),
    byCondition:Object.fromEntries(['A','B','C'].map(c=>[c,sum(evaluations.filter(e=>e.purpose==='evaluation').flatMap(e=>e.trials).filter(t=>t.condition===c))])),evaluations};
  fs.mkdirSync(path.dirname(args['--output']),{recursive:true});fs.writeFileSync(args['--output'],JSON.stringify(report,null,2));
  console.log(JSON.stringify({output:path.resolve(args['--output']),evidenceHash:report.evidenceHash,company:report.company,experiencePhase:report.experiencePhase,evaluationOnly:report.evaluationOnly,practiceOnly:report.practiceOnly,byCondition:report.byCondition,rows:evaluations.map(e=>({label:e.label,reason:e.reason,trials:e.trials.map(t=>({condition:t.condition,status:t.status,attempts:t.attempts,tokens:t.tokens,elapsedMs:t.elapsedMs,observedResponses:t.log?.observedResponses,selectionLogged:t.selectionInLoggedInput,snapshotEquals:t.log?.snapshotEqualsLogged}))}))},null,2));
} finally {db.close();}
