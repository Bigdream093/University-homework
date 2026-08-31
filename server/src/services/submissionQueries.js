import { db } from '../db.js';
import { assignmentAccess,subjectFor,fail } from './access.js';
import { resolveUploadPath } from '../utils/uploadPath.js';
export function studentView(row) {
 if(!row)return null;
 const {score,comment,graded_at,file_url,...safe}=row;
 const actor=row.submitted_by?db.prepare('SELECT name,username FROM users WHERE id=?').get(row.submitted_by):null;
 return {...safe,submitted_by_name:actor?.name,submitted_by_username:actor?.username,api_base:(row.kind==='group'?'/group-submissions/':'/submissions/')+row.id,version:row.submit_count};
}
export function submissionAccess(id,user,group=false,write=false){
 const row=group?db.prepare('SELECT s.*,g.assignment_id FROM group_submissions s JOIN assignment_groups g ON g.id=s.assignment_group_id WHERE s.id=?').get(id):db.prepare('SELECT * FROM submissions WHERE id=?').get(id);
 if(!row)fail(404,'提交记录不存在');
 const a=assignmentAccess(row.assignment_id,user,{write});
 if(user.role==='student'){
 const subject=subjectFor(a,user);
 if(group?subject.assignment_group_id!==row.assignment_group_id:row.student_id!==user.id)fail(403,'无权访问提交记录');
 }
 return {row,a,table:group?'group_submissions':'submissions',history:group?'group_submission_history':'submission_history',foreign:group?'group_submission_id':'submission_id'};
}
export function historyRows(id,group=false) {
 return db.prepare(`SELECT id,content,file_name,file_size,file_type,file_state,is_late,submitted_at${group?',submitted_by':''} FROM ${group?'group_submission_history':'submission_history'} WHERE ${group?'group_submission_id':'submission_id'}=? ORDER BY id DESC`).all(id);
}
export function receipts(id,group=false) {
 const history=group?'group_submission_history':'submission_history',foreign=group?'group_submission_id':'submission_id',receiptForeign=group?'group_submission_history_id':'submission_history_id';
 return db.prepare(`SELECT r.receipt_no,r.snapshot_json,r.created_at,h.file_state,h.file_url FROM submission_receipts r JOIN ${history} h ON h.id=r.${receiptForeign} WHERE h.${foreign}=? ORDER BY r.id DESC`).all(id).map(r=>({receipt_no:r.receipt_no,created_at:r.created_at,snapshot:JSON.parse(r.snapshot_json),current_file_state:r.file_state==='available'&&!resolveUploadPath(r.file_url,{mustExist:true})?'missing':r.file_state}));
}
export function teacherRows(a) {
 const group=a.work_mode==='group';
 let rows=group?db.prepare('SELECT s.*,g.id assignment_group_id,g.name name,g.name username FROM assignment_groups g LEFT JOIN group_submissions s ON s.assignment_group_id=g.id WHERE g.assignment_id=? ORDER BY g.id').all(a.id):db.prepare('SELECT s.*,u.id student_id,u.username,u.name,u.status user_status FROM course_students cs JOIN users u ON u.id=cs.student_id LEFT JOIN submissions s ON s.student_id=u.id AND s.assignment_id=? WHERE cs.course_id=? ORDER BY COALESCE(cs.sort_order,cs.id),cs.id').all(a.id,a.course_id);
 return rows.map(row=>{
 const history=group?'group_submission_history':'submission_history',foreign=group?'group_submission_id':'submission_id';
 const files=row.id?db.prepare(`SELECT id history_id,file_name,file_size,file_type,content,submitted_at,is_late FROM ${history} WHERE ${foreign}=? AND file_state IN ('available','online') ORDER BY id`).all(row.id):[];
 const members=group?db.prepare('SELECT student_id,username_snapshot username,name_snapshot name FROM assignment_group_members WHERE assignment_group_id=? ORDER BY student_id').all(row.assignment_group_id):undefined;
 const {file_url,...safe}=row;const actor=group&&row.submitted_by?db.prepare('SELECT name,username FROM users WHERE id=?').get(row.submitted_by):null;return {...safe,files,members,submitted_by_name:actor?.name,submitted_by_username:actor?.username,kind:group?'group':'individual',api_base:(group?'/group-submissions/':'/submissions/')+row.id};
 });
}
