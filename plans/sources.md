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
  274 KB observed) — the sanctioned page-content path.
- **Activation**: approved for SRC-06 (free, keyless, terms recorded).
  Model/search providers below remain the template for any future entry.

## Model providers

None activated. Same gate as search; additionally record price per 1M
input/output tokens and usage-reporting availability.

## Hosting references (not commitments)

- Oracle Cloud Always Free: official docs (checked 2026-09-06) state
  1,500 OCPU-h + 9,000 GB-h/mo ≈ 2 OCPU/12 GB ARM, 200 GB block storage,
  idle-reclaim and capacity caveats. No uptime guarantee.
- Fly.io: no recurring free compute tier for new users (checked 2026-09-06).
- Paid small VPS is the predictable fallback; verify current prices at need.
