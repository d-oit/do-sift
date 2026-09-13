/**
 * Computer harness (CMP-01/CMP-02, plan 006, ADR 0005). Local desktop
 * automation through an injected DesktopDriver (OS accessibility layer —
 * real driver lands later; tests inject a fake, so this slice is offline).
 *
 * NO REMOTE CONTROL SURFACE (CMP-02): this package binds no sockets, opens
 * no listeners, and exposes no network API — its entire export surface is
 * types, the harness factory, the consent ledger, and the pure replay
 * function (guarded by a test). The only inputs are the local caller's.
 *
 * Consent model (the heart of this slice):
 * - DISABLED BY DEFAULT: activation refuses unless config.enabled === true,
 *   and the kernel independently requires an explicit computer grant
 *   (INV-003) — two independent switches, both needed.
 * - PER-CLASS INTERACTIVE CONSENT: every action belongs to a class
 *   (open/type/click/scroll/key). The first action in a class prompts the
 *   user through the injected ConsentPrompt; the decision may be remembered
 *   per class. Denied classes deny their actions — remembered denies never
 *   prompt again.
 * - FAIL CLOSED: with no consent prompt wired, unconsented classes are
 *   denied (CMP-03 tests the bypass attempts). Consent decisions are
 *   recorded in an append-only ledger; every action lands in the
 *   replayable HarnessRunLog. There is no remote control surface of any
 *   kind — the only input is the local caller.
 */
import { HarnessRunLog, type HarnessAction, type HarnessTask } from "@do-sift/contracts";
import type { PluginInstance } from "@do-sift/kernel";

export type ComputerActionClass = "open" | "type" | "click" | "scroll" | "key";

export interface ComputerHarnessConfig {
  enabled?: unknown;
  actionDelayMs?: unknown;
  typeDelayMs?: unknown;
}

/** The seam the OS accessibility driver implements later; tests inject a fake. */
export interface DesktopDriver {
  open(target: string): Promise<void>;
  type(text: string, perKeystrokeMs: number): Promise<void>;
  click(target: string): Promise<void>;
  scroll(px: number): Promise<void>;
  key(combo: string): Promise<void>;
  close(): Promise<void>;
}

export interface ConsentDecision {
  allowed: boolean;
  /** Remember this verdict for the rest of the run (per class). */
  rememberClass: boolean;
}

export interface ConsentPrompt {
  ask(actionClass: ComputerActionClass, detail: string): Promise<ConsentDecision>;
}

export interface ConsentLedgerEntry {
  actionClass: ComputerActionClass;
  allowed: boolean;
  remembered: boolean;
  decidedAt: string;
}

/** Append-only record of consent decisions (CMP-02 replayability). */
export class ConsentLedger {
  private readonly entries: ConsentLedgerEntry[] = [];
  private readonly remembered = new Map<ComputerActionClass, boolean>();

  record(decision: ConsentDecision, actionClass: ComputerActionClass, nowIso: string): void {
    this.entries.push({
      actionClass,
      allowed: decision.allowed,
      remembered: decision.rememberClass,
      decidedAt: nowIso,
    });
    if (decision.rememberClass) {
      this.remembered.set(actionClass, decision.allowed);
    }
  }

  /** true/false when the class has a remembered verdict; undefined = ask. */
  verdictFor(actionClass: ComputerActionClass): boolean | undefined {
    return this.remembered.get(actionClass);
  }

  /** Defensive copy — external callers cannot rewrite the consent record. */
  all(): readonly ConsentLedgerEntry[] {
    return [...this.entries];
  }
}

/**
 * The ONLY sanctioned secret source for computer automation (CMP-03,
 * ADR 0005): the OS keychain, resolved at execution time by the real
 * driver. Secrets never ride in plans, config, or logs — activation
 * refuses secret-shaped config keys outright, and run logs record typed
 * lengths only.
 */
export interface KeychainProvider {
  /** Resolve a keychain secret by name; undefined = not present. */
  getSecret(name: string): Promise<string | undefined>;
}

const SECRET_SHAPED_CONFIG_KEY =
  /pass(?:word|wd|wort)?|secret|token|api[-_. ]?key|credential|private[-_ ]?key|apikey/iu;

export interface ComputerHarnessDeps {
  driver: DesktopDriver;
  /** Interactive approval; absent = fail-closed (unconsented classes deny). */
  consent?: ConsentPrompt | undefined;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type PlannedComputerAction =
  | { kind: "open"; target: string }
  | { kind: "type"; text: string }
  | { kind: "click"; target: string }
  | { kind: "scroll"; px: number }
  | { kind: "key"; combo: string };

export interface ComputerActionPlan {
  actions: PlannedComputerAction[];
}

export interface ComputerHarnessInstance extends PluginInstance {
  run(task: HarnessTask, plan: ComputerActionPlan): Promise<HarnessRunLog>;
  /** Consent decisions so far (replayable; CMP-02 consumes this). */
  consentLedger(): readonly ConsentLedgerEntry[];
}

function positiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return fallback;
  return value;
}

