import test from 'node:test'
import assert from 'node:assert/strict'
import { ref } from 'vue'
import { mountView, nodes, textOf, button, click, input, settle } from './helpers/view-harness.js'

const failure = (message, status = 500) => Object.assign(new Error(message), { response: { status, data: { message } } })
const assignment = extra => ({ id: 1, course_id: 1, title: '设计作业', course_name: '设计课', type: 'online', status: 'published', course_status: 'active', total_score: 100, allow_resubmit_count: 1, submission_mode: 'overwrite', ...extra })
async function student({ a = {}, context = {}, saved = null, run = async () => ({ receipt_no: 'R-1', submit_count: 1 }), confirm } = {}) {
  const calls = []
  const upload = { busy: ref(false), percent: ref(0), state: ref(''), loaded: ref(0), total: ref(null), run: async args => { calls.push(args); return run(args) } }
  const view = await mountView('views/student/StudentSubmit.vue', {
    confirm,
    dependencies: { '../../composables/useChunkedUpload.js': { useChunkedUpload: () => upload } },
    handler: async config => {
      if (config.url.endsWith('/my-submission')) return saved
      if (config.url.endsWith('/submission-context')) return { can_submit: true, ...context }
      if (config.url === '/assignments/1') return assignment(a)
      throw Error('Unexpected request ' + config.url)
    },
  })
  return { ...view, calls, upload }
}

test('提交页：空答案阻止发送，成功显示回执并清除文字草稿', async () => {
  const view = await student()
  await click(button(view, '确认提交'))
  assert.equal(view.calls.length, 0)
  assert.match(view.messages.at(-1).text, /填写在线/)
  await input(nodes(view.root, 'el-input')[0], '我的答案')
  assert.ok(sessionStorage.values().includes('我的答案'))
  await click(button(view, '确认提交'))
  assert.equal(view.calls[0].metadata.content, '我的答案')
  assert.equal(view.calls[0].baseVersion, 0)
  assert.match(textOf(view.root), /R-1/)
  assert.ok(!sessionStorage.values().includes('我的答案'))
})

test('提交页：文件后缀、大小与必需预览图控制提交按钮', async () => {
  const view = await student({ a: { type: 'document', max_file_mb: 10, allowed_extensions: 'dwg', require_preview_image: 1, preview_max_count: 2 } })
  assert.equal(button(view, '确认提交').props.disabled, true)
  await input(nodes(view.root, 'FileDropZone')[0], new File(['bad'], 'bad.exe'))
  assert.match(view.messages.at(-1).text, /后缀/)
  assert.equal(nodes(view.root, 'FileDropZone')[0].props.modelValue, null)
  await input(nodes(view.root, 'FileDropZone')[0], { name: 'large.dwg', size: 10 * 1024 * 1024 + 1 })
  assert.match(view.messages.at(-1).text, /不超过 10M/)
  const source = new File(['drawing'], 'design.dwg'), preview = new File(['png'], 'preview.png')
  await input(nodes(view.root, 'FileDropZone')[0], source)
  assert.equal(button(view, '确认提交').props.disabled, true)
  await input(nodes(view.root, 'PreviewImagePicker')[0], [preview])
  await click(button(view, '确认提交'))
  assert.deepEqual(view.calls[0].files.map(x => [x.role, x.order, x.file.name]), [['source', 0, 'design.dwg'], ['preview', 1, 'preview.png']])
})

for (const [name,a,context,saved] of [
  ['课程归档', { course_status: 'archived' }, { can_submit: false }, null],
  ['作业关闭', { status: 'closed' }, { can_submit: false }, null],
  ['非小组提交人', {}, { can_submit: false, group: { name: '甲组' }, members: [] }, null],
  ['次数用尽', { allow_resubmit_count: 0 }, {}, { submit_count: 1, status: 'submitted' }],
]) test('提交页权限：' + name + '禁用输入和提交', async () => {
  const view = await student({ a, context, saved })
  assert.equal(button(view, '确认提交').props.disabled, true)
  assert.equal(nodes(view.root, 'el-input')[0].props.disabled, true)
  assert.equal(view.calls.length, 0)
})

