import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import jwt from 'jsonwebtoken'
import request from 'supertest'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mohen-boundaries-'))
process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'business-boundaries-test-secret'
process.env.DATA_DIR = dir
process.env.UPLOAD_DIR = path.join(dir, 'uploads')
const { app } = await import('../src/index.js')
const { db } = await import('../src/db.js')
after(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

let sequence = 0
function user(role) {
  const username = `boundary-${++sequence}`
  const { lastInsertRowid: id } = db
    .prepare('INSERT INTO users(username,name,password_hash,role) VALUES(?,?,?,?)')
    .run(username, username, 'unused-test-hash', role)
  return { id, role }
}
async function call(actor, method, url, body, status = 200) {
  const response = await request(app)
    [method]('/api' + url)
    .set('Authorization', `Bearer ${jwt.sign({ id: actor.id }, process.env.JWT_SECRET)}`)
    .send(body)
  assert.equal(response.status, status, `${method} ${url}: ${response.text}`)
  return response.body
}
async function fixture() {
  const teacher = user('teacher'),
    student = user('student'),
    outsider = user('teacher')
  const course = await call(teacher, 'post', '/courses', { name: '边界测试' }, 201)
  db.prepare('INSERT INTO course_students(course_id,student_id) VALUES(?,?)').run(
    course.id,
    student.id,
  )
  return { teacher, student, outsider, course }
}
async function assignment(f, body = {}) {
  return call(
    f.teacher,
    'post',
    `/courses/${f.course.id}/assignments`,
    {
      title: '边界作业',
      type: 'online',
      status: 'published',
      deadline: '2099-01-01 00:00:00',
      ...body,
    },
    201,
  )
}
async function group(f) {
  return call(
    f.teacher,
    'post',
    `/courses/${f.course.id}/groups`,
    {
      name: '测试小组',
      member_ids: [f.student.id],
      leader_id: f.student.id,
    },
    201,
  )
}
async function extension(f, a) {
  return call(
    f.student,
    'post',
    `/assignments/${a.id}/extensions`,
    {
      reason: '需要更多时间',
      requested_deadline: '2099-02-01 00:00:00',
    },
    201,
  )
}
function row(table, id) {
  return db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id)
}

test('published and closed assignments freeze work mode even without submissions', async () => {
  const f = await fixture(),
    a = await assignment(f)
  for (const status of ['published', 'closed']) {
    if (status === 'closed') await call(f.teacher, 'post', `/assignments/${a.id}/close`)
    const before = row('assignments', a.id)
    await call(f.teacher, 'put', `/assignments/${a.id}`, { work_mode: 'group' }, 400)
    assert.deepEqual(row('assignments', a.id), before)
  }
  const draft = await assignment(f, { status: 'draft' })
  await call(f.teacher, 'put', `/assignments/${draft.id}`, { work_mode: 'group' })
  assert.equal(row('assignments', draft.id).work_mode, 'group')
})

test('invalid group publication leaves draft and lock unchanged, including failed create', async () => {
  const f = await fixture(),
    g = await group(f)
  const beforeCount = db.prepare('SELECT count(*) n FROM assignments').get().n
  await call(
    f.teacher,
    'post',
    `/courses/${f.course.id}/assignments`,
    {
      title: '直接发布失败',
      work_mode: 'group',
      status: 'published',
    },
    400,
  )
  assert.equal(db.prepare('SELECT count(*) n FROM assignments').get().n, beforeCount)
  for (const invalid of ['missing', 'empty', 'submitter', 'unenrolled']) {
    const a = await assignment(f, { work_mode: 'group', status: 'draft' })
    if (invalid !== 'missing') {
      await call(f.teacher, 'post', `/assignments/${a.id}/groups/snapshot`, { group_ids: [g.id] })
      const snapshot = db
        .prepare('SELECT id FROM assignment_groups WHERE assignment_id=?')
        .get(a.id)
      if (invalid === 'empty')
        db.prepare('DELETE FROM assignment_group_members WHERE assignment_group_id=?').run(
          snapshot.id,
        )
      if (invalid === 'submitter')
        db.prepare('UPDATE assignment_groups SET submitter_id=? WHERE id=?').run(
          f.teacher.id,
          snapshot.id,
        )
      if (invalid === 'unenrolled')
        db.prepare('DELETE FROM course_students WHERE course_id=? AND student_id=?').run(
          f.course.id,
          f.student.id,
        )
    }
    const before = row('assignments', a.id)
    await call(f.teacher, 'post', `/assignments/${a.id}/publish`, {}, 400)
    assert.deepEqual(row('assignments', a.id), before, invalid)
  }
})

