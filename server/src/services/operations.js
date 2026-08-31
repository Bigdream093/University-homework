import fs from 'node:fs';
import { createHash,randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { nowText } from '../utils/time.js';
import { fail,assignmentAccess,subjectFor,courseAccess } from './access.js';
import { queueCleanup,flushCleanup,promoteUpload } from './storage.js';

export const processOwner=randomUUID();
export function requestKey(req) {
  const key=req.get('Idempotency-Key')||randomUUID();
  if(!/^[a-zA-Z0-9_-]{8,100}$/.test(key))fail(400,'无效的上传请求编号');return key;
}
export async function fingerprint(body,file) {
  const hash=createHash('sha256');
  if(file)for await(const chunk of fs.createReadStream(file.path))hash.update(chunk);
  const digest=hash.digest('hex');
  const values=Object.keys(body||{}).sort().map(k=>[k,typeof body[k]==='string'?body[k].trim():body[k]]);
  return createHash('sha256').update(JSON.stringify({values,file:file?{digest,name:file.originalname,size:file.size}:null})).digest('hex');
}
// prepare runs awaited outside the database transaction (e.g. streaming file
// copies that would otherwise block every other request); action commits atomically.
export async function executeOperation(req,kind,targetId,action,prepare) {
  const key=requestKey(req),hash=await fingerprint(req.body,req.file),at=nowText();
  const find=()=>db.prepare('SELECT * FROM operation_requests WHERE actor_id=? AND kind=? AND target_id=? AND request_id=?').get(req.user.id,kind,targetId,key);
  if(kind==='submission'){const a=assignmentAccess(targetId,req.user,{write:true});if(a.status!=='published')fail(400,'作业已关闭');subjectFor(a,req.user,{submit:true});}
  if(kind==='material-create')courseAccess(targetId,req.user,{write:true,teacher:true});
  if(kind==='material-update'){const m=db.prepare('SELECT course_id FROM materials WHERE id=?').get(targetId);if(!m)fail(404,'资料不存在');courseAccess(m.course_id,req.user,{write:true,teacher:true});}
  const old=find();
  if(old?.fingerprint&&old.fingerprint!==hash)fail(409,'同一请求编号不能用于不同的内容，请开始新提交');
  if(old?.state==='succeeded'){if(req.file){queueCleanup([req.file.path],'重复上传');flushCleanup();}return {...JSON.parse(old.result_json),replayed:true};}
  if(old?.state==='processing')fail(409,'请求仍在处理中，请稍后查询结果');
  db.prepare(`INSERT INTO operation_requests(actor_id,kind,target_id,request_id,fingerprint,state,file_path,owner,created_at,updated_at) VALUES(?,?,?,?,?,'processing',?,?,?,?)
    ON CONFLICT(actor_id,kind,target_id,request_id) DO UPDATE SET state='processing',file_path=excluded.file_path,owner=excluded.owner,error=NULL,updated_at=excluded.updated_at`).run(req.user.id,kind,targetId,key,hash,req.file?.path||null,processOwner,at,at);
  try {
    if(req.file){promoteUpload(req.file,kind+'/'+targetId);db.prepare('UPDATE operation_requests SET file_path=? WHERE id=?').run(req.file.path,find().id);}
    let prepared;
    if(prepare)prepared=await prepare();
    // All business mutations and the successful result are committed together.
    const result=db.transaction(()=>{const data=action(prepared);db.prepare("UPDATE operation_requests SET state='succeeded',result_json=?,file_path=NULL,updated_at=? WHERE id=?").run(JSON.stringify(data),nowText(),find().id);return data;})();
    flushCleanup();return result;
  } catch(error) {
    db.prepare("UPDATE operation_requests SET state='failed',error=?,file_path=NULL,updated_at=? WHERE id=?").run(error.status&&error.status<500?error.message:'处理失败，请联系管理员或安全重试',nowText(),find().id);
    if(req.file){queueCleanup([req.file.path],'失败的上传');flushCleanup();}throw error;
  }
}
export function recoverOperations() {
  for(const row of db.prepare("SELECT * FROM operation_requests WHERE state='processing' AND (owner IS NULL OR owner<>?)").all(processOwner)) {
    queueCleanup([row.file_path],'进程中断的未完成请求');
    db.prepare("UPDATE operation_requests SET state='failed',error='服务器曾重新启动，请安全重试',file_path=NULL,updated_at=? WHERE id=?").run(nowText(),row.id);
  }flushCleanup();
}
export function operationStatus(actor,kind,target,key) {
  const row=db.prepare('SELECT state,result_json,error FROM operation_requests WHERE actor_id=? AND kind=? AND target_id=? AND request_id=?').get(actor,kind,target,key);
  return row?{state:row.state,result:row.result_json?JSON.parse(row.result_json):null,error:row.error}:{state:'unknown'};
}
