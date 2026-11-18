# do-sift service image (OPS-03/OPS-05, plans/005-007; split in issue #163).
#
# Three stages:
#   deps     installs the full workspace dependency tree once
#   build    runs the offline checks inside the image and warms the model cache
#   runtime  a non-root image with production dependencies + tsx, no test/build
#            toolchain (typescript, eslint, prettier, vitest are absent)
#
# The runtime entrypoint is still the TypeScript source through tsx: workspace
# packages export `./src/index.ts`, so a compiled-JS-only image would first
# need a packaging change (see plans/045, OI-163). `tsx` therefore lives in
# `dependencies`, not `devDependencies`.
#
# Fail-closed env is deliberately NOT defaulted: `docker run` without
# DO_SIFT_OWNERS and DO_SIFT_SEARCH_PROVIDER refuses to start (see
# docs/deployment.md). Only labeled fixture providers exist today; live
# adapters stay behind their recorded gates.
#
# Debian-slim (glibc), not alpine: native deps (@libsql, onnxruntime-node)
# ship glibc prebuilds.
FROM node:24-slim AS deps

WORKDIR /app

COPY package.json package-lock.json .npmrc ./
COPY tsconfig.json tsconfig.base.json tsconfig.build.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
COPY migrations ./migrations
COPY evals ./evals
COPY eslint.config.mjs .prettierrc.json .prettierignore vitest.config.ts ./
COPY do-harness.toml ./

RUN npm ci --include=dev

FROM deps AS build

# Offline checks INSIDE the image, at build time: the deterministic eval
# suite must pass in-container. This also warms the gitignored-by-host model
# cache into /app/.fastembed_cache so runtime healthchecks stay offline.
RUN npm run eval:offline
RUN npm run build
RUN mkdir -p /app/.fastembed_cache

FROM node:24-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

# Production dependency tree only: no typescript/eslint/prettier/vitest.
# Workspace manifests are needed for npm's workspace linking.
COPY package.json package-lock.json .npmrc ./
COPY packages ./packages
COPY apps ./apps
COPY migrations ./migrations
RUN npm ci --omit=dev && npm cache clean --force

# Sources and the baked model cache come from the build stage.
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/evals ./evals
COPY --from=build /app/.fastembed_cache ./.fastembed_cache

# Writable data dir for the non-root runtime: the in-image DB default is
# file:/data/do-sift.db — mount a volume there for persistence.
RUN mkdir -p /data /app/.fastembed_cache && chown node:node /data /app/.fastembed_cache
ENV DO_SIFT_DB_URL="file:/data/do-sift.db"
VOLUME /data

# Non-root (node image ships uid 1000 "node").
USER node

# Container convention: bind all interfaces inside the container namespace;
# publish selectively with -p and keep the authenticating reverse-proxy duties
# from docs/deployment.md (no TLS/rate limiting in the server itself).
ENV DO_SIFT_HOST=0.0.0.0

# Liveness = the real service's /healthz (unauthenticated, constant body).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.DO_SIFT_PORT || 8080) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "node_modules/tsx/dist/cli.mjs", "apps/server/src/index.ts"]
