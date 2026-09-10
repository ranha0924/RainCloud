import { spawn } from 'node:child_process';
import { existsSync,readFileSync } from 'node:fs';
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
  constructor(cwd,{deniedRoots=[],toolOnly=false}={}){super();this.cwd=cwd;this.deniedRoots=deniedRoots;this.toolOnly=toolOnly;this.pending=new Map();this.nextId=0;}
  async start(){
    const root=path.resolve(this.cwd).replaceAll('\\','/');
    const readRules={':root':'deny',':minimal':'read',[root]:'read'};
    const writeRules={':root':'deny',':minimal':'read',':tmpdir':'deny',':slash_tmp':'deny',[root]:'write',[root+'/.git']:'read',[root+'/.codex']:'read'};
    for(const denied of this.deniedRoots){const target=path.resolve(denied).replaceAll('\\','/');readRules[target]='deny';writeRules[target]='deny';}
    // Git worktrees keep their metadata outside cwd. Grant only metadata reads, not sibling source files.
    try{const content=readFileSync(path.join(root,'.git'),'utf8');const match=/^gitdir: (.+)/m.exec(content);if(match){const metadata=path.resolve(root,match[1].trim());readRules[path.resolve(metadata,'../..').replaceAll('\\','/')]='read';writeRules[path.resolve(metadata,'../..').replaceAll('\\','/')]='read';}}catch{}
    const inline=value=>'{'+Object.entries(value).map(([k,v])=>`${JSON.stringify(k)} = ${JSON.stringify(v)}`).join(', ')+'}';
    const overrides=['approval_policy="never"','default_permissions="rain_read"','web_search="disabled"','features.memories=false','features.multi_agent=false','features.apps=false','features.plugins=false',`permissions.rain_read.filesystem=${inline(readRules)}`,'permissions.rain_read.network.enabled=false',`permissions.rain_write.filesystem=${inline(writeRules)}`,'permissions.rain_write.network.enabled=false'];
    if(this.toolOnly)overrides.push(...['shell_tool','unified_exec','browser_use','browser_use_external','browser_use_full_cdp_access','computer_use','in_app_browser','view_image','skill_search','tool_suggest','workspace_dependencies','multi_agent_v2','standalone_web_search'].map(f=>`features.${f}=false`),'features.code_mode_host=true','features.skip_host_skill_discovery=true','project_doc_max_bytes=0');
    this.child=spawn(executable(),['app-server','--listen','stdio://',...overrides.flatMap(x=>['-c',x])],{cwd:this.cwd,windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
    this.child.on('error',e=>this.fail(e));
    this.child.on('close',()=>this.fail(new Error('Codex 실행 연결이 종료되었습니다.')));
    this.child.stderr.on('data',()=>{});
    this.reader=createInterface({input:this.child.stdout});
    this.reader.on('line',line=>{let m;try{m=JSON.parse(line);}catch{return;}
      if(m.method&&m.id!==undefined){
        if(m.method==='item/tool/call'&&this.dynamicHandler){
          Promise.resolve().then(()=>this.dynamicHandler(m.params)).then(value=>this.send({id:m.id,result:{contentItems:[{type:'inputText',text:JSON.stringify(value)}],success:true}})).catch(error=>this.send({id:m.id,result:{contentItems:[{type:'inputText',text:error.message}],success:false}}));return;
        }
        // No escalation or unconfigured tools are approved by the company service.
        if(m.method==='item/commandExecution/requestApproval'||m.method==='item/fileChange/requestApproval')this.send({id:m.id,result:{decision:'decline'}});
        else this.send({id:m.id,error:{code:-32601,message:'이 작업에는 추가 권한/도구가 허용되지 않습니다.'}});
        this.emit('notification',{method:'company/permissionDenied',params:{method:m.method}});return;
      }
      if(m.id!==undefined){const p=this.pending.get(m.id);if(p){this.pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}}
      else if(m.method)this.emit('notification',m);
    });
    await this.request('initialize',{clientInfo:{name:'rain_company',title:'Rain Company',version:'0.2.0'},capabilities:{experimentalApi:true}});
    this.send({method:'initialized',params:{}});
    const config=await this.request('config/read',{includeLayers:false});
    this.disabledServers=Object.fromEntries(Object.keys(config.config?.mcp_servers||{}).map(name=>[`mcp_servers.${name}.enabled`,false]));return this;
  }
  fail(error){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();this.emit('closed',error);}
  send(value){if(this.child?.stdin.writable)this.child.stdin.write(JSON.stringify(value)+'\n');}
  request(method,params={},timeoutMs=45000){return new Promise((resolve,reject)=>{const id=++this.nextId;const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`Codex 응답 시간 초과: ${method}`));},timeoutMs);this.pending.set(id,{resolve,reject,timer});this.send({id,method,params});});}
  async verify(command,cwd,{signal,timeout=180000}={}){
    const stop=()=>this.close();if(signal?.aborted)throw new Error('실행 중단');signal?.addEventListener('abort',stop,{once:true});
    try{const r=await this.request('command/exec',{command:process.platform==='win32'?['powershell.exe','-NoProfile','-NonInteractive','-Command',command]:['/bin/sh','-c',command],cwd,timeoutMs:timeout,permissionProfile:'rain_read'},timeout+5000);return {code:r.exitCode,output:[r.stdout,r.stderr].filter(Boolean).join('\n')};}finally{signal?.removeEventListener('abort',stop);}
  }
  async run({threadId,cwd,instructions,prompt,writable=false,network=false,model,signal,onEvent,onThread,outputSchema,timeoutMs=600000,restrictedRead=false,dynamicTools,dynamicHandler}){
    this.dynamicHandler=dynamicHandler;
    const options={cwd,approvalPolicy:'never',...(restrictedRead?{permissions:writable?'rain_write':'rain_read',runtimeWorkspaceRoots:[cwd]}:{sandbox:writable?'workspace-write':'read-only'}),developerInstructions:instructions,environments:[],config:{...this.disabledServers,'model_reasoning_effort':'low','memories.use_memories':false,...(network||restrictedRead?{}:{'sandbox_workspace_write.network_access':false})},...(model?{model}:{})};
    const started=await this.request(threadId?'thread/resume':'thread/start',threadId?{threadId,...options}:{...options,...(dynamicTools?{dynamicTools}:{})});
    threadId=started.thread.id;onThread(threadId);
    if(signal?.aborted)throw new Error('실행이 중지되었습니다.');
    return new Promise((resolve,reject)=>{
      let turnId;let result='';let usage;let settled=false;
      const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);this.off('notification',listen);this.off('closed',closed);};
      const finish=(err)=>{if(settled)return;settled=true;cleanup();err?reject(err):resolve({text:result,threadId,turnId,usage});};
      const abort=()=>{if(turnId)this.request('turn/interrupt',{threadId,turnId}).catch(()=>{});finish(new Error('실행이 중지되었습니다.'));this.close();};
      const closed=e=>finish(e);
      const timer=setTimeout(()=>{finish(new Error('에이전트 최대 실행 시간에 도달했습니다.'));this.close();},timeoutMs);
      const listen=m=>{if(m.params?.threadId&&m.params.threadId!==threadId)return;
        try{onEvent(m);}catch(e){finish(e);this.close();return;}
        if(m.method==='turn/started')turnId=m.params.turn.id;
        if(m.method==='item/completed'&&m.params.item?.type==='agentMessage')result=m.params.item.text;
        if(m.method==='thread/tokenUsage/updated')usage=m.params.tokenUsage;
        if(m.method==='turn/completed'){
          const t=m.params.turn;turnId=t.id;
          if(t.status==='completed')finish();else finish(new Error(t.error?.message||`실행 ${t.status}`));
        }
      };
      this.on('notification',listen);this.on('closed',closed);signal?.addEventListener('abort',abort,{once:true});
      this.request('turn/start',{threadId,input:[{type:'text',text:prompt}],cwd,approvalPolicy:'never',...(restrictedRead?{permissions:writable?'rain_write':'rain_read',runtimeWorkspaceRoots:[cwd]}:{sandboxPolicy:writable?{type:'workspaceWrite',writableRoots:[cwd],networkAccess:network,excludeTmpdirEnvVar:true,excludeSlashTmp:true}:{type:'readOnly',networkAccess:network}}),...(outputSchema?{outputSchema}:{})}).then(r=>{turnId=r.turn.id;}).catch(finish);
    });
  }
  close(){this.reader?.close();terminate(this.child);}
}
