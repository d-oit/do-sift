/** Dependency-injection and composition result types for the server entrypoint. */
import { type Client } from "@libsql/client";
import { type DnsResolver, type FetchLike } from "@do-sift/safe-fetch";
import type { createResearchServer, Runtime } from "@do-sift/server";
import { type Repositories } from "@do-sift/storage";
import { type AppConfig } from "./config.js";
export type HttpServer = ReturnType<typeof createResearchServer>;
export interface ComposeDeps {
  /** Test seam: overrides config.dbUrl (e.g. ":memory:" for hermetic tests). */
  dbUrl?: string;
  /**
   * Test seam: overrides config.port. Windows quirk: re-binding the same
   * fixed port back-to-back after close() can reset connections
   * (SO_REUSEADDR double-bind), so hermetic tests pass 0 (ephemeral).
   */
  port?: number;
  /** Test seam: fetch used by live mode (search adapter + safe-fetch). */
  fetchImpl?: FetchLike | undefined;
  /** Test seam: DNS resolver for safe-fetch (tests stay hermetic). */
  dns?: DnsResolver | undefined;
  /**
   * Test seam: the resolved model API key value (production reads the env
   * var NAMED by DO_SIFT_MODEL_API_KEY_SECRET instead — the secret itself
   * never lives in config).
   */
  modelApiKey?: string | undefined;
}
export interface ComposedApp {
  config: AppConfig;
  server: HttpServer;
  runtime: Runtime;
  repositories: Repositories;
  client: Client;
  /** Bound port (the listen() result). */
  port: number;
  close(): Promise<void>;
}
