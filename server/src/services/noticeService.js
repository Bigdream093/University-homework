import {db} from '../db.js';
import {courseAccess,fail,textValue} from './access.js';
import {isFuture,nowText} from '../utils/time.js';

function noticeAccess(id,user,write=false) {
  const n=db.prepare('SELECT * FROM notices WHERE id=?').get(id);
  if(!n)fail(404,'通知不存在');
  courseAccess(n.course_id,user,{write,teacher:write});
  return n;
}
export function publishDueNotices(at=nowText()) {
  return db.transaction(()=>{
    const rows=db.prepare("SELECT n.id FROM notices n JOIN courses c ON c.id=n.course_id WHERE n.status='scheduled' AND n.scheduled_at<=? AND c.status='active' ORDER BY n.scheduled_at,n.id LIMIT 100").all(at);
    const update=db.prepare("UPDATE notices SET status='published',published_at=?,updated_at=? WHERE id=? AND status='scheduled'");
    for(const n of rows)update.run(at,at,n.id);
    return rows.length;
  })();
}
export function listNotices(courseId,user,res) {
  courseAccess(courseId,user);publishDueNotices();
  if(user.role==='teacher')return res.json(db.prepare('SELECT n.*,(SELECT count(*) FROM notice_reads r WHERE r.notice_id=n.id AND EXISTS(SELECT 1 FROM course_students cs WHERE cs.course_id=n.course_id AND cs.student_id=r.student_id)) read_count FROM notices n WHERE course_id=? ORDER BY pinned DESC,created_at DESC,id DESC').all(courseId));
  const rows=db.prepare("SELECT n.*,r.first_read_at,r.last_seen_revision FROM notices n LEFT JOIN notice_reads r ON r.notice_id=n.id AND r.student_id=? WHERE n.course_id=? AND n.status IN ('published','withdrawn') ORDER BY pinned DESC,published_at DESC,n.id DESC").all(user.id,courseId);
  res.json(rows.map(n=>({id:n.id,title:n.status==='withdrawn'?'已撤回的通知':n.title,status:n.status,pinned:n.pinned,created_at:n.created_at,published_at:n.published_at,scheduled_at:n.scheduled_at,updated_at:n.updated_at,withdrawn_at:n.withdrawn_at,content_revision:n.content_revision,content_preview:n.status==='withdrawn'?'该通知已被教师撤回':Array.from(n.content.replace(/\s+/g,' ')).slice(0,160).join(''),is_read:!!n.first_read_at,is_updated:n.status==='published'&&!!n.first_read_at&&n.last_seen_revision<n.content_revision})));
}
export function getNotice(id,user,res) {
  publishDueNotices();const n=noticeAccess(id,user);
  if(user.role==='teacher')return res.json({...n,revisions:db.prepare('SELECT * FROM notice_revisions WHERE notice_id=? ORDER BY revision DESC').all(id)});
  if(n.status==='withdrawn')return res.json({id:n.id,title:'已撤回的通知',status:n.status,withdrawn_at:n.withdrawn_at});
  if(n.status!=='published')fail(404,'通知尚未发布');
  res.json({id:n.id,title:n.title,content:n.content,status:n.status,published_at:n.published_at,updated_at:n.updated_at,scheduled_at:n.scheduled_at,content_revision:n.content_revision});
}
export function markRead(id,user,res,body={}) {
  if(user.role!=='student')fail(403,'只登记学生阅读');
  const n=noticeAccess(id,user);
  if(n.status!=='published')fail(409,'通知当前不可登记阅读');
  const revision=body.revision===undefined?n.content_revision:Number(body.revision);
  if(!Number.isInteger(revision)||revision<1||revision>n.content_revision)fail(400,'无效的内容版本');
  const at=nowText();
  db.prepare('INSERT INTO notice_reads(notice_id,student_id,first_read_at,last_read_at,last_seen_revision) VALUES(?,?,?,?,?) ON CONFLICT(notice_id,student_id) DO UPDATE SET last_read_at=excluded.last_read_at,last_seen_revision=MAX(last_seen_revision,excluded.last_seen_revision)').run(id,user.id,at,at,revision);
  res.json({message:'已记录查看'});
}
export function readers(id,teacherId,res) {
  noticeAccess(id,{id:teacherId,role:'teacher'});
  res.json(db.prepare('SELECT u.username,u.name,r.first_read_at,r.last_read_at,r.last_seen_revision FROM notice_reads r JOIN notices n ON n.id=r.notice_id JOIN course_students cs ON cs.course_id=n.course_id AND cs.student_id=r.student_id JOIN users u ON u.id=r.student_id WHERE r.notice_id=? ORDER BY r.first_read_at,u.username').all(id));
}
function statusInput(body) { const s=body.status||'draft';if(!['draft','scheduled','published'].includes(s))fail(400,'发布状态无效');return s; }
export function createNotice(courseId,teacherId,body,res) {
  courseAccess(courseId,{id:teacherId,role:'teacher'},{write:true});
  const title=textValue(body.title,'通知标题',200),content=textValue(body.content,'通知正文',50000,false),status=statusInput(body),at=nowText();
  const scheduled=status==='scheduled'?String(body.scheduled_at||''):null;
  if(status==='scheduled'&&!isFuture(scheduled))fail(400,'定时发布时间必须是有效的未来北京时间');
  const id=db.transaction(()=>{
    const r=db.prepare('INSERT INTO notices(course_id,teacher_id,title,content,pinned,status,scheduled_at,published_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(courseId,teacherId,title,content,body.pinned?1:0,status,scheduled,status==='published'?at:null,at,at);
    db.prepare('INSERT INTO notice_revisions VALUES(?,?,?,?,?)').run(r.lastInsertRowid,1,title,content,at);return r.lastInsertRowid;
  })();
  res.status(201).json(db.prepare('SELECT * FROM notices WHERE id=?').get(id));
}
export function updateNotice(id,teacherId,body,res) {
  const saved=db.transaction(()=>{
    const n=noticeAccess(id,{id:teacherId,role:'teacher'},true);
    if(n.status==='withdrawn')fail(409,'已撤回通知不能修改');
    const status=body.status===undefined?n.status:statusInput(body);
    if(n.status==='published'&&status!=='published')fail(400,'已发布通知不能退回草稿或定时发布，请撤回');
    const scheduled=status==='scheduled'?String(body.scheduled_at??n.scheduled_at??''):status==='published'?n.scheduled_at:null;
    if(status==='scheduled'&&!isFuture(scheduled))fail(400,'定时发布时间必须是有效的未来北京时间');
    const title=textValue(body.title??n.title,'通知标题',200),content=textValue(body.content??n.content,'通知正文',50000,false),at=nowText();
    const changed=title!==n.title||content!==n.content,revision=n.content_revision+(changed?1:0);
    db.prepare('UPDATE notices SET title=?,content=?,pinned=?,status=?,scheduled_at=?,published_at=?,content_revision=?,updated_at=? WHERE id=?').run(title,content,body.pinned===undefined?n.pinned:body.pinned?1:0,status,scheduled,n.published_at||(status==='published'?at:null),revision,at,id);
    if(changed)db.prepare('INSERT INTO notice_revisions VALUES(?,?,?,?,?)').run(id,revision,title,content,at);
    return db.prepare('SELECT * FROM notices WHERE id=?').get(id);
  })();res.json(saved);
}
export function withdrawNotice(id,teacherId,body={},res) {
  db.transaction(()=>{
    const n=noticeAccess(id,{id:teacherId,role:'teacher'},true);
    if(n.status==='withdrawn')return;
    if(n.status!=='published')fail(400,'只能撤回已发布通知');
    const at=nowText();db.prepare("UPDATE notices SET status='withdrawn',withdrawn_at=?,withdrawn_reason=?,updated_at=? WHERE id=?").run(at,textValue(body.reason||'教师撤回','原因',2000),at,id);
  })();res.json({message:'通知已撤回，历史已保留'});
}
export function deleteDraftNotice(id,teacherId,res) {
  const n=noticeAccess(id,{id:teacherId,role:'teacher'},true);
  if(n.status!=='draft')fail(400,'只有草稿可删除；定时通知先取消，已发布通知请撤回');
  db.prepare('DELETE FROM notices WHERE id=?').run(id);res.json({message:'草稿已删除'});
}
