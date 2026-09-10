import path from 'node:path';
import { mkdir, writeFile, copyFile, lstat, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { command } from './process.mjs';

export const git = async (cwd,args,opts={})=>{const result=await command('git',['-c','core.quotepath=false',...args],cwd,opts);return {...result,output:result.stdout};};
export const sensitive = p=>/(^|[/\\])(\.env(?:\..*)?|auth\.json|credentials(?:\..*)?|id_rsa|id_ed25519)([/\\]|$)|\.(pem|key|p12)$/i.test(p)&&!/(\.example|\.sample)$/.test(p);
export function safeRelative(p){return typeof p==='string'&&p.length>0&&!path.isAbsolute(p)&&!p.split(/[/\\]/).includes('..')&&!p.includes('\0');}
export function allowedFile(file,prefixes){return safeRelative(file)&&!sensitive(file)&&prefixes.some(p=>p==='.'||file===p||file.startsWith(p.replace(/\/$/,'')+'/'));}
export async function inspectRepository(repository){
  if(!path.isAbsolute(repository))throw new Error('저장소에는 절대 경로를 입력하세요.');
  const canonical=await realpath(repository);const root=(await git(canonical,['rev-parse','--show-toplevel'])).output.trim();
  if(path.resolve(root).toLowerCase()!==path.resolve(canonical).toLowerCase())throw new Error('Git 저장소 최상위 폴더를 등록하세요.');
  const head=(await git(root,['rev-parse','HEAD'])).output.trim();
  const status=(await git(root,['status','--porcelain=v1'])).output;
  const branch=(await git(root,['branch','--show-current'])).output.trim();
  return {root,head,status,branch};
}
export async function prepareWorkspace(store,project,task,signal){
  if(task.workspace)return task.workspace;
  const before=await inspectRepository(project.repository);
  let dir=path.join(store.dir,'projects',project.id,'tasks',task.id);
  // A crash during clone/snapshot leaves a preserved incomplete directory, never a reused half-clone.
  if(existsSync(path.join(dir,'repository')))dir+=`-prepare-${randomUUID().slice(0,8)}`;
  await mkdir(dir,{recursive:true});
  const repo=path.join(dir,'repository');
  await git(dir,['clone','--no-hardlinks','--no-local','--',before.root,repo],{signal});
  await git(repo,['checkout','--detach',before.head],{signal});
  await git(repo,['config','user.name','Rain Company']);await git(repo,['config','user.email','ai-company@localhost']);
  const tracked=(await git(before.root,['ls-files','-z'])).output.split('\0').filter(Boolean);
  if(tracked.some(sensitive))throw new Error('비밀 정보로 보이는 추적 파일이 있습니다. 해당 파일을 Git 추적에서 제외한 뒤 연결하세요.');
  const diff=(await git(before.root,['diff','HEAD','--binary','--no-ext-diff'])).output;
  if(diff){const patch=path.join(dir,'unfinished.patch');await writeFile(patch,diff);await git(repo,['apply','--whitespace=nowarn',patch],{signal});}
  const untracked=(await git(before.root,['ls-files','--others','--exclude-standard','-z'])).output.split('\0').filter(Boolean);
  for(const file of untracked){
    if(!safeRelative(file)||sensitive(file))continue;
    const src=path.join(before.root,file);const stat=await lstat(src);
    if(stat.isSymbolicLink())throw new Error('미추적 심볼릭 링크는 스냅샷에 포함할 수 없습니다.');
    if(!stat.isFile()||stat.size>10*1024*1024)throw new Error('10MB보다 큰 미추적 파일은 먼저 정리하거나 Git에서 제외하세요.');
    const dst=path.join(repo,file);await mkdir(path.dirname(dst),{recursive:true});await copyFile(src,dst);
  }
  await git(repo,['add','-A']);
  if((await git(repo,['status','--porcelain'])).output)await git(repo,['commit','-m','Snapshot existing unfinished work (original checkout preserved)']);
  const baseline=(await git(repo,['rev-parse','HEAD'])).output.trim();
  const branch=`company/review-${task.id.slice(0,8)}`;
  await git(repo,['checkout','-b',branch]);
  const workspace={dir,repo,baseline,branch,source:before,sourceUntracked:untracked};
  store.patch('task',project.id,task.id,{workspace});return workspace;
}
export async function developerWorkspace(workspace,role,signal){
  const dir=path.join(workspace.dir,role);if(existsSync(dir))return dir;
  await git(workspace.repo,['worktree','add','-b',`company/${role}-${path.basename(workspace.dir).slice(0,8)}`,dir,'HEAD'],{signal});return dir;
}
export async function commitDeveloper(workspace,cwd,role,prefixes,signal){
  const unstaged=(await git(cwd,['diff','--name-only','HEAD','-z'])).output.split('\0').filter(Boolean);
  const untracked=(await git(cwd,['ls-files','--others','--exclude-standard','-z'])).output.split('\0').filter(Boolean);
  for(const f of [...unstaged,...untracked])if(!allowedFile(f,prefixes))throw new Error(`허용 경로 밖의 변경을 발견했습니다: ${f}. 통합하지 않았습니다.`);
  await git(cwd,['add','-A'],{signal});
  if((await git(cwd,['diff','--cached','--name-only'])).output)await git(cwd,['commit','-m',`${role}: implement assigned company task`],{signal});
  return (await git(cwd,['rev-parse','HEAD'])).output.trim();
}
export async function integrate(workspace,commit,signal){
  const contains=await git(workspace.repo,['merge-base','--is-ancestor',commit,'HEAD'],{allowFailure:true});
  if(contains.code===0)return;
  // Each worker starts at the current integration HEAD; fast-forward avoids synthetic conflict fixes.
  await git(workspace.repo,['merge','--ff-only',commit],{signal});
}
export async function resultDiff(workspace){
  const files=(await git(workspace.repo,['diff','--name-only',workspace.baseline,'HEAD'])).output.trim().split('\n').filter(Boolean);
  const diff=(await git(workspace.repo,['diff',workspace.baseline,'HEAD','--no-ext-diff'])).output;
  const head=(await git(workspace.repo,['rev-parse','HEAD'])).output.trim();
  return {files,diff,head,branch:workspace.branch,repository:workspace.repo};
}
