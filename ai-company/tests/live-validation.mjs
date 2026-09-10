// Explicit live integration check: consumes up to 5+ Codex turns from the signed-in account.
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Store,uid,now } from '../server/store.mjs';
import { Runtime,stages } from '../server/runtime.mjs';
import { git } from '../server/workspaces.mjs';

const base=path.resolve('.local/live-validation');await mkdir(base,{recursive:true});
const source=path.join(base,'greeting-project');
await mkdir(path.join(source,'backend'),{recursive:true});await mkdir(path.join(source,'frontend'),{recursive:true});await mkdir(path.join(source,'tests'),{recursive:true});
if(!existsSync(path.join(source,'.git'))){
  await writeFile(path.join(source,'backend/greeting.mjs'),'export function greet(name) { return `Hello, ${name}!`; }\n');
  await writeFile(path.join(source,'frontend/index.html'),'<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>인사 도구</title></head><body><h1>인사 도구</h1><p id="greeting">인사를 기다립니다.</p></body></html>\n');
  await writeFile(path.join(source,'tests/greeting.test.mjs'),"import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greet } from '../backend/greeting.mjs';\ntest('existing greeting',()=>assert.ok(greet('Raina').includes('Raina')));\n");
  await writeFile(path.join(source,'.gitignore'),'.env\nnode_modules/\n');
  await git(source,['init']);await git(source,['config','user.name','Validation']);await git(source,['config','user.email','validation@localhost']);await git(source,['add','.']);await git(source,['commit','-m','Initialize independent validation project']);
  await writeFile(path.join(source,'representative-notes.md'),'대표의 기존 미완료 메모. 이 내용과 Git 상태는 보존되어야 합니다.\n');
  await writeFile(path.join(source,'frontend/index.html'),(await readFile(path.join(source,'frontend/index.html'),'utf8'))+'<!-- Existing unfinished note: keep this comment. -->\n');
}
const store=new Store(path.join(base,'data'));store.recover();const runtime=new Runtime(store);
let project=store.list('project','company')[0];
if(!project){
  const team=stages.map(role=>{const c=store.list('candidate','company').find(c=>c.role===role);return store.put('employee','company',{...c,id:uid(),candidateId:c.id,hiredAt:now(),instructions:'검증용 직원입니다. 제한된 작은 변경만 수행하고 도구 호출은 최소화하세요.'});});
  project=store.put('project','company',{id:uid(),name:'협업 검증용 인사 도구 (레슨퀘스트 아님)',goal:'프로젝트 분리와 다섯 직무의 실제 협업을 검증',repository:source,stack:'HTML + JavaScript ES modules + node:test',testCommand:'node --test tests/*.test.mjs',model:'gpt-5.6-luna',maxRuns:12,tokenBudget:300000,networkAccess:false,allowedPaths:['backend','frontend','tests'],assignments:team.map(e=>({employeeId:e.id,permission:['backend','frontend'].includes(e.role)?'write':'read'}))});
}
let task=store.list('task',project.id).find(t=>t.status!=='review');
if(!task)task=store.put('task',project.id,{id:uid(),title:'한국어 인사와 이름 입력 화면 추가',description:'검증용 프로젝트의 작은 업무입니다. backend/greeting.mjs의 greet(name)을 "안녕하세요, {이름}님!" 형식으로 바꾸고 앞뒤 공백을 제거하세요. 빈 문자열 또는 공백이면 이름을 "방문자"로 처리하세요. tests/greeting.test.mjs에 세 가지 동작을 node:test로 검증하세요. frontend/index.html에는 보이는 이름 label, 연결된 input, 인사하기 button을 추가하고 ES module import로 greet를 호출하여 #greeting에 textContent로 표시하세요. aria-live="polite"를 결과에 추가하세요. 기존 대표 메모와 미완료 HTML 주석은 유지하세요. PO/CTO는 간결한 인수 조건과 분담을 출력하고, 개발자는 지정된 부분만 실제 변경하세요. 외부 조사나 패키지 설치가 필요 없습니다. 각 역할은 3분 이내로 작은 범위만 수행하세요.',status:'queued',stage:'po',checkpoints:{},createdAt:now()});
const beforeStatus=(await git(source,['status','--porcelain=v1'])).output;const beforeDiff=(await git(source,['diff','--binary','HEAD'])).output;const beforeNote=await readFile(path.join(source,'representative-notes.md'),'utf8');
runtime.startTask(project.id,task.id);console.log('Live validation started:',task.id);
let last='';while(runtime.active.size){await new Promise(r=>setTimeout(r,2000));const t=store.require('task',project.id,task.id);const marker=JSON.stringify({status:t.status,stage:t.stage,runs:runtime.usage(project.id).runs,error:t.error});if(last!==marker){console.log(marker);last=marker;}}
task=store.require('task',project.id,task.id);
const preserved=beforeStatus===(await git(source,['status','--porcelain=v1'])).output&&beforeDiff===(await git(source,['diff','--binary','HEAD'])).output&&beforeNote===await readFile(path.join(source,'representative-notes.md'),'utf8');
const report={project:project.name,task,status:task.status,originalPreserved:preserved,runs:store.list('run',project.id).map(r=>({id:r.id,role:r.role,status:r.status,threadId:r.threadId,turnId:r.turnId,usage:r.usage,error:r.error})),checkedAt:now()};
await writeFile(path.join(base,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:task.status,preserved,error:task.error,files:task.result?.files,report:path.join(base,'report.json')}));store.close();
assert.equal(preserved,true,'Original checkout changed');assert.equal(task.status,'review',task.error);assert.equal(task.testResult.exitCode,0);assert.equal(report.runs.filter(r=>r.status==='completed').length>=5,true);
