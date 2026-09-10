// Zero model calls. Verify the production QA tool boundary and actual Codex configuration.
import path from 'node:path';
import { mkdir,writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { CodexClient } from '../server/codex.mjs';
import { trialToolHandler,trialTools } from '../server/evaluation.mjs';
import { publicCase,benchmarkCases } from '../server/qa-fixtures.mjs';
const base=path.resolve('.local/experience-tool-isolation');await mkdir(base,{recursive:true});
const handler=trialToolHandler(publicCase(benchmarkCases[0]));const tests=[];
for(const request of [
  {tool:'qa_read',arguments:{file:'../answer.json'}},
  {tool:'qa_read',arguments:{file:'C:/Users/Raina/.codex/auth.json'}},
  {tool:'qa_read',arguments:{file:'subject.mjs',projectId:'another'}},
  {tool:'qa_execute',arguments:{input:{authenticated:true},caseId:'other-case'}},
  {tool:'shell',arguments:{command:'read another result'}},
]){await assert.rejects(()=>handler(request));tests.push({request,blocked:true});}
assert.match(await handler({tool:'qa_read',arguments:{file:'subject.mjs'}}),/authorize/);
const actual=await handler({tool:'qa_execute',arguments:{input:{authenticated:true,now:10,expires:10}}});assert.equal(actual.actual,true);assert.ok(!('expected' in actual));
const client=new CodexClient(base,{toolOnly:true});let features;
try{await client.start();const config=await client.request('config/read',{includeLayers:false});features=config.config.features;for(const name of ['shell_tool','unified_exec','apps','plugins','browser_use','computer_use','view_image'])assert.equal(features[name],false,name);assert.equal(features.code_mode_host,true);const thread=await client.request('thread/start',{cwd:base,approvalPolicy:'never',permissions:'rain_read',environments:[],dynamicTools:trialTools,config:client.disabledServers});assert.ok(thread.thread.id);}finally{client.close();}
const report={checkedAt:new Date().toISOString(),modelCalls:0,boundary:'whitelisted frozen-file read and fixed-function VM; no filesystem or network handle in dynamic tools',tests,featureChecksPassed:true,actual};await writeFile(path.join(base,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
