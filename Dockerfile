# do-sift offline verification image (OPS-03, plans/005-007).
#
# Purpose today: a reproducible, non-root container that carries the runtime
# and runs the offline check suite INSIDE the image (INV-006: deterministic
# datasets, 0 network, 0 model calls — local ONNX inference only). A packaged
# server entrypoint is still pending under apps/ (docs/deployment.md); when
# it lands, the CMD switches to it and this healthcheck becomes a service
# liveness probe.
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

# Non-root (node image ships uid 1000 "node"); /app is world-readable so
# the runtime user can read sources and the baked model cache.
USER node

# Liveness = the offline suite itself (slow but honest; long interval).
HEALTHCHECK --interval=120s --timeout=120s --start-period=30s --retries=2 \
  CMD ["node", "node_modules/tsx/dist/cli.mjs", "scripts/eval.ts"]

CMD ["node", "node_modules/tsx/dist/cli.mjs", "scripts/eval.ts"]
