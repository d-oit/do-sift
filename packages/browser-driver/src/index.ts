/**
 * Playwright-backed BrowserDriver (BRW-04, plan 005, ADR 0005). The real
 * driver behind the harness's BrowserDriver seam: chromium, headless by
 * default, optionally over a USER-supplied profile directory
 * (launchPersistentContext — BRW-03 profile sessions; the user logged in
 * themselves, automation never does).
 *
 * Non-stealth by construction: default Chromium, default user agent, no
 * fingerprint shaping, no anti-detection of any kind (INV-004).
 *
 * DOM-level credential refusal (the durable defense noted in BRW-03):
 * before typing, the driver inspects the REAL element — `input[type=password]`,
 * credential `autocomplete` hints, or credential-shaped name/id/label — and
 * refuses. This catches sites whose selectors hide what the field is.
 */
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { isCredentialSelector, type BrowserDriver } from "@do-sift/plugin-harness-browser";

export class CredentialTypingError extends Error {
  constructor(
    public readonly selector: string,
    reason: string,
  ) {
    super(`refusing to type into "${selector}": ${reason}`);
    this.name = "CredentialTypingError";
  }
}

export interface PlaywrightDriverOptions {
  /** User-supplied logged-in profile directory (BRW-03); omit = fresh session. */
  profileDir?: string | undefined;
  headless?: boolean | undefined;
}

export interface PlaywrightDriverHandle {
  driver: PlaywrightDriver;
  close(): Promise<void>;
}

const CREDENTIAL_AUTOCOMPLETE = [
  "current-password",
  "new-password",
  "one-time-code",
  "cc-number",
  "cc-csc",
  "cc-exp",
];

export class PlaywrightDriver implements BrowserDriver {
  private constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly browser: Browser | undefined,
  ) {}

  static async launch(options: PlaywrightDriverOptions = {}): Promise<PlaywrightDriver> {
    const headless = options.headless ?? true;
    let context: BrowserContext;
    let browser: Browser | undefined;
    if (options.profileDir !== undefined) {
      context = await chromium.launchPersistentContext(options.profileDir, { headless });
    } else {
      browser = await chromium.launch({ headless });
      context = await browser.newContext();
    }
    const page = context.pages()[0] ?? (await context.newPage());
    return new PlaywrightDriver(context, page, browser);
  }

  /** The live page — for e2e assertions only; action flows go through the harness. */
  currentUrl(): string {
    return this.page.url();
  }

  async navigate(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: "load" });
  }

  async scrollBy(px: number): Promise<void> {
    await this.page.mouse.wheel(0, px);
  }

  async type(selector: string, text: string, perKeystrokeMs: number): Promise<void> {
    const locator = this.page.locator(selector).first();
    const reason = await this.credentialRefusalReason(locator, selector);
    if (reason !== undefined) throw new CredentialTypingError(selector, reason);
    await locator.pressSequentially(text, { delay: perKeystrokeMs });
  }

  async click(selector: string): Promise<void> {
    await this.page.locator(selector).first().click();
  }

  /** Inspect the REAL element (BRW-03's durable defense): DOM type beats selectors. */
  private async credentialRefusalReason(
    locator: Locator,
    selector: string,
  ): Promise<string | undefined> {
    const info = await locator
      .evaluate((el) => {
        // structural shape — no DOM lib needed; attributes only, never page JS
        const input = el as {
          tagName: string;
          type?: string | null;
          autocomplete?: string | null;
          getAttribute(name: string): string | null;
        };
        const label = (
          el.getAttribute("aria-label") ??
          el.getAttribute("placeholder") ??
          el.getAttribute("name") ??
          el.getAttribute("id") ??
          ""
        ).toLowerCase();
        return {
          tag: input.tagName.toLowerCase(),
          type: input.type ?? undefined,
          autocomplete: input.autocomplete ?? undefined,
          label,
        };
      })
      .catch(() => undefined);
    if (info === undefined) return undefined; // element not present: typing will fail on its own

    if (info.tag === "input" && info.type === "password") {
      return "element is input[type=password]";
    }
    if (
      info.autocomplete !== undefined &&
      info.autocomplete !== "" &&
      info.autocomplete !== "off"
    ) {
      const ac = info.autocomplete.toLowerCase();
      if (CREDENTIAL_AUTOCOMPLETE.some((c) => ac.includes(c))) {
        return `autocomplete="${info.autocomplete}" marks a credential field`;
      }
    }
    if (isCredentialSelector(info.label)) {
      return `element name/label "${info.label}" is credential-shaped`;
    }
    if (isCredentialSelector(selector)) {
      return "selector is credential-shaped";
    }
    return undefined;
  }

  async close(): Promise<void> {
    await this.context.close();
    await this.browser?.close();
  }
}
