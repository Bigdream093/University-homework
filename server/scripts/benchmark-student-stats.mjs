// 使用真实表结构和独立临时数据库；不连接业务数据，也不修改生产索引。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { BASELINE_SQL } from './student-stats-baseline.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mohen-stats-benchmark-'))
process.env.NODE_ENV = 'test'
process.env.DATA_DIR = dir
process.env.UPLOAD_DIR = path.join(dir, 'uploads')
const { db } = await import('../src/db.js')
const { STUDENT_LIST_SQL: CANDIDATE_SQL } = await import('../src/services/studentQueries.js')

function seed(students, assignments) {
  return db.transaction(() => {
    const courseId = db
      .prepare("INSERT INTO courses(name,teacher_id) VALUES('性能课程',1)")
      .run().lastInsertRowid
    const addUser = db.prepare(
      "INSERT INTO users(username,name,password_hash) VALUES(?,'学生','unused')",
    )
    const enroll = db.prepare(
      'INSERT INTO course_students(course_id,student_id,sort_order) VALUES(?,?,?)',
    )
    const addAssignment = db.prepare(
      "INSERT INTO assignments(course_id,title,work_mode,status) VALUES(?,'作业',?,'published')",
    )
    const submit = db.prepare('INSERT INTO submissions(assignment_id,student_id) VALUES(?,?)')
    const addGroup = db.prepare(
      "INSERT INTO assignment_groups(assignment_id,name,created_at) VALUES(?,?,'2026-01-01 00:00:00')",
    )
    const addMember = db.prepare(
      'INSERT INTO assignment_group_members(assignment_id,assignment_group_id,student_id) VALUES(?,?,?)',
    )
    const submitGroup = db.prepare('INSERT INTO group_submissions(assignment_group_id) VALUES(?)')
    const ids = Array.from({ length: students }, (_, i) => {
      const id = addUser.run(`bench-${courseId}-${i}`).lastInsertRowid
      enroll.run(courseId, id, students - i)
      return id
    })
    for (let i = 0; i < assignments; i++) {
      const a = addAssignment.run(courseId, i % 2 ? 'group' : 'individual').lastInsertRowid
      if (i % 2) {
        for (let j = 0; j < students; j += 3) {
          const g = addGroup.run(a, `组${j}`).lastInsertRowid
          for (const id of ids.slice(j, j + 3)) addMember.run(a, g, id)
          if (j % 5) submitGroup.run(g)
        }
      } else {
        for (let j = 0; j < students; j++) if (j % 5) submit.run(a, ids[j])
      }
    }
    return courseId
  })()
}

function measure(courseId, repetitions, warmups) {
  const baseline = db.prepare(BASELINE_SQL),
    candidate = db.prepare(CANDIDATE_SQL)
  const actual = baseline.all(courseId)
  assert.deepEqual(candidate.all(courseId, courseId, courseId), actual)
  assert.ok(actual.some((student) => student.submission_count === 0))
  const timings = { baseline: [], candidate: [] }
  for (let i = 0; i < repetitions + warmups; i++) {
    // 交替顺序并丢弃预热，降低缓存及先后顺序带来的偏差。
    for (const name of i % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const start = performance.now()
      if (name === 'baseline') baseline.all(courseId)
      else candidate.all(courseId, courseId, courseId)
      if (i >= warmups) timings[name].push(performance.now() - start)
    }
  }
  const summary = (values) => {
    values.sort((a, b) => a - b)
    const middle = Math.floor(values.length / 2)
    const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2
    return {
      median_ms: +median.toFixed(3),
      min_ms: +values[0].toFixed(3),
      max_ms: +values.at(-1).toFixed(3),
    }
  }
  return {
    rows: actual.length,
    repetitions,
    warmups,
    equal: true,
    baseline: summary(timings.baseline),
    candidate: summary(timings.candidate),
    baseline_plan: db.prepare('EXPLAIN QUERY PLAN ' + BASELINE_SQL).all(courseId),
    candidate_plan: db
      .prepare('EXPLAIN QUERY PLAN ' + CANDIDATE_SQL)
      .all(courseId, courseId, courseId),
  }
}

try {
  const cases = []
  for (const [students, assignments] of [
    [30, 20],
    [300, 60],
    [3000, 120],
  ]) {
    console.error(`测量 ${students} 名学生 / ${assignments} 份作业（原查询的大样本可能耗时数分钟）`)
    const courseId = seed(students, assignments)
    const repetitions = students >= 3000 ? 3 : 20
    const warmups = students >= 3000 ? 0 : 4
    const result = { students, assignments, ...measure(courseId, repetitions, warmups) }
    cases.push(result)
    console.error(
      JSON.stringify({ students, baseline: result.baseline, candidate: result.candidate }),
    )
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        sqlite: db.prepare('SELECT sqlite_version() version').get().version,
        platform: `${process.platform}/${process.arch}`,
        cpu: os.cpus()[0]?.model,
        cases,
      },
      null,
      2,
    ),
  )
} finally {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
}
