function safeName(value) {
  return (
    String(value || '')
      // File names must not contain control characters.
      // eslint-disable-next-line no-control-regex
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .trim()
  )
}

export function fileNameFor(row, source) {
  const [datePart = '', timePart = ''] = String(source.submitted_at || '').split(' ')
  const [, month = '', day = ''] = datePart.split('-')
  const [hour = '', minute = ''] = timePart.split(':')
  const timestamp = `${month}-${day}-${hour}-${minute}`
  const rawName = source.file_name || ''
  const dot = rawName.lastIndexOf('.')
  const extension = dot > 0 ? rawName.slice(dot + 1) || 'bin' : 'txt'
  return `${safeName(row.name)}_${safeName(row.username)}_${timestamp}_${source.is_late ? '迟交' : '准时'}.${extension}`
}

export function rowFiles(row) {
  if (row.files?.length) return row.files
  if (row.file_name)
    return [
      {
        history_id: null,
        file_name: row.file_name,
        file_size: row.file_size,
        is_late: row.is_late,
        submitted_at: row.submitted_at,
      },
    ]
  return row.content
    ? [
        {
          history_id: null,
          file_name: null,
          content: row.content,
          is_late: row.is_late,
          submitted_at: row.submitted_at,
        },
      ]
    : []
}