test('提交页：覆盖确认取消不上传，网络失败保留草稿且可重试', async () => {
  let cancelled = true, failed = true
  const view = await student({ saved: { content: '旧答案', submit_count: 1, status: 'submitted' },
    confirm: async () => { if (cancelled) throw Error('cancel') },
    run: async () => { if (failed) throw failure('网络中断'); return { receipt_no: 'R-retry' } },
  })
  await input(nodes(view.root,'el-input')[0], '修订答案')
  await click(button(view,'确认提交'))
  assert.equal(view.calls.length,0)
  cancelled=false
  await click(button(view,'确认提交'))
  assert.equal(button(view,'确认提交').props.loading,false)
  assert.equal(nodes(view.root,'el-input')[0].props.modelValue,'修订答案')
  assert.match(view.messages.at(-1).text,/网络中断/)
  failed=false
  await click(button(view,'确认提交'))
  assert.equal(view.calls.length,2)
  assert.equal(view.calls[1].baseVersion,1)
  assert.match(textOf(view.root),/R-retry/)
})

test('提交页：409冲突不自动重发，保留答案并提供刷新入口', async () => {
  const view=await student({ run: async () => { throw failure('已有更新的提交记录',409) } })
  await input(nodes(view.root,'el-input')[0],'保留的答案')
  await click(button(view,'确认提交'))
  assert.equal(view.calls.length,1)
  assert.ok(nodes(view.root,'el-alert').some(n=>String(n.props.title).includes('提交冲突')))
  await click(button(view,'获取最新状态'))
  assert.equal(nodes(view.root,'el-input')[0].props.modelValue,'保留的答案')
  assert.equal(view.calls.length,1)
})

const row = extra => ({ id: 10, username: 's1', name: '学生甲', status: 'submitted', submit_count: 1, api_base: '/submissions/10', content: '答案', score: null, previews: [], ...extra })
async function grading({ archived=false, reject=false }={}) {
  let record=row(), rejectSave=reject
  const view=await mountView('views/teacher/SubmissionsView.vue', { handler: async (config,body) => {
    if(config.url==='/assignments/1') return assignment({course_status: archived?'archived':'active'})
    if(config.url.endsWith('/submissions')) return [structuredClone(record)]
    if(config.method==='post') {
      if(rejectSave) throw failure('保存失败')
      record={...record,...body,status:config.url.endsWith('/return')?'returned':'graded'}
      return {message:'ok'}
    }
    throw Error('Unexpected '+config.url)
  } })
  return {...view, recover:()=>{rejectSave=false}}
}

test('批改页：打开评分、拒绝越界、保存0分、刷新列表并清理草稿',async()=>{
  const view=await grading()
  await click(button(view,'评分'))
  await input(nodes(view.root,'el-input-number')[0],101)
  await click(button(view,'确认'))
  assert.equal(view.requests.filter(r=>r.method==='post').length,0)
  await input(nodes(view.root,'el-input-number')[0],0)
  await input(nodes(view.root,'el-input').find(n=>n.props.type==='textarea'),'需改进')
  await click(button(view,'确认'))
  assert.deepEqual(view.requests.find(r=>r.method==='post').body,{score:0,comment:'需改进'})
  assert.equal(nodes(view.root,'el-dialog').length,0)
  assert.equal(nodes(view.root,'el-table')[0].props.data[0].status,'graded')
  assert.deepEqual(sessionStorage.values(),[])
})

test('批改页：保存失败留在弹窗保留草稿，恢复后退回原因发送正确',async()=>{
  const view=await grading({reject:true})
  await click(button(view,'退回'))
  await input(nodes(view.root,'el-input').find(n=>n.props.type==='textarea'),'补充图纸')
  await click(button(view,'确认'))
  assert.equal(nodes(view.root,'el-dialog').length,1)
  assert.equal(button(view,'确认').props.loading,false)
  assert.ok(sessionStorage.values().some(v=>v.includes('补充图纸')))
  view.recover()
  await click(button(view,'确认'))
  assert.equal(view.requests.filter(r=>r.method==='post').at(-1).url,'/submissions/10/return')
  assert.equal(nodes(view.root,'el-table')[0].props.data[0].returned_reason,'补充图纸')
})

