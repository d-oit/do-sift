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

### Marginalia Search (marginalia.nu) — checked 2026-09-15 (live probe fetches, spike evidence in plans/003-004-src-ans.md SRC-15)

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
- **The newer documented API**: api2.marginalia-search.com (docs dated 2025-12-08 on api.marginalia.nu) uses an
  `API-Key` header. The shared `public` key is sanctioned for integrations but is quota-crippled in practice —
  live probe this date returned 429 `Daily Limit Exceeded` / `QPM Limit Exceeded`. Free non-commercial personal
  keys require EMAIL (contact@marginalia-search.com) — owner follow-up, not automatable. The adapter therefore
  targets the verified legacy endpoint; migration to api2 with a personal key is recorded as the follow-up when
  the owner requests a key by email.
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

## Hosting references (not commitments)

- Oracle Cloud Always Free: official docs (checked 2026-09-06) state
  1,500 OCPU-h + 9,000 GB-h/mo ≈ 2 OCPU/12 GB ARM, 200 GB block storage,
  idle-reclaim and capacity caveats. No uptime guarantee.
- Fly.io: no recurring free compute tier for new users (checked 2026-09-06).
- Paid small VPS is the predictable fallback; verify current prices at need.
