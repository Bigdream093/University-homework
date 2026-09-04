import { db } from '../db.js'
import { courseAccess, assignmentAccess, fail, textValue, requireRole } from './access.js'
import { nowText } from '../utils/time.js'

function resolveMembers(ids, courseId, except = 0) {
  if (!Array.isArray(ids) || !ids.length) fail(400, '请选择组成员')
  const result = [...new Set(ids.map(Number))]
  for (const id of result) {
    if (
      !db
        .prepare(
          "SELECT 1 FROM course_students cs JOIN users u ON u.id=cs.student_id WHERE cs.course_id=? AND cs.student_id=? AND u.role='student' AND u.status='active'",
        )
        .get(courseId, id)
    )
      fail(400, '成员必须是课程中的有效学生')
    if (
      db
        .prepare(
          'SELECT 1 FROM course_group_members WHERE course_id=? AND student_id=? AND course_group_id<>?',
        )
        .get(courseId, id, except)
    )
      fail(409, '学生已在其他小组')
  }
  return result
}
function saveGroup(courseId, user, body, id) {
  const existing = id ? db.prepare('SELECT * FROM course_groups WHERE id=?').get(id) : null
  if (id && !existing) fail(404, '小组不存在')
  const course = courseAccess(existing?.course_id || courseId, user, {
      write: true,
      teacher: true,
    }),
    memberIds = resolveMembers(body.member_ids, course.id, id || 0),
    leader = Number(body.leader_id)
  if (!memberIds.includes(leader)) fail(400, '组长必须是本组成员')
  const name = textValue(body.name, '组名', 100)
  if (
    db
      .prepare('SELECT 1 FROM course_groups WHERE course_id=? AND name=? AND id<>?')
      .get(course.id, name, id || 0)
  )
    fail(409, '组名重复')
  if (id) {
    db.prepare('UPDATE course_groups SET name=?,leader_id=? WHERE id=?').run(name, leader, id)
    db.prepare('DELETE FROM course_group_members WHERE course_group_id=?').run(id)
  } else
    id = db
      .prepare('INSERT INTO course_groups(course_id,name,leader_id,created_at) VALUES(?,?,?,?)')
      .run(course.id, name, leader, nowText()).lastInsertRowid
  for (const student of memberIds)
    db.prepare(
      'INSERT INTO course_group_members(course_group_id,course_id,student_id) VALUES(?,?,?)',
    ).run(id, course.id, student)
  return { id }
}

export function createGroup(courseId, user, body) {
  requireRole(user, 'teacher')
  return db.transaction(() => saveGroup(courseId, user, body))()
}

export function updateGroup(groupId, user, body) {
  requireRole(user, 'teacher')
  return db.transaction(() => saveGroup(groupId, user, body, Number(groupId)))()
}

export function listCourseGroups(courseId, user) {
  const course = courseAccess(courseId, user)
  const groups = db
    .prepare('SELECT * FROM course_groups WHERE course_id=? ORDER BY id')
    .all(course.id)
    .map((group) => ({
      ...group,
      members: db
        .prepare(
          'SELECT u.id,u.username,u.name FROM course_group_members m JOIN users u ON u.id=m.student_id WHERE m.course_group_id=? ORDER BY u.id',
        )
        .all(group.id),
    }))
  return user.role === 'teacher'
    ? groups
    : groups.filter((group) => group.members.some((member) => member.id === user.id))
}

export function removeGroup(groupId, user) {
  requireRole(user, 'teacher')
  return db.transaction(() => {
    const group = db.prepare('SELECT * FROM course_groups WHERE id=?').get(groupId)
    if (!group) fail(404, '小组不存在')
    courseAccess(group.course_id, user, { write: true })
    db.prepare('DELETE FROM course_groups WHERE id=?').run(group.id)
    return { message: '模板小组已删除，已发布作业快照不受影响' }
  })()
}

export function listAssignmentGroups(assignmentId, user) {
  const assignment = assignmentAccess(assignmentId, user)
  const rows = db
    .prepare('SELECT * FROM assignment_groups WHERE assignment_id=? ORDER BY id')
    .all(assignment.id)
    .map((group) => ({
      ...group,
      members: db
        .prepare(
          'SELECT student_id id,name_snapshot name,username_snapshot username FROM assignment_group_members WHERE assignment_group_id=?',
        )
        .all(group.id),
    }))
  return user.role === 'teacher'
    ? rows
    : rows.filter((group) => group.members.some((member) => member.id === user.id))
}

export function setGroupSubmitter(groupId, user, submitter) {
  requireRole(user, 'teacher')
  return db.transaction(() => {
    const group = db.prepare('SELECT * FROM assignment_groups WHERE id=?').get(groupId)
    if (!group) fail(404, '分组不存在')
    const assignment = assignmentAccess(group.assignment_id, user, { write: true }),
      submitterId = Number(submitter)
    if (
      !db
        .prepare(
          'SELECT 1 FROM assignment_group_members m JOIN course_students cs ON cs.student_id=m.student_id AND cs.course_id=? WHERE m.assignment_group_id=? AND m.student_id=?',
        )
        .get(assignment.course_id, group.id, submitterId)
    )
      fail(400, '提交人必须是当前在课的快照成员')
    db.prepare('UPDATE assignment_groups SET submitter_id=? WHERE id=?').run(submitterId, group.id)
    return { message: '提交人已更新' }
  })()
}

export function snapshotGroups(assignmentId, user, selectedGroupIds) {
  requireRole(user, 'teacher')
  return db.transaction(() => {
    const assignment = assignmentAccess(assignmentId, user, { write: true })
    if (
      assignment.status !== 'draft' ||
      assignment.groups_locked ||
      assignment.work_mode !== 'group'
    )
      fail(400, '仅未发布的分组作业草稿可以配置快照')
    const groupIds = [...new Set((selectedGroupIds || []).map(Number))]
    if (!groupIds.length) fail(400, '请选择小组')
    db.prepare('DELETE FROM assignment_groups WHERE assignment_id=?').run(assignment.id)
    for (const groupId of groupIds) {
      const template = db
        .prepare('SELECT * FROM course_groups WHERE id=? AND course_id=?')
        .get(groupId, assignment.course_id)
      if (!template) fail(400, '小组不属于本课程')
      const roster = db
        .prepare(
          'SELECT u.id,u.username,u.name FROM course_group_members m JOIN users u ON u.id=m.student_id JOIN course_students cs ON cs.student_id=u.id AND cs.course_id=? WHERE m.course_group_id=?',
        )
        .all(assignment.course_id, template.id)
      if (!roster.length || !roster.some((member) => member.id === template.leader_id))
        fail(400, '小组不能为空，且组长必须在当前课程中')
      const snapshotId = db
        .prepare(
          'INSERT INTO assignment_groups(assignment_id,name,submitter_id,created_at) VALUES(?,?,?,?)',
        )
        .run(assignment.id, template.name, template.leader_id, nowText()).lastInsertRowid
      for (const member of roster)
        db.prepare(
          'INSERT INTO assignment_group_members(assignment_group_id,assignment_id,student_id,username_snapshot,name_snapshot) VALUES(?,?,?,?,?)',
        ).run(snapshotId, assignment.id, member.id, member.username, member.name)
    }
    return { message: '已保存作业成员快照' }
  })()
}
