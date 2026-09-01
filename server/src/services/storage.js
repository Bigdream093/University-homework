import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { config } from '../config.js';
import { nowText } from '../utils/time.js';
import { resolveUploadPath } from '../utils/uploadPath.js';

export function queueCleanup(paths,reason='文件已替换') {
  const insert=db.prepare("INSERT INTO file_cleanup_jobs(path,reason,created_at) VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET reason=excluded.reason,state='pending',completed_at=NULL");
  for(const file of new Set(paths.filter(Boolean))) if(resolveUploadPath(file))insert.run(file,reason,nowText());
}
export function referencedFiles() {
  const refs=new Set();
  for(const table of ['materials','submissions','group_submissions'])for(const row of db.prepare(`SELECT file_url FROM ${table} WHERE file_url IS NOT NULL`).all()) { const p=resolveUploadPath(row.file_url);if(p)refs.add(p); }
  for(const table of ['submission_history','group_submission_history'])for(const row of db.prepare(`SELECT file_url FROM ${table} WHERE file_url IS NOT NULL AND file_state='available'`).all()){const p=resolveUploadPath(row.file_url);if(p)refs.add(p);}
  for(const row of db.prepare("SELECT file_path FROM operation_requests WHERE state='processing' AND file_path IS NOT NULL").all()){const p=resolveUploadPath(row.file_path);if(p)refs.add(p);}
  return refs;
}
export function flushCleanup() {
  if(db.inTransaction)return;
  const refs=referencedFiles();
  for(const job of db.prepare("SELECT * FROM file_cleanup_jobs WHERE state='pending'").all()) {
    const resolved=resolveUploadPath(job.path);if(!resolved||refs.has(resolved))continue;
    try{fs.rmSync(resolved,{force:true});db.prepare("UPDATE file_cleanup_jobs SET state='removed',completed_at=? WHERE id=?").run(nowText(),job.id);}catch(error){console.warn('附件清理等待重试',error.code);}
  }
}
export function promoteUpload(file,folder) {
  if(!file)return null;
  const directory=resolveUploadPath(path.join(config.uploadDir,folder));if(!directory)throw new Error('非法上传目录');
  fs.mkdirSync(directory,{recursive:true});
  const destination=path.join(directory,randomUUID()+path.extname(file.originalname).toLowerCase());
  fs.renameSync(file.path,destination);file.path=destination;return file;
}
export function quarantineOrphans(minAgeMs=24*60*60*1000) {
  const root=path.resolve(config.uploadDir),refs=referencedFiles(),candidates=[];
  const walk=directory=>{for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
    if(entry.isSymbolicLink()||entry.name==='.quarantine')continue;
    const p=path.join(directory,entry.name);if(entry.isDirectory())walk(p);else if(entry.isFile()&&!refs.has(p)&&Date.now()-fs.statSync(p).mtimeMs>=minAgeMs)candidates.push(p);
  }};
  fs.mkdirSync(root,{recursive:true});walk(root);const dest=path.join(root,'.quarantine');fs.mkdirSync(dest,{recursive:true});
  for(const source of candidates){const target=path.join(dest,randomUUID()+path.extname(source));fs.renameSync(source,target);db.prepare('INSERT INTO storage_quarantine(original_path,quarantine_path,quarantined_at) VALUES(?,?,?)').run(source,target,nowText());}
  return {quarantined:candidates.length,retention_days:30};
}
export function purgeExpiredQuarantine(retentionDays=30) {
  const rows=db.prepare("SELECT * FROM storage_quarantine WHERE deleted_at IS NULL AND quarantined_at<=datetime('now','+08:00',?)").all(`-${retentionDays} days`);
  let removed=0;
  for(const row of rows){
    const resolved=resolveUploadPath(row.quarantine_path);
    try{
      if(resolved)fs.rmSync(resolved,{force:true});
      db.prepare('UPDATE storage_quarantine SET deleted_at=? WHERE id=?').run(nowText(),row.id);removed+=1;
    }catch(error){console.warn('隔离文件到期清理等待重试',error.code);}
  }
  return {removed,retention_days:retentionDays};
}
