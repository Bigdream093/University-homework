export function placeholders(values) {
  return values.map(() => '?').join(',')
}
