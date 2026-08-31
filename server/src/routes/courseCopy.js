import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { db,randomInvite } from '../db.js';
import { config } from '../config.js';
import { auth } from '../middleware/auth.js';
import { teacherOnly } from '../middleware/teacher.js';
import { courseAccess,textValue,fail } from '../services/access.js';
import { executeOperation,operationStatus } from '../services/operations.js';
import { queueCleanup,flushCleanup } from '../services/storage.js';
import { resolveUploadPath } from '../utils/uploadPath.js';
import { nowText } from '../utils/time.js';
const router=Router();
router.post('/courses/:id/copy',auth,teacherOnly,async(req,res)=>{
 const c=courseAccess(req.params.id,req.user);
 const name=textValue(req.body.name,'新课程名称',200),code=textValue(req.body.code,'课程代码',100,false);
 const materials=req.body.include_materials===false?[]:db.prepare('SELECT * FROM materials WHERE course_id=?').all(c.id);
 const staged=[],renamed=[];let tmpDir=null;
 try {
 const result=await executeOperation(req,'course-copy',c.id,()=>{
 const at=nowText();
 const id=db.prepare('INSERT INTO courses(name,code,description,teacher_id,invite_code,created_at,copied_from_id) VALUES(?,?,?,?,?,?,?)').run(name,code,c.description,req.user.id,randomInvite(),at,c.id).lastInsertRowid;
 if(req.body.include_assignments!==false)for(const a of db.prepare('SELECT * FROM assignments WHERE course_id=?').all(c.id))
 db.prepare("INSERT INTO assignments(course_id,title,description,type,total_score,allow_resubmit_count,submission_mode,max_file_mb,work_mode,group_submit_policy,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'draft',?,?)").run(id,a.title,a.description,a.type,a.total_score,a.allow_resubmit_count,a.submission_mode,a.max_file_mb,a.work_mode,a.group_submit_policy,at,at);
 if(staged.length){
 const directory=path.join(config.uploadDir,'copies',String(id));fs.mkdirSync(directory,{recursive:true});
 for(const item of staged){
 const target=path.join(directory,randomUUID()+path.extname(item.staged));fs.renameSync(item.staged,target);renamed.push(target);
 db.prepare('INSERT INTO materials(course_id,teacher_id,title,description,file_url,file_name,file_size,file_type,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,req.user.id,item.material.title,item.material.description,target,item.material.file_name,item.material.file_size,item.material.file_type,at);
 }
 }
 return {id,message:'课程复制成功；作业均为草稿，学生和历史数据未复制'};
 },()=>{
 // 阶段一：附件复制放在数据库事务之外执行，避免长时间占用写锁阻塞其他请求。
 for(const m of materials){
 const source=resolveUploadPath(m.file_url,{mustExist:true});if(!source)fail(409,'原课程有缺失的资料，请修复后再复制');
 if(!tmpDir){tmpDir=path.join(config.uploadDir,'copies-tmp',randomUUID());fs.mkdirSync(tmpDir,{recursive:true});}
 const target=path.join(tmpDir,randomUUID()+path.extname(source));
 fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);
 staged.push({material:m,staged:target});
 }
 });res.status(result.replayed?200:201).json(result);
 }catch(error){
 const leftovers=[...staged.map(s=>s.staged),...renamed];
 if(leftovers.length)queueCleanup(leftovers,'复制课程失败');
 if(tmpDir)try{fs.rmSync(tmpDir,{recursive:true,force:true});}catch{}
 flushCleanup();throw error;
 }
});
router.get('/courses/:id/copy-status/:key',auth,teacherOnly,(req,res)=>{const c=courseAccess(req.params.id,req.user);res.json(operationStatus(req.user.id,'course-copy',c.id,req.params.key));});
export default router;
