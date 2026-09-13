/**
 * Browser harness action layer (BRW-01, plan 005, ADR 0005).
 *
 * Executes a bounded action plan (navigate/scroll/type/click) against an
 * injected BrowserDriver with human-paced, FIXED delays. ADR 0005 line:
 * "pacing for gentleness, never evasion" — delays are configured constants
 * (rate limiting for politeness), deliberately not randomized or shaped to
 * defeat bot detection, and no stealth of any kind exists here (INV-004).
 *
 * Boundaries enforced in this layer:
 * - every navigate passes the injected site-access policy BEFORE the
 *   driver; denials are recorded in the run log with `deniedBy`;
 * - `task.limits.maxActions` truncates the plan; `deadlineMs` stops the
 *   run (outcome "timeout");
 * - every action is appended to a replayable HarnessRunLog (ADR 0006
 *   contract) — nothing happens that is not logged.
 *
 * The driver interface is the seam for Playwright (BRW-04's real-browser
 * e2e); tests inject a recording fake, so this slice is fully offline.
 */
import { HarnessRunLog, type HarnessAction, type HarnessTask } from "@do-sift/contracts";
import type { PluginInstance } from "@do-sift/kernel";

export interface BrowserHarnessConfig {
  actionDelayMs?: unknown;
  typeDelayMs?: unknown;
  scrollStepPx?: unknown;
  scrollPauseMs?: unknown;
}

/**
 * The seam Playwright implements later (BRW-04). Tests inject a fake.
 *
 * BRW-03 profile sessions: a logged-in session comes from a USER-supplied
 * browser profile directory (the user logs in themselves; e.g. Playwright's
 * launchPersistentContext over that directory). The profile is a
 * DRIVER-FACTORY concern — it never passes through this harness — and the
 * guarantees here hold for any profile: automation never types into
 * credential-shaped fields (CredentialGuard, no override), and run logs
 * record selectors and typed LENGTHS only, never typed text.
 */
export interface BrowserDriver {
  navigate(url: string): Promise<void>;
  scrollBy(px: number): Promise<void>;
  type(selector: string, text: string, perKeystrokeMs: number): Promise<void>;
  click(selector: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * The navigation gate (BRW-02, ADR 0005). Satisfied structurally by
 * `@do-sift/plugin-policy-siteaccess` instances — the canonical layered
 * implementation (shipped default-deny → robots/ToS registry → allow/deny
 * lists). Browsers MUST wire the policy in `requireRegistry` strict mode:
 * every navigation target must be a registered, dated decision, and the
 * shipped default-deny list (linkedin.com et al.) can never be overridden.
 * This harness never navigates without consulting it.
 */
export interface SiteAccessGate {
  assertAllowed(host: string): void;
}

export interface BrowserHarnessDeps {
  driver: BrowserDriver;
  sitePolicy: SiteAccessGate;
  /** Injected clock for deterministic deadline tests (ms). */
  now?: () => number;
  /** Injected sleep for deterministic pacing tests (records requests). */
  sleep?: (ms: number) => Promise<void>;
}

export interface BrowserHarnessInstance extends PluginInstance {
  run(task: HarnessTask, plan: BrowserActionPlan): Promise<HarnessRunLog>;
}

export type PlannedAction =
  | { kind: "navigate"; url: string }
  | { kind: "scroll"; px?: number }
  | { kind: "type"; selector: string; text: string }
  | { kind: "click"; selector: string };

export interface BrowserPacing {
  actionDelayMs: number;
  typeDelayMs: number;
  scrollStepPx: number;
  scrollPauseMs: number;
}

/** A bounded, replayable action plan — the only thing this harness runs. */
export interface BrowserActionPlan {
  actions: PlannedAction[];
}

const DEFAULTS: BrowserPacing = {
  actionDelayMs: 750,
  typeDelayMs: 60,
  scrollStepPx: 600,
  scrollPauseMs: 400,
};

function positiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return fallback;
  return value;
}

/**
 * CredentialGuard patterns (BRW-03, ADR 0005): selectors that plausibly
 * name a secret-entry field. Deliberately broad — a false positive costs a
 * denied action; a false negative would type a secret. There is NO
 * configuration to disable this guard.
 */
const CREDENTIAL_SELECTOR_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bpass(?:word|wd|wort)?\b/iu,
  /\bpwd\b/iu,
  /\b(?:otp|totp|2fa|mfa)\b/iu,
  /\b(?:one[-_ ]?time|verification)[-_ ]?code\b/iu,
  /\b(?:cvv|cvc|security[-_ ]?code)\b/iu,
  /\b(?:card|cc)[-_. ]?number\b/iu,
  /\bssn\b/iu,
  /\bapi[-_. ]?key\b/iu,
  /\b(?:secret|private[-_ ]?key)\b/iu,
  /\bauth[-_ ]?token\b/iu,
]);

