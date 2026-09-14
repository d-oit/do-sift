# Release candidate v0.1.0 — checklist and receipts

Status: **candidate assembled and validated; NOT published.** Publishing
(git tag, GHCR push, npm publish, deployment) is a separate approval-gated
step per AGENTS.md. Prepared 2026-09-14 via the `prepare-release` skill
(OPS-04, plans/005-007-brw-cmp-later.md).

## Candidate identity

| Field         | Value                                                                                                                                                           |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Version       | 0.1.0                                                                                                                                                           |
| Commit (SHA)  | `485ed75d99338cb8cea830f24b6758754807d820` (main)                                                                                                               |
| release:check | PASS — versions consistent, lockfile in sync, `## [0.1.0]` changelog entry present, migration chain applies from the empty fixture, tag `v0.1.0` does not exist |
| Full check    | PASS — all 7 steps on the exact SHA (prettier, eslint, typecheck, policy, skills, tests, evals)                                                                 |

## Artifacts (local, `dist/release/v0.1.0/` — gitignored)

| Artifact        | Reference / digest                                                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Container image | `do-sift:v0.1.0` — image ID `sha256:4f709352009e7ed767e4760ac0fb59fa01e8e3a6215666ac7bdfc5b4b4d149b7` (local build; registry digest materializes at push) |
| Source archive  | `do-sift-v0.1.0-src.tar.gz` — `git archive` of the candidate SHA                                                                                          |
| SBOM            | `sbom-cdx-0.1.0.json` — CycloneDX 1.5 from `npm sbom` (lockfile-level)                                                                                    |
| Checksums       | `sha256sums.txt` (SHA-256 over the archive and the SBOM)                                                                                                  |
| Provenance      | Not recorded locally; SLSA/buildx provenance attestations are produced at the publish push (`docker buildx --provenance=mode=max`)                        |

Image build detail: `npm run eval:offline` runs **inside** the image at
build time and passed there — the deterministic suite (0 network, 0 model
calls, local ONNX) is the image payload, per the Dockerfile header and
INV-006. The offline eval suite is an honesty gate, not a quality claim.

## Migration notes

Migrations 0001–0005 apply forward-only (release:check validated the chain
from the empty fixture):

- `0001_owners.sql` — owner model
- `0002_core_tables.sql` — documents, passages, requests, answers, feedback, episodes, jobs, usage_ledger
- `0003_usage_ledger_expires_at.sql` — budget reservation expiry
- `0004_passages_fts.sql` — FTS5 index (bm25 retrieval)
- `0005_passage_embeddings.sql` — passage embeddings (hybrid retrieval; RET-02)

All are additive; no destructive statements. First deployment starts from
an empty database and applies 0001→0005 in order. Existing dev databases
migrate forward in place.

## Rollback

First release — **no previous deployed image digest exists** to roll back
to; rollback means "do not deploy" or redeploy whatever artifact (if any)
preceded this outside this repo's records. All migrations in this release
are additive, so a rollback of the image leaves the database compatible
with the previous schema; if data must be reverted, use the OPS-01
backup/restore procedure (`docs/deployment.md`) — restore from a
pre-migration snapshot rather than down-migrating (no downgrade scripts
exist).

## Open risks at candidate time

See `plans/risks.md` for the full register. The ones that bear on this
candidate specifically:

- **R-06** — citation validation proves existence against stored evidence,
  not entailment: no answer-quality claims are made anywhere; the QUAL
  (manual eval) gate remains the only source of quality statements.
- **R-08** — no independent security review yet; the candidate carries the
  security negative-test suites (CORE-10) and the policy/CI guardrails,
  but single-maintainer review limits stand.
- **Packaging caveat** — the server entrypoint under `apps/` is still
  pending; the image CMD currently runs the offline verification suite
  (per the Dockerfile header). This is a verification image, not yet a
  deployable service image; `docs/deployment.md` documents the interim
  composition.
- The pre-existing local image `do-sift:0.1.0-rc` (`2608fa09c9f7`) was
  built from the pre-commit working tree and is **superseded** — it must
  not be used as the candidate.
