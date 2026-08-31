import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mohen-browser-preview-'));
process.env.NODE_ENV='test';process.env.TZ='Asia/Shanghai';process.env.JWT_SECRET='temporary-preview-only';process.env.DATA_DIR=directory;process.env.UPLOAD_DIR=path.join(directory,'uploads');
const {app}=await import('../src/index.js');
const {db}=await import('../src/db.js');
const {default:bcrypt}=await import('bcryptjs');
const teacher=db.prepare("SELECT id FROM users WHERE username='teacher'").get().id;
const student=db.prepare("INSERT INTO users(username,password_hash,name,role,must_change_password) VALUES('preview-student',?,'测试同学','student',0)").run(bcrypt.hashSync('123456',4)).lastInsertRowid;
const course=db.prepare("INSERT INTO courses(name,description,teacher_id,invite_code) VALUES('统一更新验收课程','仅用于测试，不含真实学生数据',?,'UITEST')").run(teacher).lastInsertRowid;
db.prepare('INSERT INTO course_students(course_id,student_id) VALUES(?,?)').run(course,student);
db.prepare("INSERT INTO assignments(course_id,title,description,type,deadline,status,allow_resubmit_count) VALUES(?,'在线作业验收','填写任意测试答案，验收提交回执和延期入口','online','2099-01-01 00:00:00','published',-1)").run(course);
const server=app.listen(34568,'127.0.0.1',()=>console.log('Isolated preview ready: http://localhost:34568/'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>{db.close();const base=path.resolve(os.tmpdir()),target=path.resolve(directory);if(path.dirname(target)===base&&path.basename(target).startsWith('mohen-browser-preview-'))fs.rmSync(target,{recursive:true,force:true});process.exit(0);}));

