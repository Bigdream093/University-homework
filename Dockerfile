FROM node:20-bookworm-slim AS web-builder
WORKDIR /build/web
COPY web/package*.json ./
RUN npm install
COPY web/ ./
RUN npm run build

FROM node:20-bookworm-slim AS server-deps
WORKDIR /deps
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY server/package*.json ./
RUN npm install --omit=dev

FROM node:20-bookworm-slim
WORKDIR /app
COPY --from=server-deps /deps/node_modules ./node_modules
COPY server/ ./
COPY --from=web-builder /build/web/dist /web/dist
RUN mkdir -p /app/data /app/uploads
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data UPLOAD_DIR=/app/uploads
EXPOSE 3000
CMD ["node", "src/index.js"]
