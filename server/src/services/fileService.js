import { db } from '../db.js';
import { resolveUploadPath } from '../utils/uploadPath.js';

function getHistoryEntry(submissionId, historyId) {
  return db.prepare('SELECT file_url,file_name,content FROM submission_history WHERE id=? AND submission_id=?').get(Number(historyId), Number(submissionId)) || null;
}

export function serveSubmissionFile(submissionId, user, historyIdParam, res) {
  const sub = db.prepare(`SELECT s.*,c.teacher_id FROM submissions s JOIN assignments a ON a.id=s.assignment_id JOIN courses c ON c.id=a.course_id WHERE s.id=?`).get(submissionId);
  if (!sub) {
    res.status(404).json({ message: '提交记录不存在' });
    return;
  }
  if (!(sub.student_id === user.id || (user.role === 'teacher' && sub.teacher_id === user.id))) {
    res.status(403).json({ message: '无权下载该文件' });
    return;
  }
  const historyId = Number(historyIdParam);
  let fileUrl = sub.file_url;
  let fileName = sub.file_name;
  let content = sub.content;
  if (Number.isInteger(historyId) && historyId > 0) {
    const history = getHistoryEntry(sub.id, historyId);
    if (!history) {
      res.status(404).json({ message: '文件不存在' });
      return;
    }
    fileUrl = history.file_url;
    fileName = history.file_name;
    content = history.content;
  }
  if (fileUrl) {
    const resolved = resolveUploadPath(fileUrl, { mustExist: true });
    if (!resolved) {
      res.status(404).json({ message: '文件不存在' });
      return;
    }
    res.download(resolved, fileName);
    return;
  }
  if (content) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName || '在线作答.txt')}`);
    res.send(content);
    return;
  }
  res.status(404).json({ message: '文件不存在' });
}
