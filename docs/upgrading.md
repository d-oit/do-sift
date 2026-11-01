# Node.js Version & Upgrade Guide

This guide documents the Node.js runtime floor for **do-sift**, the technical justification for requiring Node >= 22, and practical upgrade instructions for developers and deployment environments transitioning from Node 20 or earlier.

---

## 1. Node.js Version Support Policy

do-sift adheres to the [Node.js Long-Term Support (LTS) release schedule](https://nodejs.org/en/about/previous-releases):

| Node Release | Status                                   | Role in do-sift                                                                        |
| ------------ | ---------------------------------------- | -------------------------------------------------------------------------------------- |
| **Node 20**  | Maintenance LTS (end-of-life April 2026) | **Unsupported**: missing key built-in modules and runtime features required by do-sift |
| **Node 22**  | Active LTS                               | **Minimum Supported Version**: all packages and tools must run without polyfills       |
| **Node 24**  | Active LTS                               | **Latest LTS Supported**: CI validates the test suite against this version             |

All first-party packages, apps, tests, and scripts declare `"engines": { "node": ">=22" }` in `package.json`.

---

## 2. Technical Justification: Why Node >= 22?

Node 22 introduced major stable capabilities and standards alignments that eliminate external dependencies, polyfills, and runtime workarounds across do-sift's architecture:

### 2.1 Built-in `node:sqlite`

Node 22 provides native support for `node:sqlite` without needing native compilation toolchains (e.g. `node-gyp`, Python-based build environments). This aligns directly with do-sift's ground rule (AGENTS.md INV-001) prohibiting Python build chains and native build friction during dependency installation.

### 2.2 Modern Web Standards and Fetch APIs

do-sift's networking stack (`@do-sift/safe-fetch`, provider adapters, and proxy clients) relies heavily on standard Web platform primitives:

- Global `fetch`, `Request`, `Response`, and `Headers` backed by Undici 6+ with enhanced spec compliance.
- AbortController and AbortSignal enhancements (e.g., `AbortSignal.any`, timeout integration).
- Enhanced streaming and byte handling (`ReadableStream`, `Uint8Array` methods).

In Node 20, several fetch edge behaviors required additional flags, polyfills, or exhibited subtle divergence in timeout and redirect handling. Node 22 stabilizes these behaviors out of the box.

### 2.3 Native WebSocket Client

Node 22 ships a stable global `WebSocket` client implementation (backed by Undici), eliminating external third-party WebSocket dependencies for browser harnesses and streaming endpoints.

### 2.4 Enhanced Glob and Filesystem Primitives

Node 22 stabilizes recursive filesystem watching and built-in path utilities (`node:fs/promises` glob matching), used across do-sift's signal harness and repository auditing tools.

### 2.5 V8 Engine Updates & ECMAScript Features

Node 22 runs V8 12.4+, providing built-in support for:

- `Array.fromAsync`
- `Iterator.prototype` helpers
- Set methods (`intersection`, `union`, `difference`, `symmetricDifference`)
- Performance improvements in regular expressions and async stack traces.

---

## 3. Upgrading from Node 20 to Node 22 (or 24)

### 3.1 Using `nvm` (Node Version Manager)

The repository includes a `.nvmrc` file specifying the minimum supported LTS version (`22`).

To install and activate the required version:

```bash
# In the repository root:
nvm install
nvm use
```

To upgrade to the latest LTS release (Node 24):

```bash
nvm install 24
nvm use 24
```

Verify your active version:

```bash
node -v
# Output should be >= v22.0.0
```

### 3.2 Using `volta`

The repository configures Volta pinning in `package.json` (`"volta": { "node": "22.14.0" }`).

If you use Volta:

```bash
# Volta automatically switches to the pinned Node version when entering the directory:
node -v

# To manually pin or switch versions:
volta pin node@22
# Or for Node 24:
volta pin node@24
```

### 3.3 Using `fnm` (Fast Node Manager)

If you use `fnm`:

```bash
fnm install
fnm use
```

### 3.4 Docker & Container Environments

Update base images in Dockerfiles and CI container configs to use Node 22 or Node 24 slim images:

```dockerfile
# Example
FROM node:22-slim
# Or:
# FROM node:24-slim
```

---

## 4. Post-Upgrade Verification Checklist

After switching your Node version:

1. **Clean stale artifacts (optional if encountering module errors):**

   ```bash
   rm -rf node_modules
   npm ci
   ```

2. **Verify Node version:**

   ```bash
   node -v
   # Must report v22.x or higher
   ```

3. **Run repository checks:**
   ```bash
   npm run check:fast
   npm test
   npm run build
   ```

All checks should pass cleanly.
