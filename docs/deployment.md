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
The packaged entrypoint composes them through the `createRuntime` seam
(`packages/server/src/runtime.ts`, RET-04: one options object wires
repositories, budgets, research embed-on-store, and answer hybrid
retrieval), then serves the runtime over HTTP.
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

The packaged entrypoint is `apps/server` — run it with tsx (no build
step needed; the repo runs through tsx). Provider selection is
fail-closed: the entrypoint refuses to start without an explicit search
provider and owner allowlist, and fixture providers are labeled as
synthetic in the startup log — never a silent default.

```bash
DO_SIFT_OWNERS="me" \
DO_SIFT_SEARCH_PROVIDER=fixture \
DO_SIFT_MODEL_PROVIDER=fixture \
DO_SIFT_DEV_BYPASS=1 DO_SIFT_DEV_OWNER=me \
npx tsx apps/server/src/index.ts
# → do-sift listening on http://127.0.0.1:8080
```

| Variable                                   | Meaning                                                                                                                                                                                                                                               | Default              |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `DO_SIFT_OWNERS`                           | Comma-separated owner allowlist (required; seeds the owners registry)                                                                                                                                                                                 | —                    |
| `DO_SIFT_SEARCH_PROVIDER`                  | Search adapter: `fixture` (synthetic, offline), `wikipedia` / `marginalia` (live, terms-checked in `plans/sources.md`), or a comma-separated merged list e.g. `wikipedia,marginalia` (SRC-16 interleave + URL dedup; `fixture` never mixes with live) | —                    |
| `DO_SIFT_MODEL_PROVIDER`                   | Answer model; `fixture` wires `/api/answer`, unset answers 501 (live providers gated behind ANS-02 + paid grants)                                                                                                                                     | unset                |
| `DO_SIFT_EMBEDDER`                         | `fastembed` = hybrid retrieval (local ONNX); unset = keyword-only bm25                                                                                                                                                                                | unset                |
| `DO_SIFT_DB_URL`                           | libSQL URL; local `file:` only in the entrypoint (Turso runs through the storage plugin + kernel secrets)                                                                                                                                             | `file:do-sift.db`    |
| `DO_SIFT_DB_MIGRATIONS_DIR`                | Numbered migrations applied at startup                                                                                                                                                                                                                | `migrations`         |
| `DO_SIFT_HOST` / `DO_SIFT_PORT`            | Bind address/port                                                                                                                                                                                                                                     | `127.0.0.1` / `8080` |
| `DO_SIFT_DEV_BYPASS` / `DO_SIFT_DEV_OWNER` | Loopback-only dev bypass (keep off outside dev)                                                                                                                                                                                                       | off                  |
| `DO_SIFT_FETCH_ALLOWLIST`                  | Exhaustive fetch allowlist for the site-access policy (wired with the first live search adapter)                                                                                                                                                      | unset                |

Migrations run automatically at startup; every allowlisted owner is
seeded into the owners registry. Research mode makes zero LLM calls by
product invariant; with no model configured, `/api/answer` answers 501
honestly instead of degrading silently.

### Live search (wikipedia)

`DO_SIFT_SEARCH_PROVIDER=wikipedia` runs the free, keyless MediaWiki
action API behind its dated terms gate (`plans/sources.md`, checked
2026-09-14). Every page fetch goes through safe-fetch (scheme/IP/
redirect/DNS-rebinding/size/time/MIME guards) with each hop checked
against the site-access policy — `DO_SIFT_FETCH_ALLOWLIST` is an
exhaustive allowlist when set, and the shipped default-deny list stays
absolute. Content is **CC BY-SA**: the evidence store preserves
attribution (source URL + title per passage); publishing derived content
would require the same license. Page content comes from the MediaWiki
plain-text extract endpoint (clean article prose — no HTML-stripping
pipeline, so template metadata cannot leak into stored passages); every
live request (search and content) carries the adapter's descriptive
User-Agent per the Wikimedia UA policy (checked 2026-09-14), and the
search adapter's single 429 retry never fires before the instructed
`Retry-After`. No
live test runs in CI — the
live shape was verified by the recorded SRC-06 spike, and offline tests
use recorded fixtures.

### Live search (marginalia, merged)

`DO_SIFT_SEARCH_PROVIDER=marginalia` runs the free, keyless legacy path
`api.marginalia.nu/public/search` behind its dated terms gate
(`plans/sources.md`, checked 2026-09-15; re-verified 2026-09-21 against
the canonical docs at `https://about.marginalia-search.com/article/api`).
Result metadata is **CC BY-NC-SA 4.0** (non-commercial research tool;
linked pages carry their own licenses); the evidence store preserves
attribution. `DO_SIFT_SEARCH_PROVIDER=wikipedia,marginalia` composes the
merged provider (SRC-16: fan-out, interleave + canonical-URL dedup);
run summaries carry per-provider `providerHealth` (SRC-17) and the bundled
UI renders it as a status line (SRC-22). The api2 host
(`api2.marginalia-search.com`, `API-Key` header) is NOT wired and NOT planned: the shared
literal key `public` probed 429 on 2026-09-21, and a personal key is closed (owner could
not obtain one) — the legacy endpoint is the supported path; see `plans/sources.md`.

### Runtime defaults (RET-04 seam)

`apps/server` passes only `client/search/fetchPage/extract/model/embedder`
into `createRuntime`; answer-pool shaping stays on the designed defaults
with no env wiring: `relevanceFloor` 0.70 (SRC-11), noise-class exclusion
on (SRC-12). `DO_SIFT_EMBEDDER=fastembed` flips both sides to hybrid
(research embed-on-store + answer RRF); unset keeps byte-identical
keyword-only bm25.

### Container

The image's CMD is the service entrypoint with a `/healthz` liveness
probe; the build-time offline eval suite is unchanged. Note: the tagged
v0.1.0 image predates the entrypoint — its CMD still runs the offline
suite; the service CMD ships with the next image build. The fail-closed
env is not defaulted, so provide configuration explicitly:

```bash
docker run -p 8080:8080 \
  -e DO_SIFT_OWNERS="me" -e DO_SIFT_SEARCH_PROVIDER=fixture \
  -e DO_SIFT_MODEL_PROVIDER=fixture \
  -e DO_SIFT_DEV_BYPASS=1 -e DO_SIFT_DEV_OWNER=me \
  do-sift:dev
```

The image binds `0.0.0.0` inside the container namespace (publish
selectively with `-p`); the server itself still has no TLS or rate
limiting — reverse-proxy duty.

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
- Live search (Wikipedia) exists behind its dated terms gate; live LLM
  adapters and remote Turso via the entrypoint remain behind their
  recorded gates (no credentials exist in this environment; paid APIs
  need explicit grants). Extraction is a block heuristic after host
  HTML→text preprocessing — no DOM parsing (SRC-03 scope). Budgets are
  not yet env-wirable in the entrypoint; the fixture/live-search posture
  makes no billable calls.
- Remote Turso behavior (DDL-in-transaction parity) is tested locally only
  until the sources.md activation gate.
