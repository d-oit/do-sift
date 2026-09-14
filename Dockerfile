# do-sift service image (OPS-03 + OPS-05, plans/005-007).
#
# Purpose: a reproducible, non-root container that carries the runtime AND
# the packaged entrypoint (apps/server): CMD = the service, healthcheck =
# its /healthz route. The offline check suite still runs INSIDE the image
# at build time (INV-006: deterministic datasets, 0 network, 0 model calls
# — local ONNX inference only) and warms the model cache so the runtime
# fastembed embedder stays offline.
#
# Fail-closed env is deliberately NOT defaulted: `docker run` without
# DO_SIFT_OWNERS and DO_SIFT_SEARCH_PROVIDER refuses to start (see
# docs/deployment.md). Only labeled fixture providers exist today; live
# adapters stay behind their recorded gates.
#
# Debian-slim (glibc), not alpine: native deps (@libsql, onnxruntime-node)
# ship glibc prebuilds.
FROM node:22-slim

WORKDIR /app

# Dependencies first (layer cache), then the tree.
COPY package.json package-lock.json ./
COPY tsconfig.json tsconfig.base.json tsconfig.build.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
COPY migrations ./migrations
COPY evals ./evals
COPY eslint.config.mjs .prettierrc.json .prettierignore vitest.config.ts ./
COPY do-harness.toml ./

# Dev tooling is included deliberately: the repo runs through tsx (a devDep)
# and the offline checks are the image's payload. NODE_ENV=production would
# prune them (npm ci honors it), so it is set only after install.
RUN npm ci --include=dev

# Offline checks INSIDE the image, at build time: the deterministic eval
# suite must pass in-container (also warms the gitignored-by-host model
# cache into /app/.fastembed_cache so runtime healthchecks stay offline).
RUN npm run eval:offline

# Writable data dir for the non-root runtime: the in-image DB default is
# file:/data/do-sift.db — mount a volume there for persistence. The baked
# model cache dir is chowned too, so a runtime-enabled fastembed embedder
# can refresh it.
RUN mkdir -p /data /app/.fastembed_cache && chown node:node /data /app/.fastembed_cache
ENV DO_SIFT_DB_URL="file:/data/do-sift.db"
VOLUME /data

# Non-root (node image ships uid 1000 "node"); /app is world-readable so
# the runtime user can read sources and the baked model cache.
USER node

# Container convention: bind all interfaces inside the container namespace;
# publish selectively with -p and keep the reverse-proxy duties from
# docs/deployment.md (no TLS/rate limiting in the server itself).
ENV DO_SIFT_HOST=0.0.0.0

# Liveness = the real service's /healthz (unauthenticated, constant body).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.DO_SIFT_PORT || 8080) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "node_modules/tsx/dist/cli.mjs", "apps/server/src/index.ts"]
