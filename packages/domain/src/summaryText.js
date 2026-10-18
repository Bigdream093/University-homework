export function summaryText(value, limit = 160) {
  return Array.from(
    String(value || '')
      .replace(/\s+/g, ' ')
      .trim(),
  )
    .slice(0, limit)
    .join('')
}
