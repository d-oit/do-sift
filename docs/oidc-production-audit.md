# OIDC production audit (#161)

Scope: the verifier and tenant-claim mapping used by
`packages/auth` and `packages/plugins/plugin-auth-oidc`. This is an audit
record and deployment checklist, not a new identity provider.

## Verifier semantics that must hold

1. **Issuer** — the token `iss` matches the configured issuer exactly.
2. **Audience** — `aud` contains the configured audience; a token minted for
   another client is rejected.
3. **Signature** — verified against the provider's JWKS, with `kid` selection
   and a bounded cache. Unknown or expired keys are a refusal, not a retry
   loop.
4. **Expiry / not-before** — `exp` and `nbf` are enforced with a small clock
   skew; an expired token never reaches storage.
5. **Algorithm** — the accepted algorithms are an allowlist. `none` and
   symmetric algorithms are refused.
6. **Tenant mapping** — the tenant comes from a configured claim and must map
   to a known tenant. The server never trusts a tenant id from the request.
7. **Owner mapping** — the owner id is the verified subject, or a configured
   claim; it is never a query parameter.
8. **Role** — the recorded role in `tenant_members` decides authorization. A
   token claim cannot elevate a role without a recorded membership.

## Deployment checklist

- [ ] `DO_SIFT_OIDC_ISSUER`, `DO_SIFT_OIDC_AUDIENCE`, and JWKS URL are set to
      the production tenant, not a test tenant.
- [ ] TLS terminates at a trusted proxy; the app binds loopback.
- [ ] The dev bypass (`DO_SIFT_DEV_BYPASS`) is **unset** in production.
- [ ] `DO_SIFT_OWNERS` is either empty (OIDC-only) or an explicit allowlist.
- [ ] Clock skew is configured below the token lifetime.
- [ ] JWKS cache has a bounded TTL and a failure mode that refuses rather than
      accepts.
- [ ] Logs contain request ids, not tokens.
- [ ] A token from another issuer/audience is rejected in a staging check.

## Known limits

- The packaged container still ships a stub verifier; do not treat it as a
  production identity deployment.
- One process serves a configured tenant set; per-tenant process isolation is
  not implemented.
- Role changes take effect on the next request; there is no token revocation
  channel beyond token expiry.

See [multi-tenant-auth.md](multi-tenant-auth.md) for the provider contract and
[deployment.md](deployment.md) for configuration.
