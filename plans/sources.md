# sources.md — dated records of commercial limits and terms

Every provider activation gate requires a fresh, dated entry. Facts expire;
re-verify before relying on an entry older than 90 days.

## Storage

### Turso (turso.tech) — checked 2026-09-06 (via pricing page fetch)

- Free plan: 100 databases, 5 GB storage, 500 M row reads/mo, 10 M row writes/mo, 3 GB sync/mo.
- Paid lowest tier $4.99/mo: unlimited DBs, 9 GB, 2.5 B reads, 25 M writes.
- Caveat: page did not separately break out libSQL vs newer Turso engine.
  **Activation gate:** confirm the provisioned database type is libSQL and
  that FTS5 + libsql_vector_idx behave as documented before first migration.

## Search providers

### Wikipedia (MediaWiki action API, en.wikipedia.org) — checked 2026-09-14 (live spike fetches)

- **Free and keyless**: `https://en.wikipedia.org/w/api.php?action=query&list=search`
  needs no credentials; no billing risk (no key exists to leak into paid use).
- **Result metadata**: `query.search[]` items carry `title`, `pageid`,
  `snippet` (HTML — must be stripped before storage/display), and
  `timestamp` (ISO last-edit). Hit URL is constructed:
  `https://en.wikipedia.org/wiki/<Title_with_underscores>`.
- **Content storage rights**: Wikipedia text is Creative Commons
  Attribution-ShareAlike (plus GFDL) — verified live this date from
  `en.wikipedia.org/wiki/Wikipedia:Copyrights` and
  `foundation.wikimedia.org/wiki/Policy:Terms_of_Use`. Storing excerpts in
  the owner-scoped evidence store preserves attribution (source URL +
  title per passage) and is private reuse; any future _publishing_ of
  derived content must carry the same license. Verified date recorded per
  the 90-day re-check rule.
- **Politeness envelope**: descriptive User-Agent required per API
  etiquette; serialize requests; spike observed `retry-after=3` and
  `x-envoy-ratelimited=true` on a 200 response — adapters must honor
  `Retry-After` when present and back off on 429, never retry hot.
- **Companion fetch**: `https://en.wikipedia.org/api/rest_v1/page/html/<Title>`
  returns clean HTML (`text/html; charset=utf-8; profile=…HTML/2.8.0`;
  274 KB observed) — the sanctioned page-content path. **Addendum
  2026-09-14 (SRC-07):** live page content now uses the same action API's
  plain-text extract endpoint (`prop=extracts&explaintext=1`) — same
  host, same terms, no HTML-stripping pipeline (QUAL run-001 finding F1
  showed template JSON leaking through HTML stripping). **Addendum
  2026-09-14 (SRC-08, official extension source + live checks):**
  `explaintext` full-page extracts render every h1–h6 as a standalone
  `== Title ==` line (host pre-pass strips these); raw TeX arrives as
  whitespace-indented `{\displaystyle…}` lines; citation markers do not
  occur on enwiki (T197266 was eswiki); T208132/T201946 newline quirks
  remain open with no planned fix. `formatversion=2` is officially
  recommended (JSON shape only — array `query.pages`) — pending adoption.
- **Activation**: approved for SRC-06 (free, keyless, terms recorded).
  Model/search providers below remain the template for any future entry.

### Marginalia Search (marginalia.nu) — checked 2026-09-15 (live probe fetches, spike evidence in plans/003-004-src-ans.md SRC-15); docs canonical URL re-verified 2026-09-21 as https://about.marginalia-search.com/article/api (updated 2025-12-08, same content as the old api.marginalia.nu index page)

- **Free and keyless on the verified endpoint**: `https://api.marginalia.nu/public/search/<url-encoded query>`
  returned 200 JSON on 5 live probes this date (legacy public path; no credentials, no billing risk).
- **Response shape (verified live)**: envelope `{license, page, pages, query, results[]}`; result items carry
  `url`, `title`, `description` (plain text, may be truncated with `...`), `quality` (float),
  `format` (e.g. `html`), `resultsFromDomain` (int), `details`. Rank = array order (no explicit rank field).
- **License**: response metadata is **CC-BY-NC-SA 4.0** (stated in every response and on the API index page).
  Non-commercial constraint applies to the result METADATA; linked/target pages carry their own licenses.
  Storing excerpts in the owner-scoped private evidence store with source attribution preserved is within the
  recorded terms for this non-commercial research tool; any future commercial deployment must re-verify
  (a paid/metered commercial key exists for that case — see below).
