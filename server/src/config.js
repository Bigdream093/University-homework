import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });
const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');

export const config = {
  // Windows 上 3000 可能处于系统保留端口段；开发模式与 Vite 统一使用 34567。
  // 生产环境仍由 Docker 的 PORT=3000 显式指定，不受这里影响。
  port: Number(process.env.PORT || (process.env.npm_lifecycle_event === 'dev' ? 34567 : 3000)),
  jwtSecret: process.env.JWT_SECRET || 'dev-only-change-this-secret',
  uploadMaxMb: Number(process.env.UPLOAD_MAX_MB || 1024),
  dataDir: path.resolve(serverRoot, process.env.DATA_DIR || 'data'),
  uploadDir: path.resolve(serverRoot, process.env.UPLOAD_DIR || 'uploads'),
  webDist: path.resolve(serverRoot, '../web/dist')
};
