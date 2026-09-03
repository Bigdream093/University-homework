const HOUR = 60 * 60 * 1000

export function clientAddress(req) {
  return String(req.ip || req.socket?.remoteAddress || 'unknown')
}

export function createFailureLimiter({
  maxFailures,
  baseDelayMs = 1000,
  lockMs = 15 * 60 * 1000,
  windowMs = 15 * 60 * 1000,
}) {
  const states = new Map()
  let checks = 0

  function stateFor(key, at) {
    const current = states.get(key)
    if (!current || at - current.startedAt >= windowMs) {
      const fresh = { failures: 0, startedAt: at, blockedUntil: 0, touchedAt: at }
      states.set(key, fresh)
      return fresh
    }
    current.touchedAt = at
    return current
  }

  function sweep(at) {
    checks += 1
    if (checks % 200 !== 0) return
    for (const [key, state] of states) if (at - state.touchedAt > 24 * HOUR) states.delete(key)
  }

  return {
    check(key, at = Date.now()) {
      sweep(at)
      const state = stateFor(String(key), at)
      return state.blockedUntil > at
        ? { allowed: false, retryAfter: Math.max(1, Math.ceil((state.blockedUntil - at) / 1000)) }
        : { allowed: true, retryAfter: 0 }
    },
    fail(key, at = Date.now()) {
      const state = stateFor(String(key), at)
      state.failures += 1
      const delay =
        state.failures >= maxFailures
          ? lockMs
          : Math.min(30_000, baseDelayMs * 2 ** Math.max(0, state.failures - 1))
      state.blockedUntil = Math.max(state.blockedUntil, at + delay)
      return Math.max(1, Math.ceil(delay / 1000))
    },
    success(key) {
      states.delete(String(key))
    },
  }
}

export function rejectLimited(res, retryAfter) {
  res.set('Retry-After', String(retryAfter))
  return res.status(429).json({ message: `尝试过于频繁，请在${retryAfter}秒后重试` })
}
