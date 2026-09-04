import assert from 'node:assert/strict'
import { afterEach } from 'node:test'
import { readFileSync } from 'node:fs'
import * as Vue from 'vue'
import { parse, compileScript } from 'vue/compiler-sfc'
import api, { messageOf } from '../../src/api/request.js'

const renderer = Vue.createRenderer({
  createElement: (tag) => ({ tag, props: {}, children: [] }),
  createText: (text) => ({ text }),
  createComment: (text) => ({ text }),
  setText: (node, text) => { node.text = text },
  setElementText: (node, text) => { node.text = text; node.children = [] },
  patchProp: (node, key, previous, value) => { node.props[key] = value },
  insert(node, parent, anchor = null) {
    if (node.parent) {
      node.parent.children.splice(node.parent.children.indexOf(node), 1)
    }
    node.parent = parent
    const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index < 0) parent.children.push(node)
    else parent.children.splice(index, 0, node)
  },
  remove(node) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
  },
  parentNode: (node) => node.parent,
  nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1],
})


const disposers = []
afterEach(() => { for (const dispose of disposers.splice(0).reverse()) dispose() })
export const nodes = (root, tag) => [root, ...(root.children || []).flatMap(child => nodes(child))].filter(n => !tag || n.tag === tag)
export const textOf = root => (root.text || '') + (root.children || []).map(textOf).join('')
export async function settle() { await new Promise(resolve => setImmediate(resolve)); await Vue.nextTick() }
export function button(view, label) {
  const found = nodes(view.root, 'el-button').filter(n => textOf(n).trim() === label)
  assert.equal(found.length, 1, '按钮必须唯一：' + label)
  return found[0]
}
export async function click(node) {
  assert.ok(node && !node.props.disabled && !node.props.loading, '操作必须可用')
  await node.props.onClick({ key: '', preventDefault() {}, stopPropagation() {} })
  await settle()
}
export async function input(node, value) {
  assert.ok(node && !node.props.disabled, '输入必须可用')
  node.props['onUpdate:modelValue'](value)
  await settle()
}
export function storage() {
  const data = new Map()
  return { getItem: k => data.get(k) ?? null, setItem: (k,v) => data.set(k,String(v)), removeItem: k => data.delete(k), clear: () => data.clear(), values: () => [...data.values()] }
}
function stub(tag) {
  return { inheritAttrs: false, setup: (_, { attrs, slots }) => () => Vue.h(tag, attrs, [slots.default?.(), slots.footer?.()]) }
}
export async function mountView(relative, { props = {}, route = { params: { id: '1' } }, handler, dependencies = {}, resetStorage = true, confirm = async () => {} } = {}) {
  const messages = [], requests = [], errors = [], navigations = [], downloads = []
  const originals = new Map()
  const globals = {
    window: { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout },
  }
  if (resetStorage) { globals.localStorage = storage(); globals.sessionStorage = storage() }
  for (const [key,value] of Object.entries(globals)) {
    originals.set(key,Object.getOwnPropertyDescriptor(globalThis,key))
    Object.defineProperty(globalThis,key,{configurable:true,value})
  }
  const originalAdapter = api.defaults.adapter
  if (handler) api.defaults.adapter = async config => {
    const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data
    requests.push({ method: config.method, url: config.url, body })
    const data = await handler(config, body)
    return { data, status: 200, statusText: 'OK', headers: {}, config }
  }
  const filename = new URL('../../src/' + relative, import.meta.url)
  const source = readFileSync(filename,'utf8')
  const { descriptor } = parse(source)
  const deps = {
    vue: Vue,
    'vue-router': { useRoute: () => Vue.reactive(route), useRouter: () => ({ push: target => navigations.push(target) }) },
    'element-plus': { ElMessage: Object.fromEntries(['success','warning','error','info'].map(level => [level, text => messages.push({level,text})])), ElMessageBox: { confirm } },
    ...dependencies,
  }
  for (const [,specifier] of descriptor.scriptSetup.content.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    if (specifier in deps) continue
    if (specifier.endsWith('.vue')) deps[specifier] = { default: stub(specifier.split('/').at(-1).replace('.vue','')) }
    else if (specifier.endsWith('/utils/files.js')) deps[specifier] = { downloadBlob: (...args) => downloads.push(args) }
    else if (specifier.endsWith('/useDownload.js')) deps[specifier] = { useDownload: () => ({ tasks: Vue.ref([]), start: async () => {} }) }
    else deps[specifier] = await import(new URL(specifier,filename))
  }
  const compiled = compileScript(descriptor,{ id: relative, inlineTemplate:true, genDefaultAs:'component' }).content
  const executable = compiled.replace(/import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?/g, (_,bindings,specifier) => {
    assert.ok(specifier in deps, 'Missing dependency ' + specifier)
    const namedStart=bindings.indexOf('{'), declarations=[]
    if(namedStart!==0) declarations.push('const '+bindings.split(',')[0].trim()+' = deps['+JSON.stringify(specifier)+'].default')
    if(namedStart>=0) declarations.push('const '+bindings.slice(namedStart).replace(/\bas\b/g, ':')+' = deps['+JSON.stringify(specifier)+']')
    return declarations.join(';\n')+';'
  })
  const component = new Function('deps',executable+'\nreturn component')(deps)
  const app=renderer.createApp(component,props)
  app.config.errorHandler = error => errors.push(error)
  app.config.warnHandler = () => {}
  app.directive('loading', {})
  for(const tag of new Set(source.match(/el-[a-z-]+/g) || []))
    if (!['el-dialog','el-table','el-table-column'].includes(tag)) app.component(tag,stub(tag))
  app.component('router-link',stub('router-link'))
  app.component('el-dialog',{ inheritAttrs:false, setup:(_, {attrs,slots}) => () => attrs.modelValue ? Vue.h('el-dialog',attrs,[slots.default?.(),slots.footer?.()]) : null })
  app.component('el-table',{
    inheritAttrs:false,
    setup:(_, {attrs,slots}) => {
      Vue.provide('tableRows', () => attrs.data || [])
      return () => Vue.h('el-table', attrs, [slots.default?.(), !(attrs.data || []).length ? slots.empty?.() : null])
    },
  })
  app.component('el-table-column',{
    inheritAttrs:false,
    setup:(_, {attrs,slots}) => {
      const rows=Vue.inject('tableRows')
      return () => Vue.h('el-table-column',attrs,[slots.header?.(), ...rows().map((row,$index) => Vue.h('cell',{rowId:row.id},slots.default ? slots.default({row,$index}) : String(row[attrs.prop] ?? '')))])
    },
  })
  const root={children:[]}
  let disposed=false
  const dispose=() => {
    if(disposed) return
    disposed=true; app.unmount(); api.defaults.adapter=originalAdapter
    for(const [key,descriptor] of originals) { if(descriptor) Object.defineProperty(globalThis,key,descriptor); else delete globalThis[key] }
    assert.deepEqual(errors.map(e=>e.message),[], '组件运行时不得报错')
  }
  disposers.push(dispose)
  app.mount(root)
  await settle()
  assert.deepEqual(errors.map(e=>e.message),[])
  return { root, messages, requests, errors, navigations, downloads, dispose }
}

export async function waitFor(predicate, label = '页面加载', timeout = 5000) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    assert.ok(Date.now() < deadline, label + '超时')
    await new Promise(resolve => setTimeout(resolve, 10))
    await Vue.nextTick()
  }
}
