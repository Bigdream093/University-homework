import { Router } from 'express';
import { db } from '../db.js';
import { auth } from '../middleware/auth.js';
import { studentOnly } from '../middleware/teacher.js';
import { uploadSingle } from '../middleware/upload.js';
import { saveSubmission } from '../services/submissionLogic.js';
import { assignmentAccess,subjectFor,fail } from '../services/access.js';
import { submissionAccess,historyRows,receipts,studentView } from '../services/submissionQueries.js';
import { effectiveDeadline } from '../services/extensions.js';
import { executeOperation,operationStatus } from '../services/operations.js';
import { queueCleanup,flushCleanup } from '../services/storage.js';
import { resolveUploadPath } from '../utils/uploadPath.js';
const router=Router();
router.get('/assignments/:id/my-submission',auth,studentOnly,(req,res)=>{
 const a=assignmentAccess(req.params.id,req.user),s=subjectFor(a,req.user);
 const row=s.not_assigned?null:s.group?db.prepare('SELECT * FROM group_submissions WHERE assignment_group_id=?').get(s.group.id):db.prepare('SELECT * FROM submissions WHERE assignment_id=? AND student_id=?').get(a.id,req.user.id);
 res.json(row?{...studentView({...row,kind:s.group?'group':'individual'}),can_submit:s.can_submit,effective_deadline:effectiveDeadline(a,s).deadline}:null);
});
router.get('/assignments/:id/submission-context',auth,studentOnly,(req,res)=>{
 const a=assignmentAccess(req.params.id,req.user),s=subjectFor(a,req.user);
 res.json({...s,effective_deadline:s.not_assigned?null:effectiveDeadline(a,s).deadline,members:s.group?db.prepare('SELECT student_id,name_snapshot name,username_snapshot username FROM assignment_group_members WHERE assignment_group_id=?').all(s.group.id):[]});
});
router.post('/assignments/:id/submit',auth,studentOnly,(req,res,next)=>{const a=assignmentAccess(req.params.id,req.user,{write:true});if(a.status!=='published')fail(400,'作业已关闭');subjectFor(a,req.user,{submit:true});req.uploadLimit=(a.max_file_mb??200)*1024*1024;next();},uploadSingle,async(req,res)=>{
 try{
 const a=assignmentAccess(req.params.id,req.user,{write:true});
 const result=await executeOperation(req,'submission',a.id,()=>studentView(saveSubmission({assignment:a,studentId:req.user.id,file:req.file,content:req.body.content,baseVersion:req.body.base_version})));
 res.status(result.replayed?200:201).json(result);
 }catch(error){if(req.file){queueCleanup([req.file.path],'未完成的上传');flushCleanup();}throw error;}
});
router.get('/assignments/:id/upload-status/:key',auth,studentOnly,(req,res)=>{const a=assignmentAccess(req.params.id,req.user);res.json(operationStatus(req.user.id,'submission',a.id,req.params.key));});
for(const [prefix,group] of [['submissions',false],['group-submissions',true]]){
 router.get('/'+prefix+'/:id/history',auth,(req,res)=>{submissionAccess(req.params.id,req.user,group);res.json(historyRows(req.params.id,group));});
 router.get('/'+prefix+'/:id/receipts',auth,(req,res)=>{submissionAccess(req.params.id,req.user,group);res.json(receipts(req.params.id,group));});
 router.get('/'+prefix+'/:id/receipts/:number/file',auth,(req,res)=>{
 submissionAccess(req.params.id,req.user,group);const r=receipts(req.params.id,group).find(r=>r.receipt_no===req.params.number);if(!r)fail(404,'回执不存在');
 res.attachment(r.receipt_no+'.txt').type('text/plain; charset=utf-8').send(JSON.stringify(r,null,2));
 });
 router.get('/'+prefix+'/:id/file',auth,(req,res,next)=>{
 const ctx=submissionAccess(req.params.id,req.user,group);let row=ctx.row;
 if(req.query.history_id){row=db.prepare(`SELECT * FROM ${ctx.history} WHERE id=? AND ${ctx.foreign}=?`).get(req.query.history_id,ctx.row.id);if(!row||!['available','online'].includes(row.file_state))fail(404,'原文件已替换或不可用');}
 if(row.file_url){const file=resolveUploadPath(row.file_url,{mustExist:true});if(!file)fail(404,'文件不存在');return res.download(file,row.file_name,error=>{if(error&&!res.headersSent)next(error);});}
 if(row.content)return res.attachment('answer.txt').type('text/plain; charset=utf-8').send(row.content);
 fail(404,'文件不存在');
 });
}
export default router;
