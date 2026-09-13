/**
 * BRW-03 credential guard: automation never types into credential-shaped
 * fields, under any profile, with no override. Also proves run logs stay
 * secret-free (lengths and selectors only, never typed text).
 */
import { describe, expect, it } from "vitest";
import type { HarnessTask } from "@do-sift/contracts";
import {
  createBrowserHarness,
  isCredentialSelector,
  type BrowserActionPlan,
  type BrowserDriver,
  type BrowserHarnessInstance,
  type SiteAccessGate,
} from "../src/index.js";

function task(): HarnessTask {
  return {
    kind: "browser",
    ownerId: "owner-a",
    instruction: "credential guard fixture",
    limits: { deadlineMs: 60_000, maxActions: 10 },
  };
}

function makeDriver() {
  const typed: Array<{ selector: string; text: string }> = [];
  return {
    typed,
    driver: {
      navigate: async () => {},
      scrollBy: async () => {},
      type: async (selector: string, text: string) => {
        typed.push({ selector, text });
      },
      click: async () => {},
      close: async () => {},
    } satisfies BrowserDriver,
  };
}

const gate: SiteAccessGate = { assertAllowed: () => {} };

async function harness(driver: BrowserDriver): Promise<BrowserHarnessInstance> {
  const instance = createBrowserHarness({
    driver,
    sitePolicy: gate,
    now: () => Date.now(),
    sleep: async () => {},
  });
  await instance.activate({
    pluginName: "harness-browser",
    config: {},
    events: { emit: () => {} },
  } as unknown as Parameters<BrowserHarnessInstance["activate"]>[0]);
  return instance;
}

describe("credential guard (BRW-03)", () => {
  it("refuses typing into credential-shaped selectors, with no override", async () => {
    const { typed, driver } = makeDriver();
    const instance = await harness(driver);
    for (const selector of [
      "#password",
      "input[name='passwd']",
      "#passwort",
      "input[type='password']", // selector text itself names the field type
      "#otp-code",
      "input[name='one_time_code']",
      "#totp",
      "#cvv",
      "input[name='card-number']",
      "#cc_number",
      "#ssn",
      "input[name='api-key']",
      "#secret-field",
      "#auth_token",
    ]) {
      const runLog = await instance.run(task(), {
        actions: [{ kind: "type", selector, text: "hunter2" }],
      });
      expect(runLog.outcome, selector).toBe("denied");
      expect(runLog.actions[0]).toMatchObject({
        type: "type",
        allowed: false,
        deniedBy: "credential-guard",
      });
    }
    expect(typed).toHaveLength(0); // nothing ever reached the driver
  });

  it("stops the plan at the guard: later actions never run", async () => {
    const { typed, driver } = makeDriver();
    const instance = await harness(driver);
    const plan: BrowserActionPlan = {
      actions: [
        { kind: "type", selector: "#search", text: "fine" },
        { kind: "type", selector: "#password", text: "hunter2" },
        { kind: "click", selector: "#submit" }, // never reached
      ],
    };
    const runLog = await instance.run(task(), plan);
    expect(runLog.outcome).toBe("denied");
    expect(typed).toEqual([{ selector: "#search", text: "fine" }]);
    expect(runLog.actions).toHaveLength(2);
  });

  it("keeps logs secret-free: selectors and lengths only, never typed text", async () => {
    const { driver } = makeDriver();
    const instance = await harness(driver);
    const secret = "definitely-a-secret-value";
    const runLog = await instance.run(task(), {
      actions: [{ kind: "type", selector: "#search", text: secret }],
    });
    const serialized = JSON.stringify(runLog);
    expect(serialized).not.toContain(secret);
    expect(runLog.actions[0]?.detail).toContain("25 chars"); // length, not content
  });

  it("classifies broadly, accepting false positives over false negatives", () => {
    for (const denied of [
      "#Password",
      "input[name='PWD']",
      "div[data-field=verification-code]",
      "#Card.Number",
      "textarea#private-key",
    ]) {
      expect(isCredentialSelector(denied), denied).toBe(true);
    }
    for (const allowed of [
      "#search",
      "input[name='q']",
      "#comment-body",
      ".bypass-link",
      "#username",
    ]) {
      expect(isCredentialSelector(allowed), allowed).toBe(false);
    }
  });
});