test('批改页：归档禁止评分和退回，筛选及搜索仍可用',async()=>{
  const view=await grading({archived:true})
  assert.equal(button(view,'评分').props.disabled,true)
  assert.equal(button(view,'退回').props.disabled,true)
  await input(nodes(view.root,'el-radio-group')[0],'graded')
  assert.equal(nodes(view.root,'el-table')[0].props.data.length,0)
  await input(nodes(view.root,'el-radio-group')[0],'all')
  await input(nodes(view.root,'el-input')[0],'不存在')
  assert.equal(nodes(view.root,'el-table')[0].props.data.length,0)
})

function summaryData() { return { config:{daily_ratio:40,final_ratio:60,grade_absent_mode:'zero'}, assignments:[
  {id:1,title:'平时',total_score:100,grade_weight:40,status:'published',is_final:0},
  {id:2,title:'期末',total_score:100,grade_weight:0,status:'published',is_final:1},
], students:[{id:2,name:'学生甲',username:'s1',status:'active',cells:{1:row({status:'graded',score:80}),2:row({id:11,api_base:'/submissions/11',status:'graded',score:90})}}] } }
async function summary({readonly=false,reject=false}={}){
  const data=summaryData()
  return mountView('components/CourseSummary.vue',{props:{courseId:1,courseName:'设计课',readonly},handler:async(config,body)=>{
    if(config.url.endsWith('/summary'))return structuredClone(data)
    if(config.url.endsWith('/grade-config')){
      if(reject)throw failure('配置保存失败')
      data.config=body
      for(const weight of body.weights)data.assignments.find(a=>a.id===weight.assignment_id).grade_weight=weight.grade_weight
      return {}
    }
    if(config.url.endsWith('/summary/export'))return new Blob(['xlsx'])
    if(config.url.endsWith('/grade')){if(reject)throw failure('评分保存失败');return {}}
    throw Error('Unexpected '+config.url)
  }})
}

test('汇总页：展示计算结果、行内改分后即时更新总分',async()=>{
  const view=await summary()
  assert.equal(textOf(nodes(view.root,'b').find(n=>n.props.class==='total')),'86.0')
  await click(nodes(view.root,'span').find(n=>n.props.title==='点击修改成绩'))
  await input(nodes(view.root,'el-input-number').find(n=>n.props.size==='small'),100)
  const editor=nodes(view.root,'el-input-number').find(n=>n.props.size==='small')
  await editor.props.onKeyup({key:'Enter'});await settle()
  assert.deepEqual(view.requests.find(r=>r.method==='post').body,{score:100,comment:''})
  assert.equal(textOf(nodes(view.root,'b').find(n=>n.props.class==='total')),'94.0')
})

test('汇总页：权重不匹配禁止保存，平均分配后导出先保存再下载',async()=>{
  const view=await summary()
  await input(nodes(view.root,'el-input-number')[0],50)
  assert.equal(button(view,'保存设置').props.disabled,true)
  await click(button(view,'占比设置'))
  await click(button(view,'平均分配'))
  await click(button(view,'完成'))
  assert.equal(button(view,'保存设置').props.disabled,false)
  await click(button(view,'导出成绩表'))
  assert.deepEqual(view.requests.slice(1).map(r=>[r.method,r.url]),[['put','/courses/1/grade-config'],['get','/courses/1/summary'],['get','/courses/1/summary/export']])
  assert.equal(view.requests[1].body.weights[0].grade_weight,50)
  assert.equal(view.downloads[0][1],'设计课-成绩汇总.xlsx')
  assert.equal(button(view,'保存设置').props.disabled,true)
})

test('汇总页：配置保存失败阻止导出，保留修改并恢复按钮',async()=>{
  const view=await summary({reject:true})
  await input(nodes(view.root,'el-select')[1],'skip_ungraded')
  await click(button(view,'导出成绩表'))
  assert.equal(view.downloads.length,0)
  assert.ok(!view.requests.some(r=>r.url.endsWith('/export')))
  assert.equal(button(view,'保存设置').props.disabled,false)
  assert.equal(button(view,'保存设置').props.loading,false)
  assert.match(view.messages.at(-1).text,/配置保存失败/)
})

