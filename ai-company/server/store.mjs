import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const roles = [
  ['cto','CTO','기술 방향과 업무 분배'],['po','사업 PO','목표와 인수 조건'],['planner','기획자','서비스 정책과 사용자 흐름'],
  ['marketer','마케터','고객과 성장 실험'],['backend','백엔드 개발자','API와 도메인 로직'],['frontend','프런트엔드 개발자','사용자 경험과 화면 구현'],
  ['qa','QA','검증과 회귀 방지'],['designer','디자이너','화면과 디자인 시스템'],['database','DB 엔지니어','데이터 모델과 성능'],
  ['accountant','회계 담당','예산과 비용 기록'],['hr','인사 담당','채용과 조직 운영'],
].map(([id,name,description])=>({id,name,description}));
export const uid = () => randomUUID();
export const now = () => new Date().toISOString();
export class Store {
  constructor(dir) {
    this.dir=path.resolve(dir); mkdirSync(this.dir,{recursive:true});
    this.db=new DatabaseSync(path.join(this.dir,'company.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS entities (kind TEXT NOT NULL, scope TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,scope,id));
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, run TEXT NOT NULL, time TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS event_scope ON events(scope,run,seq);`);
    if(!this.get('settings','company','main')) this.put('settings','company',{id:'main',name:'Rain Company',rules:'대표의 목표와 인수 조건을 먼저 확인한다. 실제 실행 근거 없이 완료를 주장하지 않는다. 비밀 정보에 접근하거나 외부에 게시하지 않는다. 프로젝트 간 기억과 자료를 섞지 않는다.',stopped:false,maxRuns:100,tokenBudget:1000000});
    if(!this.list('candidate','company').length) this.seedCandidates();
  }
  get(kind,scope,id){if(typeof scope!=='string'||typeof id!=='string')return undefined;const r=this.db.prepare('SELECT data FROM entities WHERE kind=? AND scope=? AND id=?').get(kind,scope,id);return r?JSON.parse(r.data):undefined;}
  require(kind,scope,id){const r=this.get(kind,scope,id);if(!r)throw new Error('요청한 항목이 이 프로젝트에 없습니다.');return r;}
  list(kind,scope){return this.db.prepare('SELECT data FROM entities WHERE kind=? AND scope=? ORDER BY rowid').all(kind,scope).map(r=>JSON.parse(r.data));}
  put(kind,scope,value){this.db.prepare('INSERT INTO entities VALUES(?,?,?,?) ON CONFLICT(kind,scope,id) DO UPDATE SET data=excluded.data').run(kind,scope,value.id,JSON.stringify(value));return value;}
  patch(kind,scope,id,change){return this.put(kind,scope,{...this.require(kind,scope,id),...change,updatedAt:now()});}
  transaction(work){this.db.exec('BEGIN IMMEDIATE');try{const result=work();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  event(scope,run,data){this.db.prepare('INSERT INTO events(scope,run,time,data) VALUES(?,?,?,?)').run(scope,run,now(),JSON.stringify(data));}
  events(scope,run,after=0){return this.db.prepare('SELECT * FROM events WHERE scope=? AND run=? AND seq>? ORDER BY seq LIMIT 1000').all(scope,run,after).map(r=>({...r,data:JSON.parse(r.data)}));}
  message(scope,sender,text,extra={}) {return this.put('message',scope,{id:uid(),projectId:scope,sender,text,createdAt:now(),channel:'general',...extra});}
  seedCandidates(){
    const names=[['서도윤','김서아','윤지후'],['한이서','정유진','박시온'],['강하린','이도하','최서준'],['윤나린','김태오','백지안'],['이준호','박서진','정하율'],['김유나','오지호','서수빈'],['정민서','류도현','한소율'],['최다온','임수아','문지완'],['신현우','배예린','조은호'],['차지윤','권도겸','남서영'],['송하은','홍우진','노다인']];
    const styles=[['차분한 분석가','근거와 체크리스트를 작성한 뒤 작은 단위로 진행','복잡한 문제 구조화 · 꼼꼼한 검증','정보가 부족하면 결정이 느려질 수 있음'],['빠른 실험가','작은 실험을 빠르게 만들고 피드백으로 개선','빠른 초안 · 유연한 협업','장기 설계와 문서 보완이 필요함'],['협업 중심 조율가','이해관계자의 관점을 정리하고 합의를 이끎','명확한 소통 · 의존성 조율','합의 과정이 길어질 수 있음']];
    roles.forEach((r,i)=>styles.forEach((s,j)=>this.put('candidate','company',{id:uid(),role:r.id,name:names[i][j],personality:s[0],workStyle:s[1],strengths:s[2],weaknesses:s[3],origin:'가상 프로필 템플릿',createdAt:now()})));
  }
  recover(){
    for(const p of [{id:'company'},...this.list('project','company')]){
      for(const run of this.list('run',p.id))if(run.status==='running')this.patch('run',p.id,run.id,{status:'interrupted',error:'서버 재시작으로 중단됨. 저장된 대화와 작업 공간에서 재개할 수 있습니다.'});
      for(const t of this.list('task',p.id))if(t.status==='running')this.patch('task',p.id,t.id,{status:'paused',error:'서버 재시작 후 이어서 실행할 수 있습니다.'});
    }
  }
  close(){this.db.close();}
}
