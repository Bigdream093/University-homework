import test from 'node:test'
import assert from 'node:assert/strict'
import { fileNameFor, normalizeSubmissionFileName } from '../src/utils/submissionFiles.js'

test('下载文件名只保留姓名、学号、提交时间和扩展名', () => {
  const row = { name: '学生甲', username: '20245128' }
  const source = {
    file_name: '旧版_迟交.dwg',
    submitted_at: '2026-10-17 12:34:56',
    is_late: 1,
  }

  assert.equal(fileNameFor(row, source), '学生甲_20245128_10-17-12-34.dwg')
  assert.equal(
    fileNameFor(
      { ...row, kind: 'group' },
      { ...source, file_name: '设计组_20245128_10-17-12-34_迟交.dwg' },
    ),
    '设计组_20245128_10-17-12-34.dwg',
    '小组历史文件保留实际提交人学号，只移除旧版迟交后缀',
  )
  assert.equal(normalizeSubmissionFileName('学生甲_20245128_迟交.dwg'), '学生甲_20245128.dwg')
  assert.equal(normalizeSubmissionFileName('学生甲_20245128_准时.zip'), '学生甲_20245128.zip')
})
