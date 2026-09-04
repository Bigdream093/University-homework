import axios from 'axios'
import { clearSession, readToken } from '../utils/session.js'

const api = axios.create({ baseURL: '/api', timeout: 30000 })
let redirectingToLogin = false
api.interceptors.request.use((config) => {
  const token = readToken()
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const data = error.response?.data
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      try {
        const text = await data.text()
        error.response.data = JSON.parse(text)
      } catch {
        // Keep the original Blob when the server did not return JSON.
      }
    }
    const isLoginRequest = String(error.config?.url || '').replace(/^\/api/, '') === '/auth/login'
    if (error.response?.status === 401 && !isLoginRequest) {
      clearSession()
      if (!redirectingToLogin && location.pathname !== '/login') {
        redirectingToLogin = true
        const current = `${location.pathname}${location.search}${location.hash}`
        location.assign(`/login?redirect=${encodeURIComponent(current)}`)
        window.setTimeout(() => {
          redirectingToLogin = false
        }, 1500)
      }
    }
    return Promise.reject(error)
  },
)
export default api

export function messageOf(error) {
  return error.response?.data?.message || error.message || '操作失败'
}
