import MarkdownIt from 'markdown-it'

export const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
})
export const editorImagePattern = /^\/api\/editor-images\/([a-f0-9-]{36})$/

export function imageIds(content) {
  const ids = new Set()
  function visit(tokens) {
    for (const token of tokens) {
      if (token.type === 'image') {
        const match = editorImagePattern.exec(token.attrGet('src') || '')
        if (match) ids.add(match[1])
      }
      if (token.children) visit(token.children)
    }
  }
  visit(markdown.parse(content || '', {}))
  return ids
}

export function markdownSummary(content, format = 'markdown', limit = 160) {
  let text = String(content || '')
  if (format === 'markdown') {
    const pieces = []
    function visit(tokens) {
      for (const token of tokens) {
        if (token.type === 'image') continue
        if (token.children) visit(token.children)
        else if (['text', 'code_inline', 'fence', 'code_block'].includes(token.type))
          pieces.push(token.content)
        else if (token.type === 'softbreak' || token.type === 'hardbreak' || token.block)
          pieces.push(' ')
      }
    }
    visit(markdown.parse(text, {}))
    text = pieces.join('')
  }
  return Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, limit).join('')
}
