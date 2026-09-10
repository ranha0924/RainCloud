import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { acquireServerLock } from './lock.mjs';
import { Runner } from './scheduler.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const store=new Store(process.env.COMPANY_DATA_DIR||path.join(root,'.local/data'));
const release=acquireServerLock(store.dir,'runner.lock');process.on('exit',release);
const runner=new Runner(store);await runner.start();
console.log('Rain Company 실행기 준비 완료. 브라우저·웹 서버와 독립적으로 실행합니다.');
let stopping=false;
async function stop(){if(stopping)return;stopping=true;await runner.close();store.close();release();process.exit(0);}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
