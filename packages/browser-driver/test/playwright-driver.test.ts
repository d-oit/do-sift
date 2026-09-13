/**
 * BRW-04 e2e: the REAL browser (Playwright chromium) behind the harness,
 * with the REAL site-access policy in strict mode.
 *
 * - Own-app e2e: a loopback page is navigated, typed into, and submitted
 *   through a full harness plan with human pacing.
 * - Deny-list enforcement: linkedin.com and fixture hosts are refused by
 *   the policy layers BEFORE the browser loads anything; the page never
 *   leaves the own app.
 * - DOM-level credential refusal (BRW-03's durable defense): a selector
 *   that looks innocent ("#field-a") whose element is genuinely
 *   input[type=password] is refused by the driver at the DOM layer.
 *
 * Browser-availability contract: if no chromium binary is installed the
 * suite skips as a whole (CI currently runs without browser downloads;
 * installing it locally enables this suite). Skipping is confined to the
 * launch boundary — no check or unit test is weakened.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CredentialTypingError, PlaywrightDriver } from "../src/index.js";
import { createSiteAccessPolicy, type SiteAccessInstance } from "@do-sift/plugin-policy-siteaccess";
import { createBrowserHarness, type BrowserHarnessInstance } from "@do-sift/plugin-harness-browser";

const OWN_APP_HTML = `<!doctype html><html><body>
<form id="f" method="get" action="/search">
  <input id="q" name="q" autocomplete="off">
  <input id="field-a" type="password" name="masked-field">
  <input id="cc" name="payment" autocomplete="cc-number">
  <button id="submit" type="submit">Go</button>
</form></body></html>`;

let server: Server;
let port: number;
let driver: PlaywrightDriver;
let policy: SiteAccessInstance;
let harness: BrowserHarnessInstance;
let browserAvailable = true;

const ownApp = (): string => `http://127.0.0.1:${port}/`;

async function strictPolicy(): Promise<SiteAccessInstance> {
  const p = createSiteAccessPolicy();
  await p.activate({
    pluginName: "policy-siteaccess",
    config: {
      requireRegistry: true,
      sitePolicies: [
        // the loopback own app, registered and approved for e2e
        {
          host: "127.0.0.1",
          robotsAccess: "allow",
          tosAutomated: "automated-ok",
          checkedAt: "2026-09-11",
        },
        {
          host: "robots-denied.test",
          robotsAccess: "deny",
          tosAutomated: "unspecified",
          checkedAt: "2026-09-11",
        },
      ],
    },
    events: { emit: () => {} },
  } as unknown as Parameters<SiteAccessInstance["activate"]>[0]);
  return p;
}

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(OWN_APP_HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;

  try {
    driver = await PlaywrightDriver.launch({ headless: true });
  } catch (e) {
    browserAvailable = false;
    console.warn(
      `BRW-04 e2e skipped: chromium unavailable (${e instanceof Error ? e.message : String(e)})`,
    );
    return;
  }
  policy = await strictPolicy();
  harness = createBrowserHarness({ driver, sitePolicy: policy, sleep: async () => {} });
  await harness.activate({
    pluginName: "harness-browser",
    config: { actionDelayMs: 5, typeDelayMs: 1 },
    events: { emit: () => {} },
  } as unknown as Parameters<BrowserHarnessInstance["activate"]>[0]);
});

afterAll(async () => {
  await harness?.deactivate();
  server.close();
});

describe("own-app e2e (BRW-04)", () => {
  it("navigates, types with pacing, and submits on the real browser", async () => {
    if (!browserAvailable) return; // suite-wide skip when no chromium
    const runLog = await harness.run(
      {
        kind: "browser",
        ownerId: "owner-a",
        instruction: "own-app e2e",
        limits: { deadlineMs: 60_000, maxActions: 10 },
      },
      {
        actions: [
          { kind: "navigate", url: ownApp() },
          { kind: "type", selector: "#q", text: "receipts" },
          { kind: "click", selector: "#submit" },
        ],
      },
    );
    expect(runLog.outcome).toBe("completed");
    // the GET form carried the typed query: proof the keystrokes landed
    expect(driver.currentUrl()).toContain("q=receipts");
  });

  it("refuses deny-listed and unregistered hosts before the browser loads them", async () => {
    if (!browserAvailable) return;
    const before = driver.currentUrl();

    for (const hostile of [
      "https://www.linkedin.com/lure", // layer 1: shipped default-deny
      "https://robots-denied.test/x", // layer 2: registry robots deny
      "https://unregistered.test/x", // layer 5: strict mode
    ]) {
      const runLog = await harness.run(
        {
          kind: "browser",
          ownerId: "owner-a",
          instruction: "deny enforcement",
          limits: { deadlineMs: 60_000, maxActions: 5 },
        },
        { actions: [{ kind: "navigate", url: hostile }] },
      );
      expect(runLog.outcome, hostile).toBe("denied");
      expect(runLog.actions[0]?.allowed, hostile).toBe(false);
    }
    // the browser never left the own app — no denied host was ever loaded
    expect(driver.currentUrl()).toBe(before);
  });

  it("refuses typing into a password field the DOM reveals but the selector hides", async () => {
    if (!browserAvailable) return;
    // "#field-a" is innocent to the selector guard; the element is type=password
    await expect(
      harness.run(
        {
          kind: "browser",
          ownerId: "owner-a",
          instruction: "dom guard",
          limits: { deadlineMs: 60_000, maxActions: 5 },
        },
        { actions: [{ kind: "type", selector: "#field-a", text: "hunter2" }] },
      ),
    ).rejects.toBeInstanceOf(CredentialTypingError);
    // the autocomplete-marked payment field is refused too
    await expect(
      harness.run(
        {
          kind: "browser",
          ownerId: "owner-a",
          instruction: "dom guard",
          limits: { deadlineMs: 60_000, maxActions: 5 },
        },
        { actions: [{ kind: "type", selector: "#cc", text: "4111111111111111" }] },
      ),
    ).rejects.toBeInstanceOf(CredentialTypingError);
  });
});
