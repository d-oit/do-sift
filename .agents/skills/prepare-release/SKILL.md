---
name: prepare-release
description: Assemble and verify a do-sift release candidate — exact SHA, version consistency, checks, artifacts, checksums/SBOM, rollback notes — without publishing anything. Use when the user says "prepare a release", "cut a version", or when release.yml needs a candidate validated.
---

# prepare-release

## Procedure

1. Run `npm run release:check`. It validates: requested SHA is reachable and
   reviewed on main, package/manifest versions are consistent, lockfile is
   in sync, changelog entry exists for the version, migration chain applies
   cleanly from the previous release fixture, and the release tag does not
   already exist.
2. Build the candidate **without publishing credentials**: container image,
   source archive, checksums, SBOM, provenance where supported. Record the
   immutable digest.
3. Confirm the full check suite on the exact SHA (`npm run check`).
4. Write the release checklist into `docs/release.md` output: version, SHA,
   digests, migration notes, rollback (previous digest), and open risks.
5. **Stop.** Publishing (tag, GHCR push, package publish, deployment) is a
   separate approval-gated step per AGENTS.md — never self-approve.

## Rules

- Never bypass missing checks to make a date.
- Rollback notes must reference the previous image digest and the data
  compatibility of any migrations in the release.
