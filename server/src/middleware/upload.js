import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import multer from 'multer';
import { config } from '../config.js';
import { fileFilter,decodeFilename } from '../utils/fileFilter.js';
import { queueCleanup,flushCleanup } from '../services/storage.js';

export function uploadSingle(req,res,next) {
  const directory=path.join(config.uploadDir,'.staging');fs.mkdirSync(directory,{recursive:true});
  let stagedPath;
  const storage=multer.diskStorage({destination:directory,filename(_req,file,cb){file.originalname=decodeFilename(file.originalname);const name=randomUUID()+path.extname(file.originalname).toLowerCase();stagedPath=path.join(directory,name);cb(null,name);}});
  req.once('aborted',()=>{if(stagedPath){queueCleanup([stagedPath],'上传连接中断');flushCleanup();}});
  const limit=req.uploadLimit??config.uploadMaxMb*1024*1024;
  multer({storage,fileFilter,limits:{fileSize:limit+1,fields:12,fieldSize:2*1024*1024,files:1}}).single('file')(req,res,error=>{
    if(error&&stagedPath){queueCleanup([stagedPath],'上传未完成');flushCleanup();}
    if(error?.code==='LIMIT_FILE_SIZE'){error.status=400;error.message=(req.uploadLabel||'文件')+'限制单文件不超过 '+(limit/1024/1024)+'M';}
    next(error);
  });
}
