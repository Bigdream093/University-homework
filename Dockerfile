FROM node:24-bookworm-slim AS web-builder
WORKDIR /build
COPY package.json package-lock.json ./
COPY web/package.json ./web/package.json
COPY server/package.json ./server/package.json
RUN npm ci --workspace web --include-workspace-root=false
COPY web/ ./web/
COPY server/src/domain/ ./server/src/domain/
RUN npm run build --workspace web

FROM node:24-bookworm AS server-deps
WORKDIR /deps
RUN command -v python3 && command -v make && command -v g++
COPY package.json package-lock.json ./
COPY web/package.json ./web/package.json
COPY server/package.json ./server/package.json
RUN npm ci --workspace server --include-workspace-root=false --omit=dev
RUN node -e "const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.close()"

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=server-deps /deps/node_modules ./node_modules
COPY server/ ./
COPY --from=web-builder /build/web/dist /web/dist
RUN mkdir -p /app/data /app/uploads
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data UPLOAD_DIR=/app/uploads TZ=Asia/Shanghai
EXPOSE 3000
CMD ["node", "src/index.js"]
