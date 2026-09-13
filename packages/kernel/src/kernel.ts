import {
  parseManifest,
  requiresGrant,
  type Capability,
  type PluginKind,
  type PluginManifest,
} from "./manifest.js";

/**
 * Services handed to a plugin. Plugins never receive raw `fs`/`net` — the
 * kernel mediates everything through this context (ADR 0004).
 */
export interface PluginContext {
  readonly pluginName: string;
  readonly kind: PluginKind;
  readonly config: Readonly<Record<string, unknown>>;
  readonly logger: {
    info(message: string): void;
    warn(message: string): void;
  };
  readonly events: {
    emit(type: string, payload: Readonly<Record<string, unknown>>): void;
  };
  /** Throws unless the requested host is in the manifest's allowlist. */
  readonly network: {
    assertHostAllowed(host: string): void;
  };
  /** Throws unless the secret name is in the manifest's allowlist. */
  readonly secrets: {
    assertNameAllowed(name: string): void;
    /**
     * Resolve an allowlisted secret via the host-provided resolver
     * (CORE-02). Throws unless the name is allowlisted, a resolver is
     * configured, and the secret exists. Values never touch the manifest.
     */
    resolve(name: string): Promise<string>;
  };
}

/** Minimal plugin contract: a factory receiving the kernel-built context. */
export interface PluginInstance {
  activate(ctx: PluginContext): Promise<void> | void;
  deactivate(): Promise<void> | void;
}

export type PluginFactory = (ctx: PluginContext) => PluginInstance;

export class CapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityError";
  }
}

export interface RegisteredPlugin {
  readonly manifest: PluginManifest;
  /** Factory is stored but only invoked through `activate`, after grant checks. */
  readonly factory: PluginFactory;
}

export type KernelEnvironment = "local" | "ci" | "production";

/**
 * Host-provided capabilities the kernel mediates on plugins' behalf.
 * The host owns real I/O (secret stores, etc.); plugins only ever see
 * allowlist-checked access through the context.
 */
export interface KernelOptions {
  /** Resolves a secret name to its value; the host decides the backing store. */
  secretResolver?: (name: string) => Promise<string | undefined>;
}

interface ActivateOptions {
  /** Explicit, recorded grants (e.g. from the owner's console decision). */
  grants?: Iterable<Capability>;
}

/**
 * The do-sift plugin kernel: registration → grant check → activation →
 * deactivation. A plugin declaring `paid` or `computer` capabilities cannot
 * activate without an explicit grant (INV-003), and in `ci` environments
 * those plugins are refused outright.
 */
export class Kernel {
  private readonly plugins = new Map<string, RegisteredPlugin>();
  private readonly active = new Map<string, PluginInstance>();
  private readonly grants = new Set<Capability>();

  constructor(
    private readonly environment: KernelEnvironment = "local",
    private readonly options: KernelOptions = {},
  ) {}

  register(manifestInput: unknown, factory: PluginFactory): RegisteredPlugin {
    const manifest = parseManifest(manifestInput);
    if (this.plugins.has(manifest.name)) {
      throw new Error(`plugin already registered: ${manifest.name}`);
    }
    const plugin: RegisteredPlugin = { manifest, factory };
    this.plugins.set(manifest.name, plugin);
    return plugin;
  }

  listPlugins(): readonly RegisteredPlugin[] {
    return [...this.plugins.values()];
  }

  isActivated(name: string): boolean {
    return this.active.has(name);
  }

  /** Record owner-granted capabilities (persisted by the caller/UI layer). */
  grant(...capabilities: readonly Capability[]): void {
    for (const c of capabilities) this.grants.add(c);
  }

  async activate(name: string, options: ActivateOptions = {}): Promise<void> {
    if (options.grants) for (const c of options.grants) this.grants.add(c);
    const plugin = this.plugins.get(name);
    if (!plugin) throw new Error(`unknown plugin: ${name}`);
    if (this.active.has(name)) throw new Error(`plugin already active: ${name}`);

    const needed = requiresGrant(plugin.manifest.capabilities);
    if (needed.length > 0) {
      if (this.environment === "ci") {
        throw new CapabilityError(
          `plugin ${name} requires grants for [${needed.join(", ")}] and cannot activate in ci`,
        );
      }
      const missing = needed.filter((c) => !this.grants.has(c));
      if (missing.length > 0) {
        throw new CapabilityError(
          `plugin ${name} requires explicit grants for [${missing.join(", ")}]`,
        );
      }
    }

    const ctx = this.buildContext(plugin.manifest);
    const instance = plugin.factory(ctx);
    await instance.activate(ctx);
    this.active.set(name, instance);
  }

  async deactivate(name: string): Promise<void> {
    const instance = this.active.get(name);
    if (!instance) throw new Error(`plugin not active: ${name}`);
    this.active.delete(name);
    await instance.deactivate();
  }

  private buildContext(manifest: PluginManifest): PluginContext {
    const hosts = new Set(manifest.permissions.networkHosts);
    const secretNames = new Set(manifest.permissions.secrets);
    return {
      pluginName: manifest.name,
      kind: manifest.kind,
      config: manifest.config,
      logger: {
        info: (message) => console.info(`[${manifest.name}] ${message}`),
        warn: (message) => console.warn(`[${manifest.name}] ${message}`),
      },
      events: {
        emit: (type, payload) => {
          if (process.env.DO_SIFT_DEBUG_EVENTS === "1") {
            console.debug(`[event:${type}] ${JSON.stringify(payload)}`);
          }
        },
      },
      network: {
        assertHostAllowed: (host) => {
          if (!hosts.has(host)) {
            throw new CapabilityError(
              `plugin ${manifest.name} is not allowed to contact host "${host}"`,
            );
          }
        },
      },
      secrets: {
        assertNameAllowed: (name) => {
          if (!secretNames.has(name)) {
            throw new CapabilityError(
              `plugin ${manifest.name} is not allowed to resolve secret "${name}"`,
            );
          }
        },
        resolve: async (name) => {
          if (!secretNames.has(name)) {
            throw new CapabilityError(
              `plugin ${manifest.name} is not allowed to resolve secret "${name}"`,
            );
          }
          if (!this.options.secretResolver) {
            throw new CapabilityError(`no secret resolver is configured for "${name}"`);
          }
          const value = await this.options.secretResolver(name);
          if (value === undefined) {
            throw new CapabilityError(`secret "${name}" is not available`);
          }
          return value;
        },
      },
    };
  }
}

export { parseManifest, requiresGrant } from "./manifest.js";
export type { Capability, PluginKind, PluginManifest } from "./manifest.js";
