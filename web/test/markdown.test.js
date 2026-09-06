import test from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown, markdownSummary, editableMarkdown } from '../src/utils/markdown.js'

test('Markdown renders tables, preserves legacy text, and blocks executable HTML and URLs', () => {
  assert.match(renderMarkdown('| 项目 | 要求 |\n| --- | --- |\n| A | B |'), /<table>/)
  assert.match(renderMarkdown('**原样**', 'plain'), /\*\*原样\*\*/)
  const attack = renderMarkdown('<script>alert(1)</script>\n[x](javascript:alert(1))\n![x](data:image/svg+xml,evil)')
  assert.doesNotMatch(attack, /<script|href="javascript:|src="data:/)
  assert.doesNotMatch(renderMarkdown(editableMarkdown('**旧内容** # 题目', 'plain')), /<strong>|<h1>/)
  assert.equal(markdownSummary('## 标题\n\n![截图](/api/editor-images/00000000-0000-0000-0000-000000000001)\n\n**要求**'), '标题 要求')
  assert.match(renderMarkdown('![截图](/api/editor-images/00000000-0000-0000-0000-000000000001)'), /data-editor-src=/)
  assert.doesNotMatch(renderMarkdown('![截图](/api/editor-images/00000000-0000-0000-0000-000000000001)'), / src=/)
})
