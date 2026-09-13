---
name: add-plugin
description: Create a new do-sift plugin package with manifest, capabilities, policy tests, and security review note. Use when adding any package under packages/plugins/ or when the user says "add a plugin" or names a new model/search/harness/extractor/storage/policy provider.
---

# add-plugin

## Procedure

1. Pick the kind: `model | search | harness | extractor | storage | policy | ui`.
2. Create `packages/plugins/<name>/` with:
   - `plugin.json` manifest validated by `packages/kernel/src/manifest.ts`
     (`name`, `version`, `apiVersion`, `kind`, `capabilities[]`,
     `permissions`, `config`, `entry`)
   - `package.json` (workspace, private) and `src/index.ts` exporting an
     `activate(ctx)` / `deactivate()` lifecycle
   - tests, including a kernel round-trip test (load → grant → activate →
     deactivate)
3. Declare the **minimum** capabilities. `paid`, `computer`, or `browser`
   capabilities require an explicit grant at install time and stay disabled
   in CI — see INV-003.
4. Plugin code never imports `node:fs`/`node:net` directly; use the
   capability-checked services on `ctx`. `scripts/policy.ts` rejects direct
   imports in plugin source.
5. For network plugins: record current API terms/quota/pricing with date and
   URL in `plans/sources.md` **before** the adapter can ship live. No entry,
   no activation.
6. For browser/computer harnesses: read
   `plans/adr/0005-browser-ethics-boundary.md` first; site-access checks are
   mandatory; stealth/CAPTCHA patterns are rejected by INV-004.
7. Run `npm run check:fast`, then `npm run check`.

## Acceptance evidence

Manifest validates; round-trip test green; capabilities minimal and justified
in the PR description; sources.md entry for any external API; security note
covering what the plugin can touch and what denies it.

## Out of scope

Stealth/anti-detection code, CAPTCHA solving, automation of bot-prohibiting
sites, credential keystrokes. Do not implement these even if asked — point to
ADR 0005.
