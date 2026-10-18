# syntax=docker/dockerfile:1.7
# API image: NestJS compiled to dist/, production dependencies only, non-root.
#   docker build -f deploy/api.Dockerfile -t smsgw/api .      (context = repo root)
# Run the admin seed once (idempotent):
#   docker compose -f deploy/docker-compose.prod.yml run --rm api node dist/seed.js

ARG NODE_VERSION=22.11.0
ARG ALPINE_VERSION=3.20

# 1. Full install + TypeScript build.
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS build
WORKDIR /app
COPY api/package.json api/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY api/tsconfig.json api/tsconfig.build.json ./
COPY api/src ./src
RUN npm run build && test -f dist/main.js && test -f dist/seed.js

# 2. Production dependencies only. No package needs an install script: @node-rs/argon2 ships
#    prebuilt musl binaries as optional dependencies, and @nestjs/core's script only prints a
#    banner.
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS prod-deps
WORKDIR /app
COPY api/package.json api/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && node -e "require('@node-rs/argon2')" \
 && npm cache clean --force

# 3. Runtime.
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION}
RUN apk add --no-cache tini
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    NODE_OPTIONS=--enable-source-maps
COPY --from=prod-deps --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/dist ./dist
COPY --chown=root:root api/package.json ./package.json
# The built-in `node` user (uid 1000). The app files are owned by root, so they are read-only
# for the process.
USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
