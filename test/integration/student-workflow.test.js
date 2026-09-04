import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import ExcelJS from 'exceljs'
import { effectScope } from 'vue'
import { mountView, nodes, textOf, button, click, input, waitFor, storage } from '../../web/test/helpers/view-harness.js'

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mohen-student-chain-'))
Object.assign(process.env,{NODE_ENV:'test',TZ:'Asia/Shanghai',JWT_SECRET:'isolated-student-chain-test',DATA_DIR:directory,UPLOAD_DIR:path.join(directory,'uploads')})
const {app}=await import('../../server/src/index.js')
const {db}=await import('../../server/src/db.js')
const {processCleanupBatch}=await import('../../server/src/services/storage.js')
const {resolveUploadPath}=await import('../../server/src/utils/uploadPath.js')
const {default:api}=await import('../../web/src/api/request.js')
const {useChunkedUpload}=await import('../../web/src/composables/useChunkedUpload.js')
const server=app.listen(0,'127.0.0.1')
await new Promise(resolve=>server.once('listening',resolve))
const base=`http://127.0.0.1:${server.address().port}/api`
api.defaults.baseURL=base
const originalGlobals=new Map(['localStorage','sessionStorage'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]))
for(const key of originalGlobals.keys())Object.defineProperty(globalThis,key,{configurable:true,value:storage()})
after(async()=>{
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));db.close()
  fs.rmSync(directory,{recursive:true,force:true})
  for(const [key,descriptor] of originalGlobals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key]}
})
async function call(actor,method,url,body,status=200){
  const response=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(actor?{Authorization:'Bearer '+actor.token}:{})},body:body===undefined?undefined:JSON.stringify(body)})
  const data=await response.json()
  assert.equal(response.status,status,method+' '+url+': '+JSON.stringify(data))
  return data
}
function useActor(actor){localStorage.setItem('hw_token',actor.token);localStorage.setItem('hw_user',JSON.stringify(actor.user))}
let sequence=0
async function fixture({group=false,online=false,preview=true}={}){
  sessionStorage.clear()
  const teacher=await call(null,'POST','/auth/login',{username:'teacher',password:'123456'})
  const course=await call(teacher,'POST','/courses',{name:'学生链路-'+ ++sequence},201)
  const users=[]
  for(const suffix of ['leader','member','other']){
    const username=`chain-${sequence}-${suffix}`
    await call(teacher,'POST',`/courses/${course.id}/students`,{username,name:suffix},201)
    users.push(await call(null,'POST','/auth/login',{username,password:'123456'}))
  }
  const [student,member,other]=users
  const assignment=await call(teacher,'POST',`/courses/${course.id}/assignments`,{
    title:'真实学生作业',type:online?'online':'document',status:group?'draft':'published',work_mode:group?'group':'individual',
    total_score:100,allow_resubmit_count:0,max_file_mb:20,require_preview_image:!online&&preview,preview_max_count:2,
  },201)
  if(group){
    const team=await call(teacher,'POST',`/courses/${course.id}/groups`,{name:'甲组',member_ids:[student.user.id,member.user.id],leader_id:student.user.id},201)
    await call(teacher,'POST',`/assignments/${assignment.id}/groups/snapshot`,{group_ids:[team.id]})
    await call(teacher,'POST',`/assignments/${assignment.id}/publish`)
  }
  await call(teacher,'PUT',`/courses/${course.id}/grade-config`,{daily_ratio:100,final_ratio:0,grade_absent_mode:'zero',final_assignment_id:null,weights:[{assignment_id:assignment.id,grade_weight:100}]})
  useActor(student)
  return {teacher,student,member,other,course,assignment}
}
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==','base64')
async function studentPage(f,actor=f.student){
  useActor(actor)
  const view=await mountView('views/student/StudentSubmit.vue',{resetStorage:false,route:{params:{id:String(f.assignment.id)}}})
  await waitFor(()=>nodes(view.root,'h1').some(n=>textOf(n)==='真实学生作业'))
  return view
}
async function teacherPage(f){
  useActor(f.teacher)
  const view=await mountView('views/teacher/SubmissionsView.vue',{resetStorage:false,route:{params:{id:String(f.assignment.id)}}})
  await waitFor(()=>nodes(view.root,'el-button').some(n=>textOf(n).trim()==='评分'))
  return view
}
async function download(actor,url){
  const response=await fetch(base+url,{headers:{Authorization:'Bearer '+actor.token}})
  assert.equal(response.status,200)
  return Buffer.from(await response.arrayBuffer())
}
for(const group of [false,true])test(`${group?'小组':'个人'}学生页面→分片源文件及预览→教师批改→汇总导出→退回重交`,async()=>{
  const f=await fixture({group})
  let view=await studentPage(f)
  const content=Buffer.concat([Buffer.alloc(8*1024*1024,65),Buffer.from('student-file-tail')])
  await input(nodes(view.root,'FileDropZone')[0],new File([content],'answer.zip',{lastModified:1}))
  await input(nodes(view.root,'PreviewImagePicker')[0],[new File([PNG],'preview.png',{type:'image/png'})])
  await click(button(view,'确认提交'))
  assert.ok(nodes(view.root,'el-dialog').some(n=>n.props.title==='提交成功'))
  assert.match(textOf(view.root),/回执编号/)
  const saved=await call(f.student,'GET',`/assignments/${f.assignment.id}/my-submission`)
  assert.equal(saved.submit_count,1)
  assert.match(textOf(view.root), /1 张/)
  const apiBase=saved.api_base
  assert.ok(apiBase.startsWith(group?'/group-submissions/':'/submissions/'))
  assert.deepEqual(await download(f.student,apiBase+'/file'),content)
  const receipts=await call(f.student,'GET',apiBase+'/receipts')
  assert.equal(receipts.length,1)
  assert.equal(receipts[0].snapshot.preview_count,1)
  const history=await call(f.student,'GET',apiBase+'/history')
  const previews=await call(f.student,'GET',`/${group?'group-submission-history':'submission-history'}/${history[0].id}/previews`)
  assert.equal(previews.length,1)
  assert.deepEqual(await download(f.student,previews[0].file_url.replace(/^\/api/,'')),PNG)
  view.dispose()
  if(group){
    const peer=await call(f.member,'GET',`/assignments/${f.assignment.id}/my-submission`)
    assert.equal(peer.id,saved.id)
    assert.deepEqual(await download(f.member,apiBase+'/file'),content)
    await call(f.other,'GET',apiBase+'/receipts',undefined,403)
    const denied=await studentPage(f,f.member)
    assert.equal(button(denied,'确认提交').props.disabled,true)
    denied.dispose()
    await call(f.member,'POST','/upload-sessions',{kind:'submission',assignment_id:f.assignment.id,files:[{client_id:'source',role:'source',name:'bad.zip',size:1}]},403)
  }
  view=await teacherPage(f)
  await click(button(view,'评分'))
  await input(nodes(view.root,'el-input-number')[0],88)
  await input(nodes(view.root,'el-input').find(n=>n.props.type==='textarea'),'教师私密评语')
  await click(button(view,'确认'))
  assert.equal(nodes(view.root,'el-table')[0].props.data.find(r=>r.id===saved.id).score,88)
  view.dispose()
  const safe=await call(f.student,'GET',`/assignments/${f.assignment.id}/my-submission`)
  assert.equal(safe.status,'graded')
  assert.equal(Object.hasOwn(safe,'score'),false)
  assert.equal(Object.hasOwn(safe,'comment'),false)
  useActor(f.teacher)
  const summary=await mountView('components/CourseSummary.vue',{resetStorage:false,props:{courseId:f.course.id,courseName:f.course.name}})
  await waitFor(()=>nodes(summary.root,'b').some(n=>n.props.class==='total'&&textOf(n)==='88.0'))
  await click(button(summary,'导出成绩表'))
  assert.equal(summary.downloads.length,1)
  assert.equal(summary.downloads[0][1],f.course.name+'-成绩汇总.xlsx')
  const book=new ExcelJS.Workbook()
  await book.xlsx.load(await download(f.teacher,`/courses/${f.course.id}/summary/export`))
  const rows=book.getWorksheet('成绩汇总').getSheetValues().slice(2)
  assert.equal(rows.find(r=>r[2]===f.student.user.username)[5],88)
  if(group)assert.equal(rows.find(r=>r[2]===f.member.user.username)[5],88)
  summary.dispose()
  view=await teacherPage(f)
  await click(button(view,'退回'))
  await input(nodes(view.root,'el-input').find(n=>n.props.type==='textarea'),'请补充说明')
  await click(button(view,'确认'))
  view.dispose()
  view=await studentPage(f)
  assert.ok(nodes(view.root,'el-alert').some(n=>n.props.description==='请补充说明'))
  await input(nodes(view.root,'FileDropZone')[0],new File(['revised'],'answer.zip',{lastModified:2}))
  await input(nodes(view.root,'PreviewImagePicker')[0],[new File([PNG],'preview.png',{type:'image/png'})])
  await click(button(view,'确认提交'))
  const revised=await call(f.student,'GET',`/assignments/${f.assignment.id}/my-submission`)
  assert.equal(revised.submit_count,2)
  assert.equal(revised.status,'submitted')
  assert.deepEqual(await download(f.student,apiBase+'/file'),Buffer.from('revised'))
  assert.equal((await call(f.student,'GET',apiBase+'/receipts')).length,2)
  assert.equal(button(view,'确认提交').props.disabled,true)
  view.dispose()
})

