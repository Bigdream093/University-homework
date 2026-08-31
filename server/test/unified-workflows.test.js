import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import ExcelJS from 'exceljs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mohen-unified-'));
process.env.NODE_ENV='test';process.env.TZ='UTC';process.env.JWT_SECRET='isolated-test-secret';process.env.DATA_DIR=dir;process.env.UPLOAD_DIR=path.join(dir,'uploads');
const {app}=await import('../src/index.js');
const {db}=await import('../src/db.js');
const {nowText,isLate,validTime}=await import('../src/utils/time.js');
const {publishDueNotices}=await import('../src/services/noticeService.js');
const {recoverOperations}=await import('../src/services/operations.js');
const {quarantineOrphans}=await import('../src/services/storage.js');
after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
const tokens={};
async function login(name){if(!tokens[name]){const r=await request(app).post('/api/auth/login').send({username:name,password:'123456'});assert.equal(r.status,200,r.text);tokens[name]=r.body.token;}return tokens[name];}
async function call(name,method,url,body,status=200){const r=await request(app)[method]('/api'+url).set('Authorization','Bearer '+await login(name)).send(body);assert.equal(r.status,status,method+' '+url+': '+r.text);return r.body;}
let sequence=0;
async function fixture(){
 const c=await call('teacher','post','/courses',{name:'统一测试'+(++sequence)},201);
 for(const n of ['alice','bob','cara'])await call('teacher','post','/courses/'+c.id+'/students',{username:n,name:n+'同学'},201);
 return {c,alice:db.prepare("SELECT id FROM users WHERE username='alice'").get().id,bob:db.prepare("SELECT id FROM users WHERE username='bob'").get().id,cara:db.prepare("SELECT id FROM users WHERE username='cara'").get().id};
}
async function assignment(c,body={}){return call('teacher','post','/courses/'+c.id+'/assignments',{title:'测试作业',type:'online',status:'published',allow_resubmit_count:-1,deadline:'2099-01-01 00:00:00',...body},201);}
async function submit(name,a,key,content='答案',base=0){return request(app).post('/api/assignments/'+a.id+'/submit').set('Authorization','Bearer '+await login(name)).set('Idempotency-Key',key).send({content,base_version:base});}
async function groupFixture(){
 const f=await fixture(),g=await call('teacher','post','/courses/'+f.c.id+'/groups',{name:'甲组',member_ids:[f.alice,f.bob],leader_id:f.alice},201);
 const a=await assignment(f.c,{work_mode:'group',status:'draft'});
 await call('teacher','post','/assignments/'+a.id+'/groups/snapshot',{group_ids:[g.id]});
 await call('teacher','post','/assignments/'+a.id+'/publish');
 return {...f,g,a};
}
test('F01 complete downloads count atomically; HEAD, Range, teacher and failed reads do not',async()=>{
 const {c}=await fixture(),token=await login('teacher'),student=await login('alice');
 const r=await request(app).post('/api/courses/'+c.id+'/materials').set('Authorization','Bearer '+token).set('Idempotency-Key','material-count-key').field('title','视频').attach('file',Buffer.from('0123456789'),{filename:'video.mp4'});assert.equal(r.status,201,r.text);
 const url='/api/materials/'+r.body.id+'/file';
 await request(app).head(url).set('Authorization','Bearer '+student).expect(200);
 await request(app).get(url).set('Authorization','Bearer '+student).set('Range','bytes=0-2').expect(206);
 await request(app).get(url).set('Authorization','Bearer '+token).expect(200);
 assert.equal((await call('alice','get','/courses/'+c.id+'/materials'))[0].download_count,0);
 await Promise.all([request(app).get(url).set('Authorization','Bearer '+student).expect(200),request(app).get(url).set('Authorization','Bearer '+student).expect(200)]);
 assert.equal((await call('alice','get','/courses/'+c.id+'/materials'))[0].download_count,2);
 const list=await call('teacher','get','/materials/'+r.body.id+'/downloads');assert.equal(list.length,1);assert.equal(list[0].username,'alice');assert.equal(list[0].download_count,2);
 await call('alice','get','/materials/'+r.body.id+'/downloads',undefined,403);
});
test('F02/F04 notice detail, versioned reads, irreversible publication and withdrawal tombstone',async()=>{
 const {c}=await fixture(),n=await call('teacher','post','/courses/'+c.id+'/notices',{title:'正式通知',content:'正文'.repeat(200),status:'published'},201);
 const preview=(await call('alice','get','/courses/'+c.id+'/notices'))[0];assert.equal(preview.content,undefined);assert.ok(preview.content_preview.length<=160);
 await call('alice','get','/notices/'+n.id);assert.equal(db.prepare('SELECT count(*) n FROM notice_reads WHERE notice_id=?').get(n.id).n,0);
 await call('alice','post','/notices/'+n.id+'/read',{revision:1});await call('alice','post','/notices/'+n.id+'/read',{revision:1});
 assert.equal((await call('teacher','get','/notices/'+n.id+'/readers')).length,1);
 const changed=await call('teacher','put','/notices/'+n.id,{content:'新版内容'});assert.equal(changed.content_revision,2);
 assert.equal((await call('alice','get','/my/courses')).find(x=>x.id===c.id).unread_notice_count,1);
 await call('alice','post','/notices/'+n.id+'/read',{revision:1});
 assert.equal((await call('alice','get','/courses/'+c.id+'/notices'))[0].is_updated,true);
 await call('teacher','put','/notices/'+n.id,{status:'draft'},400);
 await call('teacher','put','/notices/'+n.id,{status:'scheduled',scheduled_at:'2099-01-01 00:00:00'},400);
 await call('teacher','delete','/notices/'+n.id,undefined,400);
 await call('teacher','post','/notices/'+n.id+'/withdraw',{reason:'误发私人说明'});
 const tombstone=await call('alice','get','/notices/'+n.id);assert.equal(tombstone.content,undefined);assert.equal(tombstone.withdrawn_reason,undefined);
 assert.equal((await call('alice','get','/my/courses')).find(x=>x.id===c.id).unread_notice_count,0);
 const history=await call('teacher','get','/notices/'+n.id);assert.equal(history.published_at,n.published_at);assert.equal(history.revisions.length,2);
 assert.equal((await call('teacher','get','/notices/'+n.id+'/readers')).length,1);
 await call('teacher','put','/notices/'+n.id,{status:'published'},409);
 await call('alice','post','/notices/'+n.id+'/read',{},409);
});
test('F08 scheduling catchup is bounded, idempotent and preserves intended time after editing',async()=>{
 const {c}=await fixture();
 const n=await call('teacher','post','/courses/'+c.id+'/notices',{title:'预约',content:'正文',status:'scheduled',scheduled_at:'2099-01-01 00:00:00'},201);
 await call('alice','get','/notices/'+n.id,undefined,404);
 const scheduled='2020-01-01 00:00:00';db.prepare('UPDATE notices SET scheduled_at=? WHERE id=?').run(scheduled,n.id);
 assert.equal(publishDueNotices(),1);assert.equal(publishDueNotices(),0);
 const changed=await call('teacher','put','/notices/'+n.id,{content:'修订'});assert.equal(changed.scheduled_at,scheduled);
 const before=changed.published_at;publishDueNotices();assert.equal(db.prepare('SELECT published_at FROM notices WHERE id=?').get(n.id).published_at,before);
 const add=db.prepare("INSERT INTO notices(course_id,teacher_id,title,status,scheduled_at,created_at,updated_at) VALUES(?,?,'批量','scheduled',?,?,?)");
 for(let i=0;i<105;i++)add.run(c.id,c.teacher_id,scheduled,nowText(),nowText());
 assert.equal(publishDueNotices(),100);assert.equal(publishDueNotices(),5);assert.equal(publishDueNotices(),0);
});
test('F09 private original/replies never leak through opt-in; public summary retracts on privacy tightening',async()=>{
 const {c}=await fixture(),q=await call('alice','post','/courses/'+c.id+'/questions',{title:'私人原题',content:'私人健康情况',must_private:false},201);
 assert.equal((await call('bob','get','/courses/'+c.id+'/questions')).length,0);
 await call('bob','get','/questions/'+q.id,undefined,404);
 await call('teacher','post','/questions/'+q.id+'/replies',{content:'私人答复'},201);
 await call('teacher','post','/questions/'+q.id+'/publish',{summary:'公开学习问题',reply:'公开说明'},201);
 const pub=await call('bob','get','/courses/'+c.id+'/questions/public');assert.equal(pub.length,1);assert.ok(!JSON.stringify(pub).includes('私人'));
 await call('alice','post','/questions/'+q.id+'/replies',{content:'新的秘密追问'},201);
 assert.ok(!JSON.stringify(await call('bob','get','/courses/'+c.id+'/questions/public')).includes('秘密'));
 await call('alice','put','/questions/'+q.id,{title:'改写',content:'改写'},409);
 await call('teacher','post','/courses/'+c.id+'/archive');
 await call('alice','put','/questions/'+q.id+'/privacy',{must_private:true});
 assert.equal((await call('bob','get','/courses/'+c.id+'/questions/public')).length,0);
 await call('alice','put','/questions/'+q.id+'/privacy',{must_private:false},409);
 await call('teacher','post','/courses/'+c.id+'/restore');
 await call('teacher','post','/questions/'+q.id+'/publish',{summary:'强制公开',reply:'不可以'},400);
 await call('teacher','delete','/courses/'+c.id+'/students/'+db.prepare("SELECT id FROM users WHERE username='alice'").get().id);
 await call('alice','get','/questions/'+q.id,undefined,403);
});
test('F06/F07/F10 retry keeps grade/count/receipt, actual bytes fingerprint, extension only changes future submissions',async()=>{
 const {c}=await fixture(),a=await assignment(c,{deadline:'2020-01-01 00:00:00'});
 const first=await submit('alice',a,'receipt-test-key');assert.equal(first.status,201,first.text);assert.equal(first.body.is_late,1);assert.equal(first.body.file_url,undefined);
 await call('teacher','post',first.body.api_base+'/grade',{score:90,comment:'教师私密评语'});
 const repeated=await submit('alice',a,'receipt-test-key');assert.equal(repeated.status,200,repeated.text);
 assert.equal(db.prepare('SELECT score,submit_count FROM submissions WHERE id=?').get(first.body.id).score,90);
 assert.equal((await call('alice','get',first.body.api_base+'/receipts')).length,1);
 const changed=await submit('alice',a,'receipt-test-key','不同内容');assert.equal(changed.status,409);
 const e=await call('alice','post','/assignments/'+a.id+'/extensions',{reason:'私人延期理由',requested_deadline:'2099-01-01 00:00:00'},201);
 await call('alice','post','/assignments/'+a.id+'/extensions',{reason:'重复',requested_deadline:'2099-01-02 00:00:00'},409);
 await call('teacher','post','/extensions/'+e.id+'/decision',{status:'approved',approved_deadline:'2099-01-01 00:00:00'});
 await call('alice','post','/extensions/'+e.id+'/withdraw',{},409);
 const second=await submit('alice',a,'receipt-second-key','第二次答案');assert.equal(second.status,201,second.text);assert.equal(second.body.is_late,0);
 const r=await call('alice','get',first.body.api_base+'/receipts');assert.equal(r.length,2);assert.equal(r[1].snapshot.is_late,true);assert.equal(r[0].snapshot.extension.id,e.id);
 assert.equal((await call('alice','get','/assignments/'+a.id+'/my-submission')).score,undefined);
 await call('teacher','delete','/courses/'+c.id+'/students/'+db.prepare("SELECT id FROM users WHERE username='alice'").get().id);
 for(const url of [first.body.api_base+'/file',first.body.api_base+'/history',first.body.api_base+'/receipts','/assignments/'+a.id+'/extensions','/assignments/'+a.id+'/my-submission'])await call('alice','get',url,undefined,403);
 assert.equal((await call('teacher','get',first.body.api_base+'/receipts')).length,2);
});
test('F10 concurrent same key saves once; changed file bytes conflict and no failed-upload residue',async()=>{
 const {c}=await fixture(),a=await assignment(c),token=await login('alice');
 const upload=(key,data)=>request(app).post('/api/assignments/'+a.id+'/submit').set('Authorization','Bearer '+token).set('Idempotency-Key',key).attach('file',Buffer.from(data),{filename:'answer.txt'});
 const results=await Promise.all([upload('concurrent-key','AAA'),upload('concurrent-key','AAA')]);assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);
 const conflict=await upload('concurrent-key','BBB');assert.equal(conflict.status,409,conflict.text);
 const unsupported=await request(app).post('/api/assignments/'+a.id+'/submit').set('Authorization','Bearer '+token).attach('file',Buffer.from('blocked'),{filename:'program.exe'});assert.equal(unsupported.status,400);assert.match(unsupported.body.message,/不支持/);
 const row=db.prepare('SELECT * FROM submissions WHERE assignment_id=?').get(a.id);assert.equal(row.submit_count,1);
 assert.equal(fs.readdirSync(path.join(process.env.UPLOAD_DIR,'.staging')).length,0);
 const next=await upload('second-file-key','CCC');assert.equal(next.status,201,next.text);assert.equal(fs.existsSync(row.file_url),false);
 const receipts=await call('alice','get','/submissions/'+row.id+'/receipts');assert.equal(receipts[1].snapshot.file_state,'available');assert.equal(receipts[1].current_file_state,'replaced');
});
test('F11 snapshot required, group permission, member reads, version conflict, privacy, frozen export',async()=>{
 const f=await groupFixture(),{a,c,alice,bob,cara,g}=f;
 const empty=await assignment(c,{work_mode:'group',status:'draft'});
 await call('teacher','post','/assignments/'+empty.id+'/publish',{},400);
 const denied=await submit('bob',a,'group-denied-key');assert.equal(denied.status,403);
 const first=await submit('alice',a,'group-success-key');assert.equal(first.status,201,first.text);
 const member=await call('bob','get','/assignments/'+a.id+'/my-submission');assert.equal(member.id,first.body.id);assert.equal(member.can_submit,false);
 assert.equal((await call('bob','get',member.api_base+'/receipts')).length,1);
 await call('cara','get',member.api_base+'/file',undefined,403);
 await call('teacher','put','/assignments/'+a.id,{group_submit_policy:'any'});
 const responses=await Promise.all([submit('alice',a,'group-race-alice','甲',1),submit('bob',a,'group-race-bob','乙',1)]);
 assert.deepEqual(responses.map(r=>r.status).sort(),[201,409]);
 const e=await call('alice','post','/assignments/'+a.id+'/extensions',{reason:'保密延期原因',requested_deadline:'2099-02-01 00:00:00'},201);
 const other=await call('bob','get','/assignments/'+a.id+'/extensions');assert.equal(other[0].reason,undefined);
 await call('teacher','post','/extensions/'+e.id+'/decision',{status:'approved'});
 assert.equal((await call('bob','get','/assignments/'+a.id+'/submission-context')).effective_deadline,'2099-02-01 00:00:00');
 await call('teacher','put','/groups/'+g.id,{name:'新模板名',member_ids:[alice,cara],leader_id:alice});
 assert.equal((await call('teacher','get','/assignments/'+a.id+'/groups'))[0].members.some(m=>m.id===bob),true);
 await call('teacher','post',member.api_base+'/grade',{score:88,comment:'共享教师评语'});
 await call('teacher','delete','/courses/'+c.id+'/students/'+bob);
 await call('bob','get',member.api_base+'/receipts',undefined,403);
 const excel=await request(app).get('/api/assignments/'+a.id+'/export').set('Authorization','Bearer '+await login('teacher')).buffer(true).parse((r,cb)=>{const chunks=[];r.on('data',c=>chunks.push(c));r.on('end',()=>cb(null,Buffer.concat(chunks)));});
 assert.equal(excel.status,200);const book=new ExcelJS.Workbook();await book.xlsx.load(excel.body);const json=JSON.stringify(book.worksheets[0].getSheetValues());assert.ok(json.includes('bob'));assert.ok(json.includes('88'));assert.ok(json.includes('未安排'));
 const rows=await call('teacher','get','/assignments/'+a.id+'/submissions');assert.equal(rows.length,1);assert.equal(rows[0].members.length,2);assert.equal(rows[0].submit_count,2);
});
test('F05 archive blocks mutations and invites, cancels pending work, reads remain; copying resets independent data',async()=>{
 const {c,alice}=await fixture(),a=await assignment(c),e=await call('alice','post','/assignments/'+a.id+'/extensions',{reason:'待处理',requested_deadline:'2099-02-01 00:00:00'},201);
 const n=await call('teacher','post','/courses/'+c.id+'/notices',{title:'排期',status:'scheduled',scheduled_at:'2099-01-01 00:00:00'},201);
 await call('teacher','post','/courses/'+c.id+'/archive');
 for(const [method,url,body]of [['post','/courses/'+c.id+'/students',{username:'new',name:'新'}],['post','/courses/'+c.id+'/assignments',{title:'新'}],['put','/assignments/'+a.id,{title:'新'}],['post','/courses/'+c.id+'/groups',{name:'组',member_ids:[alice],leader_id:alice}],['delete','/courses/'+c.id],['get','/courses/'+c.id+'/invite-code']])await call('teacher',method,url,body,409);
 assert.equal((await call('teacher','get','/courses/'+c.id)).invite_code,null);
 assert.equal((await call('alice','get','/assignments/'+a.id+'/extensions'))[0].status,'cancelled');
 const draft=await call('teacher','get','/notices/'+n.id);assert.equal(draft.status,'draft');assert.equal(draft.scheduled_at,null);
 await call('alice','post','/courses/join',{invite_code:c.invite_code},400);
 const copy=await request(app).post('/api/courses/'+c.id+'/copy').set('Authorization','Bearer '+await login('teacher')).set('Idempotency-Key','copy-once-key').send({name:'副本'});
 assert.equal(copy.status,201,copy.text);
 const again=await request(app).post('/api/courses/'+c.id+'/copy').set('Authorization','Bearer '+await login('teacher')).set('Idempotency-Key','copy-once-key').send({name:'副本'});assert.equal(again.status,200);assert.equal(again.body.id,copy.body.id);
 const as=await call('teacher','get','/courses/'+copy.body.id+'/assignments');assert.equal(as[0].status,'draft');assert.equal(as[0].deadline,null);assert.equal((await call('teacher','get','/courses/'+copy.body.id+'/students')).length,0);
});
test('F12 help role checks apply to search, direct chapters and downloads; public help is minimal',async()=>{
 const pub=await request(app).get('/api/help/public');assert.equal(pub.status,200);assert.equal(pub.body.length,1);
 const student=await call('alice','get','/help');assert.ok(student.some(x=>x.body.includes('回执')));assert.ok(!JSON.stringify(student).includes('docker compose'));
 await call('alice','get','/help/maintenance',undefined,404);
 assert.deepEqual(await call('alice','get','/help?q=docker'),[]);
 const teacher=await call('teacher','get','/help/maintenance');assert.ok(teacher.body.includes('docker compose'));
 const dl=await request(app).get('/api/help/download').set('Authorization','Bearer '+await login('alice'));assert.equal(dl.status,200);assert.ok(!dl.text.includes('JWT_SECRET'));assert.ok(dl.text.includes('私人问答'));
});
test('time boundaries, interrupted requests recover and unknown files quarantine without deleting referenced files',()=>{
 assert.equal(isLate('2026-08-31 12:00:00','2026-08-31 12:00:00'),0);
 assert.equal(isLate('2026-08-31 12:00:00','2026-08-31 12:00:01'),1);
 assert.equal(validTime('2026-02-30 12:00:00'),false);
 const at=nowText(),china=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date());assert.equal(at.slice(0,16),china.slice(0,16));
 const stage=path.join(process.env.UPLOAD_DIR,'interrupted.txt');fs.writeFileSync(stage,'partial');
 db.prepare("INSERT INTO operation_requests(actor_id,kind,target_id,request_id,state,file_path,owner,created_at,updated_at) VALUES(1,'submission',999,'crash-test','processing',?,'previous-process',?,?)").run(stage,at,at);
 recoverOperations();assert.equal(db.prepare("SELECT state FROM operation_requests WHERE request_id='crash-test'").get().state,'failed');assert.equal(fs.existsSync(stage),false);
 const unknown=path.join(process.env.UPLOAD_DIR,'legacy-orphan.txt');fs.writeFileSync(unknown,'preserve');fs.utimesSync(unknown,new Date('2020-01-01'),new Date('2020-01-01'));
 const refs=db.prepare("SELECT file_url FROM submission_history WHERE file_state='available'").all().map(x=>x.file_url).filter(Boolean);
 const result=quarantineOrphans();assert.ok(result.quarantined>=1);assert.equal(result.retention_days,30);
 assert.ok(refs.every(p=>fs.existsSync(p)));const q=db.prepare('SELECT quarantine_path FROM storage_quarantine WHERE original_path=?').get(unknown);assert.equal(fs.readFileSync(q.quarantine_path,'utf8'),'preserve');
});

