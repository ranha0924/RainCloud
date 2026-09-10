import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { terminate } from './process.mjs';

export function executable(){
  if(process.env.COMPANY_CODEX_BIN)return process.env.COMPANY_CODEX_BIN;
  if(process.platform==='win32'){
    const root=path.join(process.env.APPDATA||'','npm/node_modules/@openai/codex');
    const p=path.join(root,'node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
    if(existsSync(p))return p;
  }
  return 'codex';
}
export class CodexClient extends EventEmitter{
  constructor(cwd){super();this.cwd=cwd;this.pending=new Map();this.nextId=0;}
  async start(){
    this.child=spawn(executable(),['app-server','--listen','stdio://','-c','approval_policy="never"','-c','web_search="disabled"','-c','features.memories=false','-c','features.multi_agent=false','-c','features.apps=false'],{cwd:this.cwd,windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
    this.child.on('error',e=>this.fail(e));
    this.child.on('close',()=>this.fail(new Error('Codex 실행 연결이 종료되었습니다.')));
    this.child.stderr.on('data',()=>{});
    this.reader=createInterface({input:this.child.stdout});
    this.reader.on('line',line=>{let m;try{m=JSON.parse(line);}catch{return;}
      if(m.method&&m.id!==undefined){
        // No escalation or unconfigured tools are approved by the company service.
        if(m.method==='item/commandExecution/requestApproval'||m.method==='item/fileChange/requestApproval')this.send({id:m.id,result:{decision:'decline'}});
        else this.send({id:m.id,error:{code:-32601,message:'이 작업에는 추가 권한/도구가 허용되지 않습니다.'}});
        this.emit('notification',{method:'company/permissionDenied',params:{method:m.method}});return;
      }
      if(m.id!==undefined){const p=this.pending.get(m.id);if(p){this.pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}}
      else if(m.method)this.emit('notification',m);
    });
    await this.request('initialize',{clientInfo:{name:'rain_company',title:'Rain Company',version:'0.1.0'}});
    this.send({method:'initialized',params:{}});return this;
  }
  fail(error){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();this.emit('closed',error);}
  send(value){if(this.child?.stdin.writable)this.child.stdin.write(JSON.stringify(value)+'\n');}
  request(method,params={}){return new Promise((resolve,reject)=>{const id=++this.nextId;const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`Codex 응답 시간 초과: ${method}`));},45000);this.pending.set(id,{resolve,reject,timer});this.send({id,method,params});});}
  async run({threadId,cwd,instructions,prompt,writable=false,network=false,model,signal,onEvent,onThread,outputSchema}){
    const options={cwd,approvalPolicy:'never',sandbox:writable?'workspace-write':'read-only',developerInstructions:instructions,config:{'model_reasoning_effort':'low','memories.use_memories':false,...(network?{}:{'sandbox_workspace_write.network_access':false})},...(model?{model}:{})};
    const started=await this.request(threadId?'thread/resume':'thread/start',threadId?{threadId,...options}:options);
    threadId=started.thread.id;onThread(threadId);
    if(signal?.aborted)throw new Error('실행이 중지되었습니다.');
    return new Promise((resolve,reject)=>{
      let turnId;let result='';let usage;let settled=false;
      const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);this.off('notification',listen);this.off('closed',closed);};
      const finish=(err)=>{if(settled)return;settled=true;cleanup();err?reject(err):resolve({text:result,threadId,turnId,usage});};
      const abort=()=>{if(turnId)this.request('turn/interrupt',{threadId,turnId}).catch(()=>{});finish(new Error('실행이 중지되었습니다.'));this.close();};
      const closed=e=>finish(e);
      const timer=setTimeout(()=>{finish(new Error('에이전트 실행 시간 제한(10분)에 도달했습니다.'));this.close();},600000);
      const listen=m=>{if(m.params?.threadId&&m.params.threadId!==threadId)return;
        onEvent(m);
        if(m.method==='turn/started')turnId=m.params.turn.id;
        if(m.method==='item/completed'&&m.params.item?.type==='agentMessage')result=m.params.item.text;
        if(m.method==='thread/tokenUsage/updated')usage=m.params.tokenUsage;
        if(m.method==='turn/completed'){
          const t=m.params.turn;turnId=t.id;
          if(t.status==='completed')finish();else finish(new Error(t.error?.message||`실행 ${t.status}`));
        }
      };
      this.on('notification',listen);this.on('closed',closed);signal?.addEventListener('abort',abort,{once:true});
      this.request('turn/start',{threadId,input:[{type:'text',text:prompt}],cwd,approvalPolicy:'never',sandboxPolicy:writable?{type:'workspaceWrite',writableRoots:[cwd],networkAccess:network,excludeTmpdirEnvVar:true,excludeSlashTmp:true}:{type:'readOnly',networkAccess:network},...(outputSchema?{outputSchema}:{})}).then(r=>{turnId=r.turn.id;}).catch(finish);
    });
  }
  close(){this.reader?.close();terminate(this.child);}
}
