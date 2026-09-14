# do-sift

**Research with receipts.** A plugin-based, token-frugal web research engine.

do-sift answers questions with verifiable sources: every claim links to stored
evidence, search mode costs zero LLM calls, and answer mode makes at most one
bounded synthesis call.

## Architecture

Everything is a plugin (inspired by the everything-is-a-plugin style of
[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness), adopted as
a concept — not a dependency):

- `packages/kernel` — plugin manifest validation, lifecycle, capability grants
- `packages/contracts` — shared zod schemas (models, search, harnesses, evidence)
- `packages/plugins/*` — model router, search providers, research/browser/computer
  harnesses, extraction, storage, site-access policy, web console

See `plans/000-product-and-decisions.md` for the full decision log and
`docs/architecture.md` for the runtime design.

## Constraints (enforced, not aspirational)

- TypeScript/Node only; no authored Python and no Python runtime requirement.
- Paid API calls require explicit opt-in and verified price metadata.
- Browser automation is policy-gated: no stealth, no CAPTCHA bypass, and
  sites whose terms prohibit automation (LinkedIn and similar) are
  default-deny. See `plans/adr/0005-browser-ethics-boundary.md`.
- Computer automation is local-only, interactive-consent-gated, and disabled
  by default.

## Development

```bash
npm install
npm run check:fast   # format, lint, types, policy, skills validation
npm run check        # fast checks + unit/integration/security tests + build
npm run eval:offline # deterministic retrieval/citation/budget fixtures
```

Requires Node >= 22.

### Dev signal harness

Development checks also run as recorded, receipt-producing signals, ported
from d-o-hub/do-harness concepts (`plans/adr/0007-dev-signal-harness.md`).
Sensors wrap the repo's own check pipeline steps, grouped into named signal
sets: `feedback` for the edit/fix loop, `verification` before claiming a task
done, `release` for release gating. Each run appends to an append-only,
hash-chained event log and writes per-set evidence receipts under
`.do-harness/` (gitignored). A sensor failing 3 consecutive runs is halted —
skipped and reported failed — until `npm run signals -- errors clear --sensor
<name>`; never clear a strike before fixing the cause. Git hooks are optional:
`npm run hooks:install` wires pre-commit to the feedback set and pre-push to
the verification set.

```bash
npm run signals -- verify --set feedback  # fast feedback loop
npm run signals -- status                 # last recorded state per sensor
npm run hooks:install                     # activate pre-commit/pre-push hooks
```

## Deployment

Single-owner pre-alpha deployment: libSQL storage (local file by default,
Turso behind env config), owner-allowlist auth, HTTP server intended for
loopback or a TLS-terminating reverse proxy. See
[docs/deployment.md](docs/deployment.md) for configuration, auth, backup
cadence, and known limits.

## Status

Pre-alpha. FND, CORE, SRC, ANS, BRW, and CMP milestones are complete (see
`plans/`); OPS in progress (`plans/005-007-brw-cmp-later.md`).

## License

MIT