for (const failingTable of ['extension_requests', 'notices']) {
  test(`archive rolls all three tables back when ${failingTable} update fails`, async () => {
    const f = await fixture(),
      a = await assignment(f),
      e = await extension(f, a)
    const n = await call(
      f.teacher,
      'post',
      `/courses/${f.course.id}/notices`,
      {
        title: '定时通知',
        status: 'scheduled',
        scheduled_at: '2099-01-01 00:00:00',
      },
      201,
    )
    const before = [
      row('courses', f.course.id),
      row('extension_requests', e.id),
      row('notices', n.id),
    ]
    db.exec(`CREATE TEMP TRIGGER fail_archive BEFORE UPDATE ON ${failingTable}
      BEGIN SELECT RAISE(ABORT, 'injected archive failure'); END`)
    try {
      await call(f.teacher, 'post', `/courses/${f.course.id}/archive`, {}, 500)
      assert.deepEqual(
        [row('courses', f.course.id), row('extension_requests', e.id), row('notices', n.id)],
        before,
      )
      const { archiveCourse } = await import('../src/services/courseService.js')
      assert.throws(() => archiveCourse(f.course.id, f.teacher), /injected archive failure/)
      assert.deepEqual(
        [row('courses', f.course.id), row('extension_requests', e.id), row('notices', n.id)],
        before,
      )
    } finally {
      db.exec('DROP TRIGGER fail_archive')
    }
    await call(f.teacher, 'post', `/courses/${f.course.id}/archive`)
    assert.equal(row('courses', f.course.id).status, 'archived')
    assert.equal(row('extension_requests', e.id).status, 'cancelled')
    assert.equal(row('notices', n.id).status, 'draft')
    assert.equal(row('notices', n.id).scheduled_at, null)
  })
}

test('snapshot replacement rolls back deleted and newly inserted groups on foreign group', async () => {
  const f = await fixture(),
    other = await fixture()
  const g = await group(f),
    foreign = await group(other)
  const a = await assignment(f, { work_mode: 'group', status: 'draft' })
  await call(f.teacher, 'post', `/assignments/${a.id}/groups/snapshot`, { group_ids: [g.id] })
  const readSnapshot = () => ({
    groups: db
      .prepare('SELECT * FROM assignment_groups WHERE assignment_id=? ORDER BY id')
      .all(a.id),
    members: db
      .prepare('SELECT * FROM assignment_group_members WHERE assignment_id=? ORDER BY student_id')
      .all(a.id),
  })
  const before = readSnapshot()
  await call(
    f.teacher,
    'post',
    `/assignments/${a.id}/groups/snapshot`,
    { group_ids: [g.id, foreign.id] },
    400,
  )
  assert.deepEqual(readSnapshot(), before)
  const { snapshotGroups } = await import('../src/services/groupService.js')
  assert.throws(() => snapshotGroups(a.id, f.teacher, [g.id, foreign.id]), { status: 400 })
  assert.deepEqual(readSnapshot(), before)
})

test('closed assignment rejects approval but allows rejection; duplicate decisions preserve result', async () => {
  const f = await fixture(),
    a = await assignment(f),
    e = await extension(f, a)
  await call(f.teacher, 'post', `/assignments/${a.id}/close`)
  const before = row('extension_requests', e.id)
  await call(f.teacher, 'post', `/extensions/${e.id}/decision`, { status: 'approved' }, 409)
  assert.deepEqual(row('extension_requests', e.id), before)
  await call(f.teacher, 'post', `/extensions/${e.id}/decision`, {
    status: 'rejected',
    decision_reason: '作业已关闭',
  })
  const rejected = row('extension_requests', e.id)
  assert.equal(rejected.status, 'rejected')
  await call(f.teacher, 'post', `/extensions/${e.id}/decision`, { status: 'approved' }, 409)
  assert.deepEqual(row('extension_requests', e.id), rejected)
})

