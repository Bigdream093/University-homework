import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import Database from 'better-sqlite3';
const source=path.resolve(process.argv[2]||'server/data/homework.sqlite');
if(!fs.existsSync(source))throw new Error('指定的原数据库不存在');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'mohen-local-migration-copy-'));
const original=new Database(source,{readonly:true,fileMustExist:true});
const tables=['users','courses','course_students','assignments','submissions','submission_history','notices','materials'];
const counts=db=>Object.fromEntries(tables.map(t=>[t,db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)?db.prepare('SELECT count(*) n FROM '+t).get().n:0]));
const before=counts(original);await original.backup(path.join(temp,'homework.sqlite'));original.close();
const code="const {db}=await import('./src/db.js');db.close();";
for(let i=0;i<2;i++){const result=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,NODE_ENV:'test',TZ:'UTC',DATA_DIR:temp},encoding:'utf8'});if(result.status!==0)throw new Error(result.stderr);}
const upgraded=new Database(path.join(temp,'homework.sqlite'),{readonly:true}),after=counts(upgraded),foreign=upgraded.pragma('foreign_key_check');upgraded.close();
if(JSON.stringify(before)!==JSON.stringify(after)||foreign.length)throw new Error('副本校验失败，请保留临时副本进行检查');
console.log(JSON.stringify({source_modified:false,counts_preserved:true,foreign_key_errors:foreign.length,successful_boots:2,table_counts:after}));
const resolved=path.resolve(temp);if(path.dirname(resolved)===path.resolve(os.tmpdir())&&path.basename(resolved).startsWith('mohen-local-migration-copy-'))fs.rmSync(resolved,{recursive:true,force:true});

