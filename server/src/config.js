import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });
if(process.env.NODE_ENV==='production'&&process.env.TZ!=='Asia/Shanghai')throw new Error('生产环境必须设置 TZ=Asia/Shanghai');
const jwtSecret=process.env.JWT_SECRET;
if(process.env.NODE_ENV==='production'&&(!jwtSecret||Buffer.byteLength(jwtSecret,'utf8')<32||jwtSecret==='replace-with-a-long-random-string'))throw new Error('生产环境必须设置至少32字节的非示例 JWT_SECRET');
const uploadMaxMb = Number(process.env.UPLOAD_MAX_MB || 1024);
const materialUploadMaxMb = Number(process.env.MATERIAL_UPLOAD_MAX_MB || 10240);
if (!Number.isFinite(uploadMaxMb) || uploadMaxMb <= 0) throw new Error('UPLOAD_MAX_MB 必须是正数');
if (!Number.isFinite(materialUploadMaxMb) || materialUploadMaxMb <= 0) throw new Error('MATERIAL_UPLOAD_MAX_MB 必须是正数');
const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');

export const config = {
  // Windows 上 3000 可能处于系统保留端口段；开发模式与 Vite 统一使用 34567。
  // 生产环境仍由 Docker 的 PORT=3000 显式指定，不受这里影响。
  port: Number(process.env.PORT || (process.env.npm_lifecycle_event === 'dev' ? 34567 : 3000)),
  jwtSecret: jwtSecret || 'dev-only-change-this-secret',
  uploadMaxMb,
  materialUploadMaxMb,
  dataDir: path.resolve(serverRoot, process.env.DATA_DIR || 'data'),
  uploadDir: path.resolve(serverRoot, process.env.UPLOAD_DIR || 'uploads'),
  webDist: path.resolve(serverRoot, '../web/dist')
};
