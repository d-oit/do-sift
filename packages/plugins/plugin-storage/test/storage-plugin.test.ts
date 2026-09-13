import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CapabilityError, Kernel } from "@do-sift/kernel";
import { loadMigrations } from "@do-sift/storage";
import storageJson from "../plugin.json" with { type: "json" };
import {
  createStoragePlugin,
  storageConfigFromEnv,
  type StoragePluginInstance,
} from "../src/index.js";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");

function makeKernel(options?: ConstructorParameters<typeof Kernel>[1]): Kernel {
  return new Kernel("local", options);
}

function registerFactory(
  kernel: Kernel,
  manifest: unknown,
): { readonly current: StoragePluginInstance | undefined } {
  const ref: { current: StoragePluginInstance | undefined } = { current: undefined };
  kernel.register(manifest, () => {
    ref.current = createStoragePlugin();
    return ref.current;
  });
  return ref;
}

describe("storage plugin round-trip (local)", () => {
  it("activates on :memory:, runs migrations, and deactivates", async () => {
    const kernel = makeKernel();
    const ref = registerFactory(kernel, {
      ...storageJson,
      config: { url: ":memory:", migrationsDir: MIGRATIONS_DIR },
    });
    await kernel.activate("storage");
    expect(kernel.isActivated("storage")).toBe(true);
    const rows = await ref.current?.client().execute("SELECT number FROM schema_migrations");
    expect(rows?.rows).toHaveLength(loadMigrations(MIGRATIONS_DIR).length); // full chain applied
    await kernel.deactivate("storage");
    expect(kernel.isActivated("storage")).toBe(false);
    expect(() => ref.current?.client()).toThrow(/not activated/);
  });

  it("persists to a local file database", async () => {
    const file = join(tmpdir(), `ds-storage-${randomUUID()}.db`).replace(/\\/gu, "/");
    const kernel = makeKernel();
    const ref = registerFactory(kernel, {
      ...storageJson,
      config: { url: `file:${file}`, migrationsDir: MIGRATIONS_DIR },
    });
    await kernel.activate("storage");
    const client = ref.current?.client();
    await client?.execute({
      sql: "INSERT INTO owners (id, display_name, created_at) VALUES (?, ?, ?)",
      args: ["owner-1", "Owner", "2026-09-06T00:00:00Z"],
    });
    const back = await client?.execute("SELECT id FROM owners");
    expect(back?.rows).toHaveLength(1);
    await kernel.deactivate("storage");
  });

  it("skips migrations when migrationsDir is omitted", async () => {
    const kernel = makeKernel();
    const ref = registerFactory(kernel, {
      ...storageJson,
      config: { url: ":memory:" },
    });
    await kernel.activate("storage");
    const tables = await ref.current
      ?.client()
      .execute("SELECT name FROM sqlite_master WHERE type='table' AND name='owners'");
    expect(tables?.rows).toHaveLength(0);
  });
});

describe("storage plugin remote fail-closed rules", () => {
  const REMOTE_URL = "libsql://127.0.0.1:8123/db"; // localhost: never dialed, safe offline

  it("refuses a remote DB whose host is not in the manifest allowlist", async () => {
    const kernel = makeKernel();
    registerFactory(kernel, {
      ...storageJson,
      config: { url: REMOTE_URL, authTokenSecret: "TURSO_TOKEN" },
      permissions: { networkHosts: [], secrets: ["TURSO_TOKEN"] },
    });
    await expect(kernel.activate("storage")).rejects.toBeInstanceOf(CapabilityError);
  });

  it("refuses a remote DB with an allowlisted host but unallowlisted secret", async () => {
    const kernel = makeKernel({
      secretResolver: async () => "tok",
    });
    registerFactory(kernel, {
      ...storageJson,
      config: { url: REMOTE_URL, authTokenSecret: "TURSO_TOKEN" },
      permissions: { networkHosts: ["127.0.0.1"], secrets: [] },
    });
    await expect(kernel.activate("storage")).rejects.toBeInstanceOf(CapabilityError);
  });

  it("refuses a remote DB when no auth token secret is configured at all", async () => {
    const kernel = makeKernel();
    registerFactory(kernel, {
      ...storageJson,
      config: { url: REMOTE_URL },
      permissions: { networkHosts: ["127.0.0.1"], secrets: [] },
    });
    await expect(kernel.activate("storage")).rejects.toThrow(/authTokenSecret/);
  });

  it("activates a remote DB with allowlisted host and resolvable secret", async () => {
    const kernel = makeKernel({
      secretResolver: async (name) => (name === "TURSO_TOKEN" ? "tok-123" : undefined),
    });
    // no migrationsDir: a real query would dial the remote; activation itself must not
    const ref = registerFactory(kernel, {
      ...storageJson,
      config: { url: REMOTE_URL, authTokenSecret: "TURSO_TOKEN" },
      permissions: { networkHosts: ["127.0.0.1"], secrets: ["TURSO_TOKEN"] },
    });
    await kernel.activate("storage");
    expect(kernel.isActivated("storage")).toBe(true);
    expect(ref.current).toBeDefined();
    await kernel.deactivate("storage");
  });

  it("maps env vars to config for host wiring", () => {
    const cfg = storageConfigFromEnv({
      DO_SIFT_DB_URL: "libsql://my-db.turso.io",
      DO_SIFT_DB_AUTH_TOKEN_SECRET: "TURSO_TOKEN",
      DO_SIFT_DB_MIGRATIONS_DIR: "migrations",
    });
    expect(cfg).toEqual({
      url: "libsql://my-db.turso.io",
      authTokenSecret: "TURSO_TOKEN",
      migrationsDir: "migrations",
    });
    const fallback = storageConfigFromEnv({});
    expect(fallback.url).toBe("file:do-sift.db");
    expect(fallback.authTokenSecret).toBeUndefined();
  });
});
