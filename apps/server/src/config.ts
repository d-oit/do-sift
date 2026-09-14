/**
 * OPS-05 (plan 005-007): env → typed config for the packaged entrypoint.
 * Pure and fail-closed: every missing-but-required or ambiguous value
 * throws with the offending variable named — a service that would silently
 * do nothing must refuse to start instead.
 *
 * Honesty rules encoded here:
 * - Fixture providers are opt-in labels, never defaults; live providers do
 *   not exist yet (SRC-02/ANS-02 gates: sources.md entries + paid grants).
 * - Remote DB URLs refuse: the Turso path runs through the storage
 *   plugin's kernel-mediated secret resolution, which the bare entrypoint
 *   does not replace (docs/deployment.md).
 */

export type SearchProviderChoice = "fixture" | "wikipedia";
export type ModelProviderChoice = "fixture";
export type EmbedderChoice = "fastembed";

export interface AppConfig {
  dbUrl: string;
  migrationsDir: string;
  host: string;
  port: number;
  owners: string[];
  devBypass: boolean;
  devOwner?: string | undefined;
  searchProvider: SearchProviderChoice;
  /** Unset → the answer surface stays unwired: /api/answer answers 501. */
  modelProvider?: ModelProviderChoice | undefined;
  /** Unset → keyword-only bm25 on both research and answer retrieval. */
  embedder?: EmbedderChoice | undefined;
  /** Exhaustive when non-empty (site-access policy semantics). */
  fetchAllowlist: string[];
}

function splitList(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseBool(name: string, raw: string | undefined): boolean {
  if (raw === undefined || raw === "") return false;
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  throw new Error(`${name} must be "1", "true", "0", or "false" (got "${raw}")`);
}

function isRemoteUrl(url: string): boolean {
  return url !== ":memory:" && !url.startsWith("file:");
}

export function parseEnvConfig(env: Record<string, string | undefined>): AppConfig {
  const owners = splitList(env.DO_SIFT_OWNERS);
  if (owners.length === 0) {
    throw new Error(
      "DO_SIFT_OWNERS must list at least one owner id (comma-separated): an empty allowlist could never authenticate anyone",
    );
  }

  const searchRaw = env.DO_SIFT_SEARCH_PROVIDER;
  if (searchRaw === undefined || searchRaw === "") {
    throw new Error(
      "DO_SIFT_SEARCH_PROVIDER is required ('fixture' or 'wikipedia' — the live adapter is terms-checked 2026-09-14 in plans/sources.md) — refusing to start an idle research surface",
    );
  }
  if (searchRaw !== "fixture" && searchRaw !== "wikipedia") {
    throw new Error(
      `DO_SIFT_SEARCH_PROVIDER must be "fixture" or "wikipedia" (got "${searchRaw}"); live adapters require a dated plans/sources.md entry (SRC-02 gate)`,
    );
  }

  const modelRaw = env.DO_SIFT_MODEL_PROVIDER;
  if (modelRaw !== undefined && modelRaw !== "" && modelRaw !== "fixture") {
    throw new Error(
      `DO_SIFT_MODEL_PROVIDER must be "fixture" or unset (got "${modelRaw}"); unset = /api/answer answers 501; live providers are gated behind ANS-02 + paid-capability grants`,
    );
  }

  const embedderRaw = env.DO_SIFT_EMBEDDER;
  if (embedderRaw !== undefined && embedderRaw !== "" && embedderRaw !== "fastembed") {
    throw new Error(
      `DO_SIFT_EMBEDDER must be "fastembed" or unset (got "${embedderRaw}"); unset = keyword-only bm25`,
    );
  }

  const dbUrl = env.DO_SIFT_DB_URL ?? "file:do-sift.db";
  if (isRemoteUrl(dbUrl)) {
    throw new Error(
      `DO_SIFT_DB_URL with a remote URL is not wired into the app entrypoint yet: the Turso path runs through the storage plugin + kernel secret service (docs/deployment.md); use a local file: URL (or :memory: for tests), got "${dbUrl}"`,
    );
  }

  const devBypass = parseBool("DO_SIFT_DEV_BYPASS", env.DO_SIFT_DEV_BYPASS);
  const devOwner = env.DO_SIFT_DEV_OWNER;
  if (devBypass && (devOwner === undefined || devOwner === "")) {
    throw new Error(
      "DO_SIFT_DEV_BYPASS=1 requires DO_SIFT_DEV_OWNER (the owner the bypass acts as)",
    );
  }
  if (devOwner !== undefined && devOwner !== "" && !owners.includes(devOwner)) {
    throw new Error("DO_SIFT_DEV_OWNER must be in the DO_SIFT_OWNERS allowlist");
  }

  const portRaw = env.DO_SIFT_PORT;
  let port = 8080;
  if (portRaw !== undefined && portRaw !== "") {
    port = Number(portRaw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`DO_SIFT_PORT must be an integer in 1..65535 (got "${portRaw}")`);
    }
  }

  return {
    dbUrl,
    migrationsDir: env.DO_SIFT_DB_MIGRATIONS_DIR ?? "migrations",
    host: env.DO_SIFT_HOST ?? "127.0.0.1",
    port,
    owners,
    devBypass,
    ...(devBypass && devOwner !== undefined && devOwner !== "" ? { devOwner } : {}),
    searchProvider: searchRaw,
    ...(modelRaw === "fixture" ? { modelProvider: "fixture" as const } : {}),
    ...(embedderRaw === "fastembed" ? { embedder: "fastembed" as const } : {}),
    fetchAllowlist: splitList(env.DO_SIFT_FETCH_ALLOWLIST),
  };
}
