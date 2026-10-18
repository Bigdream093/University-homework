// 浏览器可直接导入的输入约束；不依赖 Node 或数据库。
export const PREVIEW_MAX_BYTES = 20 * 1024 * 1024
export const IMAGE_MAX_PIXELS = 80_000_000
export const PREVIEW_EXTENSIONS = ['jpg', 'jpeg', 'png']
export const CHUNK_BYTES = 8 * 1024 * 1024
export const EDITOR_IMAGE_MAX_BYTES = 10 * 1024 * 1024
export const EDITOR_IMAGE_MAX_PIXELS = 40_000_000
export const DEFAULT_ASSIGNMENT_FILE_MAX_MB = 200

export const LIMITS = {
  courseName: 200,
  courseCode: 100,
  groupName: 100,
  noticeTitle: 200,
  materialTitle: 200,
  materialDescription: 20000,
  questionTitle: 200,
  assignmentTitle: 200,
  requiredAnswer: 20000,
  comment: 10000,
  reason: 2000,
  richText: 50000,
  plainText: 20000,
  defaultPageSize: 50,
  maxPageSize: 200,
  // 问答列表分页口径与批改列表不同（题目条目更重），单独声明。
  questionPageSize: 20,
  maxQuestionPageSize: 100,
  batchItems: 200,
}

// 带兜底的正整数收敛：非法输入回退fallback，超出max 截断到max。
// 与 idValue 的区别是本页用于查询参数（可容忍缺失），而 idValue 用于路径参数（必须报错）。
export function boundedInt(value, fallback, max) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? Math.min(number, max) : fallback
}
