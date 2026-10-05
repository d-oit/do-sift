# Plan 017 — improvement backlog (repo analysis 2026-10-05)

Status: in-progress (2026-10-05)

Trigger: an analysis pass over the repository after the 016 close-out. The
codebase is green (570/570 tests, check:fast 5/5 after QF-01), but the pass
surfaced two tooling defects, one dependency decision with a newly visible
fix path, and one stale plan pointer. Already-queued work (ANS-11 → ANS-13,
OPS-10, DHC-06, TS-00+) is NOT duplicated here — see `plans/README.md`'s
current queue.

## Analysis evidence (2026-10-05, agent)

Commands and findings:

- `npx vitest run` → **49 files, 570/570 passed**. No test-level rot.
- `npm run check:fast` → **FAIL prettier**: `.cline-home/` (agent session
  data, excluded from git via `.git/info/exclude`) was format-checked.
  Root cause: `prettier --check .` (scripts/check.ts:32) does not read
  `.gitignore`, and `.prettierignore` listed none of the local-only state
  dirs. Fixed as QF-01.
- `npm audit` → **2 vulnerabilities (1 critical, 1 high)** in `tar@6.2.1`,
  a direct dependency of `fastembed@2.1.0` (13 published advisories now
  affect tar ≤7.5.20). New fact: `npm view fastembed@3.0.0 dependencies`
  shows **tar is gone** (`progress`, `@huggingface/hub`,
  `onnxruntime-node@1.21.0`, `@anush008/tokenizers`). A fix path exists
  that plan 016 could not see. Recorded as R-18 + QF-03.
