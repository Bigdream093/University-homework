import { Router } from 'express';
import { db } from '../db.js';
import { auth } from '../middleware/auth.js';
import { teacherOnly,studentOnly } from '../middleware/teacher.js';
import { courseAccess,fail,textValue,pageOf } from '../services/access.js';
import { nowText } from '../utils/time.js';
const router=Router();
function privateQuestion(id,user,write=false){
 const q=db.prepare('SELECT * FROM course_questions WHERE id=?').get(id);if(!q)fail(404,'问题不存在');
 courseAccess(q.course_id,user,{write});
 if(user.role!=='teacher'&&q.student_id!==user.id)fail(404,'问题不存在');
 return q;
}
function event(q,user,type){db.prepare('INSERT INTO question_visibility_events(question_id,actor_id,event,created_at) VALUES(?,?,?,?)').run(q.id,user.id,type,nowText());}
function withdraw(q,user){db.prepare("UPDATE question_publications SET status='withdrawn',withdrawn_at=? WHERE question_id=? AND status='published'").run(nowText(),q.id);event(q,user,'withdraw');}
function editable(q){if(db.prepare('SELECT 1 FROM question_replies WHERE question_id=?').get(q.id)||db.prepare('SELECT 1 FROM question_publications WHERE question_id=?').get(q.id))fail(409,'已有回复或公开历史，不能改写原问题');}
router.get('/courses/:id/questions',auth,(req,res)=>{
 courseAccess(req.params.id,req.user);const {limit,offset}=pageOf(req.query),keyword='%'+String(req.query.keyword||'')+'%';
 const student=req.user.role==='student',where="q.course_id=?"+(student?' AND q.student_id=?':'')+" AND (q.title LIKE ? OR q.content LIKE ?)"+(req.query.status?' AND q.status=?':'');
 const args=[req.params.id,...(student?[req.user.id]:[]),keyword,keyword,...(req.query.status?[req.query.status]:[])];
 res.json(db.prepare(`SELECT q.*,u.name student_name FROM course_questions q JOIN users u ON u.id=q.student_id WHERE ${where} ORDER BY q.pinned DESC,q.id DESC LIMIT ? OFFSET ?`).all(...args,limit,offset));
});
router.get('/courses/:id/questions/public',auth,(req,res)=>{
 courseAccess(req.params.id,req.user);const {limit,offset}=pageOf(req.query),keyword='%'+String(req.query.keyword||'')+'%';
 // Public reads never select the student identity, original question text or private replies.
 res.json(db.prepare("SELECT p.id,p.summary,p.reply,p.created_at,q.pinned FROM question_publications p JOIN course_questions q ON q.id=p.question_id WHERE q.course_id=? AND q.hidden=0 AND p.status='published' AND (p.summary LIKE ? OR p.reply LIKE ?) ORDER BY q.pinned DESC,p.id DESC LIMIT ? OFFSET ?").all(req.params.id,keyword,keyword,limit,offset));
});
router.post('/courses/:id/questions',auth,studentOnly,(req,res)=>{
 const c=courseAccess(req.params.id,req.user,{write:true}),at=nowText();
 const id=db.prepare('INSERT INTO course_questions(course_id,student_id,title,content,must_private,created_at,updated_at) VALUES(?,?,?,?,0,?,?)').run(c.id,req.user.id,textValue(req.body.title,'标题',200),textValue(req.body.content,'问题内容'),at,at).lastInsertRowid;
 res.status(201).json({id});
});
router.get('/questions/:id',auth,(req,res)=>{
 const q=privateQuestion(req.params.id,req.user);
 res.json({...q,replies:db.prepare('SELECT r.*,u.name author_name,u.role FROM question_replies r JOIN users u ON u.id=r.author_id WHERE question_id=? ORDER BY r.id').all(q.id),publications:db.prepare('SELECT * FROM question_publications WHERE question_id=? ORDER BY id DESC').all(q.id),visibility_events:db.prepare('SELECT event,created_at FROM question_visibility_events WHERE question_id=? ORDER BY id').all(q.id)});
});
router.put('/questions/:id',auth,studentOnly,(req,res)=>{
 const q=privateQuestion(req.params.id,req.user,true);editable(q);
 db.prepare('UPDATE course_questions SET title=?,content=?,updated_at=? WHERE id=?').run(textValue(req.body.title,'标题',200),textValue(req.body.content,'内容'),nowText(),q.id);res.json({message:'问题已修改'});
});
router.delete('/questions/:id',auth,studentOnly,(req,res)=>{
 const q=privateQuestion(req.params.id,req.user,true);editable(q);db.prepare('DELETE FROM course_questions WHERE id=?').run(q.id);res.json({message:'问题已删除'});
});
router.post('/questions/:id/replies',auth,(req,res)=>{
 const q=privateQuestion(req.params.id,req.user,true),at=nowText();
 db.transaction(()=>{db.prepare('INSERT INTO question_replies(question_id,author_id,content,created_at) VALUES(?,?,?,?)').run(q.id,req.user.id,textValue(req.body.content,'回复内容'),at);db.prepare('UPDATE course_questions SET status=?,updated_at=? WHERE id=?').run(req.user.role==='teacher'?'answered':'open',at,q.id);})();
 res.status(201).json({message:'私人回复已保存'});
});
router.post('/questions/:id/publish',auth,teacherOnly,(req,res)=>{
 db.transaction(()=>{const q=privateQuestion(req.params.id,req.user,true);if(q.hidden)fail(400,'问题已隐藏，不能公开');
 const summary=textValue(req.body.summary,'公开摘要'),reply=textValue(req.body.reply,'公开答复');withdraw(q,req.user);
 db.prepare('INSERT INTO question_publications(question_id,teacher_id,summary,reply,created_at) VALUES(?,?,?,?,?)').run(q.id,req.user.id,summary,reply,nowText());event(q,req.user,'publish');})();
 res.status(201).json({message:'已公开摘要和答复，私人原帖及后续追问不会公开'});
});
router.post('/questions/:id/withdraw',auth,teacherOnly,(req,res)=>{db.transaction(()=>withdraw(privateQuestion(req.params.id,req.user),req.user))();res.json({message:'公开摘要已撤回'});});
router.put('/questions/:id/manage',auth,teacherOnly,(req,res)=>{
 db.transaction(()=>{const q=privateQuestion(req.params.id,req.user);
 if(req.body.hidden!==true||req.body.status!==undefined||req.body.pinned!==undefined)courseAccess(q.course_id,req.user,{write:true});
 const status=req.body.status??q.status;if(!['open','answered','resolved'].includes(status))fail(400,'无效状态');
 const hidden=req.body.hidden===undefined?q.hidden:Number(!!req.body.hidden);
 if(hidden)withdraw(q,req.user);
 db.prepare('UPDATE course_questions SET status=?,pinned=?,hidden=?,updated_at=? WHERE id=?').run(status,req.body.pinned===undefined?q.pinned:Number(!!req.body.pinned),hidden,nowText(),q.id);})();
 res.json({message:'问题状态已更新'});
});
export default router;
