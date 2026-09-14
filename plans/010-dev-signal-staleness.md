# Plan 010 — dev-signal staleness + verify --only/--json coverage

Status: done (2026-09-13)

Goal: close the two items plan 008 explicitly registered "for later plans":
(a) `signals status` cannot tell whether a green receipt still describes the
current working tree (upstream do-harness parity: staleness detection), and
(b) the CLI `--json` verify path was exercised by review only. Per ADR 0008
the first-party CLI remains the enforced path; this plan extends it without
breaking the frozen interface (all schema changes are optional fields).

## Tasks

| ID     | Task                                                                                                                  | Status | Owner | Evidence |
| ------ | --------------------------------------------------------------------------------------------------------------------- | ------ | ----- | -------- |
| DSH-07 | Workspace fingerprint + `stale` status verdict: stamp sensor_result events and evidence receipts, surface in `status` | done   | agent | below    |
| DSH-08 | `verify --only <sensor>` (upstream parity) + CLI `--json` test coverage with a real fast sensor                       | done   | agent | below    |

**Row-status correction (2026-09-14, follow-up agent):** both task rows
still read `in-progress`/`pending` although the evidence section below had
been recorded complete the same day (68/68 dev-harness tests; verification
set green). Flipped to `done` on the strength of the recorded evidence; no
evidence content altered.

## Decomposition (htn-planner workflow per plan 009)

Vertical slice; preconditions met (frozen interface in plans/008, CLI/store
sources owned by this series, no other dev-harness editor). Ordered
subtasks:

1. Red tests: pure `statusVerdict` matrix; event/evidence fingerprint
   round-trip; `runSignalSet` stamps `workspaceSha256` and honors `only`;
   CLI `status` STALE path with a synthetic fingerprint; CLI
   `verify --json --only skills` against the real registry.
2. Implement: optional `workspaceSha256` on WorkflowEvent + EvidenceReport
   (Hex64); pure `stale.ts` verdict helper; fingerprint helper in cli.ts
   (sha256 over `git rev-parse HEAD` + `git status --porcelain=v1`;
   undefined outside a git repo → no staleness judgment, backward
   compatible with pre-fingerprint events); `verify --only` restricted to
   members of the chosen set (usage error otherwise).
3. Exit-code semantics: `status` exits 0 only when every sensor verdict is
   green; stale counts as not-green (a receipt that does not cover the
   current tree is not a receipt for the current tree). Partial `--only`
   runs stamp only the sensors actually run; untouched sensors keep their
   older fingerprints.
4. Docs: dev-signals skill gains the stale verdict and the fix-forward
   habit (prettier --write before re-verify; the format sensor fired 3×
   this sprint — steering loop).
5. Verify via dev-signals (feedback in the loop, verification at handoff);
   record evidence here.

## DSH-07 + DSH-08 evidence (2026-09-13, agent)

**Files:** `scripts/dev-harness/schemas.ts` (optional `workspaceSha256`
Hex64 on WorkflowEvent + EvidenceReport — backward compatible: old events
without it still validate), `scripts/dev-harness/stale.ts` (new, pure:
`statusVerdict` matrix), `scripts/dev-harness/index.ts` (+export),
`scripts/dev-harness/verify.ts` (`workspaceSha256` stamping on sensor_result
events and the receipt; `only` member selection with usage error for
non-members), `scripts/dev-harness/cli.ts` (`computeWorkspaceFingerprint`:
content-based — sha-256 over the sorted (path, content hash) pairs of every
tracked and untracked non-ignored file, undefined outside a git repo;
`verify --only`; `status` STALE verdicts + roll-up
`status: green | red | stale` with exit 0 only on all-green),
`scripts/dev-harness/test/stale.test.ts` (new), `test/verify.test.ts` (+2),
`test/cli.test.ts` (+4), `.agents/skills/dev-signals/SKILL.md` (stale
verdict, fix-forward habit, `--only`, stale-citation rule).

**Design flaw found and fixed same-task:** the first fingerprint hashed
`git status --porcelain` output. Live verification exposed it as
ineffective — porcelain records file STATES, not contents, so re-editing an
already-modified or already-untracked file produced the identical
fingerprint and kept stale receipts green (observed directly: tests/evals
receipts from before a plan-file edit still read green). Replaced with
content-based hashing; the flaw and fix are recorded here rather than
silently rewritten.

**Design:** staleness is judged only when both fingerprints exist —
pre-DSH-07 events (no stored fingerprint) and non-git contexts (no current
fingerprint) keep the original green/red/missing semantics. The roll-up
preserves frozen behavior exactly: all-missing still prints `status: red`
with exit 1; stale sits between red and green (red dominates when both
appear). `--only` requires membership in the chosen set so a receipt can
never contain sensors outside its set; a partial run stamps only the
sensors actually run, so untouched sensors correctly age to stale. The
fingerprint includes untracked non-ignored files (conservative: new files
stale the receipt; `.do-harness/` and `.spikes/` are gitignored and do not).

**Commands:** `npx vitest run scripts/dev-harness` → 68/68 pass (57 prior +
11 new: statusVerdict matrix incl. outside-git-repo and pre-fingerprint
cases; fingerprinted-event store round-trip with chain intact;
runSignalSet stamping + `only` member/non-member; CLI STALE path with a
synthetic fingerprint; CLI backward-compatible green on pre-fingerprint
receipts; CLI `verify --json --only skills` real-sensor receipt (~1s — the
one sanctioned deviation from plan 008's no-real-sensors CLI-test rule,
closing plan 008's deferred `--json` coverage gap); `--only` non-member
usage error). One typecheck failure during the slice (exactOptionalPropertyTypes
on the `only` option) fixed with conditional spread. Dev-signal receipts:
`npm run signals -- verify --set feedback` → green; `npm run signals --
verify --set verification` → green, all 7 sensors; `npm run signals --
status --set feedback` → all PASS, `status: green` under the new verdict
logic. No edits to `plans/invariants.json`, `scripts/policy.ts`, or
`.github/workflows`.

**Risks / open questions:** the fingerprint covers the whole working tree,
so ANY edit stales every sensor — intended (a receipt describes one exact
tree; upstream do-harness parity), and `--only` provides a cheap refresh
path for a single sensor; a future refinement could scope fingerprints to
per-sensor `when-changed` globs (upstream parity, deferred). Chain hashing
now covers events with the new field; old logs remain valid (field is
optional). `--record`/`--evidence`/`--strict` upstream flags remain
unported (no current need).

**When-changed scoping — evaluated 2026-09-13, rejected for now:** upstream
sensors carry `when-changed` globs so a run skips sensors whose inputs did
not change. do-sift's 8 sensors all read the whole tree (prettier, eslint,
tsc, policy, skills, vitest, evals, release-check), so glob scoping would
either skip sensors that could still be affected by cross-cutting edits
(dishonest receipts) or degenerate to "always run" for every sensor. Not
built; revisit only if the registry grows per-area sensors (e.g. a
packages/<x>-only typecheck) or full-set runtime becomes a daily problem.
