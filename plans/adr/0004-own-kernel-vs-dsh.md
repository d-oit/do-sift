# ADR 0004 — Own minimal plugin kernel; deepseek-harness as concept

Status: accepted 2026-09-06 (spike FND-10 may append a follow-up)

## Context

The owner asked for an everything-is-a-plugin architecture "like
deepseek-harness" (dsh). dsh is a TypeScript/Cordis harness with a huge
adoption but is an explicitly developer-preview project announcing
compatibility-breaking changes, and it vendors a `python/` tree — in tension
with ADR 0001 if adopted wholesale.

## Decision

We build a **minimal first-party kernel** (`packages/kernel`): manifest
validation, lifecycle (`activate`/`deactivate`), capability/permission model
with explicit grants, and a local registry. dsh/Cordis is a concept
reference. Adoption of Cordis or dsh as a dependency is permitted only via a
spike (FND-10) that demonstrates concrete benefit over the first-party kernel
without reintroducing a Python runtime requirement or preview-churn risk;
the outcome is recorded as an addendum here.

## Consequences

- Kernel stays tiny; contracts live in `packages/contracts` (the only shared
  dependency); all features — including the research pipeline itself — are
  plugins.
- Plugins declaring `paid` or `computer` capabilities require recorded,
  explicit grants and stay disabled in CI (INV-003).
- Plugin code is loaded through the kernel's capability-checked services,
  not granted raw `fs`/`net`. Isolated-runtime hardening is a later
  evaluation (risk R-04), tracked in the risk register.

## Addendum — FND-10 adoption spike (2026-09-13; outcome: no adoption)

The spike this ADR reserves was run per the spike-runner workflow
(plans/001 FND-10): the kernel round-trip (schema-validated config →
activate → capability-gated activation → deactivate) was re-implemented on
the actually installed cordis 4.0.0-rc.10 and passed with exit code 0, so
the adoption route is technically viable. It is still refused, on this ADR's
own terms:

- **No concrete benefit over the first-party kernel.** Cordis provides
  context/fiber lifecycle machinery, but none of what this kernel exists
  for: manifest validation is per-plugin and opt-in (a `Config` standard
  schema) rather than a registration-time gate before any code loads, and
  capabilities/grants/deny-by-default do not exist in cordis — the spike had
  to re-implement the INV-003 check inside plugin `apply()` bodies. Adopting
  cordis would add ~1545 lines of runtime JS plus two dependencies
  (`@standard-schema/spec`, `cosmokit`) under a security layer we would
  still own entirely.
- **Preview-churn risk confirmed, not hypothetical:** `latest` is
  4.0.0-rc.10 — a release candidate on the stable tag (`next` is a beta) —
  with 166 releases total, 13 in the last six months, newest five days
  before the spike.
- **Python:** the cordis core ships no `.py` files; that ADR concern
  attaches to dsh-the-product, not the framework core. This was the only
  criterion cordis passes.

Behavioral notes from the spike (for the record): cordis refuses
schema-invalid configs by rejecting the plugin promise with its
`ValidationError` (the fiber's `state` field stays PENDING — state does not
reflect this path), and plugin runtimes are keyed by object identity, so
re-plugging one plugin object updates rather than reloads. Spike artifacts
were deleted after findings were recorded; scratch is not maintained code.
The Decision above stands unchanged.
