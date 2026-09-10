// Explicit live validation. Uses the existing Codex login; capped at 12 turns / 300k reported tokens.
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Store,uid,now,roles } from '../server/store.mjs';
import { policyOf,createTask } from '../server/operations.mjs';
import { git } from '../server/workspaces.mjs';

const base=path.resolve(process.env.COMPANY_VALIDATION_DIR||'.local/autonomy-live');await mkdir(base,{recursive:true});
const source=path.join(base,'greeting-project');await mkdir(source,{recursive:true});
if(!existsSync(path.join(source,'.git'))){
  for(const d of ['backend','frontend','tests'])await mkdir(path.join(source,d));
  await writeFile(path.join(source,'backend/greeting.mjs'),'export function greet(name) { return `안녕하세요, ${name}님!`; }\n');
  await writeFile(path.join(source,'frontend/index.html'),'<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>인사</title></head><body><label for="name">이름</label><input id="name"><button id="greet">인사하기</button><p id="result"></p><script type="module">import {greet} from "../backend/greeting.mjs";document.querySelector("#greet").onclick=()=>{document.querySelector("#result").textContent=greet(document.querySelector("#name").value);};</script></body></html>\n');
  await writeFile(path.join(source,'tests/greeting.test.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';import {greet} from '../backend/greeting.mjs';test('existing greeting',()=>assert.equal(greet('하나'),'안녕하세요, 하나님!'));\n");
  await writeFile(path.join(source,'README.md'),'기존 이름 인사 도구. 외부 패키지 없이 node --test tests/*.test.mjs 로 검증한다.\n');
  await git(source,['init']);await git(source,['config','user.name','Validation']);await git(source,['config','user.email','validation@localhost']);await git(source,['add','.']);await git(source,['commit','-m','Independent autonomous validation fixture']);
  await writeFile(path.join(source,'representative-note.md'),'대표의 기존 미완료 메모. 수정하지 마세요.\n');
}
const store=new Store(path.join(base,'data'));let p=store.list('project','company')[0];
if(!p){
  const employees=roles.map(role=>{const c=store.list('candidate','company').find(c=>c.role===role.id);return store.put('employee','company',{...c,id:uid(),instructions:'검증용 작은 업무입니다. 필요한 파일만 읽고 도구 호출을 최소화하세요. 추가 직무가 불필요하면 requiredRoles=[]로 보고하세요. 검증 코드를 실제로 작성하고 실제 결과만 보고하세요.'});});
  p=store.put('project','company',{id:uid(),name:'자율 운영 실증 · 인사 도구',repository:source,goal:'기존 인사 기능의 빈 이름 오류 수정',stack:'HTML + ES modules + node:test',testCommand:'node --test tests/*.test.mjs',model:'gpt-5.6-luna',maxRuns:12,tokenBudget:300000,networkAccess:false,allowedPaths:['backend','frontend','tests'],assignments:employees.map(e=>({employeeId:e.id,permission:['backend','frontend'].includes(e.role)?'write':'read'})),operation:{...policyOf({}),objectives:[{id:'greeting-fix',text:'기존 인사 기능의 공백 이름 처리를 보완한다.',acceptance:'이름 trim·빈 이름 방문자 처리·접근성 결과 알림·실제 node:test 통과',priority:1}],allowedCategories:['bugfix','ui'],scope:'기존 인사 함수의 이름 공백 처리 오류 수정, 입력 안내와 결과 접근성 속성 보완, 회귀 테스트 추가만 허용. 외부 기능·새 서비스·배포는 금지.',maxRetries:1,maxTaskCalls:10,taskMinutes:25,turnMinutes:4,sessionMinutes:30},operationEnabled:true,paused:false,operationState:'running',stopAt:new Date(Date.now()+1800000).toISOString()});
  createTask(store,p.id,{title:'이름 공백 처리 오류와 입력 안내 수정',description:'기존 backend/greeting.mjs의 greet(name)이 이름 앞뒤 공백을 제거하고, 빈 문자열 또는 공백뿐인 이름에는 방문자를 사용하도록 고치세요. 기존 한국어 인사 형식을 유지합니다. frontend/index.html은 기존 흐름을 유지하며 이름을 비워 두면 방문자로 인사한다는 안내와 결과 p의 aria-live="polite"를 추가하세요. tests/greeting.test.mjs에서 정상 이름, 앞뒤 공백, 빈 값/공백 값의 회귀 테스트와 HTML 안내/aria-live 속성을 검증하세요. 변경 범위는 이 세 파일이며 외부 패키지 설치나 새 기능은 필요 없습니다. PO는 간결한 완료 기준, CTO는 백엔드/프런트엔드 분담, QA는 실제 파일과 검증 결과, 마지막 CTO는 실제 증거를 확인해 보고하세요.',goalId:'greeting-fix',category:'bugfix',priority:1,acceptance:['이름 앞뒤 공백 제거','빈 이름은 방문자','안내 문구와 aria-live','node:test 통과']});
  const current=store.require('project','company',p.id);store.patch('project','company',p.id,{plannedVersion:current.wakeVersion,nextCheckAt:new Date(Date.now()+3600000).toISOString()});
}
let task=store.list('task',p.id).at(-1);
if(process.argv.includes('--retry')){
  const {title,description,goalId,category,priority,acceptance}=task;task=createTask(store,p.id,{title,description,goalId,category,priority,acceptance});
  const current=store.require('project','company',p.id);store.patch('project','company',p.id,{paused:false,operationEnabled:true,stopAt:new Date(Date.now()+1800000).toISOString(),plannedVersion:current.wakeVersion,nextCheckAt:new Date(Date.now()+3600000).toISOString()});
}
if(process.argv.includes('--resume')){
  if(task.status!=='paused')throw new Error('일시정지된 검증 업무만 재개할 수 있습니다.');
  const current=store.require('project','company',p.id);store.patch('project','company',p.id,{paused:false,operationEnabled:true,stopAt:new Date(Date.now()+1800000).toISOString(),plannedVersion:current.wakeVersion,nextCheckAt:new Date(Date.now()+3600000).toISOString()});
  store.patch('task',p.id,task.id,{status:'queued'});store.patch('job',p.id,`task:${task.id}`,{status:'queued'});
}
const before=(await git(source,['status','--porcelain'])).output;const beforeDiff=(await git(source,['diff','HEAD','--binary'])).output;
let child,restarted=false;const logs=[];
function launch(){child=spawn(process.execPath,['server/runner.mjs'],{cwd:process.cwd(),windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,COMPANY_DATA_DIR:store.dir}});child.stdout.on('data',d=>{logs.push(d.toString());process.stdout.write(d);});child.stderr.on('data',d=>logs.push(d.toString()));child.on('error',e=>logs.push(e.message));}
async function stop(){if(!child||child.exitCode!==null)return;const closed=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await closed;}
launch();let last='';const started=Date.now();
try{
  while(Date.now()-started<1800000){
    await new Promise(r=>setTimeout(r,100));const t=store.require('task',p.id,task.id);const runs=store.list('run',p.id);const marker=JSON.stringify({status:t.status,stage:t.stage,calls:runs.length,reason:t.reason});if(marker!==last){console.log(marker);last=marker;}
    // Restart only between durable stages. A separate deterministic test covers a crash mid-turn.
    if(!restarted&&t.checkpoints?.['po:0']?.status==='completed'&&store.get('job',p.id,`task:${t.id}`)?.status==='queued'){
      await stop();restarted=true;console.log('실제 실행기 재시작: PO 체크포인트 보존 확인');launch();
    }
    if(['review','completed','failed','waiting_info','waiting_approval','paused'].includes(t.status))break;
    if(child.exitCode!==null)throw new Error('실행기가 종료되었습니다: '+logs.join(''));
  }
}finally{store.patch('project','company',p.id,{paused:true,operationEnabled:false,operationState:'paused',operationReason:'실증 종료 · 추가 호출 중지'});await stop();}
const result=store.require('task',p.id,task.id);const runs=store.list('run',p.id);const preserved=before===(await git(source,['status','--porcelain'])).output&&beforeDiff===(await git(source,['diff','HEAD','--binary'])).output;
const report={checkedAt:now(),task:result,sourcePreserved:preserved,runnerRestarted:restarted,noBrowserRequired:true,runs:runs.map(r=>({id:r.id,role:r.role,stage:r.stage,status:r.status,threadId:r.threadId,turnId:r.turnId,usage:r.usage,tokens:r.accountedTokens,error:r.error})),messages:store.list('message',p.id).filter(m=>m.kind||m.artifact),logs};
await writeFile(path.join(base,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:result.status,reason:result.reason,sourcePreserved:preserved,runnerRestarted:restarted,calls:runs.length,tokens:runs.reduce((n,r)=>n+(r.accountedTokens||0),0),report:path.join(base,'report.json')}));store.close();
assert.equal(preserved,true);assert.equal(result.status,'review',result.reason);assert.equal(result.testResult.exitCode,0);assert.ok(result.evidence);
