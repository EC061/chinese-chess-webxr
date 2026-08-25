# syntax=docker/dockerfile:1.9

# ---------------------------------------------------------------------- build --
# Pinned to the build machine's own architecture. Everything this stage produces
# is platform-independent JavaScript, so cross-building for arm64 needs no QEMU
# emulation — which takes a multi-arch build from ~15 minutes down to ~2.
FROM --platform=$BUILDPLATFORM node:24-alpine AS build

WORKDIR /app
ENV NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false

# Manifests first: this layer only busts when a dependency actually changes.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/ai/package.json packages/ai/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN npm ci

COPY packages ./packages
COPY vitest.config.ts ./

# Typecheck and test as part of the image build: a container that boots but
# plays illegal moves is worse than one that fails to build.
RUN npm run typecheck && npm test

# The client bundle, then the server as a single self-contained ESM file.
RUN npm run build && npm run bundle -w @ccx/server

# -------------------------------------------------------------------- runtime --
FROM node:24-alpine AS runtime

LABEL org.opencontainers.image.title="chinese-chess-webxr" \
      org.opencontainers.image.description="Xiangqi (Chinese Chess) as a seated WebXR experience for Meta Quest 3 / 3S." \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/EC061/chinese-chess-webxr"

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    STATIC_DIR=/app/public \
    DATABASE_PATH=/data/xiangqi.db

# The server is one bundled file: no node_modules in the runtime image, nothing
# to install at deploy time, and a much smaller attack surface.
COPY --from=build /app/packages/server/dist/server.mjs ./server.mjs
COPY --from=build /app/packages/client/dist ./public

# SQLite needs to own its directory, not just the file, so it can write the
# -wal and -shm sidecars.
RUN mkdir -p /data && chown -R node:node /data /app

USER node
EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:${PORT}/healthz || exit 1

CMD ["node", "server.mjs"]
