/**
 * OPS-05 (plan 005-007): env → typed config for the packaged entrypoint.
 * Pure and fail-closed: every missing-but-required or ambiguous value
 * throws with the offending variable named — a service that would silently
 * do nothing must refuse to start instead.
 *
 * Honesty rules encoded here:
 * - Fixture providers are opt-in labels, never defaults; live search needs
 *   its sources.md entry (SRC-02 gate) and a live model needs its terms
 *   pair (DO_SIFT_MODEL_TERMS_ACCEPTED_AT + DO_SIFT_MODEL_SOURCES_ENTRY —
 *   paid use additionally needs the router terms gate + INV-003 grant).
 * - Remote DB URLs refuse: the Turso path runs through the storage
 *   plugin's kernel-mediated secret resolution, which the bare entrypoint
 *   does not replace (docs/deployment.md).
 */
import { isLoopbackAddress } from "@do-sift/auth";

export type SearchProviderChoice = "fixture" | "wikipedia" | "marginalia";
export type ModelProviderChoice = "fixture" | "openai-compat";
export type EmbedderChoice = "fastembed";
export type ModelResponseFormat = "strict" | "best-effort" | "json";

export interface OpenAICompatModelEnv {
  baseURL: string;
  modelId: string;
  /**
   * NAME of the env var holding the provider key (never the key itself —
   * same posture as DO_SIFT_DB_AUTH_TOKEN_SECRET). Undefined = keyless
   * (Ollama-class loopback servers). When named, the entrypoint resolves
   * it at startup and refuses to start if it is missing or empty.
   */
  apiKeySecret?: string | undefined;
  /**
   * Kill-switch for key sending (default true): "if a key exists, use it"
   * unless the operator sets this to "0"/"false", which forces keyless
   * operation even when apiKeySecret is configured.
   */
  useApiKey: boolean;
  responseFormat: ModelResponseFormat;
  schemaName: string;
  /** Dated sources.md gate, mirrored into the plugin activation terms. */
  termsAcceptedAt: string;
  sourcesEntry: string;
}

