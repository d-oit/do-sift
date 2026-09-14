# Deploying do-sift

Status: pre-alpha, **single-owner**. Plan 000's non-goal applies: no public
multi-user deployment before the OPS/QUAL gates are met. This document
describes the supported deployment shape today and the knobs that exist.

## Architecture in one paragraph

The host wires four pieces together: the **storage plugin** (libSQL —
local file or Turso remote), the **auth service** (owner allowlist; OIDC
bearer tokens, or a loopback-only dev bypass), the **research/answer
services** (safe-fetch + site-access policy + budgets + citation gate),
and the **HTTP server** (`createResearchServer` on Node's `node:http`).
Plugins never touch the network or filesystem directly; the kernel mediates
via capability-checked services (ADR 0004).

## Configuration

Storage is configured through environment variables, mapped onto the
storage plugin by `storageConfigFromEnv` (packages/plugins/plugin-storage):

| Variable                       | Meaning                                                           | Default           |
| ------------------------------ | ----------------------------------------------------------------- | ----------------- |
| `DO_SIFT_DB_URL`               | libSQL URL: `file:do-sift.db` (local) or `libsql://…` (Turso)     | `file:do-sift.db` |
| `DO_SIFT_DB_AUTH_TOKEN_SECRET` | NAME of the secret holding the Turso auth token (never the token) | unset             |
| `DO_SIFT_DB_MIGRATIONS_DIR`    | Directory of numbered migrations applied at activation            | `migrations`      |

Rules the storage plugin enforces (fail closed):

- A **remote** URL requires the exact DB hostname in the plugin manifest's
  `permissions.networkHosts` AND an auth-token secret that resolves through
  the kernel's secret service. The token itself never lives in config or
  env — the host's `secretResolver` decides the backing store (the OS
  keychain is the sanctioned choice; see ADR 0005 / CMP-03).
- Remote Turso use additionally requires a dated entry in
  `plans/sources.md` before going live (commercial-terms gate).

### Auth

`AuthService` (packages/auth) is the only documented entry to owner-scoped
data. Configure an owner **allowlist** and either:

- an OIDC verifier (`OidcVerifier` interface; the stub
  `StaticOidcVerifier` is for tests/local only — a real provider needs its
  own sources.md entry), or
- the **dev bypass**: `devBypass: true` acts as the configured `devOwner`
  for token-less requests from literal loopback addresses
  (127.0.0.0/8, ::1). Hostnames like `localhost` deliberately never count.
  Keep `devBypass: false` in anything resembling production.

## Network exposure

The server speaks plain HTTP on whatever interface you bind it to and has
**no TLS and no rate limiting**. Therefore:

- Preferred: bind to loopback only and keep the whole stack on one machine.
- If it must be reached remotely, put a reverse proxy (Caddy/nginx) in
  front that terminates TLS and adds rate limiting. do-sift sets
  `X-Content-Type-Options: nosniff` and serves same-origin only; the proxy
  must not loosen that.

## Running

```bash
npm install
npm run build      # tsc -b tsconfig.build.json
npm run check      # full verification before starting anything
```

The HTTP surface is a library (`createResearchServer` in
packages/server); a packaged app entry under `apps/` is pending (tracked
in the OPS notes). Migrations run automatically when the storage plugin
activates with `migrationsDir` set.

## Backups

The database is one file (local mode) — snapshot it with
`backupToFile` (packages/storage), which uses `VACUUM INTO` for a
consistent, portable snapshot:

- **Cadence:** before every deploy or migration, plus a daily snapshot.
- **Restore:** open the snapshot (`openRestore`) — restore _is_ opening a
  file. `verifyRestore` proves the copy matches (row counts + owners
  registry). The rehearsal lives in packages/storage/test/backup.test.ts.
- **Turso:** the local procedure does not apply remotely; use
  `turso db dump` or platform snapshots (documented, not yet executed —
  gated on the live database).

## Verification before handoff

`npm run check` runs the full pipeline (format, lint, typecheck, policy,
skills, tests, evals). The dev-signal harness (plan 008) records receipts
per run — cite `.do-harness/evidence.verification.json` rather than memory.

## Known limits (pre-alpha)

- Single owner; no multi-user deployment (plan 000 non-goal until
  OPS/QUAL gates).
- No TLS, no rate limiting in the server itself (reverse proxy duty).
- No packaged container yet (OPS-03) and no app entry point under `apps/`.
- Remote Turso behavior (DDL-in-transaction parity) is tested locally only
  until the sources.md activation gate.
