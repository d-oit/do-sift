/** baseURL parsing for the trusted-operator gate: loopback detection and the fail-closed URL parser. */
import { ModelProviderError } from "./model-contracts.js";
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}
export function parseBaseURL(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ModelProviderError(
      "http",
      "activation refused: config.baseURL must be a non-empty OpenAI-compatible base URL (e.g. https://api.groq.com/openai/v1 or http://localhost:11434/v1)",
    );
  }
  let url: URL;
  try {
    // Strip trailing slashes without a regex (CodeQL js/redos hygiene —
    // a `\/+$` pattern can backtrack on slash-heavy input).
    let normalized = value.trim();
    while (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
    url = new URL(normalized);
  } catch {
    throw new ModelProviderError(
      "http",
      "activation refused: config.baseURL does not parse as a URL",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ModelProviderError(
      "http",
      "activation refused: config.baseURL must be https (http is allowed for loopback hosts only)",
    );
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new ModelProviderError(
      "http",
      `activation refused: http baseURL host "${url.hostname}" is not loopback — remote providers require https`,
    );
  }
  return url.toString();
}