test('outsider teacher and enrolled student cannot mutate teacher-owned operations', async () => {
  const f = await fixture(),
    a = await assignment(f),
    e = await extension(f, a)
  for (const actor of [f.outsider, f.student]) {
    await call(actor, 'put', `/assignments/${a.id}`, { title: '越权' }, 403)
    await call(actor, 'post', `/assignments/${a.id}/publish`, {}, 403)
    await call(actor, 'post', `/courses/${f.course.id}/archive`, {}, 403)
    await call(actor, 'post', `/extensions/${e.id}/decision`, { status: 'approved' }, 403)
    await call(
      actor,
      'post',
      `/courses/${f.course.id}/groups`,
      {
        name: '越权',
        member_ids: [f.student.id],
        leader_id: f.student.id,
      },
      403,
    )
  }
  assert.equal(row('courses', f.course.id).status, 'active')
  assert.equal(row('assignments', a.id).title, '边界作业')
  assert.equal(row('extension_requests', e.id).status, 'pending')
})

test('extension services enforce ownership, state and deadlines without HTTP middleware', async () => {
  const { applyExtension, decideExtension, withdrawExtension } = await import(
    '../src/services/extensions.js'
  )
  const f = await fixture(),
    a = await assignment(f)
  const body = { reason: '直接申请', requested_deadline: '2099-02-01 00:00:00' }
  assert.throws(() => applyExtension(a.id, f.teacher, body), { status: 403 })
  const e = applyExtension(a.id, f.student, body)
  assert.throws(() => applyExtension(a.id, f.student, body), { status: 409 })
  const before = row('extension_requests', e.id)
  for (const actor of [f.student, f.outsider]) {
    assert.throws(() => decideExtension(e.id, actor, { status: 'approved' }), { status: 403 })
  }
  for (const deadline of ['invalid', '2000-01-01 00:00:00', a.deadline]) {
    assert.throws(
      () =>
        decideExtension(e.id, f.teacher, {
          status: 'approved',
          approved_deadline: deadline,
        }),
      { status: 400 },
    )
    assert.deepEqual(row('extension_requests', e.id), before)
  }
  decideExtension(e.id, f.teacher, { status: 'approved' })
  const approved = row('extension_requests', e.id)
  assert.equal(approved.approved_deadline, body.requested_deadline)
  assert.equal(approved.decided_by, f.teacher.id)
  assert.throws(() => withdrawExtension(e.id, f.student), { status: 409 })
  assert.throws(() => decideExtension(e.id, f.teacher, { status: 'approved' }), { status: 409 })
  assert.deepEqual(row('extension_requests', e.id), approved)

  const next = applyExtension(a.id, f.student, {
    ...body,
    requested_deadline: '2099-03-01 00:00:00',
  })
  assert.throws(() => withdrawExtension(next.id, user('student')), { status: 404 })
  assert.throws(() => withdrawExtension(next.id, f.teacher), { status: 403 })
  withdrawExtension(next.id, f.student)
  assert.equal(row('extension_requests', next.id).status, 'withdrawn')
  assert.throws(() => withdrawExtension(next.id, f.student), { status: 409 })
})

test('teacher services reject wrong roles, foreign owners and archived course writes directly', async () => {
  const {
    createAssignment,
    updateAssignment,
    publishAssignment,
    closeAssignment,
    removeAssignment,
    moveAssignment,
  } = await import('../src/services/assignmentService.js')
  const { createGroup, updateGroup, removeGroup, snapshotGroups, setGroupSubmitter } = await import(
    '../src/services/groupService.js'
  )
  const { archiveCourse } = await import('../src/services/courseService.js')
  const { applyExtension, decideExtension, withdrawExtension } = await import(
    '../src/services/extensions.js'
  )
  const f = await fixture(),
    a = await assignment(f),
    g = await group(f),
    e = await extension(f, a)
  const grouped = await assignment(f, { work_mode: 'group', status: 'draft' })
  snapshotGroups(grouped.id, f.teacher, [g.id])
  const snapshot = db
    .prepare('SELECT id FROM assignment_groups WHERE assignment_id=?')
    .get(grouped.id)
  const groupBody = { name: '新组名', member_ids: [f.student.id], leader_id: f.student.id }
  const operations = [
    (actor) => createAssignment(f.course.id, actor, { title: '新作业' }),
    (actor) => updateAssignment(a.id, actor, { title: '新标题' }),
    (actor) => publishAssignment(a.id, actor),
    (actor) => closeAssignment(a.id, actor),
    (actor) => removeAssignment(a.id, actor),
    (actor) => moveAssignment(a.id, actor, 'up'),
    (actor) => createGroup(f.course.id, actor, groupBody),
    (actor) => updateGroup(g.id, actor, groupBody),
    (actor) => removeGroup(g.id, actor),
    (actor) => snapshotGroups(grouped.id, actor, [g.id]),
    (actor) => setGroupSubmitter(snapshot.id, actor, f.student.id),
    (actor) => decideExtension(e.id, actor, { status: 'approved' }),
  ]
  for (const actor of [f.student, f.outsider]) {
    for (const operation of operations) assert.throws(() => operation(actor), { status: 403 })
    assert.throws(() => archiveCourse(f.course.id, actor), { status: 403 })
  }
  assert.equal(row('assignments', a.id).title, '边界作业')
  assert.equal(row('course_groups', g.id).name, '测试小组')
  archiveCourse(f.course.id, f.teacher)
  for (const operation of operations) assert.throws(() => operation(f.teacher), { status: 409 })
  assert.throws(() => archiveCourse(f.course.id, f.teacher), { status: 409 })
  assert.throws(() => applyExtension(a.id, f.student, { reason: '归档后' }), { status: 409 })
  assert.throws(() => withdrawExtension(e.id, f.student), { status: 409 })
})

