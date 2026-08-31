import { db } from '../db.js';
import { resolveUploadPath } from '../utils/uploadPath.js';
import { nowText } from '../utils/time.js';
import { courseAccess,fail } from './access.js';
export function serveMaterialFile(id,user,res,req=res.req,next=()=>{}){
 const m=db.prepare('SELECT * FROM materials WHERE id=?').get(id);if(!m)fail(404,'资料不存在');
 courseAccess(m.course_id,user);
 const file=resolveUploadPath(m.file_url,{mustExist:true});if(!file)fail(404,'资料文件不存在');
 res.download(file,m.file_name,error=>{
 if(error){if(!res.headersSent)next(error);return;}
 if(user.role!=='student'||req?.method==='HEAD'||res.statusCode!==200||res.getHeader('content-range'))return;
 // A course/material may be deleted while the response is streaming.
 if(!db.prepare('SELECT 1 FROM materials WHERE id=?').get(m.id))return;
 const at=nowText();
 try{db.prepare('INSERT INTO material_downloads(material_id,student_id,download_count,first_downloaded_at,last_downloaded_at) VALUES(?,?,1,?,?) ON CONFLICT(material_id,student_id) DO UPDATE SET download_count=download_count+1,last_downloaded_at=excluded.last_downloaded_at').run(m.id,user.id,at,at);}
 catch(e){console.error('下载统计写入失败',e.message);}
 });
}
