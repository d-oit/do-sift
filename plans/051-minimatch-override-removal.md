# Plan 051 — Remove the `minimatch` override (R-20)

Status: in-progress (2026-11-19). Owner: maintainer.

Plan 043 fixed Dependabot alert #18 (`minimatch` GHSA-g3hv-75wg-m249) with a
temporary npm `overrides` entry (`minimatch: ^11.0.5`), because no
`eslint`/`typescript-eslint` release accepted 11 yet. Risk R-20 in
`plans/risks.md` records the removal condition: remove the override once all
three consumers declare a patched `minimatch` range.

Spike finding (2026-11-19): checking `npm view` (latest tags) alone is
misleading — the repo's pinned toolchain still declares `^10`, so deleting the
override with no other change re-resolves `minimatch@10.2.6` (verified via
`npm install` + `npm ls`). But the very next minors fix it:

| Consumer                               | Installed (declares) | Latest minor (declares) |
| -------------------------------------- | -------------------- | ----------------------- |
| `eslint`                               | 10.14.0 (`^10.2.6`)  | 10.15.0 (`^11.0.5`)     |
| `@eslint/config-array`                 | 0.23.5 (`^10.2.6`)   | 0.23.6 (`^11.0.5`)      |
| `@typescript-eslint/typescript-estree` | 8.72.2 (`^10.2.2`)   | 8.73.0 (`^11.0.1`)      |

All three latest minors are inside the existing `^` ranges in root
`package.json`, so the slice is a lockfile refresh (`npm update eslint
typescript-eslint`), plus deleting the now-redundant `overrides` entry. No
range edits, no new network, no behavior change beyond the patched resolver.

## Task IDs

| ID | Task | Status |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ || DEP-07 | Refresh `eslint`/`typescript-eslint` to the minors declaring `minimatch ^11`, remove `overrides.minimatch`, confirm `npm ls minimatch` resolves 11.x natively | done |
| DEP-08 | Verify with full `npm run check` (lint toolchain changed) and record evidence here; R-20 flips to done when this merges | done |

## Evidence

- `npm view` consumer ranges (table above).
- `npm ls minimatch --all` after refresh: `minimatch@11.0.9` under `eslint@10.15.0` / `@eslint/config-array@0.23.6` / `@typescript-eslint/typescript-estree@8.73.0`, no override.
- `npm run check` (full, 2026-11-19): all PASS except `prettier` on this plan file; fixed with `prettier --write`, re-verified via `npm run check:fast` before push.
