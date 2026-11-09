# Plan 041 — Harden the guardrails Rego sync gate and cover it with tests

Status: done (2026-11-09, PR #140 squash-merged as 33f50b8); follow-up from plan 040.

## Context

`scripts/guardrails-check.ts` (plan 039, sensor since plan 040) only checked
that every JSON value appears quoted _somewhere_ in `policies/guardrails.rego`.
It had no tests, and that substring check misses:

- a value present only in a Rego comment;
- a value listed under the wrong set (e.g. a captcha action under stealth);
- stale extra Rego entries the JSON no longer has;
- `consentRequired`, `siteAccessRequired`, and `siteScopedActions`
  mismatches (not compared at all).

ADR 0011 says the gate exists so the two documents cannot drift; this plan
makes that true without changing the decision (the gate only gets stricter),
so no new decision record is needed.

## Tasks

| ID     | Task                                                                                                                                                                                                        | Status |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| GRX-01 | Extract a pure `scripts/guardrails/sync.ts` (behaviour-preserving); CLI stays argv-identical and validates JSON with the contracts `GuardrailsPolicy` schema                                                | done   |
| GRX-02 | Red: `scripts/guardrails/test/sync.test.ts` — in-sync baseline, JSON-only site, stale Rego entry, comment-only value, wrong set, gate mismatches, extra capability, missing set, missing default deny, CRLF | done   |
| GRX-03 | Harden: parse Rego data sets (comment-stripped, brace-matched) and compare with the JSON in both directions                                                                                                 | done   |
| GRX-04 | `stale.ts` inputs include `scripts/guardrails/`; `docs/guardrails.md` describes the stricter gate                                                                                                           | done   |
| GRX-05 | Verify on Windows and WSL2: new tests, dev-harness tests, `npm run signals -- verify --set feedback`                                                                                                        | done   |

## Decisions

- Comparison is set equality per Rego data set: `default_deny_sites`,
  `prohibited_<category>` (hyphens → underscores), `grant_required`,
  `consent_required`, `site_access_required`, `site_scoped_actions` (union
  across capabilities, matching the flat Rego set), and `allowed_actions` per
  capability. Unknown `prohibited_*` sets in the Rego are findings.
- The parser covers the data-document subset the export uses (set literals,
  `set()`, one object of sets); rule bodies are ignored. It is not a Rego
  parser, and a construct it cannot read becomes a finding, never a pass.
- Line endings are normalized before parsing, so a CRLF checkout (Windows
  without `.gitattributes`) behaves like LF on Linux, macOS, and WSL2.
- `guardrails.json` stays the single source of truth; no change to the Rego
  content, `scripts/check.ts`, `scripts/policy.ts`, `plans/invariants.json`,
  or `.github/workflows`.

## Evidence (2026-11-09, base 375c12a = origin/main)

Commands (Windows 11, Node v24.9.0):

- Red: `npx vitest run scripts/guardrails/test/sync.test.ts` after the
  behaviour-preserving extract → 9 failed / 4 passed, one failure per gap.
- Green: same command after hardening → 13/13 passed.
- `npx tsx scripts/guardrails-check.ts` → PASS on the shipped files.
- `npx vitest run` (full suite) → 93 files, 990/990 passed.
- `npm run signals -- verify --set verification` → red twice: every sensor
  PASS except `tests`, which timed out at 5000 ms in dev-harness tests that
  fingerprint the repo or run signal sets (`stale.test.ts`
  computeSetFingerprint, `verify.test.ts` runSignalSet), different tests each
  run; the second run was ~2x slower across all sensors. In isolation the
  slowest of those tests takes ~2 s. Halted per the AGENTS.md stop condition.

Base comparison (Windows, clean clones on C: NTFS, sequential, no other load;
`npm ci` then `npm run signals -- verify --set verification`):

- Base 375c12a → green; `tests` 23.9 s.
- Base + plans 040/041 changes → green, `guardrails` PASS; `tests` 29.4 s
  (13 new tests).
- Conclusion: the two red runs in the working tree were environmental (load on
  this machine, including an orphaned concurrent run), not caused by this change.

Commands (WSL2 Ubuntu, Linux 6.18 microsoft-standard-WSL2, Node v22.23.2;
fresh clone in `/tmp` + `npm ci --ignore-scripts`):

- `npx vitest run scripts/guardrails scripts/dev-harness` → 8 files, 95/95.
- `npm run signals -- verify --set feedback` → green, `guardrails` PASS.
- Negative: a stale `captcha-farm` entry in the Rego → the CLI exits 1 with
  a `prohibited_captcha` finding naming it; restored → exit 0.

## Risks

- The working tree's dev-signal state holds 2 `tests` strikes from the
  environmental timeouts; the next verification run there should be done on an
  idle machine (a third consecutive failure halts the sensor).

- A future Rego refactor that renames a data set fails the gate until the
  mapping in `sync.ts` is updated — intended (fail closed).
