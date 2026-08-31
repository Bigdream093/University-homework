import fs from 'node:fs';
import archiver from 'archiver';
import { pipeline } from 'node:stream/promises';
import { safeName } from './fileFilter.js';

// ZIP64 is selected automatically for archives exceeding 4GiB.
// STORE avoids recompressing videos and compressed student attachments.
export async function pipeZipToResponse(entries,response) {
 const archive=archiver('zip',{store:true});
 archive.on('warning',error=>archive.emit('error',error));
 response.once('close',()=>{if(!response.writableFinished)archive.abort();});
 const completion=pipeline(archive,response);
 // Attach a rejection handler immediately, including while queuing files.
 completion.catch(()=>{});
 try {
 for(const entry of entries){
 const name=safeName(entry.name||'file');
 if(entry.content!==undefined&&entry.content!==null)archive.append(Buffer.from(String(entry.content),'utf8'),{name});
 else archive.file(entry.path,{name,stats:fs.statSync(entry.path)});
 }
 await Promise.all([archive.finalize(),completion]);
 }catch(error){
 archive.abort();if(!response.destroyed)response.destroy();
 if(error.code!=='ERR_STREAM_PREMATURE_CLOSE')console.error('作业打包失败',error.message);
 }
}
