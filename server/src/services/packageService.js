import path from 'node:path';
import { db } from '../db.js';
import { safeName } from '../utils/fileFilter.js';
import { resolveUploadPath } from '../utils/uploadPath.js';
import { pipeZipToResponse } from '../utils/zipStream.js';

export async function downloadAssignmentPackage(assignmentId, teacherId, res) {
  const assignment = db.prepare(`SELECT a.* FROM assignments a JOIN courses c ON c.id=a.course_id WHERE a.id=? AND c.teacher_id=?`).get(assignmentId, teacherId);
  if (!assignment) {
    res.status(404).json({ message: '作业不存在' });
    return;
  }

  const students = db.prepare(`SELECT u.id student_id,u.username,u.name,s.id submission_id,s.content,s.is_late,s.submitted_at
    FROM course_students cs JOIN users u ON u.id=cs.student_id
    LEFT JOIN submissions s ON s.assignment_id=? AND s.student_id=u.id
    WHERE cs.course_id=? ORDER BY cs.sort_order,u.username`).all(assignment.id, assignment.course_id);

  const historyRows = db.prepare(`SELECT h.submission_id,h.file_url,h.file_name,h.content,h.submitted_at,h.is_late
    FROM submission_history h JOIN submissions s ON s.id=h.submission_id
    WHERE s.assignment_id=? AND (h.file_url IS NOT NULL OR (h.content IS NOT NULL AND h.content <> ''))
    ORDER BY h.submitted_at,h.id`).all(assignment.id);

  const studentMap = new Map(students.map(s => [s.submission_id, s]));
  const usedNames = new Set();
  const entries = [];

  const uniqueName = (name, fallback) => {
    let base = String(name || '').trim() || fallback;
    let candidate = base;
    let index = 2;
    while (usedNames.has(candidate.toLowerCase())) {
      const ext = path.extname(base);
      candidate = `${base.slice(0, base.length - ext.length)} (${index})${ext}`;
      index += 1;
    }
    usedNames.add(candidate.toLowerCase());
    return candidate;
  };

  const timestampText = (submittedAt) => {
    const [datePart = '', timePart = ''] = String(submittedAt || '').split(' ');
    const [, month = '', day = ''] = datePart.split('-');
    const [hour = '', minute = ''] = timePart.split(':');
    return `${month}-${day}-${hour}:${minute}`;
  };

  for (const history of historyRows) {
    const student = studentMap.get(history.submission_id);
    if (!student) continue;
    if (history.file_url) {
      const resolved = resolveUploadPath(history.file_url, { mustExist: true });
      if (!resolved) continue;
      entries.push({ name: uniqueName(history.file_name, `作业_${entries.length + 1}.bin`), path: resolved });
    } else if (history.content) {
      const name = `${safeName(String(student.name).trim())}_${safeName(String(student.username).trim())}_${timestampText(history.submitted_at)}_${history.is_late ? '迟交' : '准时'}.txt`;
      entries.push({ name: uniqueName(name, '在线作答.txt'), content: history.content });
    }
  }

  if (entries.length === 0) {
    res.status(400).json({ message: '还没有学生提交作业' });
    return;
  }

  const zipName = `${assignment.title}-全部作业.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`);
  await pipeZipToResponse(entries, res);
}
