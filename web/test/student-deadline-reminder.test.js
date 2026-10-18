import test from 'node:test'
import assert from 'node:assert/strict'
import { onMounted } from 'vue'
import { mountView, textOf } from './helpers/view-harness.js'

test('学生课程提醒按服务器时间显示剩余天数和小时，已批改状态与倒计时分开显示', async () => {
  const view = await mountView('views/student/StudentAssignments.vue', {
    dependencies: {
      '../../composables/useRefresh.js': { useRefresh: (load) => onMounted(load) },
      '../../composables/useDraggableTabs.js': { useDraggableTabs: () => {} },
    },
    handler: async (config) => {
      if (config.url === '/courses/1') return { id: 1, name: '计算机辅助设计', status: 'active' }
      if (config.url === '/courses/1/assignments')
        return [
          {
            id: 1,
            title: '首次大作业',
            status: 'published',
            submission_status: 'graded',
            effective_deadline: '2026-10-26 17:00:00',
            server_now: '2026-10-17 12:00:00',
          },
        ]
      throw Error('Unexpected request ' + config.url)
    },
  })
  const content = textOf(view.root)
  assert.match(content, /剩余 9 天 5 小时/)
  assert.doesNotMatch(content, /剩余 10 天/)
  assert.match(content, /已批改/)
  assert.deepEqual(view.errors, [])
})
