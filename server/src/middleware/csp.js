// Inline styles are required by Element Plus; scripts remain same-origin only.
// wasm-unsafe-eval permits the SHA-256 fallback on HTTP LAN connections.
export const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "media-src 'self' blob:",
  "frame-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  'report-uri /api/security/csp-report',
].join('; ')

export function cspHeaders(mode = process.env.CSP_MODE || 'enforce') {
  if (!['report-only', 'enforce'].includes(mode)) throw new Error('CSP_MODE must be report-only or enforce')
  const header = mode === 'enforce' ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only'
  return (_req, res, next) => {
    res.setHeader(header, contentSecurityPolicy)
    next()
  }
}

// Reports are untrusted. Log only a bounded directive name, never URLs, tokens or samples.
let windowStart = 0
let reports = 0
export function reportCspViolation(req, res) {
  if (Date.now() - windowStart > 60000) { windowStart = Date.now(); reports = 0 }
  const directive = req.body?.['csp-report']?.['effective-directive']
  if (reports++ < 20 && typeof directive === 'string' && /^[a-z-]{1,40}$/.test(directive))
    console.warn('CSP violation:', directive)
  res.sendStatus(204)
}