test('assignment service freezes modes and owns deadline cancellation rollback', async () => {
  const { createAssignment, updateAssignment, publishAssignment, closeAssignment } = await import(
    '../src/services/assignmentService.js'
  )
  const f = await fixture(),
    a = await assignment(f),
    e = await extension(f, a)
  const before = [row('assignments', a.id), row('extension_requests', e.id)]
  db.exec(`CREATE TEMP TRIGGER fail_deadline BEFORE UPDATE ON extension_requests
    BEGIN SELECT RAISE(ABORT, 'injected deadline failure'); END`)
  try {
    assert.throws(
      () => updateAssignment(a.id, f.teacher, { deadline: null }),
      /injected deadline failure/,
    )
    assert.deepEqual([row('assignments', a.id), row('extension_requests', e.id)], before)
  } finally {
    db.exec('DROP TRIGGER fail_deadline')
  }
  const changed = updateAssignment(a.id, f.teacher, { deadline: null })
  assert.equal(changed.cancelled_extension_count, 1)
  assert.equal(row('extension_requests', e.id).status, 'cancelled')
  assert.throws(() => updateAssignment(a.id, f.teacher, { work_mode: 'group' }), { status: 400 })
  closeAssignment(a.id, f.teacher)
  assert.throws(() => updateAssignment(a.id, f.teacher, { work_mode: 'group' }), { status: 400 })
  const draft = createAssignment(f.course.id, f.teacher, { title: '分组草稿', work_mode: 'group' })
  assert.throws(() => publishAssignment(draft.id, f.teacher), { status: 400 })
  assert.equal(row('assignments', draft.id).status, 'draft')
  assert.equal(row('assignments', draft.id).groups_locked, 0)
  assert.throws(() => closeAssignment(draft.id, f.teacher), { status: 400 })
})

test('group service validates members and rolls roster replacement back on insert failure', async () => {
  const { createGroup, updateGroup, snapshotGroups, setGroupSubmitter } = await import(
    '../src/services/groupService.js'
  )
  const { publishAssignment } = await import('../src/services/assignmentService.js')
  const f = await fixture(),
    g = await group(f)
  const inactive = user('student')
  db.prepare('INSERT INTO course_students(course_id,student_id) VALUES(?,?)').run(
    f.course.id,
    inactive.id,
  )
  db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(inactive.id)
  assert.throws(
    () =>
      createGroup(f.course.id, f.teacher, {
        name: '无效组员',
        member_ids: [inactive.id],
        leader_id: inactive.id,
      }),
    { status: 400 },
  )
  assert.throws(
    () =>
      createGroup(f.course.id, f.teacher, {
        name: '重复组员',
        member_ids: [f.student.id],
        leader_id: f.student.id,
      }),
    { status: 409 },
  )
  assert.throws(
    () =>
      updateGroup(g.id, f.teacher, {
        name: '错误组长',
        member_ids: [f.student.id],
        leader_id: f.teacher.id,
      }),
    { status: 400 },
  )
  const roster = () =>
    db.prepare('SELECT * FROM course_group_members WHERE course_group_id=?').all(g.id)
  const before = [row('course_groups', g.id), roster()]
  db.exec(`CREATE TEMP TRIGGER fail_roster BEFORE INSERT ON course_group_members
    BEGIN SELECT RAISE(ABORT, 'injected roster failure'); END`)
  try {
    assert.throws(
      () =>
        updateGroup(g.id, f.teacher, {
          name: '更新后组名',
          member_ids: [f.student.id],
          leader_id: f.student.id,
        }),
      /injected roster failure/,
    )
    assert.deepEqual([row('course_groups', g.id), roster()], before)
  } finally {
    db.exec('DROP TRIGGER fail_roster')
  }
  const a = await assignment(f, { work_mode: 'group', status: 'draft' })
  snapshotGroups(a.id, f.teacher, [g.id])
  const snapshot = db.prepare('SELECT * FROM assignment_groups WHERE assignment_id=?').get(a.id)
  assert.throws(() => setGroupSubmitter(snapshot.id, f.teacher, inactive.id), { status: 400 })
  setGroupSubmitter(snapshot.id, f.teacher, f.student.id)
  publishAssignment(a.id, f.teacher)
  assert.throws(() => snapshotGroups(a.id, f.teacher, [g.id]), { status: 400 })
  db.prepare('DELETE FROM course_students WHERE course_id=? AND student_id=?').run(
    f.course.id,
    f.student.id,
  )
  assert.throws(() => setGroupSubmitter(snapshot.id, f.teacher, f.student.id), { status: 400 })
})

