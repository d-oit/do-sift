# Plan 043 — Fix Dependabot alert #18 (minimatch GHSA-g3hv-75wg-m249)

Status: done locally (2026-11-09). Dev-only toolchain change; no runtime code.

## Context

Dependabot alert #18: `minimatch` >= 7.0.0, < 11.0.1 has a potential denial of
service via globparts amplification (GHSA-g3hv-75wg-m249, CVE-2026-118764,
moderate). It is a transitive **development** dependency: `eslint`,
`@eslint/config-array`, and `@typescript-eslint/typescript-estree` resolve
`minimatch` 10.2.6. The fix exists only in 11.0.1+; there is no 10.x backport,
and the latest `eslint` (10.14.0), `@eslint/config-array` (0.23.5), and
`typescript-estree` (8.72.2) still declare `^10`, so no upstream bump fixes it.

## Tasks

| ID     | Task                                                                         | Status |
| ------ | ---------------------------------------------------------------------------- | ------ |
| DEP-03 | API audit: what the three consumers call on `minimatch` vs the 11.0 removals | done   |
| DEP-04 | `overrides.minimatch: ^11.0.5` in `package.json`; lockfile refreshed         | done   |
| DEP-05 | Verify: lint file set unchanged, `npm audit` clean, verification set green   | done   |
| DEP-06 | Risk R-20: remove the override once upstream declares `^11`                  | done   |

## Decisions

- An npm `overrides` entry instead of waiting: the consumers only use
  `new Minimatch(pattern, { dot: true })`, `.match(path)`, `.match(path, true)`,
  `.pattern`, and `minimatch(path, pattern, { dot: true })`. 11.0 removes
  `makeRe()`, `Minimatch#regexp`, `AST`, `debug`, `matchOne`, `slashSplit`,
  and `maxExtglobRecursion` — none of which they use.
- 11.0 changes `partial` matching with `**` and trailing-empty-portion
  semantics; eslint uses `partial` for directory traversal, so the lint file
  set was compared before and after (identical, below).
- Range `^11.0.5` (latest at the time), not an exact pin, so patch fixes flow.
- The override is temporary: R-20 in `plans/risks.md` records the removal
  condition.

## Evidence (2026-11-09, base f9d199c = origin/main)

- `npm ls minimatch --all` before → 10.2.6 under all three consumers; after
  `npm install` → 11.0.5 deduped under all three. New transitive package:
  `@isaacs/nonrecursive-glob-match` 1.1.0 (same author/license, dev-only);
  `brace-expansion` 5.0.12 satisfies the new `^5.0.12`.
- `npm audit --omit=optional` → found 0 vulnerabilities.
- `npx eslint . --format json` before and after → 226 files, 0 errors,
  0 warnings both times; the sorted file lists are identical.
- Verification: `npm run check:fast`, pre-commit feedback set, pre-push
  verification set, PR CI (reported in the handoff).

## Risks

- R-20 (open): the override can mask a future upstream `minimatch` 12 bump;
  remove it when `eslint`, `@eslint/config-array`, and
  `@typescript-eslint/typescript-estree` all declare a patched range.
