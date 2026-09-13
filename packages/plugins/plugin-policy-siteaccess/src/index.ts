/**
 * Site-access policy (CORE-08, ADR 0005). The single decision point every
 * fetch and every browser navigation must pass. Layered, fail-closed:
 *
 *   1. default-deny list (contracts, INV-007) — shipped, cannot shrink
 *      without an ADR;
 *   2. robots/ToS registry — per-site recorded decisions with a checked
 *      date; a registry deny wins over everything except (1);
 *   3. config denylist — operator additions;
 *   4. allowlist mode — when non-empty, only listed hosts may pass;
 *   5. default — allow, unless `requireRegistry` is set (strict mode:
 *      unregistered hosts are denied; this is the BRW-02 navigation gate).
 *
 * Zero capabilities: this is a pure decision function over config.
 */
import { isSiteDenied, normalizeHost } from "@do-sift/contracts";
import type { PluginInstance } from "@do-sift/kernel";

export interface SitePolicyEntry {
  host?: unknown;
  /** robots.txt automated-access posture, as recorded and dated. */
  robotsAccess?: unknown;
  /** The site's ToS posture toward automation, as recorded and dated. */
  tosAutomated?: unknown;
  /** ISO date the decision was verified (staleness is a review duty). */
  checkedAt?: unknown;
}

export interface SiteAccessConfig {
  denylist?: unknown;
  allowlist?: unknown;
  sitePolicies?: unknown;
  requireRegistry?: unknown;
}

export type SiteAccessVerdict = {
  allowed: boolean;
  /** Which layer produced the decision. */
  source: "default-deny" | "registry" | "denylist" | "allowlist" | "require-registry" | "default";
  reason?: string | undefined;
};

export class SiteAccessDeniedError extends Error {
  constructor(
    public readonly host: string,
    public readonly verdict: SiteAccessVerdict,
  ) {
    super(
      `site access denied for ${host}: ${verdict.source}${verdict.reason ? ` (${verdict.reason})` : ""}`,
    );
    this.name = "SiteAccessDeniedError";
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/u;

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function matchesEntry(normalizedHost: string, entry: string): boolean {
  const e = normalizeHost(entry);
  return e.length > 0 && (normalizedHost === e || normalizedHost.endsWith(`.${e}`));
}

export interface SiteAccessInstance extends PluginInstance {
  /** Layered decision for a host (bare hostname, host:port, or bracketed v6). */
  check(host: string): SiteAccessVerdict;
  /** check() that throws on denial — the shape callers most often want. */
  assertAllowed(host: string): void;
}

export function createSiteAccessPolicy(): SiteAccessInstance {
  let denylist: string[] = [];
  let allowlist: string[] = [];
  let registry = new Map<
    string,
    { robotsAccess: string; tosAutomated: string; checkedAt: string }
  >();
  let requireRegistry = false;
  let activated = false;

  return {
    async activate(context) {
      const cfg = context.config as SiteAccessConfig;
      denylist = stringList(cfg.denylist);
      allowlist = stringList(cfg.allowlist);
      requireRegistry = cfg.requireRegistry === true;

      registry = new Map();
      for (const raw of Array.isArray(cfg.sitePolicies) ? cfg.sitePolicies : []) {
        const entry = raw as SitePolicyEntry;
        const host = typeof entry.host === "string" ? normalizeHost(entry.host) : "";
        const robotsAccess = typeof entry.robotsAccess === "string" ? entry.robotsAccess : "";
        const tosAutomated = typeof entry.tosAutomated === "string" ? entry.tosAutomated : "";
        const checkedAt = typeof entry.checkedAt === "string" ? entry.checkedAt : "";
        if (
          host.length === 0 ||
          !["allow", "deny", "unspecified"].includes(robotsAccess) ||
          !["automated-ok", "automated-denied", "unspecified"].includes(tosAutomated) ||
          !ISO_DATE.test(checkedAt)
        ) {
          throw new Error(
            `invalid site policy entry for "${String(entry.host)}": needs host, robotsAccess(allow|deny|unspecified), tosAutomated(automated-ok|automated-denied|unspecified), and a dated checkedAt`,
          );
        }
        registry.set(host, { robotsAccess, tosAutomated, checkedAt });
      }
      activated = true;
      context.events.emit("policy-siteaccess.activated", {
        denylist: denylist.length,
        allowlist: allowlist.length,
        registry: registry.size,
        requireRegistry,
      });
    },

    async deactivate() {
      activated = false;
    },

    check(host: string): SiteAccessVerdict {
      if (!activated) throw new Error("policy-siteaccess is not activated");
      const normalized = normalizeHost(host);
      if (normalized.length === 0) {
        return { allowed: false, source: "default", reason: "empty host" };
      }

      // 1. shipped default-deny (INV-007) — absolute, cannot be overridden
      if (isSiteDenied(normalized)) {
        return { allowed: false, source: "default-deny", reason: "shipped deny list (ADR 0005)" };
      }

      // 2. robots/ToS registry — recorded, dated per-site decisions
      let registered = false;
      for (const [entryHost, policy] of registry) {
        if (matchesEntry(normalized, entryHost)) {
          registered = true;
          if (policy.robotsAccess === "deny") {
            return {
              allowed: false,
              source: "registry",
              reason: `robots deny (checked ${policy.checkedAt})`,
            };
          }
          if (policy.tosAutomated === "automated-denied") {
            return {
              allowed: false,
              source: "registry",
              reason: `ToS denies automation (checked ${policy.checkedAt})`,
            };
          }
          break; // registered and not denied: fall through to the list layers
        }
      }

      // 3. operator denylist
      if (denylist.some((entry) => matchesEntry(normalized, entry))) {
        return { allowed: false, source: "denylist", reason: "operator denylist" };
      }

      // 4. allowlist mode: when configured, it is exhaustive
      if (allowlist.length > 0) {
        if (allowlist.some((entry) => matchesEntry(normalized, entry))) {
          return { allowed: true, source: "allowlist" };
        }
        return { allowed: false, source: "allowlist", reason: "host is not allowlisted" };
      }

      // 5. default
      if (requireRegistry && !registered) {
        return {
          allowed: false,
          source: "require-registry",
          reason: "host is not in the registry",
        };
      }
      return { allowed: true, source: "default" };
    },

    assertAllowed(host: string): void {
      const verdict = this.check(host);
      if (!verdict.allowed) throw new SiteAccessDeniedError(host, verdict);
    },
  };
}
