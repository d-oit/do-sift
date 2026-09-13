---
name: integrate-provider
description: Integrate an external API (search or model provider) behind an existing plugin adapter, including terms/quota verification and offline tests. Use when wiring a new LLM or search API, or when the user names a provider like Tavily, Brave, Groq, Gemini, or Ollama.
---

# integrate-provider

## Procedure

1. **Terms gate first.** Record in `plans/sources.md`: current API terms,
   quota, billing behavior (does a key imply paid risk?), result metadata,
   and — for search — **content storage rights**, with checked date and URL.
   No entry → the provider stays fixture-only.
2. Implement behind the existing adapter interface (`SearchProvider.search`
   or `ModelProvider.complete/stream` from `packages/contracts`). Provider
   SDK objects never cross the zod boundary into stored contracts.
3. Timeouts, retries (bounded, idempotent), and error mapping: provider
   failures degrade to evidence-only or a typed error — never a hang, never
   an automatic paid fallback.
4. Budget integration: every call reserves in `usage_ledger` first
   (`paid` capability requires grant); reconcile with provider-reported
   usage afterward.
5. Offline tests use recorded fixtures (no network, no keys). A separate,
   explicitly enabled live test may exist but must never run in CI.
6. Run `npm run check` and attach evidence to the task in the plan file.

## Rules

- Never commit keys or record real prompts in fixtures/logs.
- Price metadata must be verified against the provider's current page, not
  memory or older research.
