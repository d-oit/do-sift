# CI failure triage

How to classify a CI failure in this repository and decide the next action.
The advisory classifier lives in `scripts/ci-diagnostics.ts`
(`classifyFailure`); this document owns the policy.

## Taxonomy

| Category                | Typical evidence                                                         | Next action                                       | Retry?            |
| ----------------------- | ------------------------------------------------------------------------ | ------------------------------------------------- | ----------------- |
| `test-regression`       | `AssertionError`, failing vitest suite on an unchanged environment       | Fix the code or fixture; never retry into a pass  | never             |
| `dependency-resolution` | `npm error`, `ERESOLVE`, `ETARGET`, registry 404/403 during install      | Check lockfile/manifest agreement; fix the pin    | once, after a fix |
| `native-install`        | `node-gyp`, `prebuild-install`, missing prebuilt binary for the platform | Check the pinned version's platform support       | once, after a fix |
| `external-provider`     | Network error inside a live-provider step, provider rate limit (429)     | Record the outage; rerun the scheduled job later  | only on schedule  |
| `runner-infrastructure` | Runner loss, transport reset with no provider involved                   | One bounded retry; keep the first failure visible | once, bounded     |
| `unknown`               | Nothing above matched                                                    | Read the raw step log before deciding             | never             |

## Rules

1. **A deterministic test failure is never retried into a pass.** A retry is
   allowed only for the `dependency-resolution`, `native-install`,
   `external-provider`, and `runner-infrastructure` classes, at most once per
   failed job, and the first failure stays visible in the job summary.
2. **Classifications are advisory.** `classifyFailure` matches keywords in the
   failing step's name and sanitized error text; it can mislabel an unusual
   failure. The raw step log always wins over the suggestion.
3. **No secret-bearing material in diagnostics.** Error excerpts pasted into
   issues or summaries must be sanitized: no tokens, cookies, headers, or
   environment dumps (see "Approval boundaries" in `AGENTS.md`).
4. **Live-provider failures stay separated from merge gates.** A scheduled
   live job failing is an operational event, never a reason to convert a
   deterministic gate into a passing one or vice versa.

## Required-check audit

The merge-gating check names and this document's inventory must not drift.
After any workflow rename or job restructure, run the audit and update the
inventory here:

```bash
gh api repos/d-oit/do-sift/actions/workflows --jq '.workflows[].name'
gh api repos/d-oit/do-sift/branches/main/protection --jq '.required_status_checks'
```

An owner must verify both outputs: the required contexts still match job
names in `.github/workflows/*`, and the ruleset/branch-protection settings
themselves are repository-settings actions owned by the maintainer (see
"Approval boundaries" in `AGENTS.md`) — this document never claims they are
active.