test('copying uses independent physical files and failure rolls back course and all copied attachments',async()=>{
 const {c}=await fixture(),token=await login('teacher');
 for(const title of ['资料一','资料二']){
 const r=await request(app).post('/api/courses/'+c.id+'/materials').set('Authorization','Bearer '+token).field('title',title).attach('file',Buffer.from(title),{filename:'notes.txt'});assert.equal(r.status,201,r.text);
 }
 const copy=await request(app).post('/api/courses/'+c.id+'/copy').set('Authorization','Bearer '+token).set('Idempotency-Key','copy-materials-key').send({name:'独立副本'});assert.equal(copy.status,201,copy.text);
 const original=db.prepare('SELECT * FROM materials WHERE course_id=? ORDER BY id').all(c.id),cloned=db.prepare('SELECT * FROM materials WHERE course_id=? ORDER BY id').all(copy.body.id);
 assert.equal(cloned.length,2);assert.notEqual(original[0].file_url,cloned[0].file_url);assert.equal(fs.readFileSync(cloned[0].file_url,'utf8'),'资料一');
 await call('teacher','delete','/materials/'+original[0].id);assert.equal(fs.readFileSync(cloned[0].file_url,'utf8'),'资料一');
 const count=db.prepare('SELECT count(*) n FROM courses').get().n;
 const realCopy=fs.copyFileSync;let calls=0;
 fs.copyFileSync=(...args)=>{calls++;if(calls===2)throw new Error('simulated disk failure');return realCopy(...args);};
 try{
 const failed=await request(app).post('/api/courses/'+copy.body.id+'/copy').set('Authorization','Bearer '+token).set('Idempotency-Key','copy-failure-key').send({name:'不应留下半成品'});
 assert.equal(failed.status,500);assert.equal(db.prepare('SELECT count(*) n FROM courses').get().n,count);
 assert.equal(db.prepare("SELECT state FROM operation_requests WHERE request_id='copy-failure-key'").get().state,'failed');
 }finally{fs.copyFileSync=realCopy;}
});
test('failed receipt transaction preserves old file, grade and attempt count; concurrent final attempt admits one',async()=>{
 const {c}=await fixture(),a=await assignment(c),token=await login('alice');
 const upload=(key,value)=>request(app).post('/api/assignments/'+a.id+'/submit').set('Authorization','Bearer '+token).set('Idempotency-Key',key).attach('file',Buffer.from(value),{filename:'answer.txt'});
 const first=await upload('rollback-original','original');assert.equal(first.status,201);
 await call('teacher','post',first.body.api_base+'/grade',{score:99,comment:'保留'});
 const old=db.prepare('SELECT * FROM submissions WHERE id=?').get(first.body.id);
 db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON submission_receipts BEGIN SELECT RAISE(ABORT,'test receipt failure'); END");
 try{const failed=await upload('rollback-failure','new');assert.equal(failed.status,500);const row=db.prepare('SELECT * FROM submissions WHERE id=?').get(first.body.id);assert.deepEqual(row,old);assert.equal(fs.readFileSync(old.file_url,'utf8'),'original');}
 finally{db.exec('DROP TRIGGER reject_receipt');}
 const final=await assignment(c,{allow_resubmit_count:0});
 const race=await Promise.all([submit('alice',final,'final-attempt-one'),submit('alice',final,'final-attempt-two')]);
 assert.deepEqual(race.map(r=>r.status).sort(),[201,400]);assert.equal(db.prepare('SELECT submit_count FROM submissions WHERE assignment_id=?').get(final.id).submit_count,1);
});
test('group empty rows retain members; group package includes each available history only once; archive denies grading',async()=>{
 const {a,c}=await groupFixture();
 const before=await call('teacher','get','/assignments/'+a.id+'/submissions');assert.equal(before.length,1);assert.equal(before[0].members.length,2);assert.equal(before[0].id,null);
 await call('teacher','put','/assignments/'+a.id,{submission_mode:'append'});
 const first=await submit('alice',a,'group-package-one','first');assert.equal(first.status,201,first.text);
 const second=await submit('alice',a,'group-package-two','second',1);assert.equal(second.status,201,second.text);
 const zip=await request(app).get('/api/assignments/'+a.id+'/package').set('Authorization','Bearer '+await login('teacher')).buffer(true).parse((r,cb)=>{const list=[];r.on('data',c=>list.push(c));r.on('end',()=>cb(null,Buffer.concat(list)));});
 assert.equal(zip.status,200);let end=-1;for(let i=zip.body.length-22;i>=0;i--)if(zip.body.readUInt32LE(i)===0x06054b50){end=i;break;}assert.ok(end>=0);assert.equal(zip.body.readUInt16LE(end+10),2);
 await call('teacher','post','/courses/'+c.id+'/archive');
 await call('teacher','post',first.body.api_base+'/grade',{score:20},409);await call('teacher','post',first.body.api_base+'/return',{returned_reason:'不能退回'},409);
 assert.equal((await call('bob','get',first.body.api_base+'/receipts')).length,2);
});
test('closing keeps pending extensions rejectable but not approvable; document assignments require a file',async()=>{
 const {c}=await fixture();
 const doc=await call('teacher','post','/courses/'+c.id+'/assignments',{title:'文件作业',type:'document',status:'published',allow_resubmit_count:-1,deadline:'2099-01-01 00:00:00'},201);
 const textOnly=await submit('alice',doc,'doc-text-only');assert.equal(textOnly.status,400,textOnly.text);
 const withFile=await request(app).post('/api/assignments/'+doc.id+'/submit').set('Authorization','Bearer '+await login('alice')).set('Idempotency-Key','doc-file-key').attach('file',Buffer.from('ok'),{filename:'答案.pdf'});
 assert.equal(withFile.status,201,withFile.text);
 const a=await assignment(c);
 const e=await call('alice','post','/assignments/'+a.id+'/extensions',{reason:'关闭前申请',requested_deadline:'2099-03-01 00:00:00'},201);
 await call('teacher','post','/assignments/'+a.id+'/close');
 await call('teacher','post','/extensions/'+e.id+'/decision',{status:'approved'},409);
 await call('teacher','post','/extensions/'+e.id+'/decision',{status:'rejected',decision_reason:'已截止，请下学期重新申请'});
 assert.equal((await call('alice','get','/assignments/'+a.id+'/extensions'))[0].status,'rejected');
});
test('teacher material retries preserve one row and replacement counts; group deletion cascades histories and receipts',async()=>{
 const {c}=await fixture(),token=await login('teacher');
 const create=()=>request(app).post('/api/courses/'+c.id+'/materials').set('Authorization','Bearer '+token).set('Idempotency-Key','teacher-material-once').field('title','可重试资料').attach('file',Buffer.from('old'),{filename:'notes.txt'});
 const created=await create(),retry=await create();assert.equal(created.status,201);assert.equal(retry.status,200);assert.equal(created.body.id,retry.body.id);
 assert.equal(db.prepare('SELECT count(*) n FROM materials WHERE course_id=?').get(c.id).n,1);
 await request(app).get('/api/materials/'+created.body.id+'/file').set('Authorization','Bearer '+await login('alice')).expect(200);
 const replace=()=>request(app).put('/api/materials/'+created.body.id).set('Authorization','Bearer '+token).set('Idempotency-Key','teacher-replace-once').field('title','可重试资料').attach('file',Buffer.from('new'),{filename:'notes.txt'});
 const changed=await replace();assert.equal(changed.status,200);assert.equal((await replace()).status,200);assert.equal(changed.body.download_count,1);
 const gf=await groupFixture(),submitted=await submit('alice',gf.a,'delete-group-once','组答案');assert.equal(submitted.status,201);
 const gid=db.prepare('SELECT id FROM assignment_groups WHERE assignment_id=?').get(gf.a.id).id;
 await call('teacher','delete','/assignments/'+gf.a.id);
 assert.equal(db.prepare('SELECT count(*) n FROM group_submissions WHERE assignment_group_id=?').get(gid).n,0);
 assert.equal(db.prepare('SELECT count(*) n FROM submission_receipts WHERE assignment_id=?').get(gf.a.id).n,0);
 assert.deepEqual(db.pragma('foreign_key_check'),[]);
});
