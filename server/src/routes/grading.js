import { Router } from 'express';
import { db } from '../db.js';
import { auth } from '../middleware/auth.js';
import { teacherOnly } from '../middleware/teacher.js';
import { assignmentAccess,courseAccess,fail,textValue } from '../services/access.js';
import { submissionAccess,teacherRows } from '../services/submissionQueries.js';
import { nowText } from '../utils/time.js';
const router=Router();
router.get('/assignments/:id/submissions',auth,teacherOnly,(req,res)=>{
 let rows=teacherRows(assignmentAccess(req.params.id,req.user)),keyword=String(req.query.keyword||'').toLowerCase();
 if(keyword)rows=rows.filter(r=>[r.name,r.username,...(r.members||[]).flatMap(m=>[m.name,m.username])].join(' ').toLowerCase().includes(keyword));
 const s=req.query.status;if(s==='unsubmitted')rows=rows.filter(r=>!r.id);else if(s==='late')rows=rows.filter(r=>r.is_late===1);else if(s)rows=rows.filter(r=>r.id&&r.status===s);
 res.json(rows);
});
for(const [prefix,group] of [['submissions',false],['group-submissions',true]]){
 router.post('/'+prefix+'/:id/grade',auth,teacherOnly,(req,res)=>{
 const {row,a,table}=submissionAccess(req.params.id,req.user,group,true),score=Number(req.body.score);
 if(!Number.isFinite(score)||score<0||score>a.total_score)fail(400,'成绩超出作业分值范围');
 db.prepare(`UPDATE ${table} SET score=?,comment=?,status='graded',returned_reason=NULL,graded_at=? WHERE id=?`).run(score,textValue(req.body.comment,'评语',10000,false),nowText(),row.id);res.json({message:'批改已保存'});
 });
 router.post('/'+prefix+'/:id/return',auth,teacherOnly,(req,res)=>{
 const {row,table}=submissionAccess(req.params.id,req.user,group,true);
 db.prepare(`UPDATE ${table} SET status='returned',returned_reason=?,score=NULL,comment=NULL,graded_at=NULL WHERE id=?`).run(textValue(req.body.returned_reason,'退回原因',2000),row.id);res.json({message:'已退回，提交次数限制保持不变'});
 });
}
router.get('/courses/:id/students/:sid/submissions',auth,teacherOnly,(req,res)=>{
 courseAccess(req.params.id,req.user);res.json(db.prepare('SELECT * FROM assignments WHERE course_id=? ORDER BY id DESC').all(req.params.id).flatMap(a=>teacherRows(a).filter(r=>r.student_id===Number(req.params.sid)||r.members?.some(m=>m.student_id===Number(req.params.sid))).map(r=>({...r,title:a.title,deadline:a.deadline}))));
});
export default router;
