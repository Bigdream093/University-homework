import path from 'node:path';
import { Router } from 'express';
import { db } from '../db.js';
import { auth } from '../middleware/auth.js';
import { teacherOnly } from '../middleware/teacher.js';
import { uploadSingle } from '../middleware/upload.js';
import { safeName } from '../utils/fileFilter.js';
import { courseAccess,fail,textValue } from '../services/access.js';
import { executeOperation,operationStatus } from '../services/operations.js';
import { queueCleanup,flushCleanup } from '../services/storage.js';
import { serveMaterialFile } from '../services/materialFileService.js';
import { nowText } from '../utils/time.js';
import { config } from '../config.js';
const router=Router();
function limitMaterialUpload(req,_res,next){req.uploadLimit=config.materialUploadMaxMb*1024*1024;req.uploadLabel='课程资料';next();}
function material(id,user,write=false){
 const m=db.prepare('SELECT * FROM materials WHERE id=?').get(id);if(!m)fail(404,'资料不存在');courseAccess(m.course_id,user,{write});return m;
}
function view(id){return db.prepare('SELECT m.id,m.title,m.description,m.file_name,m.file_size,m.file_type,m.created_at,COALESCE((SELECT SUM(download_count) FROM material_downloads d WHERE d.material_id=m.id),0) download_count FROM materials m WHERE m.id=?').get(id);}
router.get('/courses/:id/materials',auth,(req,res)=>{const c=courseAccess(req.params.id,req.user);res.json(db.prepare('SELECT id FROM materials WHERE course_id=? ORDER BY id DESC').all(c.id).map(m=>view(m.id)));});
router.post('/courses/:id/materials',auth,teacherOnly,(req,res,next)=>{courseAccess(req.params.id,req.user,{write:true});next();},limitMaterialUpload,uploadSingle,async(req,res)=>{
 try{
 const c=courseAccess(req.params.id,req.user,{write:true});
 const data=await executeOperation(req,'material-create',c.id,()=>{
 courseAccess(c.id,req.user,{write:true});if(!req.file)fail(400,'请选择资料文件');
 const f=req.file,id=db.prepare('INSERT INTO materials(course_id,teacher_id,title,description,file_url,file_name,file_size,file_type,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(c.id,req.user.id,textValue(req.body.title,'资料标题',200),textValue(req.body.description,'资料说明',20000,false),f.path,safeName(f.originalname),f.size,path.extname(f.originalname).slice(1).toLowerCase(),nowText()).lastInsertRowid;return view(id);
 });res.status(data.replayed?200:201).json(data);
 }catch(error){if(req.file){queueCleanup([req.file.path],'失败上传');flushCleanup();}throw error;}
});
router.put('/materials/:id',auth,teacherOnly,(req,res,next)=>{material(req.params.id,req.user,true);next();},limitMaterialUpload,uploadSingle,async(req,res)=>{
 try{
 const m=material(req.params.id,req.user,true),data=await executeOperation(req,'material-update',m.id,()=>{
 const current=material(m.id,req.user,true),f=req.file;
 db.prepare('UPDATE materials SET title=?,description=?,file_url=?,file_name=?,file_size=?,file_type=? WHERE id=?').run(textValue(req.body.title??current.title,'资料标题',200),textValue(req.body.description??current.description,'说明',20000,false),f?.path||current.file_url,f?safeName(f.originalname):current.file_name,f?.size??current.file_size,f?path.extname(f.originalname).slice(1).toLowerCase():current.file_type,current.id);
 if(f)queueCleanup([current.file_url],'资料替换');return view(current.id);
 });res.json(data);
 }catch(error){if(req.file){queueCleanup([req.file.path],'失败上传');flushCleanup();}throw error;}
});
router.get('/courses/:id/material-upload-status/:key',auth,teacherOnly,(req,res)=>{const c=courseAccess(req.params.id,req.user);res.json(operationStatus(req.user.id,'material-create',c.id,req.params.key));});
router.get('/materials/:id/upload-status/:key',auth,teacherOnly,(req,res)=>{const m=material(req.params.id,req.user);res.json(operationStatus(req.user.id,'material-update',m.id,req.params.key));});
router.delete('/materials/:id',auth,teacherOnly,(req,res)=>{const m=material(req.params.id,req.user,true);db.transaction(()=>{queueCleanup([m.file_url],'删除资料');db.prepare('DELETE FROM materials WHERE id=?').run(m.id);})();flushCleanup();res.json({message:'资料已删除'});});
router.get('/materials/:id/downloads',auth,teacherOnly,(req,res)=>{const m=material(req.params.id,req.user);res.json(db.prepare('SELECT u.username,u.name,d.download_count,d.first_downloaded_at,d.last_downloaded_at FROM material_downloads d JOIN users u ON u.id=d.student_id WHERE material_id=? ORDER BY d.last_downloaded_at DESC').all(m.id));});
router.get('/materials/:id/file',auth,(req,res,next)=>serveMaterialFile(Number(req.params.id),req.user,res,req,next));
export default router;
