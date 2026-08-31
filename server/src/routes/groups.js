import { Router } from 'express';
import { db } from '../db.js';
import { auth } from '../middleware/auth.js';
import { teacherOnly } from '../middleware/teacher.js';
import { courseAccess,assignmentAccess,fail,textValue } from '../services/access.js';
import { nowText } from '../utils/time.js';
const router=Router();
function members(ids,courseId,except=0){
 if(!Array.isArray(ids)||!ids.length)fail(400,'请选择组成员');const result=[...new Set(ids.map(Number))];
 for(const id of result){
 if(!db.prepare("SELECT 1 FROM course_students cs JOIN users u ON u.id=cs.student_id WHERE cs.course_id=? AND cs.student_id=? AND u.role='student' AND u.status='active'").get(courseId,id))fail(400,'成员必须是课程中的有效学生');
 if(db.prepare('SELECT 1 FROM course_group_members WHERE course_id=? AND student_id=? AND course_group_id<>?').get(courseId,id,except))fail(409,'学生已在其他小组');
 }return result;
}
router.get('/courses/:id/groups',auth,(req,res)=>{
 const c=courseAccess(req.params.id,req.user);
 const groups=db.prepare('SELECT * FROM course_groups WHERE course_id=? ORDER BY id').all(c.id).map(g=>({...g,members:db.prepare('SELECT u.id,u.username,u.name FROM course_group_members m JOIN users u ON u.id=m.student_id WHERE m.course_group_id=? ORDER BY u.id').all(g.id)}));
 res.json(req.user.role==='teacher'?groups:groups.filter(g=>g.members.some(m=>m.id===req.user.id)));
});
function saveGroup(req,id){
 const existing=id?db.prepare('SELECT * FROM course_groups WHERE id=?').get(id):null;if(id&&!existing)fail(404,'小组不存在');
 const c=courseAccess(existing?.course_id||req.params.id,req.user,{write:true,teacher:true}),list=members(req.body.member_ids,c.id,id||0),leader=Number(req.body.leader_id);
 if(!list.includes(leader))fail(400,'组长必须是本组成员');const name=textValue(req.body.name,'组名',100);
 if(db.prepare('SELECT 1 FROM course_groups WHERE course_id=? AND name=? AND id<>?').get(c.id,name,id||0))fail(409,'组名重复');
 if(id){db.prepare('UPDATE course_groups SET name=?,leader_id=? WHERE id=?').run(name,leader,id);db.prepare('DELETE FROM course_group_members WHERE course_group_id=?').run(id);}
 else id=db.prepare('INSERT INTO course_groups(course_id,name,leader_id,created_at) VALUES(?,?,?,?)').run(c.id,name,leader,nowText()).lastInsertRowid;
 for(const student of list)db.prepare('INSERT INTO course_group_members(course_group_id,course_id,student_id) VALUES(?,?,?)').run(id,c.id,student);
 return {id};
}
router.post('/courses/:id/groups',auth,teacherOnly,(req,res)=>res.status(201).json(db.transaction(()=>saveGroup(req))()));
router.put('/groups/:id',auth,teacherOnly,(req,res)=>res.json(db.transaction(()=>saveGroup(req,Number(req.params.id)))()));
router.delete('/groups/:id',auth,teacherOnly,(req,res)=>{const g=db.prepare('SELECT * FROM course_groups WHERE id=?').get(req.params.id);if(!g)fail(404,'小组不存在');courseAccess(g.course_id,req.user,{write:true});db.prepare('DELETE FROM course_groups WHERE id=?').run(g.id);res.json({message:'模板小组已删除，已发布作业快照不受影响'});});
router.get('/assignments/:id/groups',auth,(req,res)=>{
 const a=assignmentAccess(req.params.id,req.user);
 const rows=db.prepare('SELECT * FROM assignment_groups WHERE assignment_id=? ORDER BY id').all(a.id).map(g=>({...g,members:db.prepare('SELECT student_id id,name_snapshot name,username_snapshot username FROM assignment_group_members WHERE assignment_group_id=?').all(g.id)}));
 res.json(req.user.role==='teacher'?rows:rows.filter(g=>g.members.some(m=>m.id===req.user.id)));
});
router.post('/assignments/:id/groups/snapshot',auth,teacherOnly,(req,res)=>{
 db.transaction(()=>{
 const a=assignmentAccess(req.params.id,req.user,{write:true});if(a.status!=='draft'||a.groups_locked||a.work_mode!=='group')fail(400,'仅未发布的分组作业草稿可以配置快照');
 const ids=[...new Set((req.body.group_ids||[]).map(Number))];if(!ids.length)fail(400,'请选择小组');
 db.prepare('DELETE FROM assignment_groups WHERE assignment_id=?').run(a.id);
 for(const id of ids){
 const g=db.prepare('SELECT * FROM course_groups WHERE id=? AND course_id=?').get(id,a.course_id);if(!g)fail(400,'小组不属于本课程');
 const list=db.prepare('SELECT u.id,u.username,u.name FROM course_group_members m JOIN users u ON u.id=m.student_id JOIN course_students cs ON cs.student_id=u.id AND cs.course_id=? WHERE m.course_group_id=?').all(a.course_id,g.id);
 if(!list.length||!list.some(m=>m.id===g.leader_id))fail(400,'小组不能为空，且组长必须在当前课程中');
 const gid=db.prepare('INSERT INTO assignment_groups(assignment_id,name,submitter_id,created_at) VALUES(?,?,?,?)').run(a.id,g.name,g.leader_id,nowText()).lastInsertRowid;
 for(const m of list)db.prepare('INSERT INTO assignment_group_members(assignment_group_id,assignment_id,student_id,username_snapshot,name_snapshot) VALUES(?,?,?,?,?)').run(gid,a.id,m.id,m.username,m.name);
 }
 })();res.json({message:'已保存作业成员快照'});
});
router.put('/assignment-groups/:id/submitter',auth,teacherOnly,(req,res)=>{
 const g=db.prepare('SELECT * FROM assignment_groups WHERE id=?').get(req.params.id);if(!g)fail(404,'分组不存在');
 const a=assignmentAccess(g.assignment_id,req.user,{write:true}),id=Number(req.body.submitter_id);
 if(!db.prepare('SELECT 1 FROM assignment_group_members m JOIN course_students cs ON cs.student_id=m.student_id AND cs.course_id=? WHERE m.assignment_group_id=? AND m.student_id=?').get(a.course_id,g.id,id))fail(400,'提交人必须是当前在课的快照成员');
 db.prepare('UPDATE assignment_groups SET submitter_id=? WHERE id=?').run(id,g.id);res.json({message:'提交人已更新'});
});
export default router;