- `npm run eval:offline` → **crashes** with an unhandled
  `TAR_BAD_ARCHIVE` rejection when the fastembed model download fails
  (sandbox proxy returns a 399-byte error body, cached as
  `.fastembed_cache/fast-bge-small-en-v1.5.tar.gz`). Two defects: (a)
  `scripts/eval.ts` `run()` has no `.catch` — the runner dies with a stack
  trace instead of a FAIL report, losing the earlier stages' results and
  the `eval: PASS/FAIL` summary line (INV-006's reporting contract);
  (b) a poisoned model cache artifact is never detected or cleaned, so a
  bad download can brick local evals until the cache is manually deleted.
  Recorded as QF-02. (In CI with network the download succeeds — this is
  a robustness gap, not a current CI failure.)
- `grep` for `neutralizeEvidenceText|frameEvidenceLine|suspectEvidenceMarkers`
  outside `packages/contracts` → **zero hits**: ANS-11 wiring is confirmed
  still open (matches plan 013's queue position — not re-scoped here).
- `apps/server` already wires `DO_SIFT_EMBEDDER=fastembed` end-to-end
  (config.ts:205, main.ts:331-384) and `docs/deployment.md` documents it —
  RET-04's "flip the server answer path to hybrid" follow-up is done; no
  stale queue entry to correct.
- Plan 015's DHC-06 row points at `/tmp/opencode/do-harness-task-gates.md`
  for the upstream issue body; `/tmp` is ephemeral and the file is gone.
  The authoritative copy is the draft inlined in plan 015 itself. Pointer
  corrected as QF-04.

## Tasks

| ID    | Task                                                                                                                                                                       | Status            | Owner       | Evidence |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ----------- | -------- |
| QF-01 | `.prettierignore` mirrors `.gitignore`'s local-only dirs (`.do-harness/`, `.spikes/`, `.fastembed_cache/`, `.hf-cache/`, `.cline-home/`, env/log files)                    | done (2026-10-05) | agent       | below    |
| QF-02 | evals sensor robustness: catch embedder/model-download failure into a fail-closed `eval: FAIL` report (never an unhandled rejection); detect/clean poisoned model cache    | done (2026-10-05) | agent       | below    |
| QF-03 | Evaluate `fastembed@3.0.0` upgrade (removes vulnerable `tar@6.2.1`): spike API compat, re-measure hybrid metrics vs `evals/baselines/retrieval-baseline.json` per ADR 0009 | proposed          | owner-gated | below    |
| QF-04 | Correct plan 015's stale `/tmp` draft pointer (append-only, history preserved)                                                                                             | done (2026-10-05) | agent       | below    |

## Guard rails

- No edits to `scripts/policy.ts`, `plans/invariants.json`, or
  `.github/workflows`.
- QF-02 must fail closed: an unavailable model is a FAIL with a readable
  reason, never a silent pass and never a crash; offline-eval
  determinism (INV-006) is unchanged on the happy path.
- QF-03 is a breaking retrieval-stack decision under ADR 0009 and plan
  016's "Still open" note: it proceeds only with an owner go-ahead, a
  spike-runner pass in `.spikes/`, and a re-measured baseline recorded as
  its own reviewed change. `npm audit fix` is NOT the path (no
  semver-compatible fix exists within fastembed ^2.1.0).
- QF-04 is append-only: add a dated note, do not rewrite DHC-06 history.

### QF-01 evidence (2026-10-05, agent)

Files: `.prettierignore` (+11 lines mirroring `.gitignore`'s local-only
state; comment records that Prettier ignores `.gitignore`).

Commands: `npm run check:fast` → FAIL prettier (`.cline-home/…messages.json`)
before the change → **PASS 5/5** after. No code impact; commit
`059917f` on `cline/wzfn3q4j`.

Status: done.

### QF-04 evidence (2026-10-05, agent)

Files: `plans/015-workflow-compaction.md` — appended a dated note that the
`/tmp/opencode/do-harness-task-gates.md` copy is ephemeral and lost, and
that the inlined draft section in plan 015 is the authoritative text.
History untouched.

Status: done.

## Open risks

- QF-02: the eval runner's happy path must stay byte-identical in output
  contract (`eval: PASS (N deterministic cases…)`); the fix only changes
  the failure path.
- QF-03: fastembed 3.x may change model download mechanics (the
  `@huggingface/hub` dependency suggests a new fetch path) and embedding
  output; the held-out re-measure is the gate, not the version number.
  R-18 tracks the advisory pressure.

### QF-02 evidence (2026-10-05, agent)

Files:

- `packages/storage/src/fastembed-embedder.ts` — `clearModelDownloadArtifacts`
  (exported; removes only `*.tar.gz` download artifacts, never extracted model
  dirs or unrelated files); init detects `TAR_BAD_ARCHIVE` (poisoned cache
  signature), clears the artifacts, retries once; a still-failing init throws
  ONE readable error line naming the cacheDir and the retry failure.
- `packages/storage/test/fastembed-embedder.test.ts` (new, 2 tests) — artifact
  cleanup keeps extracted dirs/unrelated files; missing cache dir → `[]`.
- `scripts/eval.ts` — `describeError` (first-line-only, no stack dump);
  `evalRetrieval()` wrapped in try/catch recorded as a failed case; final
  rejection handler prints `eval: FAIL — runner error: …` and exits 1;
  `DO_SIFT_EVAL_MODEL_CACHE` env override keeps the runner test hermetic.
- `scripts/test/eval-runner.test.ts` (new, 1 test) — spawns the real runner
  against a poisoned tmp cache: asserts exit ∈ {0,1}, `eval: PASS|FAIL`
  summary always printed, no tar stack-dump markers, poisoned marker never
  survives (works offline → clean FAIL, online → recover + PASS).

Commands:

- Red first: `npx vitest run packages/storage/test/fastembed-embedder.test.ts
scripts/test/eval-runner.test.ts` → **3 failed** (missing export ×2, runner
  contract: unhandled `TAR_BAD_ARCHIVE` rejection, no summary line).
- Green: same command → **3/3 passed**.
- Failure-path demo: `DO_SIFT_EVAL_MODEL_CACHE=/tmp/qf02-demo npx tsx
scripts/eval.ts` → **exit 1** with
  `FAIL retrieval stage completed without runner errors — Error: fastembed
model unavailable: cleared 1 corrupt download artifact(s) … but
re-download/init still failed — … TAR_BAD_ARCHIVE` and summary
  `eval: FAIL — 1/26 case(s) failed`; poisoned marker gone.
- `npx vitest run` → **51 files, 573/573 passed**.
- `npm run check:fast` → **5/5 PASS**; `npm run signals -- verify --set
feedback` → **green** (receipt `.do-harness/evidence.feedback.json`).

Self-correction (recorded): the first perl substitution ate template
interpolations in `assert`/`describeError` (`FAIL ` with empty name) — caught
by the failure-path demo output, repaired with escaped replacements, re-verified.

Risks/open questions:

- In this sandbox the model download is proxy-blocked (`AccessDenied` body),
  so the evals sensor still exits 1 HERE — but now with a readable FAIL report
  instead of a crash. CI with network runs the recover path (proven by the
  runner test's cleanup assertion).
- `npm run check` (full) cannot pass in this sandbox for the same
  environmental reason; happy-path output contract is unchanged
  (`eval: PASS (N deterministic cases, 0 network calls, 0 model calls)`).
- Only `*.tar.gz` artifacts are auto-cleared; a corrupt EXTRACTED model dir
  would still fail init with the wrapped readable error (no auto-delete of
  directories — deliberate, destructive scope stays minimal).

Status: done. do-harness CLI unavailable in this sandbox (`which do-harness`
empty); `npm run signals` used as the enforced path (ADR 0008).

### QF-03 spike note (2026-10-05, agent)

Spike attempted in-scope check: `npm view fastembed@3.0.0` registry access
works, but the embedding model download (huggingface.co egress) is denied in
this sandbox (`AccessDenied` on `fast-bge-small-en-v1.5.tar.gz`), so the
held-out re-measure cannot run here. QF-03 stays proposed/owner-gated;
execute the spike on a machine with HF egress (or CI) after the owner
go-ahead per ADR 0009.
