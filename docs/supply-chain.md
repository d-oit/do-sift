# Supply chain: SBOM, provenance, and image scans (#164)

Release evidence is generated, reviewed, and attached to the candidate. Nothing
here publishes an artifact; publication stays an owner-gated ritual
([release.md](release.md)).

## SBOM

```bash
npm run sbom -- --out sbom.json
```

- Source of truth: `package-lock.json`. No registry call and no credentials.
- Deterministic: components are sorted by purl and the timestamp is omitted
  unless `--created <ISO>` is passed, so the same lockfile yields byte-identical
  output and a stable `sha256` digest.
- Each component carries its version, purl, scope, and the lockfile integrity
  digest when present (`SHA-512/256/1`).
- Zero components is a failure, never an empty artifact (INV-006).

`.github/workflows/sbom.yml` runs the generator on a manual dispatch and on
pull requests that touch dependency manifests, then uploads the SBOM as
retained evidence. It has `contents: read` only and receives no secrets.

## Provenance and image evidence

These remain owner-gated because they need a registry identity:

- Build provenance attestation for the container image (SLSA/in-toto).
- Image vulnerability scan with a severity policy and expiring exceptions.
- Published checksum file and signature verification instructions.

The repository already pins GitHub Actions by full SHA and runs the scheduled
advisory scan ([dependency-maintenance.md](dependency-maintenance.md)). Those
are inputs to this evidence, not substitutes for it.

## Review rules

- Do not auto-merge a dependency update that changes runtime, native bindings,
  migrations, policy, auth, or provider behaviour.
- Treat a new transitive dependency as a review item, not a version bump.
- A scan finding without a reachable code path may be documented as an
  exception with an owner and expiry; an unexplained count is not triage.
