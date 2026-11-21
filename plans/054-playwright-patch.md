# Plan 054 — Playwright 1.65.0 → 1.65.1 patch (BRW-04 e2e gate)

Status: done (2026-11-21). Owner: maintainer. Merged via PR to be recorded; gate evidence below.

Plan 053 deferred the Playwright patch to batch with the next e2e-touching
change. This is that change: the patch is the work, and the honest BRW-04
e2e (`packages/browser-driver/test/playwright-driver.test.ts`) is the gate.
No range edit is needed (`^1.65.0` already covers 1.65.1); the slice is a
lockfile refresh plus proof the real-browser test still genuinely executes.

## Decision rule (set before updating)

Merge only if **all** hold:

- `npm ls playwright` resolves 1.65.1;
- the BRW-04 e2e runs against a real chromium (not skipped) and passes;
- `npm run check:fast` passes.

A skipped e2e (missing chromium, `DO_SIFT_ALLOW_BROWSER_SKIP=1`) does not
count as evidence — install chromium and rerun.

## Task IDs

| ID     | Task                                                                  | Status |
| ------ | --------------------------------------------------------------------- | ------ |
| BRW-05 | Refresh lockfile to Playwright 1.65.1, run BRW-04 e2e unskipped green | done   |
| BRW-06 | Verify with `npm run check:fast` and record evidence here             | done   |

## Evidence

- `npm ls playwright`: `playwright@1.65.1` under `@do-sift/browser-driver` (range `^1.65.0` unchanged).
- BRW-04 e2e (`--reporter=verbose`, real chromium, no skip env): 3 passed — launch test genuinely executed (318 ms), both refusal guards green.
- `npm run check:fast`: 9/9 PASS (prettier fixed with `--write`, re-verified).