test('在线作答页面通过真实普通提交接口保存答案、回执和历史',async()=>{
  const f=await fixture({online:true})
  const view=await studentPage(f)
  await input(nodes(view.root,'el-input')[0],'在线学生的完整答案')
  await click(button(view,'确认提交'))
  assert.ok(nodes(view.root,'el-dialog').some(n=>n.props.title==='提交成功'))
  const saved=await call(f.student,'GET',`/assignments/${f.assignment.id}/my-submission`)
  assert.equal(saved.content,'在线学生的完整答案')
  assert.equal((await call(f.student,'GET',saved.api_base+'/history'))[0].content,saved.content)
  assert.equal((await call(f.student,'GET',saved.api_base+'/receipts')).length,1)
  assert.equal((await download(f.student,saved.api_base+'/file')).toString(),saved.content)
  view.dispose()
})

test('学生分片协议：会话越权、错误摘要和缺片完成被拒绝，取消清理真实文件',async()=>{
  const f=await fixture({preview:false})
  const session=await call(f.student,'POST','/upload-sessions',{kind:'submission',assignment_id:f.assignment.id,files:[{client_id:'source',role:'source',name:'answer.zip',size:6}]},201)
  await call(f.other,'GET','/upload-sessions/'+session.id,undefined,404)
  await call(f.other,'DELETE','/upload-sessions/'+session.id,undefined,404)
  const file=session.files[0]
  const chunk=async(actor,hash)=>fetch(base+`/upload-sessions/${session.id}/files/${file.id}/chunk`,{method:'PUT',headers:{Authorization:'Bearer '+actor.token,'Content-Type':'application/octet-stream','Content-Range':'bytes 0-2/6','X-Chunk-SHA256':hash},body:'abc'})
  const digest=createHash('sha256').update('abc').digest('hex')
  assert.equal((await chunk(f.other,digest)).status,404)
  assert.equal((await chunk(f.student,'0'.repeat(64))).status,400)
  assert.equal((await call(f.student,'GET','/upload-sessions/'+session.id)).files[0].uploaded_bytes,0)
  assert.equal((await chunk(f.student,digest)).status,200)
  await call(f.student,'POST',`/upload-sessions/${session.id}/complete`,{},409)
  assert.equal(db.prepare('SELECT count(*) n FROM submissions WHERE assignment_id=?').get(f.assignment.id).n,0)
  const stored=db.prepare('SELECT temporary_path FROM upload_session_files WHERE id=?').get(file.id)
  const physical=resolveUploadPath(stored.temporary_path)
  assert.equal(fs.readFileSync(physical,'utf8'),'abc')
  await call(f.student,'DELETE','/upload-sessions/'+session.id)
  processCleanupBatch()
  assert.equal(fs.existsSync(physical),false)
  assert.equal(db.prepare('SELECT count(*) n FROM upload_session_files WHERE session_id=?').get(session.id).n,0)
  assert.equal(db.prepare('SELECT count(*) n FROM submission_receipts WHERE assignment_id=?').get(f.assignment.id).n,0)
})

