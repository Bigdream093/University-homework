import { validateEditorImages } from "../services/editorImageAccess.js";
import { contentFormat } from "../domain/contentFormat.js";
import { Router } from "express";
import { db } from "../db.js";
import { auth } from "../middleware/auth.js";
import { teacherOnly, studentOnly } from "../middleware/teacher.js";
import { courseAccess, fail, textValue, pageOf } from "../services/access.js";
import { nowText } from "../utils/time.js";
const router = Router();
function validateQuestionBody(req, _res, next) {
  if (["POST", "PUT"].includes(req.method)) {
    const previous =
      req.method === "PUT" && /^\/questions\/\d+$/.test(req.path)
        ? db
            .prepare("SELECT content_format FROM course_questions WHERE id=?")
            .get(req.path.split("/").pop())
        : null;
    const format = contentFormat(
      req.body?.content_format ?? previous?.content_format,
    );
    for (const field of ["content", "summary", "reply"])
      if (typeof req.body?.[field] === "string")
        validateEditorImages(req.body[field], format, req.user);
  }
  next();
}
function visibleQuestion(id, user, write = false) {
  const question = db
    .prepare("SELECT * FROM course_questions WHERE id=?")
    .get(id);
  if (!question) fail(404, "问题不存在");
  courseAccess(question.course_id, user, { write });
  if (user.role !== "teacher" && question.student_id !== user.id)
    fail(404, "问题不存在");
  return question;
}
function recordEvent(question, user, type) {
  db.prepare(
    "INSERT INTO question_visibility_events(question_id,actor_id,event,created_at) VALUES(?,?,?,?)",
  ).run(question.id, user.id, type, nowText());
}
function withdrawPublications(question, user) {
  db.prepare(
    "UPDATE question_publications SET status='withdrawn',withdrawn_at=? WHERE question_id=? AND status='published'",
  ).run(nowText(), question.id);
  recordEvent(question, user, "withdraw");
}
function assertEditable(question) {
  if (
    db
      .prepare("SELECT 1 FROM question_replies WHERE question_id=?")
      .get(question.id) ||
    db
      .prepare("SELECT 1 FROM question_publications WHERE question_id=?")
      .get(question.id)
  )
    fail(409, "已有回复或公开历史，不能改写原问题");
}
router.get("/courses/:id/questions", auth, validateQuestionBody, (req, res) => {
  courseAccess(req.params.id, req.user);
  const { limit, offset } = pageOf(req.query),
    keyword = "%" + String(req.query.keyword || "") + "%";
  const student = req.user.role === "student",
    where =
      "q.course_id=?" +
      (student ? " AND q.student_id=?" : "") +
      " AND (q.title LIKE ? OR q.content LIKE ?)" +
      (req.query.status ? " AND q.status=?" : "");
  const args = [
    req.params.id,
    ...(student ? [req.user.id] : []),
    keyword,
    keyword,
    ...(req.query.status ? [req.query.status] : []),
  ];
  res.json(
    db
      .prepare(
        `SELECT q.*,u.name student_name FROM course_questions q JOIN users u ON u.id=q.student_id WHERE ${where} ORDER BY q.pinned DESC,q.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset),
  );
});
router.get(
  "/courses/:id/questions/public",
  auth,
  validateQuestionBody,
  (req, res) => {
    courseAccess(req.params.id, req.user);
    const { limit, offset } = pageOf(req.query),
      keyword = "%" + String(req.query.keyword || "") + "%";
    // Public reads never select the student identity, original question text or private replies.
    // Teachers additionally see withdrawn summaries for audit; question_id is identity-free.
    const teacher = req.user.role === "teacher",
      statusSql = teacher
        ? "p.status IN ('published','withdrawn')"
        : "p.status='published'";
    res.json(
      db
        .prepare(
          `SELECT p.id,p.question_id,p.summary,p.reply,p.content_format,p.status,p.created_at,p.withdrawn_at,q.sort_order,q.pinned FROM question_publications p JOIN course_questions q ON q.id=p.question_id WHERE q.course_id=? AND q.hidden=0 AND ${statusSql} AND (p.summary LIKE ? OR p.reply LIKE ?) ORDER BY q.pinned DESC,q.sort_order,q.id,p.id DESC LIMIT ? OFFSET ?`,
        )
        .all(req.params.id, keyword, keyword, limit, offset),
    );
  },
);
router.post(
  "/courses/:id/questions",
  auth,
  validateQuestionBody,
  studentOnly,
  (req, res) => {
    const course = courseAccess(req.params.id, req.user, { write: true }),
      at = nowText();
    const order = db
      .prepare(
        "SELECT COALESCE(MIN(sort_order),0)-1 value FROM course_questions WHERE course_id=?",
      )
      .get(course.id).value;
    const id = db
      .prepare(
        "INSERT INTO course_questions(course_id,student_id,title,content,must_private,sort_order,created_at,updated_at,content_format) VALUES(?,?,?,?,0,?,?,?,?)",
      )
      .run(
        course.id,
        req.user.id,
        textValue(req.body.title, "标题", 200),
        textValue(req.body.content, "问题内容"),
        order,
        at,
        at,
        contentFormat(req.body.content_format),
      ).lastInsertRowid;
    res.status(201).json({ id });
  },
);
router.get("/questions/:id", auth, validateQuestionBody, (req, res) => {
  const question = visibleQuestion(req.params.id, req.user);
  res.json({
    ...question,
    replies: db
      .prepare(
        "SELECT r.*,u.name author_name,u.role FROM question_replies r JOIN users u ON u.id=r.author_id WHERE question_id=? ORDER BY r.id",
      )
      .all(question.id),
    publications: db
      .prepare(
        "SELECT * FROM question_publications WHERE question_id=? ORDER BY id DESC",
      )
      .all(question.id),
    visibility_events: db
      .prepare(
        "SELECT event,created_at FROM question_visibility_events WHERE question_id=? ORDER BY id",
      )
      .all(question.id),
  });
});
router.put(
  "/questions/:id",
  auth,
  validateQuestionBody,
  studentOnly,
  (req, res) => {
    const question = visibleQuestion(req.params.id, req.user, true);
    assertEditable(question);
    db.prepare(
      "UPDATE course_questions SET title=?,content=?,updated_at=?,content_format=? WHERE id=?",
    ).run(
      textValue(req.body.title, "标题", 200),
      textValue(req.body.content, "内容"),
      nowText(),
      contentFormat(req.body.content_format ?? question.content_format),
      question.id,
    );
    res.json({ message: "问题已修改" });
  },
);
router.delete(
  "/questions/:id",
  auth,
  validateQuestionBody,
  studentOnly,
  (req, res) => {
    const question = visibleQuestion(req.params.id, req.user, true);
    assertEditable(question);
    db.prepare("DELETE FROM course_questions WHERE id=?").run(question.id);
    res.json({ message: "问题已删除" });
  },
);
router.post(
  "/questions/:id/replies",
  auth,
  validateQuestionBody,
  (req, res) => {
    const question = visibleQuestion(req.params.id, req.user, true),
      at = nowText();
    db.transaction(() => {
      db.prepare(
        "INSERT INTO question_replies(question_id,author_id,content,created_at,content_format) VALUES(?,?,?,?,?)",
      ).run(
        question.id,
        req.user.id,
        textValue(req.body.content, "回复内容"),
        at,
        contentFormat(req.body.content_format),
      );
      db.prepare(
        "UPDATE course_questions SET status=?,updated_at=? WHERE id=?",
      ).run(req.user.role === "teacher" ? "answered" : "open", at, question.id);
    })();
    res.status(201).json({ message: "私人回复已保存" });
  },
);
router.post(
  "/questions/:id/publish",
  auth,
  validateQuestionBody,
  teacherOnly,
  (req, res) => {
    db.transaction(() => {
      const question = visibleQuestion(req.params.id, req.user, true);
      if (question.hidden) fail(400, "问题已隐藏，不能公开");
      const summary = textValue(req.body.summary, "公开摘要"),
        reply = textValue(req.body.reply, "公开答复");
      withdrawPublications(question, req.user);
      db.prepare(
        "INSERT INTO question_publications(question_id,teacher_id,summary,reply,created_at,content_format) VALUES(?,?,?,?,?,?)",
      ).run(
        question.id,
        req.user.id,
        summary,
        reply,
        nowText(),
        contentFormat(req.body.content_format),
      );
      recordEvent(question, req.user, "publish");
    })();
    res
      .status(201)
      .json({ message: "已公开摘要和答复，私人原帖及后续追问不会公开" });
  },
);
router.post(
  "/questions/:id/withdraw",
  auth,
  validateQuestionBody,
  teacherOnly,
  (req, res) => {
    db.transaction(() => {
      const question = visibleQuestion(req.params.id, req.user);
      if (
        !db
          .prepare(
            "SELECT 1 FROM question_publications WHERE question_id=? AND status='published'",
          )
          .get(question.id)
      )
        fail(409, "没有已公开的摘要");
      withdrawPublications(question, req.user);
    })();
    res.json({ message: "公开摘要已撤回" });
  },
);
router.delete(
  "/questions/:id/publications/:pubId",
  auth,
  validateQuestionBody,
  teacherOnly,
  (req, res) => {
    db.transaction(() => {
      const question = visibleQuestion(req.params.id, req.user, true);
      const publication = db
        .prepare(
          "SELECT id FROM question_publications WHERE id=? AND question_id=?",
        )
        .get(req.params.pubId, question.id);
      if (!publication) fail(404, "公开摘要不存在");
      db.prepare("DELETE FROM question_publications WHERE id=?").run(
        publication.id,
      );
      recordEvent(question, req.user, "delete_publication");
    })();
    res.json({ message: "公开摘要已删除，学生端立即消失" });
  },
);
router.post(
  "/questions/:id/publications/:pubId/move",
  auth,
  validateQuestionBody,
  teacherOnly,
  (req, res) => {
    const question = visibleQuestion(req.params.id, req.user, true),
      direction = req.body.direction;
    if (!["up", "down"].includes(direction)) fail(400, "移动方向无效");
    const current = db
      .prepare(
        "SELECT p.id,q.sort_order,q.pinned FROM question_publications p JOIN course_questions q ON q.id=p.question_id WHERE p.id=? AND p.question_id=?",
      )
      .get(req.params.pubId, question.id);
    if (!current) fail(404, "公开摘要不存在");
    const operator = direction === "up" ? "<" : ">",
      order = direction === "up" ? "DESC" : "ASC";
    const sibling = db
      .prepare(
        `SELECT other.id,other.sort_order FROM course_questions other WHERE other.course_id=? AND other.hidden=0 AND other.pinned=? AND other.sort_order ${operator} ? AND EXISTS(SELECT 1 FROM question_publications p WHERE p.question_id=other.id AND p.status='published') ORDER BY other.sort_order ${order},other.id ${order} LIMIT 1`,
      )
      .get(question.course_id, current.pinned, current.sort_order);
    if (sibling)
      db.transaction(() => {
        db.prepare("UPDATE course_questions SET sort_order=? WHERE id=?").run(
          sibling.sort_order,
          question.id,
        );
        db.prepare("UPDATE course_questions SET sort_order=? WHERE id=?").run(
          current.sort_order,
          sibling.id,
        );
      })();
    res.json({ moved: !!sibling });
  },
);
router.put(
  "/questions/:id/manage",
  auth,
  validateQuestionBody,
  teacherOnly,
  (req, res) => {
    db.transaction(() => {
      const question = visibleQuestion(req.params.id, req.user);
      if (
        req.body.hidden !== true ||
        req.body.status !== undefined ||
        req.body.pinned !== undefined
      )
        courseAccess(question.course_id, req.user, { write: true });
      const status = req.body.status ?? question.status;
      if (!["open", "answered", "resolved"].includes(status))
        fail(400, "无效状态");
      const hidden =
        req.body.hidden === undefined
          ? question.hidden
          : Number(!!req.body.hidden);
      if (hidden) withdrawPublications(question, req.user);
      db.prepare(
        "UPDATE course_questions SET status=?,pinned=?,hidden=?,updated_at=? WHERE id=?",
      ).run(
        status,
        req.body.pinned === undefined
          ? question.pinned
          : Number(!!req.body.pinned),
        hidden,
        nowText(),
        question.id,
      );
    })();
    res.json({ message: "问题状态已更新" });
  },
);
export default router;
