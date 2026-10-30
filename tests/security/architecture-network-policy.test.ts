/**
 * Architecture test enforcing network transport invariants across production plugins and apps.
 *
 * Invariants checked:
 * 1. Production code in packages/plugins and apps/ must NOT use unapproved raw global fetch calls.
 * 2. Allowed fetch call sites in production must be documented in the allowlist below.
 * 3. Raw Node socket/HTTP modules (node:net, node:http, node:https) are banned in plugins (checked via policy.ts).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function collectTsFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
      collectTsFiles(p, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Allowlist of production files that may reference `fetch` directly, each with a mandatory documented rationale.
 */
const ALLOWLIST_FETCH_FILES: Record<string, string> = {
  // apps/server
  "apps/server/src/main.ts":
    "Live server composition initializing pinned safe-fetch and setting default adapter fetchImpl",
  "apps/server/src/compose-contracts.ts": "Type definition for FetchLike seam",
  "packages/server/src/default-page.ts":
    "Client-side browser JavaScript template for default landing page (runs in browser)",

  // packages/auth
  "packages/auth/src/oidc.ts":
    "OIDC verifier fetching JWKS keys with injectable fetchImpl fallback to fetch",

  // packages/storage
  "packages/storage/src/fastembed-embedder.ts":
    "FastEmbed model downloader with injectable fetchImpl fallback to fetch",

  // packages/safe-fetch
  "packages/safe-fetch/src/safe-fetch.ts": "Safe fetch orchestrator implementation",
  "packages/safe-fetch/src/pinned-fetch.ts": "Pinned fetch wrapper factory",
  "packages/safe-fetch/src/pinned-transport.ts":
    "Low-level Node HTTP/TLS pinned transport implementation",

  // Production plugins using injectable fetchImpl seams
  "packages/plugins/plugin-search-marginalia/src/index.ts":
    "Search adapter with injectable fetchImpl seam (defaults to fetch)",
  "packages/plugins/plugin-search-wikipedia/src/index.ts":
    "Search adapter with injectable fetchImpl seam (defaults to fetch)",
  "packages/plugins/plugin-model-openai-compat/src/index.ts":
    "Model adapter with injectable fetchImpl seam (defaults to fetch)",
};

function rel(f: string): string {
  return relative(ROOT, f).split(sep).join("/");
}

describe("Architecture Network Policy (CI Guard)", () => {
  it("enforces that no unapproved bare fetch calls exist in production plugin/app code", () => {
    const scanDirs = [join(ROOT, "packages"), join(ROOT, "apps")];
    const files = scanDirs.flatMap((d) => collectTsFiles(d));

    const violations: string[] = [];

    const fetchCallPattern = /\bfetch\s*\(/u;

    for (const file of files) {
      const relPath = rel(file);
      // Skip test-support files or non-source directories
      if (relPath.includes("/test/") || relPath.includes("/dist/")) continue;

      const text = readFileSync(file, "utf8");
      const lines = text.split(/\r?\n/);

      lines.forEach((line, index) => {
        const trimmed = line.trim();
        // Ignore single-line comments and type declarations/imports
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
        if (
          trimmed.includes("type FetchLike") ||
          trimmed.includes("import") ||
          trimmed.includes("export type")
        )
          return;

        if (fetchCallPattern.test(line)) {
          if (!ALLOWLIST_FETCH_FILES[relPath]) {
            violations.push(
              `${relPath}:${index + 1} uses direct fetch() call without allowlist registration`,
            );
          }
        }
      });
    }

    expect(violations, `Unapproved fetch calls detected:\n${violations.join("\n")}`).toEqual([]);
  });

  it("verifies every allowlisted file still exists in the repository", () => {
    for (const relPath of Object.keys(ALLOWLIST_FETCH_FILES)) {
      const fullPath = join(ROOT, relPath);
      expect(existsSync(fullPath), `Allowlisted file ${relPath} does not exist`).toBe(true);
    }
  });
});
