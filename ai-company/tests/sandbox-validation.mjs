// No model calls. Probe real native Codex command sandbox with disposable canaries.
import path from 'node:path';
import { mkdir,writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { Store,uid } from '../server/store.mjs';
import { Runner } from '../server/scheduler.mjs';
const base=path.resolve('.local/sandbox-validation');await mkdir(base,{recursive:true});const a=path.join(base,'a'),b=path.join(base,'b');await mkdir(a,{recursive:true});await mkdir(b,{recursive:true});await writeFile(path.join(b,'canary.txt'),'PROJECT_B_CANARY');
const s=new Store(path.join(base,'data'));const pa=s.put('project','company',{id:'probe-a',repository:a}),pb=s.put('project','company',{id:'probe-b',repository:b});
const script=`const fs=require('node:fs');const results={};for(const [key,file] of ${JSON.stringify([['otherProject',path.join(b,'canary.txt')],['companyDatabase',path.join(s.dir,'company.sqlite')]])}){try{fs.readFileSync(file);results[key]='ALLOWED';}catch(e){results[key]=e.code;}}try{fs.writeFileSync('forbidden-write.txt','canary');results.readOnlyWrite='ALLOWED';}catch(e){results.readOnlyWrite=e.code;}console.log(JSON.stringify(results));`;
await writeFile(path.join(a,'probe.cjs'),script);const r=new Runner(s);const client=r.scopedClient(a,pa.id);let output;
try{await client.start();output=await client.verify('node probe.cjs',a,{timeout:15000});}finally{client.close();s.close();}
await writeFile(path.join(base,'report.json'),JSON.stringify({checkedAt:new Date().toISOString(),...output},null,2));console.log(output);
const parsed=JSON.parse(output.output.trim());assert.notEqual(parsed.otherProject,'ALLOWED');assert.notEqual(parsed.companyDatabase,'ALLOWED');assert.notEqual(parsed.readOnlyWrite,'ALLOWED');