export function createComputerHarness(deps: ComputerHarnessDeps): ComputerHarnessInstance {
  const ledger = new ConsentLedger();
  let actionDelayMs = 500;
  let typeDelayMs = 60;
  let activated = false;
  const now = deps.now ?? (() => Date.now());
  const sleep =
    deps.sleep ??
    (async (ms: number) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });

  return {
    async activate(context) {
      const cfg = context.config as ComputerHarnessConfig;
      if (cfg.enabled !== true) {
        // ADR 0005: computer automation is consent-gated and DEFAULT-OFF
        throw new Error(
          "computer harness is disabled by default: set config.enabled=true (and hold the kernel computer grant) to activate",
        );
      }
      // CMP-03: secrets ride in the OS keychain, never in config
      for (const key of Object.keys(cfg)) {
        if (SECRET_SHAPED_CONFIG_KEY.test(key)) {
          throw new Error(
            `config key "${key}" is secret-shaped: secrets come from the OS keychain (KeychainProvider), never from harness config`,
          );
        }
      }
      actionDelayMs = positiveInt(cfg.actionDelayMs, 500);
      typeDelayMs = positiveInt(cfg.typeDelayMs, 60);
      activated = true;
      context.events.emit("harness-computer.activated", { actionDelayMs, typeDelayMs });
    },

    async deactivate() {
      activated = false;
      await deps.driver.close();
    },

    consentLedger(): readonly ConsentLedgerEntry[] {
      return ledger.all();
    },

    async run(task: HarnessTask, plan: ComputerActionPlan): Promise<HarnessRunLog> {
      if (!activated) throw new Error("computer harness is not activated");
      const log = {
        task,
        actions: [] as HarnessAction[],
        outcome: "completed" as HarnessRunLog["outcome"],
      };
      let seq = 0;

      const deny = (action: Omit<HarnessAction, "allowed" | "seq">, deniedBy: string): "denied" => {
        log.actions.push({ seq: seq++, allowed: false, deniedBy, ...action });
        return "denied";
      };
      const approve = (action: Omit<HarnessAction, "allowed" | "seq">): void => {
        log.actions.push({ seq: seq++, allowed: true, ...action });
      };

      /** Consent for one action: remembered verdict → prompt → fail-closed.
       * A prompt that CRASHES is a denial, not an escape hatch (CMP-03):
       * the run logs the denial and keeps the replayable record. */
      const consentTo = async (
        actionClass: ComputerActionClass,
        detail: string,
      ): Promise<boolean> => {
        const remembered = ledger.verdictFor(actionClass);
        if (remembered !== undefined) return remembered;
        if (deps.consent === undefined) {
          return false; // no interactive approver wired: fail closed
        }
        let decision: ConsentDecision;
        try {
          decision = await deps.consent.ask(actionClass, detail);
        } catch (e) {
          ledger.record(
            { allowed: false, rememberClass: false },
            actionClass,
            new Date(now()).toISOString(),
          );
          console.warn(
            `[harness-computer] consent prompt failed for class "${actionClass}": ${e instanceof Error ? e.message : String(e)} — treated as denial`,
          );
          return false;
        }
        // garbage verdicts (non-boolean fields) deny without memory; a
        // WELL-FORMED deny keeps its rememberedClass (CMP-01 semantics)
        const wellFormed =
          decision !== null &&
          typeof decision === "object" &&
          typeof decision.allowed === "boolean" &&
          typeof decision.rememberClass === "boolean";
        if (!wellFormed) {
          ledger.record(
            { allowed: false, rememberClass: false },
            actionClass,
            new Date(now()).toISOString(),
          );
          return false;
        }
        ledger.record(decision, actionClass, new Date(now()).toISOString());
        return decision.allowed;
      };

      for (const step of plan.actions) {
        if (log.actions.length >= task.limits.maxActions) break;
        if (seq > 0) await sleep(actionDelayMs);

        if (step.kind === "open") {
          if (!(await consentTo("open", step.target))) {
            log.outcome = deny({ type: "open", detail: step.target }, "consent:open");
            break;
          }
          await deps.driver.open(step.target);
          approve({ type: "open", detail: step.target });
          continue;
        }
        if (step.kind === "type") {
          if (!(await consentTo("type", `${step.text.length} chars`))) {
            log.outcome = deny(
              { type: "type", detail: `${step.text.length} chars` },
              "consent:type",
            );
            break;
          }
          await deps.driver.type(step.text, typeDelayMs);
          approve({
            type: "type",
            detail: `${step.text.length} chars @ ${typeDelayMs}ms/keystroke`,
          });
          continue;
        }
        if (step.kind === "click") {
          if (!(await consentTo("click", step.target))) {
            log.outcome = deny({ type: "click", detail: step.target }, "consent:click");
            break;
          }
          await deps.driver.click(step.target);
          approve({ type: "click", detail: step.target });
          continue;
        }
        if (step.kind === "scroll") {
          if (!(await consentTo("scroll", `${step.px}px`))) {
            log.outcome = deny({ type: "scroll", detail: `${step.px}px` }, "consent:scroll");
            break;
          }
          await deps.driver.scroll(step.px);
          approve({ type: "scroll", detail: `${step.px}px` });
          continue;
        }
        if (step.kind === "key") {
          if (!(await consentTo("key", step.combo))) {
            log.outcome = deny({ type: "key", detail: step.combo }, "consent:key");
            break;
          }
          await deps.driver.key(step.combo);
          approve({ type: "key", detail: step.combo });
          continue;
        }
      }

      return HarnessRunLog.parse(log);
    },
  };
}

export { ReplayError, replayComputerRun } from "./replay.js";
export type { ReplayComputerRunOptions, ReplayOutcome } from "./replay.js";
