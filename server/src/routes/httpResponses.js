export function sendRateLimitedResponse(res, retryAfter) {
  res.set('Retry-After', String(retryAfter))
  return res.status(429).json({ message: `尝试过于频繁，请在${retryAfter}秒后重试` })
}
