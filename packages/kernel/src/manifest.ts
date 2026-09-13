import { z } from "zod";

/**
 * Plugin manifest schema (ADR 0004). `plugin.json` on disk must match this;
 * validation happens at registration, before any code loads.
 */
export const PluginKind = z.enum([
  "model",
  "search",
  "harness",
  "extractor",
  "storage",
  "policy",
  "ui",
]);
export type PluginKind = z.infer<typeof PluginKind>;

export const Capability = z.enum(["network", "secrets", "fs", "browser", "computer", "paid"]);
export type Capability = z.infer<typeof Capability>;

/**
 * Capabilities that can never activate from config alone: they need a
 * recorded, explicit grant (and stay disabled in CI entirely). INV-003.
 */
export const GRANT_REQUIRED: readonly Capability[] = ["paid", "computer"] as const;

const SemVer = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/, "must be a semantic version");

export const PluginPermissions = z.object({
  /** Hosts the plugin may contact over HTTPS. Empty = no network. */
  networkHosts: z.array(z.string().min(1).max(253)).max(64).default([]),
  /** Secret names resolvable via the kernel's secret resolver. */
  secrets: z.array(z.string().min(1).max(64)).max(16).default([]),
});
export type PluginPermissions = z.infer<typeof PluginPermissions>;

export const PluginManifest = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/, "kebab-case, 3-64 chars"),
    version: SemVer,
    /** Kernel API the plugin was built against; mismatches fail registration. */
    apiVersion: z.literal("1"),
    kind: PluginKind,
    capabilities: z.array(Capability).max(6).default([]),
    permissions: PluginPermissions.default({ networkHosts: [], secrets: [] }),
    config: z.record(z.unknown()).default({}),
    /** Module-relative export that returns the plugin factory. */
    entry: z.string().min(1).max(256),
    description: z.string().min(1).max(512),
  })
  .strict();
export type PluginManifest = z.infer<typeof PluginManifest>;

export function parseManifest(input: unknown): PluginManifest {
  return PluginManifest.parse(input);
}

/** Capabilities requiring an explicit recorded grant before activation. */
export function requiresGrant(capabilities: readonly Capability[]): Capability[] {
  return capabilities.filter((c) => (GRANT_REQUIRED as readonly string[]).includes(c));
}
