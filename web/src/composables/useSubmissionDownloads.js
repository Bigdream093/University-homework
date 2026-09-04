import { ElMessage } from 'element-plus'
import api, { messageOf } from '../api/request.js'
import { downloadBlob } from '../utils/files.js'
import { fileNameFor } from '../utils/submissionFiles.js'
import { useDownload } from './useDownload.js'

export function useSubmissionDownloads(route, assignment) {
  const downloadTask = useDownload()
  async function downloadSingle(row, file) {
    const url = file.history_id
      ? `${row.api_base}/file?history_id=${file.history_id}`
      : `${row.api_base}/file`
    const group = row.api_base.startsWith('/group-submissions/')
    await downloadTask.start({
      endpoint: `/api${url}`,
      ticket: { kind: 'submission-file', id: row.id, group, historyId: file.history_id },
      fileName: fileNameFor(row, file),
      fileSize: file.file_size || 0,
    })
  }

  async function download(row) {
    const group = row.api_base.startsWith('/group-submissions/')
    await downloadTask.start({
      endpoint: `/api${row.api_base}/package`,
      ticket: { kind: 'submission-package', id: row.id, group },
      fileName: `${assignment.value.title}-${row.name}.zip`,
    })
  }

  async function downloadAll() {
    await downloadTask.start({
      endpoint: `/api/assignments/${route.params.id}/package`,
      ticket: { kind: 'assignment-package', id: Number(route.params.id) },
      fileName: `${assignment.value.title}-全部作业.zip`,
    })
  }

  async function exportExcel() {
    try {
      const response = await api.get(`/assignments/${route.params.id}/export`, {
        responseType: 'blob',
        timeout: 0,
      })
      downloadBlob(response.data, `${assignment.value.title}-成绩表.xlsx`)
    } catch (error) {
      ElMessage.error(messageOf(error))
    }
  }

  return { downloadTask, downloadSingle, download, downloadAll, exportExcel }
}
