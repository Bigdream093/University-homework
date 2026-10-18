// Use one error shape across domain, service, middleware and route validation.
export function httpError(status, message, properties = {}) {
  return Object.assign(new Error(message), { status }, properties)
}
