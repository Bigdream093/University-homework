import {
  markdown,
  markdownSummary,
  editorImagePattern,
} from '../../../server/src/domain/markdown.js'
import linkify from './linkify.js'

export { markdownSummary, editorImagePattern }
// Keep authenticated image paths inert until the viewer fetches them with a Bearer token.
markdown.renderer.rules.image = (tokens, index) => {
  const token = tokens[index]
  const src = token.attrGet('src') || ''
  const alt = markdown.utils.escapeHtml(token.content || '图片')
  if (editorImagePattern.test(src)) return `<img data-editor-src="${src}" alt="${alt}" />`
  if (/^https:\/\//i.test(src))
    return `<img src="${markdown.utils.escapeHtml(src)}" alt="${alt}" referrerpolicy="no-referrer" loading="lazy" />`
  return `<span class="image-unavailable">[${alt}：请使用上传图片功能]</span>`
}
const renderLink =
  markdown.renderer.rules.link_open ||
  ((tokens, index, options, env, self) => self.renderToken(tokens, index, options))
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index].attrSet('target', '_blank')
  tokens[index].attrSet('rel', 'noopener noreferrer')
  return renderLink(tokens, index, options, env, self)
}

export function renderMarkdown(content, format = 'markdown') {
  return format === 'markdown' ? markdown.render(content || '') : linkify(content)
}

export function editableMarkdown(content, format) {
  if (format === 'markdown') return content || ''
  // Escape old literal punctuation before the first Markdown edit.
  return String(content || '').replace(/([\\`*_[\]{}()#+.!|>~<>-])/g, '\\$1')
}
