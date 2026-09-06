import sanitizeHtml from 'sanitize-html'

export const editorImagePattern = /^\/api\/editor-images\/([a-f0-9-]{36})$/

const options = {
  allowedTags: [
    'p', 'br', 'h1', 'h2', 'h3', 'h4', 'strong', 'em', 'u', 's', 'blockquote', 'pre', 'code',
    'ul', 'ol', 'li', 'a', 'span', 'mark', 'img', 'table', 'colgroup', 'col', 'thead', 'tbody',
    'tfoot', 'tr', 'th', 'td',
  ],
  allowedAttributes: {
    a: ['href', 'target', 'rel'],
    img: ['src', 'alt', 'title'],
    '*': ['style'],
    td: ['colspan', 'rowspan', 'colwidth', 'style'],
    th: ['colspan', 'rowspan', 'colwidth', 'style'],
    col: ['style'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['https'] },
  allowedStyles: {
    '*': {
      color: [/^#[0-9a-f]{3,8}$/i, /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/i],
      'background-color': [/^#[0-9a-f]{3,8}$/i, /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/i],
      'text-align': [/^(left|center|right|justify)$/],
    },
    col: { width: [/^\d{1,4}px$/] },
    td: { 'min-width': [/^\d{1,4}px$/] },
    th: { 'min-width': [/^\d{1,4}px$/] },
  },
  transformTags: {
    a: (_tag, attrs) => ({
      tagName: 'a',
      attribs: { ...attrs, target: '_blank', rel: 'noopener noreferrer' },
    }),
    img: (_tag, attrs) => {
      const src = attrs.src || ''
      return editorImagePattern.test(src) || /^https:\/\//i.test(src)
        ? { tagName: 'img', attribs: { src, alt: attrs.alt || '图片', title: attrs.title || '' } }
        : { tagName: 'span', text: '[图片不可用]' }
    },
  },
}

export function sanitizeRichText(content) {
  return sanitizeHtml(String(content || ''), options).trim()
}

export function imageIds(content) {
  const ids = new Set()
  for (const match of String(content || '').matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) {
    const found = editorImagePattern.exec(match[1])
    if (found) ids.add(found[1])
  }
  return ids
}

export function richTextSummary(content, limit = 160) {
  const text = sanitizeHtml(sanitizeRichText(content), { allowedTags: [], allowedAttributes: {} })
  return Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, limit).join('')
}

// 摘要按格式分流：纯文本直接截断，避免 <、> 被当成 HTML 标签丢弃。
export function contentSummary(content, format, limit = 160) {
  if (format !== 'html')
    return Array.from(String(content || '').replace(/\s+/g, ' ').trim())
      .slice(0, limit)
      .join('')
  return richTextSummary(content, limit)
}

export function richTextValue(value, label, max = 50000, required = true) {
  const content = sanitizeRichText(value)
  if (content.length > max)
    throw Object.assign(new Error(`${label}不能超过${max}个字符`), { status: 400 })
  if (required && !richTextSummary(content, 1))
    throw Object.assign(new Error(`${label}不能为空`), { status: 400 })
  return content
}
