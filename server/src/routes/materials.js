import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { auth } from '../middleware/auth.js';
import { teacherOnly } from '../middleware/teacher.js';
import { fileFilter, safeName, decodeFilename } from '../utils/fileFilter.js';
import { listMaterials, createMaterial, updateMaterial, deleteMaterial } from '../services/materialService.js';
import { serveMaterialFile } from '../services/materialFileService.js';

const materialsRoot = path.join(config.uploadDir, 'materials');
fs.mkdirSync(materialsRoot, { recursive: true });
// 学习资料不设文件大小上限：multer 走磁盘流式写入，不占用内存
const storage = multer.diskStorage({
  destination(req, _file, cb) {
    const dir = path.join(materialsRoot, String(req.params.id));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    file.originalname = decodeFilename(file.originalname);
    cb(null, `${req.user.id}_${Date.now()}_${safeName(file.originalname)}`);
  }
});
const upload = multer({ storage, fileFilter });

const router = Router();

router.get('/courses/:id/materials', auth, (req, res) => listMaterials(Number(req.params.id), req.user, res));
router.post('/courses/:id/materials', auth, teacherOnly, upload.single('file'), (req, res) => createMaterial(Number(req.params.id), req.user.id, req.body, req.file, res));
router.put('/materials/:id', auth, teacherOnly, upload.single('file'), (req, res) => updateMaterial(Number(req.params.id), req.user.id, req.body, req.file, res));
router.delete('/materials/:id', auth, teacherOnly, (req, res) => deleteMaterial(Number(req.params.id), req.user.id, res));
router.get('/materials/:id/file', auth, (req, res) => serveMaterialFile(Number(req.params.id), req.user, res));

export default router;
