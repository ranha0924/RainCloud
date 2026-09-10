import { openSync,readFileSync,writeFileSync,closeSync,unlinkSync } from 'node:fs';
import path from 'node:path';

export function acquireServerLock(directory){
  const file=path.join(directory,'server.lock');
  for(let attempt=0;attempt<2;attempt++){
    try{const fd=openSync(file,'wx');writeFileSync(fd,String(process.pid));closeSync(fd);return ()=>{try{if(readFileSync(file,'utf8')===String(process.pid))unlinkSync(file);}catch{}};}
    catch(error){
      if(error.code!=='EEXIST')throw error;
      const owner=Number(readFileSync(file,'utf8'));let alive=true;
      if(Number.isInteger(owner)&&owner>0){try{process.kill(owner,0);}catch(e){alive=e.code!=='ESRCH';}}
      if(alive)throw new Error('같은 회사 데이터로 실행 중인 서버가 있습니다. 기존 앱을 사용하거나 다른 COMPANY_DATA_DIR를 지정하세요.');
      unlinkSync(file);
    }
  }
  throw new Error('회사 서버 잠금을 확보하지 못했습니다.');
}