export interface AppConfig {
  dbUrl: string;
  migrationsDir: string;
  host: string;
  port: number;
  owners: string[];
  devBypass: boolean;
  devOwner?: string | undefined;
  /** SRC-16: one or more live/fixture search providers, in priority order
   * (primary first). A single value parses as a one-element list. */
  searchProviders: SearchProviderChoice[];
  /** Unset → the answer surface stays unwired: /api/answer answers 501. */
  modelProvider?: ModelProviderChoice | undefined;
  /** Set iff modelProvider is "openai-compat" (fail-closed parsing below). */
  modelOpenAI?: OpenAICompatModelEnv | undefined;
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
      "DO_SIFT_SEARCH_PROVIDER is required ('fixture', 'wikipedia', or 'marginalia' — comma-separated lists compose a merged provider, SRC-16) — refusing to start an idle research surface",
    );
  }
  const ALLOWED_SEARCH = new Set(["fixture", "wikipedia", "marginalia"]);
  const searchProviders = searchRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (searchProviders.length === 0) {
    throw new Error(`DO_SIFT_SEARCH_PROVIDER lists no providers (got "${searchRaw}")`);
  }
  for (const choice of searchProviders) {
    if (!ALLOWED_SEARCH.has(choice)) {
      throw new Error(
        `DO_SIFT_SEARCH_PROVIDER entries must be "fixture", "wikipedia", or "marginalia" (got "${choice}"); live adapters require a dated plans/sources.md entry (SRC-02 gate)`,
      );
    }
  }
  if (new Set(searchProviders).size !== searchProviders.length) {
    throw new Error(
      `DO_SIFT_SEARCH_PROVIDER lists duplicate providers (got "${searchRaw}") — a merged provider needs distinct sources`,
    );
  }
  if (searchProviders.includes("fixture") && searchProviders.length > 1) {
    throw new Error(
      `DO_SIFT_SEARCH_PROVIDER cannot mix "fixture" with live providers (got "${searchRaw}")`,
    );
  }

  const modelRaw = env.DO_SIFT_MODEL_PROVIDER;
  if (
    modelRaw !== undefined &&
    modelRaw !== "" &&
    modelRaw !== "fixture" &&
    modelRaw !== "openai-compat"
  ) {
    throw new Error(
      `DO_SIFT_MODEL_PROVIDER must be "fixture", "openai-compat", or unset (got "${modelRaw}"); unset = /api/answer answers 501; "openai-compat" needs DO_SIFT_MODEL_BASE_URL + DO_SIFT_MODEL_ID + the terms pair, with an optional key via DO_SIFT_MODEL_API_KEY_SECRET (paid use additionally needs the router terms gate + INV-003 grant)`,
    );
  }

  let modelOpenAI: OpenAICompatModelEnv | undefined;
  if (modelRaw === "openai-compat") {
    const baseURL = env.DO_SIFT_MODEL_BASE_URL ?? "";
    const modelId = env.DO_SIFT_MODEL_ID ?? "";
    const termsAcceptedAt = env.DO_SIFT_MODEL_TERMS_ACCEPTED_AT ?? "";
    const sourcesEntry = env.DO_SIFT_MODEL_SOURCES_ENTRY ?? "";
    if (baseURL.trim() === "") {
      throw new Error(
        "DO_SIFT_MODEL_BASE_URL is required with DO_SIFT_MODEL_PROVIDER=openai-compat (e.g. http://localhost:11434/v1 for Ollama-local, https://api.groq.com/openai/v1 for Groq)",
      );
    }
    if (modelId.trim() === "") {
      throw new Error(
        "DO_SIFT_MODEL_ID is required with DO_SIFT_MODEL_PROVIDER=openai-compat (the provider model id, e.g. gpt-oss-20b)",
      );
    }
    if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/u.test(termsAcceptedAt)) {
      throw new Error(
        "DO_SIFT_MODEL_TERMS_ACCEPTED_AT must record the date the provider terms were checked (mirrored into the plugin activation gate; see plans/sources.md)",
      );
    }
    if (sourcesEntry.trim() === "") {
      throw new Error(
        "DO_SIFT_MODEL_SOURCES_ENTRY must name the plans/sources.md entry that clears this provider (mirrored into the plugin activation gate)",
      );
    }
    const responseFormatRaw = env.DO_SIFT_MODEL_RESPONSE_FORMAT ?? "strict";
    if (
      responseFormatRaw !== "strict" &&
      responseFormatRaw !== "best-effort" &&
      responseFormatRaw !== "json"
    ) {
      throw new Error(
        `DO_SIFT_MODEL_RESPONSE_FORMAT must be "strict", "best-effort", or "json" (got "${responseFormatRaw}")`,
      );
    }
    const apiKeySecretRaw = env.DO_SIFT_MODEL_API_KEY_SECRET ?? "";
    // CodeQL clear-text-logging hygiene: this var's name marks its value
    // as sensitive, so the refusal below must NOT echo the value the way
    // parseBool does for ordinary flags — name the variable, never the value.
    const useApiKeyRaw = env.DO_SIFT_MODEL_USE_API_KEY ?? "";
    let useApiKey = true;
    if (useApiKeyRaw !== "") {
      if (useApiKeyRaw === "1" || useApiKeyRaw === "true") useApiKey = true;
      else if (useApiKeyRaw === "0" || useApiKeyRaw === "false") useApiKey = false;
      else {
        throw new Error(
          'DO_SIFT_MODEL_USE_API_KEY must be "1", "true", "0", or "false" to switch key sending',
        );
      }
    }
    const init: OpenAICompatModelEnv = {
      baseURL: baseURL.trim(),
      modelId: modelId.trim(),
      useApiKey,
      responseFormat: responseFormatRaw,
      schemaName:
        env.DO_SIFT_MODEL_SCHEMA_NAME?.trim() === "" || env.DO_SIFT_MODEL_SCHEMA_NAME === undefined
          ? "grounded_answer"
          : env.DO_SIFT_MODEL_SCHEMA_NAME.trim(),
      termsAcceptedAt,
      sourcesEntry: sourcesEntry.trim(),
    };
    if (apiKeySecretRaw.trim() !== "") init.apiKeySecret = apiKeySecretRaw.trim();
    modelOpenAI = init;
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
  const host = env.DO_SIFT_HOST ?? "127.0.0.1";
  if (devBypass && !isLoopbackAddress(host)) {
    throw new Error(
      "DO_SIFT_DEV_BYPASS requires a literal loopback DO_SIFT_HOST; a reverse proxy must keep the upstream loopback-only",
    );
  }
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
    host,
    port,
    owners,
    devBypass,
    ...(devBypass && devOwner !== undefined && devOwner !== "" ? { devOwner } : {}),
    searchProviders: searchProviders as SearchProviderChoice[],
    ...(modelRaw === "fixture" ? { modelProvider: "fixture" as const } : {}),
    ...(modelRaw === "openai-compat" && modelOpenAI !== undefined
      ? { modelProvider: "openai-compat" as const, modelOpenAI }
      : {}),
    ...(embedderRaw === "fastembed" ? { embedder: "fastembed" as const } : {}),
    fetchAllowlist: splitList(env.DO_SIFT_FETCH_ALLOWLIST),
  };
}
