// 将纯文本中的 http(s) 链接转换为可点击的 <a> 标签。
// 先整体 HTML 转义、再替换 URL，且仅放行 http/https 协议，避免 XSS。
const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (character) => ESCAPE_MAP[character])
}

export default function linkify(text) {
  return escapeHtml(text).replace(/https?:\/\/[^\s<>"'）】」，。；！？]+/g, (url) => {
    const trailing = /[).,;!?]+$/.exec(url)
    const href = trailing ? url.slice(0, -trailing[0].length) : url
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>${trailing ? trailing[0] : ''}`
  })
}
