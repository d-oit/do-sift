# ADR 0011 — Ship and type on Node 24 LTS

Status: accepted 2026-11-09

Supersedes the Node floor clause of
[`0001-typescript-node.md`](0001-typescript-node.md) and
`docs/decisions/0008-node-only-no-python.md`, which both state "Node.js
(>= 22)". Everything else in both records — TypeScript only, no authored
Python, prebuilt native binaries required — still holds and is restated here
unchanged.

## Context

The repository declared four different Node pins that disagreed with each
other:

| Pin            | Declared  | Resolves to                        |
| -------------- | --------- | ---------------------------------- |
| `.nvmrc`       | `22`      | current 22.x (latest, patched)     |
| `engines.node` | `>=22`    | admits 23 and 25 (non-LTS) as well |
| `volta.node`   | `22.14.0` | a fixed patch from 2025-02-11      |
| `Dockerfile`   | `22-slim` | current 22.x (latest, patched)     |
| `@types/node`  | `^24.0.0` | the Node 24 API surface            |

Two consequences made this a correctness problem rather than tidiness:

- **The Volta pin was seven Node 22 security releases behind** (newest
  `v22.23.4`, 2026-10-20). CI uses `actions/setup-node` with a floating `22`
  and the container uses the floating `22-slim` tag, so both silently receive
  patches while every Volta developer runs the stale one. No sensor could
  catch this: nothing in CI resolves the Volta pin.
- **Types and runtime disagreed by a major.** `@types/node` described Node 24
  APIs while Volta developers and the shipped image ran Node 22, so code could
  typecheck against APIs absent from the runtime. CI's Node 22 leg catches
  that only after a push.

The blocking question was which major to standardise on. Node 22 entered
maintenance on 2025-10-21 (EOL 2027-04-30); Node 24 is the active LTS
(maintenance 2026-10-20, EOL 2028-04-30). Both are still supported, so the
choice is about where to spend the next migration.

The usual objection to a runtime major bump — native ABI — does not apply
here. `@libsql/client` and `onnxruntime-node` ship Node-API `napi-v3`
prebuilts, which are ABI-stable across majors by design. CI already tests
Node 24 and `release.yml` already builds on 24, so the move is to a runtime
the project already exercises.

## Decision

Node 24 is the supported floor. Every pin moves to it:

- `.nvmrc` → `24`
- `engines.node` → `>=24`
- `volta.node` → a current `24.x` patch
- `Dockerfile` → `node:24-slim`
- `@types/node` → the Node 24 typings, kept current
- CI's Linux matrix → `[24, 26]`, with Windows and release staying on 24

Node 22 becomes "compatible but no longer the floor": it still passes the
suite, and CI may keep a leg on it to prove that, but no artifact or type
pin claims it.

## Consequences

- The Volta and container pins now track a line that receives patches for
  roughly another two years, and types match the runtime that ships.
- `engines.node: ">=24"` rejects Node 22 installs that used to work. That is
  intended — a floor that admits an untested major is not a floor — but any
  operator pinned to 22 must upgrade before the next release.
- Moving off `>=22` also stops silently admitting Node 23/25, which are never
  LTS and never tested.
- Deployment targets must offer Node 24 images; Debian-slim base images exist
  for every supported architecture, and the arm64 native-prebuilt constraint
  from ADR 0001 is unchanged by this record.
- This changes the floor, not the runtime boundary: no authored Python, no
  Python-driven native build, and no interpreter dependency is reintroduced.
- The review that produced this record also found that the arm64 tokenizer
  prebuilt gap (`@anush008/tokenizers` ships `linux-x64-gnu`,
  `win32-x64-msvc`, `darwin-universal` only) blocks the arm64 deploy
  candidate named in ADR 0001. That is tracked separately in
  `plans/044-dependency-review-2026-11.md` (DRV-06) and is not solved here.
