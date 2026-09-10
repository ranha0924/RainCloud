import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Store } from './store.mjs';
import { Runtime } from './runtime.mjs';
import { createApp } from './app.mjs';
import { acquireServerLock } from './lock.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const store=new Store(process.env.COMPANY_DATA_DIR||path.join(root,'.local/data'));
const releaseLock=acquireServerLock(store.dir);process.on('exit',releaseLock);store.recover();
const runtime=new Runtime(store);const app=createApp(store,runtime);
const port=Number(process.env.PORT||4310);
if(process.argv.includes('--production')){app.use(express.static(path.join(root,'dist')));app.get('/{*path}',(req,res)=>res.sendFile(path.join(root,'dist/index.html')));}
else {const {createServer}=await import('vite');const vite=await createServer({root,server:{middlewareMode:true,hmr:{port:port+1000}},appType:'spa'});app.use(vite.middlewares);}
const server=app.listen(port,'127.0.0.1',()=>console.log(`Rain Company: http://127.0.0.1:${port}`));
function shutdown(){for(const c of runtime.active.values())c.abort();server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),3000).unref();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
