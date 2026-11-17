# Node.js Version & Upgrade Guide

This guide documents the Node.js runtime floor for **do-sift**, the technical justification for requiring Node >= 24, and practical upgrade instructions for developers and deployment environments transitioning from an older Node line.

---

## 1. Node.js Version Support Policy

do-sift adheres to the [Node.js Long-Term Support (LTS) release schedule](https://nodejs.org/en/about/previous-releases):

| Node Release | Status                                     | Role in do-sift                                                                               |
| ------------ | ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| **Node 20**  | End-of-life (April 2026)                   | **Unsupported**: missing key built-in modules and runtime features required by do-sift        |
| **Node 22**  | Maintenance LTS (end-of-life April 2027)   | **Unsupported**: below the shipped floor; use it only to inspect the historical justification |
| **Node 24**  | Active LTS (maintenance from October 2026) | **Minimum Supported Version**: all packages and tools must run without polyfills              |
| **Node 26**  | Active LTS                                 | **Latest LTS Supported**: CI validates the test suite against this version                    |

All first-party packages, apps, tests, and scripts declare `"engines": { "node": ">=24" }` in `package.json`.

---

## 2. Technical Justification: Why Node >= 24?

The floor is Node 24. The capabilities below arrived in earlier lines and are still relied on today; no API newer than Node 24 is required:

### 2.1 Built-in `node:sqlite`

Node's built-in `node:sqlite` avoids needing a native compilation toolchain (e.g. `node-gyp`, which historically pulled in Python build environments) for the fallback storage path. This aligns with do-sift's ground rule (AGENTS.md INV-001) prohibiting Python build chains.

### 2.2 Modern Web Standards and Fetch APIs

do-sift's networking stack (`@do-sift/safe-fetch`, provider adapters, and proxy clients) relies heavily on standard Web platform primitives:

- Global `fetch`, `Request`, `Response`, and `Headers` backed by Undici 6+ with enhanced spec compliance.
- AbortController and AbortSignal enhancements (e.g., `AbortSignal.any`, timeout integration).
- Enhanced streaming and byte handling (`ReadableStream`, `Uint8Array` methods).

Older Node lines required flags or polyfills for several fetch edge behaviors (timeout and redirect handling in particular). Node 22+ stabilizes these out of the box, and Node 24 is the tested baseline.

### 2.3 Native WebSocket Client

Node ships a stable global `WebSocket` client (backed by Undici), eliminating a third-party WebSocket dependency for streaming endpoints.

### 2.4 Enhanced Glob and Filesystem Primitives

Built-in recursive filesystem watching and `node:fs/promises` glob matching are used by do-sift's signal harness and repository auditing tools.

### 2.5 V8 Engine Updates & ECMAScript Features

The supported Node lines provide built-in support for:

- `Array.fromAsync`
- `Iterator.prototype` helpers
- Set methods (`intersection`, `union`, `difference`, `symmetricDifference`)
- Performance improvements in regular expressions and async stack traces.

---

## 3. Upgrading to Node 24

### 3.1 Using `nvm` (Node Version Manager)

The repository includes a `.nvmrc` file pinning the supported default (`24`).

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
# Output should be >= v24.0.0
```

### 3.2 Using `volta`

The repository configures Volta pinning in `package.json` (`"volta": { "node": "24.22.2" }`).

If you use Volta:

```bash
# Volta automatically switches to the pinned Node version when entering the directory:
node -v

# To manually pin or switch versions:
volta pin node@24
```

### 3.3 Using `fnm` (Fast Node Manager)

If you use `fnm`:

```bash
fnm install
fnm use
```

### 3.4 Docker & Container Environments

Update base images in Dockerfiles and CI container configs to use Node 24 slim images:

```dockerfile
# Example
FROM node:24-slim
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
   # Must report v24.x or higher
   ```

3. **Run repository checks:**
   ```bash
   npm run check:fast
   npm test
   npm run build
   ```

All checks should pass cleanly.
