// Private evaluator data. Agents receive only a copied source file and its public contract.
// This module and the answer records must never be staged in an agent workspace.
import vm from 'node:vm';
import { hash } from './experience.mjs';

const contract='authorize(input)는 접근 허용이면 true, 거절이면 false를 반환합니다. now/expires는 정수 밀리초, role은 viewer 또는 admin, tenant/resourceTenant와 audience/service는 문자열, authenticated/revoked는 boolean입니다. 입력에 없는 필드는 undefined입니다. 제시된 계약만 검증하세요. 계약에 없는 보안 요구를 새로 가정하지 마세요.';
const make=(id,domain,topic,requirement,body,oracle,witness)=>({id,domain,topic,requirement:contract+'\n'+requirement,source:`export function authorize(x) { ${body} }\n`,oracle,witness,defectId:witness?`${id}:contract`:null});
const expiry=x=>x.authenticated===true&&Number.isInteger(x.expires)&&x.now<x.expires;
const role=x=>x.authenticated===true&&x.role==='admin';
const revoke=x=>x.authenticated===true&&x.revoked===false;
const tenant=x=>x.authenticated===true&&typeof x.tenant==='string'&&x.tenant===x.resourceTenant;
const audience=x=>x.authenticated===true&&typeof x.audience==='string'&&x.audience===x.service;
export const checklist={version:'qa-general-1',items:['공개 계약의 정상 입력과 거절 입력을 비교한다.','관찰한 실제 반환값과 기대값이 다를 때만 결함을 보고한다.','동일 원인의 중복 지적은 하나로 합친다.','다른 개발자의 완료 보고만으로 통과시키지 않고 실제 결과를 확인한다.']};
export const benchmarkCases=[
  make('auth-01','Console A','expiry','authenticated=true인 세션은 정수 expires가 있고 now < expires일 때만 허용합니다.','return x.authenticated === true && Number.isInteger(x.expires) && x.now <= x.expires;',expiry,{authenticated:true,now:1000,expires:1000}),
  make('auth-02','Console A','expiry','authenticated=true인 세션은 정수 expires가 있고 now < expires일 때만 허용합니다.','return x.authenticated === true && Number.isInteger(x.expires) && x.now < x.expires;',expiry,null),
  make('auth-03','Console A','revocation','authenticated=true이고 revoked=false일 때만 허용합니다.','return x.authenticated === true;',revoke,{authenticated:true,revoked:true}),
  make('auth-04','Console A','role','인증된 admin만 허용합니다.','return x.authenticated === true || x.role === "admin";',role,{authenticated:true,role:'viewer'}),
  make('auth-05','Console A','role','인증된 admin만 허용합니다.','return x.authenticated === true && x.role === "admin";',role,null),
  make('auth-06','Console A','tenant','인증되었고 tenant가 문자열이며 resourceTenant와 같을 때만 허용합니다.','return x.authenticated === true && typeof x.tenant === "string";',tenant,{authenticated:true,tenant:'alpha',resourceTenant:'beta'}),
  make('auth-07','Portal B · 전이','expiry','authenticated=true인 세션은 정수 expires가 있고 now < expires일 때만 허용합니다.','if (x.authenticated !== true) return false; if (!Number.isInteger(x.expires)) return true; return x.now < x.expires;',expiry,{authenticated:true,now:23}),
  make('auth-08','Portal B · 전이','expiry','authenticated=true인 세션은 정수 expires가 있고 now < expires일 때만 허용합니다.','if (!Number.isInteger(x.expires)) return false; return x.authenticated === true && !(x.now > x.expires);',expiry,{authenticated:true,now:67,expires:67}),
  make('auth-09','Portal B · 전이','audience','인증되었고 audience가 문자열이며 service와 같을 때만 허용합니다.','return x.authenticated === true && typeof x.audience === "string";',audience,{authenticated:true,audience:'billing',service:'files'}),
  make('auth-10','Portal B · 전이','revocation','authenticated=true이고 revoked=false일 때만 허용합니다.','if (x.revoked !== false) return false; return x.authenticated === true;',revoke,null),
  make('auth-11','Portal B · 전이','tenant','인증되었고 tenant가 문자열이며 resourceTenant와 같을 때만 허용합니다.','if (x.authenticated !== true) return false; return typeof x.tenant === "string" && x.tenant === x.resourceTenant;',tenant,null),
  make('auth-12','Portal B · 전이','role','인증된 admin만 허용합니다.','if (x.authenticated !== true) return false; return x.role !== "guest";',role,{authenticated:true,role:'viewer'}),
];
export const practiceCase=make('practice-refresh-01','연습 전용','expiry','authenticated=true인 세션은 정수 expires가 있고 now < expires일 때만 허용합니다.','const stillValid = x.expires - x.now >= 0; return x.authenticated === true && Number.isInteger(x.expires) && stillValid;',expiry,{authenticated:true,now:457,expires:457});
export const fixtureVersion=hash(benchmarkCases.map(c=>({id:c.id,source:c.source,requirement:c.requirement,witness:c.witness,oracle:String(c.oracle)})));
export function publicCase(c){return {id:c.id,domain:c.domain,topic:c.topic,requirement:c.requirement,source:c.source,snapshotHash:hash([c.source,c.requirement])};}
export function actual(c,input){return vm.runInNewContext(c.source.replace('export ','')+'\nauthorize(input)',{input:JSON.parse(JSON.stringify(input))},{timeout:100});}
export function verifyFixtures(){return [...benchmarkCases,practiceCase].map(c=>{const expected=c.witness?c.oracle(c.witness):null,observed=c.witness?actual(c,c.witness):null;if(c.witness&&expected===observed)throw new Error('정답 자료 불일치: '+c.id);return {id:c.id,knownDefect:!!c.witness,expected,observed,snapshot:publicCase(c).snapshotHash};});}
export function judge(c,report){
  const findings=report.findings||[];const confirmed=new Set(),fp=new Set();let reproduced=0;
  const details=findings.map((f,i)=>{let observed,expected,error;try{observed=actual(c,f.input);expected=c.oracle(f.input);}catch(e){error=e.message;}
    const valid=!error&&observed!==expected&&f.expected===expected;
    if(valid){confirmed.add(c.defectId||'unexpected-contract-mismatch');reproduced++;}else fp.add(hash([f.input,f.expected]));
    return {index:i,input:f.input,claimedExpected:f.expected,observed,oracleExpected:expected,confirmed:valid,error:error||null,reproduction:f.reproduction};
  });
  return {basis:'고정 계약 oracle와 실제 JavaScript 반환값 비교 · LLM 채점 없음',knownDefects:c.defectId?1:0,found:confirmed.size,missed:c.defectId&&!confirmed.has(c.defectId)?1:0,falsePositives:fp.size,reported:findings.length,reproduced,reproductionAccuracy:findings.length?reproduced/findings.length:null,details,reviewMinutes:null,correctionMinutes:null,humanConfirmed:null};
}