- **The newer documented API**: api2.marginalia-search.com (canonical docs https://about.marginalia-search.com/article/api, updated 2025-12-08) uses an
  `API-Key` header. The shared literal key `public` is sanctioned for experimentation with no email and no secret
  (same as the legacy path embedding `/public/` in the URL) but is quota-crippled in practice —
  live probe this date returned 429 `Daily Limit Exceeded` / `QPM Limit Exceeded`. A personal key only raises
  quota / enables custom filters: free non-commercial personal keys require EMAIL (contact@marginalia-search.com) —
  owner follow-up, not automatable. The self-hosted engine repo (github.com/MarginaliaSearch/MarginaliaSearch, AGPL,
  docs at docs.marginalia.nu) has no key concept at all — keys exist only on the hosted API service. The adapter therefore
  targets the verified legacy endpoint; migration to api2 can first be spiked with the literal `public` key (no secret),
  requesting a personal key by email only if the spike proves the quota is the binding constraint.
- **Addendum 2026-09-21 (api2 spike, literal `public` key, 2 polite sequential probes):** legacy
  `api.marginalia.nu/public/search/tallest%20mountain%20on%20Earth?count=3` → 200 in 0.28 s,
  envelope `{license: CC-BY-NC-SA 4.0, page, pages: 11, query, results[]}` with the R-16 value intact
  (ecuador-travel-guide tallest-mountain pages + the QUAL run-015 blogspot Everest hit);
  `api2.marginalia-search.com/search?query=...&count=3` with `API-Key: public` → 429 `Daily Limit Exceeded`
  (`text/plain`, 20 bytes, 0.13 s). No email or secret was used or needed for either probe. Decision: stay on the
  legacy endpoint; api2 migration waits on a personal key (owner email) or a re-probe showing `public` healthy —
  do not migrate to api2 on the shared key.
- **Error envelope**: transient failures arrive as HTML status pages (observed `504 Gateway Time-out` nginx, twice
  under rapid probing) — adapters must treat non-JSON/non-200 as a typed error with bounded retry, never hot.
- **Rate limits**: not numerically documented for the legacy public path; aggressive under bursts (observed 504s
  at ~1 req/1.5s). Serialize + pace requests; honor Retry-After when present.
- **Recall value (why this entry exists)**: for the R-16 class question `What is the tallest mountain on Earth?` the
  MediaWiki search API never surfaces Mount Everest (top-20, all query shapes — 2026-09-15 spike); Marginalia's
  public API returns Everest-class pages at ranks 1-5 for the SAME raw question (live-verified this date), and
  ranks en.wikipedia.org/wiki/Tallest_mountain at 7. This is the R-16 structural lever.
- **Activation**: approved for SRC-15 (free, keyless on the verified endpoint, terms recorded this date).

## Model providers

None activated. Same gate as search; additionally record price per 1M
input/output tokens and usage-reporting availability.

### Candidate (NOT activated) — OpenAI-compatible adapter slice, checked 2026-09-21 (offline docs + code, no live calls, no keys, no spend)

- **What exists:** `packages/plugins/plugin-model-openai-compat` (new, kind `model`, zero
  capabilities): one generic adapter mapping `SynthesisRequest` to a single
  `POST {baseURL}/chat/completions` with `response_format` json_schema over the
  `DraftAnswer` blocks shape (closed schema, strict-compatible), `temperature: 0`,
  `stream: false`, `max_tokens` = request output ceiling, never a `tools` field (ADR 0006),
  never a retry (a call may be billable — 429 surfaces typed). Usage reconciles provider
  `prompt_tokens`/`completion_tokens` (`estimated: false`) with the contract estimator as
  fallback (`estimated: true`). Key (when needed) arrives host-side via deps, never config.
  17 offline tests (recorded envelopes, injected fetch); `apps/server` config UNCHANGED
  (still `fixture`-or-unset) so nothing live can select it.
- **Terms surveyed (official docs, this date):**
  - Ollama local (`https://docs.ollama.com/api`, `/api/chat.md`,
    `/capabilities/structured-outputs.md`, `/api/usage.md`): `http://localhost:11434/api`
    (+ OpenAI-compat `/v1`), no key, price 0, local `format` schema + usage counts supported;
    cloud Ollama does NOT support structured outputs. Weights/GB + RAM per chosen model;
    MIT runner, per-model licenses. Localhost bypasses safe-fetch by design (guards refuse
    loopback) — direct loopback fetch, host-internal.
  - Groq (`https://console.groq.com/docs/overview`, `/docs/structured-outputs`,
    `/docs/rate-limits`): OpenAI-compat `https://api.groq.com/openai/v1`, keyed, strict
    constrained decoding on `openai/gpt-oss-20b/120b`, zod-supported, 429 + `retry-after`
    headers; free plan exists (oss-20b: 30 RPM / 1K RPD / 8K TPM) but a key is billing-capable
    → `paid` + grant + spend limits + verified pricing before any use.
  - Gemini (`https://ai.google.dev/gemini-api/docs/structured-output`,
    `/gemini-api/docs/pricing`): schema + zod supported, free tier free tokens — REJECTED as
    first adapter: free-tier content is used to improve Google's products (private
    owner-scoped evidence must not train third-party models); paid tier (e.g. 3.1 Flash-Lite
    $0.25/1M in, $1.50/1M out) removes that term but needs money + grant.
- **Activation gate (not met):** owner picks the model (Ollama-local recommended first:
  $0, private, no grant; Groq second), then a follow-up slice wires config + dated entry
  with per-1M pricing + `review-security` (R-12 live exposure) + QUAL re-measure.

## Hosting references (not commitments)

- Oracle Cloud Always Free: official docs (checked 2026-09-06) state
  1,500 OCPU-h + 9,000 GB-h/mo ≈ 2 OCPU/12 GB ARM, 200 GB block storage,
  idle-reclaim and capacity caveats. No uptime guarantee.
- Fly.io: no recurring free compute tier for new users (checked 2026-09-06).
- Paid small VPS is the predictable fallback; verify current prices at need.
