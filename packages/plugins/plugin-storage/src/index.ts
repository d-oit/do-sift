/**
 * Storage plugin (CORE-02, ADR 0002). Owns the process's libSQL client.
 *
 * Fail-closed rules:
 * - Local URLs (`file:`, `:memory:`) need no extra grant; the `fs`
 *   capability covers local DB files.
 * - Remote URLs (Turso: `libsql://`, `https://`, `ws(s)://`) require BOTH
 *   the exact DB hostname in the manifest's `permissions.networkHosts`
 *   (kernel-checked) AND a resolvable auth-token secret named in
 *   `permissions.secrets` (kernel-checked). Anything missing refuses
 *   activation.
 *
 * The DB connection target is host configuration (see
 * storageConfigFromEnv); the plugin makes no other network calls.
 */
import { createClient, type Client } from "@libsql/client";
import { applyMigrations, loadMigrations } from "@do-sift/storage";
import type { PluginInstance } from "@do-sift/kernel";

export interface StoragePluginConfig {
  /** libSQL URL. Local: `file:*`, `:memory:`. Remote: Turso libsql:// etc. */
  url?: unknown;
  /** Secret name holding the remote auth token (remote URLs only). */
  authTokenSecret?: unknown;
  /** Directory of numbered migrations; omit to skip migration on activate. */
  migrationsDir?: unknown;
}

/** Host wiring for "Turso remote behind env config": env → plugin config. */
export function storageConfigFromEnv(env: Record<string, string | undefined>): StoragePluginConfig {
  return {
    url: env.DO_SIFT_DB_URL ?? "file:do-sift.db",
    authTokenSecret: env.DO_SIFT_DB_AUTH_TOKEN_SECRET,
    migrationsDir: env.DO_SIFT_DB_MIGRATIONS_DIR ?? "migrations",
  };
}

export interface StoragePluginInstance extends PluginInstance {
  /** The activated libSQL client. Valid until deactivate() closes it. */
  client(): Client;
}

function asString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`storage config.${field} must be a string`);
  return value;
}

function isRemoteUrl(url: string): boolean {
  return url !== ":memory:" && !url.startsWith("file:");
}

function remoteHost(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`storage config.url is not a valid remote URL: ${url}`);
  }
  return parsed.hostname;
}

export function createStoragePlugin(): StoragePluginInstance {
  let client: Client | undefined;

  return {
    async activate(context) {
      const cfg = context.config as StoragePluginConfig;
      const url = asString(cfg.url, "url") ?? "file:do-sift.db";
      const authTokenSecret = asString(cfg.authTokenSecret, "authTokenSecret");
      const migrationsDir = asString(cfg.migrationsDir, "migrationsDir");

      let authToken: string | undefined;
      if (isRemoteUrl(url)) {
        // kernel enforces the manifest network allowlist for this host
        context.network.assertHostAllowed(remoteHost(url));
        if (!authTokenSecret) {
          throw new Error(
            "remote storage requires config.authTokenSecret (kernel-resolved); refusing unauthenticated remote DB",
          );
        }
        authToken = await context.secrets.resolve(authTokenSecret);
      }

      client = createClient(authToken !== undefined ? { url, authToken } : { url });

      if (migrationsDir !== undefined) {
        await applyMigrations(client, loadMigrations(migrationsDir));
      }
      context.events.emit("storage.activated", {
        url: isRemoteUrl(url) ? remoteHost(url) : url,
        remote: isRemoteUrl(url),
      });
    },

    async deactivate() {
      client?.close();
      client = undefined;
    },

    client() {
      if (!client) throw new Error("storage plugin is not activated");
      return client;
    },
  };
}
