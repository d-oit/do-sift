/**
 * Reference OIDC auth plugin (#120, ADR 0010).
 *
 * The kernel never depends on a specific identity implementation: this
 * package registers an `auth`-kind plugin whose instance exposes an
 * `AuthProvider` (contracts) built from verified OIDC id tokens. Verification
 * is the auth package's `JwksOidcVerifier` (RS256/ES384 pinned, JWKS-cached,
 * fail closed); claim → `Principal` mapping is `OidcPrincipalProvider`.
 *
 * Capability posture: the plugin declares the non-grant `network` capability
 * and may only contact the host named in `permissions.networkHosts` — the
 * kernel enforces that through `ctx.network.assertHostAllowed` at activation
 * time. No secrets are read here: the JWKS endpoint is public.
 */
import { JwksOidcVerifier, OidcPrincipalProvider, type OidcVerifier } from "@do-sift/auth";
import { AuthProviderError, type AuthProvider } from "@do-sift/contracts";
import type { PluginContext, PluginInstance } from "@do-sift/kernel";

/** Plugin config, as mirrored in `plugin.json` (`config` object). */
export interface AuthOidcPluginConfig {
  /** Exact `iss` the id token must carry and the issuer reported upstream. */
  issuer: string;
  /** Token `aud` must contain this value. */
  audience: string;
  /** HTTPS URL of the provider's JWKS. */
  jwksUrl: string;
  /** Verified claim naming the caller's tenant (unset → single-tenant mode). */
  tenantClaim?: string | undefined;
  /** Tenant used when `tenantClaim` is not configured. */
  defaultTenant?: string | undefined;
  /** Claim carrying role strings. */
  rolesClaim?: string | undefined;
  /** Optional accepted-tenant allowlist. */
  tenantAllowlist?: readonly string[] | undefined;
}

/** Plugin instance: an `AuthProvider` ready for the server's auth door. */
export interface AuthOidcPlugin extends PluginInstance {
  readonly provider: AuthProvider;
}

export interface AuthOidcPluginOptions {
  /** Injected verifier (tests / offline harness); production uses JWKS. */
  verifier?: OidcVerifier | undefined;
}

function configString(config: Readonly<Record<string, unknown>>, key: string): string {
  const value = config[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new AuthProviderError(
      "provider-unavailable",
      `auth-oidc config is missing a non-empty "${key}"`,
    );
  }
  return value;
}

function configStringList(
  config: Readonly<Record<string, unknown>>,
  key: string,
): string[] | undefined {
  const value = config[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new AuthProviderError(
      "provider-unavailable",
      `auth-oidc config "${key}" must be strings`,
    );
  }
  return value as string[];
}

/** Parse + validate the plugin config; throws when anything is missing. */
export function readOidcPluginConfig(
  config: Readonly<Record<string, unknown>>,
): AuthOidcPluginConfig {
  const issuer = configString(config, "issuer");
  const audience = configString(config, "audience");
  const jwksUrl = configString(config, "jwksUrl");
  let parsed: URL;
  try {
    parsed = new URL(jwksUrl);
  } catch {
    throw new AuthProviderError("provider-unavailable", "auth-oidc jwksUrl must be an https URL");
  }
  if (parsed.protocol !== "https:") {
    throw new AuthProviderError("provider-unavailable", "auth-oidc jwksUrl must be an https URL");
  }
  const tenantClaim = typeof config.tenantClaim === "string" ? config.tenantClaim : undefined;
  const defaultTenant = typeof config.defaultTenant === "string" ? config.defaultTenant : undefined;
  const rolesClaim = typeof config.rolesClaim === "string" ? config.rolesClaim : undefined;
  const tenantAllowlist = configStringList(config, "tenantAllowlist");
  return {
    issuer,
    audience,
    jwksUrl,
    ...(tenantClaim === undefined ? {} : { tenantClaim }),
    ...(defaultTenant === undefined ? {} : { defaultTenant }),
    ...(rolesClaim === undefined ? {} : { rolesClaim }),
    ...(tenantAllowlist === undefined ? {} : { tenantAllowlist }),
  };
}

/**
 * Plugin factory. Activation validates the config, asserts the JWKS host is
 * allowlisted by the manifest, and builds the provider; deactivation drops
 * it. `provider` throws before activation / after deactivation.
 */
export function createOidcAuthPlugin(
  options: AuthOidcPluginOptions = {},
): (ctx: PluginContext) => AuthOidcPlugin {
  return (ctx: PluginContext): AuthOidcPlugin => {
    let provider: AuthProvider | undefined;
    return {
      activate: (): void => {
        const config = readOidcPluginConfig(ctx.config);
        const host = new URL(config.jwksUrl).host;
        ctx.network.assertHostAllowed(host);
        const verifier: OidcVerifier =
          options.verifier ??
          new JwksOidcVerifier({
            issuer: config.issuer,
            audience: config.audience,
            jwksUrl: config.jwksUrl,
          });
        provider = new OidcPrincipalProvider({
          verifier,
          ...(config.tenantClaim === undefined ? {} : { tenantClaim: config.tenantClaim }),
          ...(config.defaultTenant === undefined ? {} : { defaultTenant: config.defaultTenant }),
          ...(config.rolesClaim === undefined ? {} : { rolesClaim: config.rolesClaim }),
          ...(config.tenantAllowlist === undefined
            ? {}
            : { tenantAllowlist: config.tenantAllowlist }),
        });
      },
      deactivate: (): void => {
        provider = undefined;
      },
      get provider(): AuthProvider {
        if (provider === undefined) {
          throw new AuthProviderError("provider-unavailable", "auth-oidc plugin is not active");
        }
        return provider;
      },
    };
  };
}
