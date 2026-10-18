// 列表与提交上下文共用权限规则；调用方负责加载课程、作业与当前学生的小组。
export function canSubmitAssignment(assignment, courseStatus, group, studentId) {
  return (
    assignment.status === 'published' &&
    courseStatus !== 'archived' &&
    (assignment.work_mode !== 'group' ||
      Boolean(
        group && (assignment.group_submit_policy === 'any' || group.submitter_id === studentId),
      ))
  )
}
