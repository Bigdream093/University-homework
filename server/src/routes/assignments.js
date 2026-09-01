import { Router } from 'express';
import { db } from '../db.js';
import { auth } from '../middleware/auth.js';
import { teacherOnly } from '../middleware/teacher.js';
import { deleteAssignment } from '../services/deletionService.js';
import { courseAccess,assignmentAccess,subjectFor,textValue,fail } from '../services/access.js';
import { nowText,validTime } from '../utils/time.js';
import { effectiveDeadline } from '../services/extensions.js';
const router=Router();
function hasSubmissions(id){return !!(db.prepare('SELECT 1 FROM submissions WHERE assignment_id=? LIMIT 1').get(id)||db.prepare('SELECT 1 FROM group_submissions s JOIN assignment_groups g ON g.id=s.assignment_group_id WHERE g.assignment_id=? LIMIT 1').get(id));}
function highestScore(id){return db.prepare(`SELECT MAX(score) value FROM (SELECT score FROM submissions WHERE assignment_id=? UNION ALL SELECT s.score FROM group_submissions s JOIN assignment_groups g ON g.id=s.assignment_group_id WHERE g.assignment_id=?)`).get(id,id).value;}
function values(body,current={}){
 const a={...current,...body};
 const title=textValue(a.title,'作业标题',200),deadline=a.deadline||null,max=Number(a.max_file_mb??200),score=Number(a.total_score??100),allowed=Number(a.allow_resubmit_count??1);
 if(deadline&&!validTime(deadline))fail(400,'截止时间格式无效');
 if(![100,200,500,1024].includes(max))fail(400,'文件大小上限只能是 100M、200M、500M 或 1G');
 if(!Number.isFinite(score)||score<=0||!Number.isInteger(allowed)||allowed< -1)fail(400,'分值或提交次数无效');
 const work=a.work_mode??'individual',policy=a.group_submit_policy??'designated',mode=a.submission_mode??'overwrite',type=a.type??'document';
 if(!['individual','group'].includes(work)||!['designated','any'].includes(policy)||!['overwrite','append'].includes(mode)||!['document','image','video','online'].includes(type))fail(400,'作业设置无效');
 if(current.id&&(current.status!=='draft'||current.groups_locked||db.prepare('SELECT 1 FROM submissions WHERE assignment_id=?').get(current.id))&&work!==current.work_mode)fail(400,'已发布或已有提交的作业不能改变个人/分组类型');
 if(current.id&&hasSubmissions(current.id)){
  if(type!==current.type||mode!==current.submission_mode||max!==current.max_file_mb)fail(409,'已有学生提交，不能修改作业类型、提交模式或文件大小上限');
  const gradedMax=highestScore(current.id);if(gradedMax!==null&&score<gradedMax)fail(409,`满分不能低于已有最高成绩 ${gradedMax}`);
 }
 return [title,textValue(a.description,'作业要求',20000,false),type,deadline,score,allowed,mode,max,work,policy];
}
function publish(a){
 if(a.work_mode==='group'){
 const groups=db.prepare('SELECT * FROM assignment_groups WHERE assignment_id=?').all(a.id);
 if(!groups.length)fail(400,'分组作业必须先配置成员快照');
 for(const g of groups){
 const list=db.prepare('SELECT student_id FROM assignment_group_members WHERE assignment_group_id=?').all(g.id);
 if(!list.length)fail(400,'不能发布空小组');
 if(!a.groups_locked)for(const m of list)if(!db.prepare('SELECT 1 FROM course_students WHERE course_id=? AND student_id=?').get(a.course_id,m.student_id))fail(400,'快照成员已退课，请重新配置');
 if(a.group_submit_policy==='designated'&&!list.some(m=>m.student_id===g.submitter_id))fail(400,'小组没有有效提交人');
 }
 }
 db.prepare("UPDATE assignments SET status='published',groups_locked=1,updated_at=? WHERE id=?").run(nowText(),a.id);
}
router.get('/courses/:id/assignments',auth,(req,res)=>{
 const c=courseAccess(req.params.id,req.user);
 const rows=db.prepare("SELECT * FROM assignments WHERE course_id=?"+(req.user.role==='student'?" AND status IN ('published','closed')":'')+" ORDER BY deadline IS NULL,deadline,id DESC").all(c.id);
 res.json(rows.map(a=>{
 if(req.user.role==='student'){
 const subject=subjectFor({...a,course_status:c.status},req.user);
 const sub=subject.not_assigned?null:subject.group?db.prepare('SELECT status,submitted_at FROM group_submissions WHERE assignment_group_id=?').get(subject.group.id):db.prepare('SELECT status,submitted_at FROM submissions WHERE assignment_id=? AND student_id=?').get(a.id,req.user.id);
 return {...a,submission_status:sub?.status,submitted_at:sub?.submitted_at,can_submit:subject.can_submit,not_assigned:subject.not_assigned||false,effective_deadline:subject.not_assigned?null:effectiveDeadline(a,subject).deadline,server_now:nowText()};
 }return {...a,server_now:nowText()};
 }));
});
router.get('/assignments/:id',auth,(req,res)=>{const a=assignmentAccess(req.params.id,req.user);delete a.teacher_id;res.json({...a,server_now:nowText()});});
router.post('/courses/:id/assignments',auth,teacherOnly,(req,res)=>{
 const c=courseAccess(req.params.id,req.user,{write:true}),v=values(req.body),status=req.body.status??'draft';
 if(!['draft','published'].includes(status))fail(400,'新作业状态无效');
 const id=db.transaction(()=>{
 const id=db.prepare("INSERT INTO assignments(course_id,title,description,type,deadline,total_score,allow_resubmit_count,submission_mode,max_file_mb,work_mode,group_submit_policy,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'draft',?,?)").run(c.id,...v,nowText(),nowText()).lastInsertRowid;
 if(status==='published')publish(db.prepare('SELECT * FROM assignments WHERE id=?').get(id));return id;
 })();res.status(201).json(db.prepare('SELECT * FROM assignments WHERE id=?').get(id));
});
router.put('/assignments/:id',auth,teacherOnly,(req,res)=>{
 const a=assignmentAccess(req.params.id,req.user,{write:true}),v=values(req.body,a);
 const at=nowText(),cancelled=db.transaction(()=>{db.prepare('UPDATE assignments SET title=?,description=?,type=?,deadline=?,total_score=?,allow_resubmit_count=?,submission_mode=?,max_file_mb=?,work_mode=?,group_submit_policy=?,updated_at=? WHERE id=?').run(...v,at,a.id);return a.deadline&&!v[3]?db.prepare("UPDATE extension_requests SET status='cancelled',decision_reason='作业截止时间已清空',decided_at=? WHERE assignment_id=? AND status='pending'").run(at,a.id).changes:0;})();
 res.json({...db.prepare('SELECT * FROM assignments WHERE id=?').get(a.id),cancelled_extension_count:cancelled});
});
router.delete('/assignments/:id',auth,teacherOnly,(req,res)=>{const a=assignmentAccess(req.params.id,req.user,{write:true});deleteAssignment(a.id);res.json({message:'作业已删除'});});
router.post('/assignments/:id/publish',auth,teacherOnly,(req,res)=>{db.transaction(()=>publish(assignmentAccess(req.params.id,req.user,{write:true})))();res.json({message:'作业已发布'});});
router.post('/assignments/:id/close',auth,teacherOnly,(req,res)=>{
 db.transaction(()=>{const a=assignmentAccess(req.params.id,req.user,{write:true});if(a.status==='draft')fail(400,'草稿不能直接关闭');db.prepare("UPDATE assignments SET status='closed',updated_at=? WHERE id=?").run(nowText(),a.id);})();
 res.json({message:'作业已关闭；待审批的延期申请保留，可拒绝但不可批准'});
});
export default router;
