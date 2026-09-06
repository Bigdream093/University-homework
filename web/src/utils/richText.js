import DOMPurify from 'dompurify'

export const editorImagePattern = /^\/api\/editor-images\/([a-f0-9-]{36})$/

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
