import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { db } from '../src/db.js';
import { quarantineOrphans,referencedFiles } from '../src/services/storage.js';
import { parseTime,nowText } from '../src/utils/time.js';
const action=process.argv[2]||'--report';
const root=path.resolve(config.uploadDir),quarantine=path.join(root,'.quarantine');
if(action==='--quarantine')console.log(JSON.stringify(quarantineOrphans()));
else if(action==='--purge-after-30-days'){
 let removed=0;
 for(const row of db.prepare('SELECT * FROM storage_quarantine WHERE deleted_at IS NULL').all()){
 const target=path.resolve(row.quarantine_path);
 if(path.dirname(target)!==quarantine)throw new Error('隔离文件不在预期目录中，停止处理');
 if(Date.now()-parseTime(row.quarantined_at)<30*24*60*60*1000)continue;
 if(referencedFiles().has(target)||referencedFiles().has(path.resolve(row.original_path)))continue;
 fs.rmSync(target,{force:true});
 db.prepare('UPDATE storage_quarantine SET deleted_at=? WHERE id=?').run(nowText(),row.id);removed++;
 }console.log(JSON.stringify({removed,minimum_retention_days:30}));
}else if(action==='--report')console.log(JSON.stringify({referenced_files:referencedFiles().size,pending_cleanup:db.prepare("SELECT count(*) n FROM file_cleanup_jobs WHERE state='pending'").get().n,quarantined_files:db.prepare('SELECT count(*) n FROM storage_quarantine WHERE deleted_at IS NULL').get().n}));
else throw new Error('支持 --report、--quarantine 或 --purge-after-30-days');
db.close();

