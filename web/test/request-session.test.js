import test from 'node:test'
import assert from 'node:assert/strict'
import api from '../src/api/request.js'
import { saveSession, readToken } from '../src/utils/session.js'

test('explicit login marker survives URL changes; concurrent protected 401 redirects once', async () => {
  const names = ['localStorage','location','window']
  const originals = names.map(name => Object.getOwnPropertyDescriptor(globalThis,name))
  const values = new Map(), navigations = []
  const mocks = [
    {getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)},
    {pathname:'/teacher/courses/1',search:'?tab=summary',hash:'',assign:url=>navigations.push(url)},
    {setTimeout:()=>0,dispatchEvent:()=>{}},
  ]
  const adapter=api.defaults.adapter
  try {
    names.forEach((name,index)=>Object.defineProperty(globalThis,name,{configurable:true,value:mocks[index]}))
    api.defaults.adapter=async config=>{ throw {config,response:{status:401,data:{message:'denied'}}} }
    saveSession('existing-token',{id:1})
    await assert.rejects(api.post('/renamed-login',{}, {skipSessionExpiry:true}))
    assert.equal(readToken(),'existing-token')
    assert.deepEqual(navigations,[])
    await Promise.allSettled([api.get('/protected-a'),api.get('/protected-b')])
    assert.equal(readToken(),'')
    assert.deepEqual(navigations,['/login?redirect=%2Fteacher%2Fcourses%2F1%3Ftab%3Dsummary'])
  } finally {
    api.defaults.adapter=adapter
    names.forEach((name,index)=>originals[index] ? Object.defineProperty(globalThis,name,originals[index]) : delete globalThis[name])
  }
})
