/**
 * Declarative ethical guardrails (issue #124, ADR 0005).
 *
 * The rules live in `guardrails.json` — a standalone, auditable policy
 * document — and this module is the decision engine that evaluates it. The
 * kernel consults the engine for every browser/computer action (INV-003,
 * INV-004, INV-007), so the guardrails are data plus one reviewable
 * evaluator instead of logic scattered through plugin code.
 *
 * Why not OPA/Rego itself: the repository is Node-only (ADR 0001) and the
 * check pipeline is hermetic; adding an `opa` binary would put a Go
 * toolchain and a workflow edit on the critical path. A typed evaluator over
 * a declarative document gives the same properties the issue asks for —
 * externalized, versionable, testable policy with default-deny semantics —
 * while remaining part of `npm run check`.
 *
 * Extending: edit `guardrails.json` (sites, actions, prohibited classes).
 * `assertGuardrailsIntegrity` is the floor: widening is allowed, weakening
 * the shipped guarantees throws and requires an ADR.
 */
import { z } from "zod";
import policyDocument from "./guardrails.json" with { type: "json" };
import { DEFAULT_DENY_SITES, isSiteDenied, normalizeHost } from "./sitepolicy.js";

export const GuardrailCapability = z.enum(["browser", "computer"]);
export type GuardrailCapability = z.infer<typeof GuardrailCapability>;

const CapabilityGuardrails = z
  .object({
    /** INV-003: an explicit recorded owner grant is required. */
    grantRequired: z.boolean(),
    /** ADR 0005: interactive per-class consent is required. */
    consentRequired: z.boolean(),
    /** INV-007: the shipped default-deny list applies. */
    siteAccessRequired: z.boolean(),
    /** Actions that need a target host (and therefore the site gate). */
    siteScopedActions: z.array(z.string().min(1)).default([]),
    allowedActions: z.array(z.string().min(1)).min(1),
  })
  .strict();

/**
 * Shape of the policy document. `.strict()` everywhere: a typo in the JSON
 * must fail loudly rather than silently falling through to a permissive
 * default.
 */
export const GuardrailsPolicy = z
  .object({
    schemaVersion: z.literal("1"),
    name: z.string().min(1),
    authority: z
      .object({
        adr: z.string().min(1),
        invariants: z.array(z.string().min(1)).min(1),
        extend: z.string().min(1),
      })
      .strict(),
    defaultDecision: z.literal("deny"),
    /** Action classes that may never run, keyed by the boundary they cross. */
    prohibited: z.record(z.string().min(1), z.array(z.string().min(1)).min(1)),
    siteAccess: z.object({ defaultDenySites: z.array(z.string().min(1)).min(1) }).strict(),
    capabilities: z
      .object({ browser: CapabilityGuardrails, computer: CapabilityGuardrails })
      .strict(),
  })
  .strict();
export type GuardrailsPolicy = z.infer<typeof GuardrailsPolicy>;

/** The policy shipped in this package — the default the kernel enforces. */
export const SHIPPED_GUARDRAILS: GuardrailsPolicy = GuardrailsPolicy.parse(policyDocument);

/** Boundaries whose prohibited lists may never be emptied (INV-004). */
const REQUIRED_PROHIBITED_CATEGORIES = ["stealth", "captcha"] as const;

/**
 * Validate a policy document and refuse any that weakens the shipped
 * guarantees. Returns the parsed policy so callers can use one call.
 *
 * Weakening (throws, needs an ADR to change this function):
 * - the browser/computer capabilities losing their grant requirement;
 * - computer automation losing consent;
 * - browser actions losing site access;
 * - any shipped default-deny site disappearing;
 * - a prohibited class (stealth, CAPTCHA) disappearing.
 */
export function assertGuardrailsIntegrity(input: unknown): GuardrailsPolicy {
  const policy = GuardrailsPolicy.parse(input);
  const problems: string[] = [];

  for (const site of DEFAULT_DENY_SITES) {
    const normalized = normalizeHost(site);
    const listed = policy.siteAccess.defaultDenySites.some(
      (entry) => normalizeHost(entry) === normalized,
    );
    if (!listed) {
      problems.push(`siteAccess.defaultDenySites is missing "${site}" (INV-007)`);
    }
  }

  for (const category of REQUIRED_PROHIBITED_CATEGORIES) {
    const actions = policy.prohibited[category];
    if (actions === undefined || actions.length === 0) {
      problems.push(`prohibited.${category} must list at least one action (INV-004)`);
    }
  }

  for (const capability of GuardrailCapability.options) {
    const section = policy.capabilities[capability];
    if (!section.grantRequired) {
      problems.push(`capabilities.${capability}.grantRequired must stay true (INV-003)`);
    }
    if (capability === "browser" && !section.siteAccessRequired) {
      problems.push("capabilities.browser.siteAccessRequired must stay true (INV-007)");
    }
    if (capability === "computer" && !section.consentRequired) {
      problems.push("capabilities.computer.consentRequired must stay true (ADR 0005)");
    }
  }

  if (problems.length > 0) {
    throw new Error(`guardrails policy weakened: ${problems.join("; ")}`);
  }
  return policy;
}

