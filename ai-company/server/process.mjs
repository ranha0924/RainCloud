import { spawn } from 'node:child_process';
export function terminate(child){
  if(!child?.pid)return;
  if(process.platform==='win32')spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
  else {try{process.kill(-child.pid,'SIGTERM');}catch{child.kill('SIGTERM');}}
}
export function command(exe,args,cwd,{signal,env,timeout=120000,allowFailure=false}={}){
  return new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(new Error('실행이 중지되었습니다.'));
    const c=spawn(exe,args,{cwd,env:env?{...process.env,...env}:process.env,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
    let output='',stdout='',stderr='',overflow=false;
    const collect=(d,isError)=>{const chunk=d.toString();output=(output+chunk).slice(-300000);if(isError)stderr=(stderr+chunk).slice(-300000);else if(stdout.length+chunk.length<=16*1024*1024)stdout+=chunk;else {overflow=true;terminate(c);}};c.stdout.on('data',d=>collect(d,false));c.stderr.on('data',d=>collect(d,true));
    let timedOut=false;const stop=()=>terminate(c);signal?.addEventListener('abort',stop,{once:true});
    const timer=setTimeout(()=>{timedOut=true;stop();},timeout);
    const clean=()=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);};
    c.on('error',e=>{clean();reject(e);});c.on('close',code=>{clean();if(overflow)reject(new Error('명령 출력이 16MB 제한을 초과했습니다. 결과를 자르지 않고 중단했습니다.'));else if(signal?.aborted||timedOut)reject(new Error(timedOut?'명령 실행 시간 제한에 도달했습니다.':'실행이 중지되었습니다.'));else if(code!==0&&!allowFailure)reject(new Error(output||`${exe}: ${code}`));else resolve({code,output,stdout,stderr});});
  });
}
