import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { nowText,isLate } from '../utils/time.js';
import { safeName } from '../utils/fileFilter.js';
import { assignmentAccess,subjectFor,fail } from './access.js';
import { effectiveDeadline } from './extensions.js';
import { queueCleanup,flushCleanup } from './storage.js';

export function saveSubmission({assignment,studentId,file,content,baseVersion}) {
  const result=db.transaction(()=>{
    const student=db.prepare("SELECT id,username,name,role FROM users WHERE id=? AND role='student'").get(studentId);
    if(!student)fail(404,'学生账号不存在');
    const a=assignmentAccess(assignment.id,student,{write:true});
    if(a.status!=='published')fail(400,'作业当前不可提交');
    const subject=subjectFor(a,student,{submit:true}),group=!!subject.group;
    const table=group?'group_submissions':'submissions',historyTable=group?'group_submission_history':'submission_history';
    const foreign=group?'group_submission_id':'submission_id';
    const current=group?db.prepare('SELECT * FROM group_submissions WHERE assignment_group_id=?').get(subject.group.id):db.prepare('SELECT * FROM submissions WHERE assignment_id=? AND student_id=?').get(a.id,studentId);
    if(group && Number(baseVersion??0)!==(current?.submit_count||0))fail(409,'本组已有更新，请刷新后确认再提交');
    if(current&&a.allow_resubmit_count!==-1&&current.submit_count>=a.allow_resubmit_count+1)fail(400,'已达到允许提交次数');
    const answer=String(content??'').trim();if(!file&&!answer)fail(400,'请上传文件或填写在线作答内容');
    // 文件类作业必须携带文件：否则一段文字就会在覆盖模式下顶掉并删除已提交的文件。
    if(a.type!=='online'&&!file)fail(400,'本作业需要上传文件提交');
    if(file&&file.size>(a.max_file_mb??200)*1024*1024)fail(400,'文件超过本作业大小限制');
    const at=nowText(),deadline=effectiveDeadline(a,subject),late=isLate(deadline.deadline,at);
    const [date,time]=at.split(' '),stamp=date.slice(5)+'-'+time.slice(0,5);
    const owner=group?subject.group.name:student.name;
    const name=file?`${safeName(owner)}_${safeName(student.username)}_${stamp}_${late?'迟交':'准时'}${path.extname(file.originalname).toLowerCase()}`:null;
    const values=[answer||null,file?.path||null,name,file?.size??null,file?path.extname(file.originalname).slice(1).toLowerCase():null];
    let id=current?.id;
    if(current){
      if(a.submission_mode!=='append'){
        const old=db.prepare(`SELECT file_url FROM ${historyTable} WHERE ${foreign}=? AND file_state='available'`).all(id);
        queueCleanup([...old.map(r=>r.file_url),current.file_url],'覆盖提交的旧文件');
        db.prepare(`UPDATE ${historyTable} SET file_state='replaced',replaced_at=? WHERE ${foreign}=? AND file_state='available'`).run(at,id);
      }
      db.prepare(`UPDATE ${table} SET content=?,file_url=?,file_name=?,file_size=?,file_type=?,submit_count=submit_count+1,status='submitted',score=NULL,comment=NULL,returned_reason=NULL,is_late=?,submitted_at=?,graded_at=NULL${group?',submitted_by=?':''} WHERE id=?`).run(...values,late,at,...(group?[studentId]:[]),id);
    }else{
      const sql=group?"INSERT INTO group_submissions(assignment_group_id,content,file_url,file_name,file_size,file_type,submit_count,status,is_late,submitted_at,submitted_by) VALUES(?,?,?,?,?,?,1,'submitted',?,?,?)":"INSERT INTO submissions(assignment_id,student_id,content,file_url,file_name,file_size,file_type,submit_count,status,is_late,submitted_at) VALUES(?,?,?,?,?,?,?,1,'submitted',?,?)";
      id=db.prepare(sql).run(...(group?[subject.group.id]:[a.id,studentId]),...values,late,at,...(group?[studentId]:[])).lastInsertRowid;
    }
    const history=db.prepare(`INSERT INTO ${historyTable}(${foreign},content,file_url,file_name,file_size,file_type,file_state,is_late,submitted_at${group?',submitted_by':''}) VALUES(?,?,?,?,?,?,?,?,?${group?',?':''})`).run(id,...values,file?'available':'online',late,at,...(group?[studentId]:[]));
    const members=group?db.prepare('SELECT student_id,username_snapshot username,name_snapshot name FROM assignment_group_members WHERE assignment_group_id=? ORDER BY student_id').all(subject.group.id):null;
    const snapshot={course_id:a.course_id,course_name:a.course_name,assignment_title:a.title,work_mode:a.work_mode,student:{username:student.username,name:student.name},group:group?{id:subject.group.id,name:subject.group.name,members}:null,file_name:name,file_size:file?.size??null,file_type:values[4],file_state:file?'available':'online',submitted_at:at,is_late:!!late,effective_deadline:deadline.deadline,extension:deadline.extension?{id:deadline.extension.id,approved_deadline:deadline.extension.approved_deadline}:null,submit_count:(current?.submit_count||0)+1};
    const receiptNo='MH-'+randomUUID();
    db.prepare(`INSERT INTO submission_receipts(receipt_no,${group?'group_submission_history_id':'submission_history_id'},assignment_id,${group?'assignment_group_id':'student_id'},snapshot_json,created_at) VALUES(?,?,?,?,?,?)`).run(receiptNo,history.lastInsertRowid,a.id,group?subject.group.id:studentId,JSON.stringify(snapshot),at);
    return {...db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id),receipt_no:receiptNo,kind:group?'group':'individual'};
  })();
  flushCleanup();return result;
}
