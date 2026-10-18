// 历史提交名称的显示规则；不处理文件系统路径边界。
export function normalizeSubmissionFileName(value) {
  return String(value || '')
    .replace(/_(?:迟交|准时)(?=\.[^./\\]+$)/, '')
    .replaceAll(':', '-')
}