export function isCredentialSelector(selector: string): boolean {
  return CREDENTIAL_SELECTOR_PATTERNS.some((re) => re.test(selector));
}

function hostOf(url: string): string {
  return new URL(url).hostname;
}

export function createBrowserHarness(deps: BrowserHarnessDeps): BrowserHarnessInstance {
  let pacing: BrowserPacing = { ...DEFAULTS };
  let activated = false;
  const now = deps.now ?? (() => Date.now());
  const sleep =
    deps.sleep ??
    (async (ms: number) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });

  return {
    async activate(context) {
      const cfg = context.config as BrowserHarnessConfig;
      pacing = {
        actionDelayMs: positiveInt(cfg.actionDelayMs, DEFAULTS.actionDelayMs),
        typeDelayMs: positiveInt(cfg.typeDelayMs, DEFAULTS.typeDelayMs),
        scrollStepPx: positiveInt(cfg.scrollStepPx, DEFAULTS.scrollStepPx),
        scrollPauseMs: positiveInt(cfg.scrollPauseMs, DEFAULTS.scrollPauseMs),
      };
      activated = true;
      context.events.emit("harness-browser.activated", { ...pacing });
    },

    async deactivate() {
      activated = false;
      await deps.driver.close();
    },

    async run(task: HarnessTask, plan: BrowserActionPlan): Promise<HarnessRunLog> {
      if (!activated) throw new Error("browser harness is not activated");
      const log = {
        task,
        actions: [] as HarnessAction[],
        outcome: "completed" as HarnessRunLog["outcome"],
      };

      const startedAt = now();
      const deadline = startedAt + task.limits.deadlineMs;
      let seq = 0;

      const record = (action: HarnessAction): void => {
        log.actions.push(action);
      };
      const deny = (action: Omit<HarnessAction, "allowed" | "seq">, deniedBy: string): "denied" => {
        record({ seq: seq++, allowed: false, deniedBy, ...action });
        return "denied";
      };

      for (const step of plan.actions) {
        if (log.actions.length >= task.limits.maxActions) {
          break; // plan truncated by the task's own bound
        }
        if (now() >= deadline) {
          log.outcome = "timeout";
          break;
        }
        // inter-action pacing: pause between actions (not before the first)
        if (seq > 0) {
          await sleep(pacing.actionDelayMs);
          if (now() >= deadline) {
            log.outcome = "timeout";
            break;
          }
        }

        if (step.kind === "navigate") {
          try {
            deps.sitePolicy.assertAllowed(hostOf(step.url));
          } catch (e) {
            log.outcome = deny(
              { type: "navigate", detail: step.url },
              `site-access: ${e instanceof Error ? e.message : "denied"}`,
            );
            break;
          }
          await deps.driver.navigate(step.url);
          record({ seq: seq++, type: "navigate", detail: step.url, allowed: true });
          continue;
        }

        if (step.kind === "scroll") {
          const px = step.px ?? pacing.scrollStepPx;
          await deps.driver.scrollBy(px);
          record({ seq: seq++, type: "scroll", detail: `${px}px`, allowed: true });
          await sleep(pacing.scrollPauseMs);
          continue;
        }

        if (step.kind === "type") {
          // BRW-03 credential guard: automation never types into
          // credential-shaped fields, under any profile, with no override
          if (isCredentialSelector(step.selector)) {
            log.outcome = deny(
              { type: "type", detail: `${step.selector} ← credential-shaped selector` },
              "credential-guard",
            );
            break;
          }
          await deps.driver.type(step.selector, step.text, pacing.typeDelayMs);
          record({
            seq: seq++,
            type: "type",
            // logs record the selector and LENGTH only — never the text
            detail: `${step.selector} ← ${step.text.length} chars @ ${pacing.typeDelayMs}ms/keystroke`,
            allowed: true,
          });
          continue;
        }

        if (step.kind === "click") {
          await deps.driver.click(step.selector);
          record({ seq: seq++, type: "click", detail: step.selector, allowed: true });
          continue;
        }
      }

      return HarnessRunLog.parse(log);
    },
  };
}
