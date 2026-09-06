import DOMPurify from 'dompurify'
import linkify from './linkify.js'

export const editorImagePattern = /^\/api\/editor-images\/([a-f0-9-]{36})$/

// 非 html（plain 及遗留 markdown）按纯文本显示：转义 + 自动识别网址。
export function renderContent(content, format) {
  return format === 'html' ? renderRichText(content) : linkify(content)
}

// 旧纯文本进入富文本编辑器前，转义并按换行拆成段落。
export function plainTextToHtml(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map(
      (line) =>
        `<p>${line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') || '<br>'}</p>`,
    )
    .join('')
}

export function editableRichText(content, format) {
  return format === 'html' ? content || '' : plainTextToHtml(content)
}

export function contentSummary(content, format, limit = 160) {
  if (format !== 'html')
    return Array.from(
      String(content || '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
      .slice(0, limit)
      .join('')
  return richTextSummary(content, limit)
}

export function renderRichText(content) {
  const html = DOMPurify.sanitize(String(content || ''), {
    ADD_ATTR: ['colwidth', 'target'],
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form'],
  })
  const root = document.createElement('div')
  root.innerHTML = html
  for (const link of root.querySelectorAll('a')) {
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
  }
  for (const image of root.querySelectorAll('img')) {
    const src = image.getAttribute('src') || ''
    if (editorImagePattern.test(src)) {
      image.removeAttribute('src')
      image.dataset.editorSrc = src
    } else if (/^https:\/\//i.test(src)) {
      image.referrerPolicy = 'no-referrer'
      image.loading = 'lazy'
    } else image.replaceWith(document.createTextNode('[图片不可用]'))
  }
  return root.innerHTML
}

export function richTextSummary(content, limit = 160) {
  const root = document.createElement('div')
  root.innerHTML = renderRichText(content)
  return Array.from((root.textContent || '').replace(/\s+/g, ' ').trim())
    .slice(0, limit)
    .join('')
}