test('汇总页：只读禁止改分和设置，搜索正常',async()=>{
  const view=await summary({readonly:true})
  assert.equal(button(view,'占比设置').props.disabled,true)
  await click(nodes(view.root,'span').find(n=>n.props.class==='score'))
  assert.ok(!nodes(view.root,'el-input-number').some(n=>n.props.size==='small'))
  await input(nodes(view.root,'el-input')[0],'不存在')
  assert.equal(nodes(view.root,'el-table')[0].props.data.length,0)
})

test('看图评分：切换图片、保存并跳过已评记录到下一份未评分',async()=>{
  const saved=[], first=row({previews:[{id:1,name:'一',thumbnail:'one',preview:'one-full'},{id:2,name:'二',thumbnail:'two',preview:'two-full'}]}), next=row({id:12,api_base:'/submissions/12'})
  const view=await mountView('components/GradeWorkspace.vue',{props:{modelValue:true,row:first,assignment:assignment(),rows:[first,row({id:11,api_base:'/submissions/11',status:'graded'}),next],onSaved:(...args)=>saved.push(args)},handler:async()=>({})})
  await click(button(view,'下一张 →'))
  assert.equal(nodes(view.root,'el-image')[0].props.src,'two')
  await input(nodes(view.root,'el-input-number')[0],100)
  await click(button(view,'保存并下一份未评分'))
  assert.equal(view.requests[0].body.score,100)
  assert.equal(saved[1][0].id,12)
  assert.equal(saved[1][1],true)
  assert.deepEqual(sessionStorage.values(),[])
})

test('汇总页：行内评分失败保留原成绩，不错误更新总分',async()=>{
  const view=await summary({reject:true})
  await click(nodes(view.root,'span').find(n=>n.props.title==='点击修改成绩'))
  await input(nodes(view.root,'el-input-number').find(n=>n.props.size==='small'),100)
  await nodes(view.root,'el-input-number').find(n=>n.props.size==='small').props.onBlur()
  await settle()
  assert.equal(textOf(nodes(view.root,'b').find(n=>n.props.class==='total')),'86.0')
  assert.match(view.messages.at(-1).text,/评分保存失败/)
})

for (const [name,path,props] of [
  ['提交页','views/student/StudentSubmit.vue',{}],
  ['批改页','views/teacher/SubmissionsView.vue',{}],
  ['汇总页','components/CourseSummary.vue',{courseId:1}],
]) test(name+'：加载失败显示错误且不发生渲染异常',async()=>{
  const view=await mountView(path,{props,handler:async()=>{throw failure('加载失败')}})
  assert.ok(view.messages.some(m=>m.level==='error'&&m.text==='加载失败'))
  assert.deepEqual(view.errors,[])
})


test('课程页：提取后的作业表单新建、校验后缀并清空再次打开的草稿', async () => {
  const view = await mountView('views/teacher/CourseManage.vue', {
    dependencies: { '../../composables/useDraggableTabs.js': { useDraggableTabs: () => {} } },
    handler: async (config, body) => {
      if (config.method === 'post' && config.url === '/courses/1/assignments') return {id: 2, ...body}
      if (config.url === '/courses/1') return {id:1,name:'设计课',status:'active'}
      if (config.url.endsWith('/students') || config.url.endsWith('/assignments')) return []
      throw Error('Unexpected request ' + config.url)
    },
  })
  await click(button(view, '发布新作业'))
  const fields = nodes(view.root, 'el-input')
  await input(fields[0], '新作业')
  await input(fields[2], '.ZIP；dwg')
  await click(button(view, '保存'))
  const created = view.requests.find(r => r.method === 'post')
  assert.equal(created.body.title, '新作业')
  assert.equal(created.body.allowed_extensions, 'zip,dwg')
  await click(button(view, '发布新作业'))
  assert.equal(nodes(view.root, 'el-input')[0].props.modelValue, '')
})

test('批改页：放弃草稿恢复服务端成绩并删除缓存', async () => {
  const view = await grading()
  await click(button(view, '评分'))
  await input(nodes(view.root, 'el-input-number')[0], 75)
  assert.ok(sessionStorage.values().some(value => value.includes('75')))
  await click(button(view, '放弃草稿'))
  assert.equal(nodes(view.root, 'el-input-number')[0].props.modelValue, null)
  assert.equal(sessionStorage.values().length, 0)
})