export type GuardrailRule =
  | "unknown-capability"
  | "prohibited-action"
  | "action-not-permitted"
  | "site-access-required"
  | "site-default-deny"
  | "grant-required"
  | "consent-required"
  | "permitted";

export interface GuardrailRequest {
  capability?: GuardrailCapability;
  action?: string;
  /** Target host for site-scoped actions (navigate). */
  host?: string;
  /** Whether the owner grant for this capability is recorded. */
  granted?: boolean;
  /** Whether interactive consent for this action class was obtained. */
  consent?: boolean;
}

export interface GuardrailDecision {
  decision: "allow" | "deny";
  rule: GuardrailRule;
  reason: string;
}

function deny(rule: GuardrailRule, reason: string): GuardrailDecision {
  return { decision: "deny", rule, reason };
}

function prohibitedCategory(policy: GuardrailsPolicy, action: string): string | undefined {
  for (const [category, actions] of Object.entries(policy.prohibited)) {
    if (actions.includes(action)) return category;
  }
  return undefined;
}

function matchesSite(normalizedHost: string, entry: string): boolean {
  const normalizedEntry = normalizeHost(entry);
  return (
    normalizedEntry.length > 0 &&
    (normalizedHost === normalizedEntry || normalizedHost.endsWith(`.${normalizedEntry}`))
  );
}

/**
 * Pure policy evaluation, fail-closed and ordered: capability → prohibited
 * class → allowed action → site default-deny → grant → consent.
 */
export function evaluateGuardrails(
  policy: GuardrailsPolicy,
  request: GuardrailRequest,
): GuardrailDecision {
  const capability = request.capability;
  if (capability === undefined) {
    return deny("unknown-capability", "guardrails: no automation capability named");
  }
  const section = policy.capabilities[capability];
  if (section === undefined) {
    return deny("unknown-capability", `guardrails: capability "${capability}" is not declared`);
  }

  const action = request.action ?? "";
  const category = prohibitedCategory(policy, action);
  if (category !== undefined) {
    return deny(
      "prohibited-action",
      `guardrails: "${action}" is prohibited (${category}, ADR 0005)`,
    );
  }
  if (!section.allowedActions.includes(action)) {
    return deny(
      "action-not-permitted",
      `guardrails: "${action}" is not an allowed ${capability} action`,
    );
  }

  if (section.siteAccessRequired && section.siteScopedActions.includes(action)) {
    const host = normalizeHost(request.host ?? "");
    if (host.length === 0) {
      return deny(
        "site-access-required",
        `guardrails: ${capability}:${action} needs a target host so the site gate can decide`,
      );
    }
    const deniedBySite =
      isSiteDenied(host) ||
      policy.siteAccess.defaultDenySites.some((entry) => matchesSite(host, entry));
    if (deniedBySite) {
      return deny(
        "site-default-deny",
        `guardrails: ${host} is on the default-deny list (ADR 0005)`,
      );
    }
  }

  if (section.grantRequired && request.granted !== true) {
    return deny(
      "grant-required",
      `guardrails: ${capability} needs an explicit recorded grant (INV-003)`,
    );
  }
  if (section.consentRequired && request.consent !== true) {
    return deny(
      "consent-required",
      `guardrails: ${capability} needs interactive consent for this action class (ADR 0005)`,
    );
  }

  return {
    decision: "allow",
    rule: "permitted",
    reason: `guardrails: ${capability}:${action} permitted`,
  };
}

/** Thrown by `assertAllowed` when the policy denies an action. */
export class GuardrailError extends Error {
  constructor(public readonly decision: GuardrailDecision) {
    super(decision.reason);
    this.name = "GuardrailError";
  }
}

/**
 * A policy-bound entry point. `defaults` seed fields the caller does not
 * know (the kernel seeds `granted` because activation already passed the
 * grant gate); explicit request fields always win.
 */
export interface GuardrailEngine {
  readonly policy: GuardrailsPolicy;
  check(request?: GuardrailRequest): GuardrailDecision;
  assertAllowed(request?: GuardrailRequest): void;
}

function mergeRequest(defaults: GuardrailRequest, request: GuardrailRequest): GuardrailRequest {
  const merged: GuardrailRequest = {};
  const capability = request.capability ?? defaults.capability;
  if (capability !== undefined) merged.capability = capability;
  const action = request.action ?? defaults.action;
  if (action !== undefined) merged.action = action;
  const host = request.host ?? defaults.host;
  if (host !== undefined) merged.host = host;
  const granted = request.granted ?? defaults.granted;
  if (granted !== undefined) merged.granted = granted;
  const consent = request.consent ?? defaults.consent;
  if (consent !== undefined) merged.consent = consent;
  return merged;
}

export function createGuardrailEngine(
  policy: GuardrailsPolicy,
  defaults: GuardrailRequest = {},
): GuardrailEngine {
  return {
    policy,
    check(request = {}) {
      return evaluateGuardrails(policy, mergeRequest(defaults, request));
    },
    assertAllowed(request = {}) {
      const decision = evaluateGuardrails(policy, mergeRequest(defaults, request));
      if (decision.decision !== "allow") throw new GuardrailError(decision);
    },
  };
}
