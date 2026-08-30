import axios from 'axios';
import { clearSession, readToken } from '../utils/session.js';

const api = axios.create({ baseURL: '/api', timeout: 30000 });
api.interceptors.request.use(config => {
  const token = readToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});
api.interceptors.response.use(r => r, error => {
  if (error.response?.status === 401) {
    clearSession();
    if (!location.pathname.includes('login')) location.href = '/login';
  }
  return Promise.reject(error);
});
export default api;

export function messageOf(error) { return error.response?.data?.message || error.message || '操作失败'; }
