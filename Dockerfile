FROM node:24-bookworm-slim AS web-builder
WORKDIR /build
COPY package.json package-lock.json ./
COPY web/package.json ./web/package.json
COPY server/package.json ./server/package.json
COPY packages/domain/package.json ./packages/domain/package.json
RUN npm ci --workspace web --include-workspace-root=false
COPY web/ ./web/
COPY server/src/ ./server/src/
COPY server/help/ ./server/help/
COPY packages/domain/ ./packages/domain/
COPY scripts/build-info.cjs ./scripts/build-info.cjs
COPY scripts/check-shared-boundary.cjs ./scripts/check-shared-boundary.cjs
COPY Dockerfile ./Dockerfile
RUN node scripts/check-shared-boundary.cjs && npm run build --workspace web && node scripts/build-info.cjs

FROM node:24-bookworm AS server-deps
WORKDIR /deps
RUN command -v python3 && command -v make && command -v g++
COPY package.json package-lock.json ./
COPY web/package.json ./web/package.json
COPY server/package.json ./server/package.json
COPY packages/domain/package.json ./packages/domain/package.json
RUN npm ci --workspace server --include-workspace-root=false --omit=dev
COPY packages/domain/ ./packages/domain/
RUN node -e "const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.close()"

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=server-deps /deps/node_modules ./node_modules
COPY --from=server-deps /deps/packages/domain ./packages/domain
COPY server/ ./
COPY package.json ./source-package.json
COPY --from=web-builder /build/server/build-info.json ./build-info.json
COPY --from=web-builder /build/web/dist /web/dist
RUN mkdir -p /app/data /app/uploads
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data UPLOAD_DIR=/app/uploads TZ=Asia/Shanghai
EXPOSE 3000
CMD ["node", "src/index.js"]
