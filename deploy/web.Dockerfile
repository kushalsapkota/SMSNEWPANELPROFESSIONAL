# syntax=docker/dockerfile:1.7
# Web image: Next.js 14 standalone output (server.js + the traced node_modules only), non-root.
#   docker build -f deploy/web.Dockerfile --build-arg API_URL=http://api:3000 -t smsgw/web .
#
# web/next.config.mjs sets `output: 'standalone'` when NEXT_OUTPUT=standalone at build time
# (set below). Next.js writes rewrite destinations into the build, so API_URL, the address
# where the server-side web container reaches the api, has to be a BUILD argument. Changing it
# means rebuilding the image. The NEXT_PUBLIC_* values are inlined into the browser bundle, so
# they are build arguments too.

ARG NODE_VERSION=22.11.0
ARG ALPINE_VERSION=3.20

FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS build
# libc6-compat: some optional native tooling expects glibc symbols (Next.js recommendation).
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY web/package.json web/package-lock.json web/.npmrc ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY web/ ./
ARG API_URL=http://api:3000
ARG NEXT_PUBLIC_API_BASE_URL=
ARG NEXT_PUBLIC_SMPP_HOST=
ARG NEXT_PUBLIC_SMPP_PORT=2775
ENV NEXT_OUTPUT=standalone \
    NEXT_TELEMETRY_DISABLED=1 \
    API_URL=${API_URL} \
    NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL} \
    NEXT_PUBLIC_SMPP_HOST=${NEXT_PUBLIC_SMPP_HOST} \
    NEXT_PUBLIC_SMPP_PORT=${NEXT_PUBLIC_SMPP_PORT}
RUN npm run build \
 && test -f .next/standalone/server.js \
 && mkdir -p public

FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION}
RUN apk add --no-cache tini
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3001 \
    HOSTNAME=0.0.0.0
COPY --from=build --chown=root:root /app/.next/standalone ./
COPY --from=build --chown=root:root /app/.next/static ./.next/static
COPY --from=build --chown=root:root /app/public ./public
# Next writes its ISR/image cache under .next/cache: the only writable path.
RUN mkdir -p .next/cache && chown node:node .next/cache
USER node
EXPOSE 3001
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/login').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
