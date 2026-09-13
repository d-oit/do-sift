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

None activated. Required before any live adapter ships: current API terms,
quota, billing behavior, result metadata, and **content storage rights**.
Record here with date + URL.

## Model providers

None activated. Same gate as search; additionally record price per 1M
input/output tokens and usage-reporting availability.

## Hosting references (not commitments)

- Oracle Cloud Always Free: official docs (checked 2026-09-06) state
  1,500 OCPU-h + 9,000 GB-h/mo ≈ 2 OCPU/12 GB ARM, 200 GB block storage,
  idle-reclaim and capacity caveats. No uptime guarantee.
- Fly.io: no recurring free compute tier for new users (checked 2026-09-06).
- Paid small VPS is the predictable fallback; verify current prices at need.