test('学生上传完成响应丢失：重新查询回执，不重复提交或消耗次数',async()=>{
  const f=await fixture({preview:false})
  const scope=effectScope(), transfer=scope.run(()=>useChunkedUpload())
  const originalPost=api.post
  let completes=0
  api.post=async function(url,...args){
    const response=await originalPost.call(this,url,...args)
    if(url.endsWith('/complete')&&++completes===1)throw Error('模拟完成响应丢失')
    return response
  }
  try{
    const args={kind:'submission',target:{assignment_id:f.assignment.id},files:[{role:'source',file:new File(['once'],'once.zip',{lastModified:1})}]}
    await assert.rejects(transfer.run(args),/模拟完成响应丢失/)
    const result=await transfer.run(args)
    assert.equal(result.submit_count,1)
    assert.equal(completes,1)
    assert.equal((await call(f.student,'GET',result.api_base+'/receipts')).length,1)
    assert.equal(db.prepare('SELECT submit_count FROM submissions WHERE assignment_id=?').get(f.assignment.id).submit_count,1)
  }finally{api.post=originalPost;scope.stop()}
})

test('学生提交页：首片落盘暂停，点击继续上传从断点完成',async()=>{
  const f=await fixture({preview:false})
  const view=await studentPage(f)
  const size=8*1024*1024, bytes=Buffer.concat([Buffer.alloc(size,67),Buffer.from('resume-tail')])
  await input(nodes(view.root,'FileDropZone')[0],new File([bytes],'resume.zip',{lastModified:1}))
  const originalPut=api.put, ranges=[]
  api.put=async function(url,data,config){
    const response=await originalPut.call(this,url,data,config)
    if(url.endsWith('/chunk')){
      ranges.push(config.headers['Content-Range'])
      if(ranges.length===1)await click(button(view,'暂停'))
    }
    return response
  }
  try{
    await click(button(view,'确认提交'))
    assert.equal(db.prepare('SELECT count(*) n FROM submissions WHERE assignment_id=?').get(f.assignment.id).n,0)
    const file=db.prepare('SELECT f.* FROM upload_session_files f JOIN upload_sessions s ON s.id=f.session_id WHERE s.assignment_id=?').get(f.assignment.id)
    assert.equal(file.uploaded_bytes,size)
    assert.equal(fs.statSync(resolveUploadPath(file.temporary_path)).size,size)
    await click(button(view,'继续上传'))
    assert.deepEqual(ranges,[`bytes 0-${size-1}/${bytes.length}`,`bytes ${size}-${bytes.length-1}/${bytes.length}`])
    const saved=await call(f.student,'GET',`/assignments/${f.assignment.id}/my-submission`)
    assert.equal(saved.submit_count,1)
    assert.deepEqual(await download(f.student,saved.api_base+'/file'),bytes)
    assert.ok(nodes(view.root,'el-dialog').some(n=>n.props.title==='提交成功'))
  }finally{api.put=originalPut;view.dispose()}
})
