import test from 'node:test'
import assert from 'node:assert/strict'
import { imageIds, richTextSummary, sanitizeRichText } from '../src/domain/richText.js'

test('rich text keeps table spans and widths while removing executable content', () => {
  const id = '00000000-0000-0000-0000-000000000001'
  const result = sanitizeRichText(`<script>alert(1)</script><h2 style="text-align:center" onclick="bad()">标题</h2><table><colgroup><col style="width:180px"></colgroup><tbody><tr><td colspan="2" rowspan="2" colwidth="180,180">内容</td></tr></tbody></table><img src="/api/editor-images/${id}" onerror="bad()"><a href="javascript:bad()">链接</a>`)
  assert.doesNotMatch(result, /script|onclick|onerror|javascript:/i)
  assert.match(result, /colspan="2"/)
  assert.match(result, /rowspan="2"/)
  assert.match(result, /colwidth="180,180"/)
  assert.match(result, /width:180px/)
  assert.deepEqual([...imageIds(result)], [id])
  assert.equal(richTextSummary(result), '标题内容链接')
})
