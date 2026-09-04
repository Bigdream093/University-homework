import { defineStore } from 'pinia'
import api from '../api/request.js'
import { clearSession, readToken, readUser, saveSession } from '../utils/session.js'

export const useUserStore = defineStore('user', {
  state: () => ({ token: readToken(), user: readUser() }),
  actions: {
    async login(form) {
      const { data } = await api.post('/auth/login', form)
      this.token = data.token
      this.user = data.user
      saveSession(data.token, data.user)
      return data.user
    },
    logout() {
      this.token = ''
      this.user = null
      clearSession()
    },
  },
})
