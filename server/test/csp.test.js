import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import request from 'supertest'
import { cspHeaders, contentSecurityPolicy, reportCspViolation } from '../src/middleware/csp.js'
for (const mode of ['report-only','enforce']) test('CSP response header: ' + mode, async () => {
  const app = express()
  app.use(cspHeaders(mode))
  app.get('/', (_,res) => res.send('ok'))
  const res = await request(app).get('/')
  assert.equal(res.headers[mode === 'enforce' ? 'content-security-policy' : 'content-security-policy-report-only'], contentSecurityPolicy)
  assert.match(contentSecurityPolicy, /wasm-unsafe-eval/)
  assert.ok(!contentSecurityPolicy.includes("script-src 'self' 'unsafe-inline'"))
})
test('CSP report endpoint handles malformed fields without logging user content', async () => {
  const app=express()
  app.post('/report',express.json({type:'application/csp-report',limit:'8kb'}),reportCspViolation)
  assert.equal((await request(app).post('/report').set('Content-Type','application/csp-report').send(JSON.stringify({'csp-report': {'effective-directive': '<script>token</script>'}}))).status,204)
  assert.throws(() => cspHeaders('invalid'))
})