test('student statistics preserve zero rows, mixed submission counts, course scope and ordering', async () => {
  const { listCourseStudents } = await import('../src/services/studentQueries.js')
  const { BASELINE_SQL } = await import('../scripts/student-stats-baseline.mjs')
  const { createGroup, snapshotGroups } = await import('../src/services/groupService.js')
  const { publishAssignment } = await import('../src/services/assignmentService.js')
  const f = await fixture(),
    other = await fixture()
  const member = user('student'),
    zero = user('student')
  for (const actor of [member, zero]) {
    db.prepare('INSERT INTO course_students(course_id,student_id,sort_order) VALUES(?,?,10)').run(
      f.course.id,
      actor.id,
    )
  }
  db.prepare('UPDATE course_students SET sort_order=30 WHERE course_id=? AND student_id=?').run(
    f.course.id,
    f.student.id,
  )
  for (const status of ['returned', 'graded']) {
    const a = await assignment(f)
    db.prepare('INSERT INTO submissions(assignment_id,student_id,status) VALUES(?,?,?)').run(
      a.id,
      f.student.id,
      status,
    )
  }
  const g = createGroup(f.course.id, f.teacher, {
    name: '统计组',
    member_ids: [f.student.id, member.id],
    leader_id: f.student.id,
  })
  for (const status of ['submitted', 'returned', null]) {
    const a = await assignment(f, { work_mode: 'group', status: 'draft' })
    snapshotGroups(a.id, f.teacher, [g.id])
    publishAssignment(a.id, f.teacher)
    const snapshot = db.prepare('SELECT id FROM assignment_groups WHERE assignment_id=?').get(a.id)
    if (status)
      db.prepare('INSERT INTO group_submissions(assignment_group_id,status) VALUES(?,?)').run(
        snapshot.id,
        status,
      )
  }
  const foreignAssignment = await assignment(other)
  db.prepare('INSERT INTO course_students(course_id,student_id) VALUES(?,?)').run(
    other.course.id,
    f.student.id,
  )
  db.prepare('INSERT INTO submissions(assignment_id,student_id) VALUES(?,?)').run(
    foreignAssignment.id,
    f.student.id,
  )
  db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(member.id)
  const actual = listCourseStudents(f.course.id, f.teacher)
  assert.deepEqual(actual, db.prepare(BASELINE_SQL).all(f.course.id))
  assert.deepEqual(
    actual.map((r) => [r.id, r.submission_count]),
    [
      [member.id, 2],
      [zero.id, 0],
      [f.student.id, 4],
    ],
  )
  assert.equal(actual[0].status, 'disabled')
  assert.deepEqual(await call(f.teacher, 'get', `/courses/${f.course.id}/students`), actual)
  for (const actor of [f.student, f.outsider]) {
    assert.throws(() => listCourseStudents(f.course.id, actor), { status: 403 })
  }
  // 保留旧排序的 NULL 回退及空课程行为。
  db.prepare('UPDATE course_students SET sort_order=NULL WHERE course_id=?').run(f.course.id)
  assert.deepEqual(
    listCourseStudents(f.course.id, f.teacher),
    db.prepare(BASELINE_SQL).all(f.course.id),
  )
  const empty = await call(f.teacher, 'post', '/courses', { name: '空课程' }, 201)
  assert.deepEqual(listCourseStudents(empty.id, f.teacher), [])
})
