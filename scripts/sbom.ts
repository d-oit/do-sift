/**
 * Deterministic CycloneDX-style SBOM for the release candidate (issue #164).
 *
 * The SBOM is generated from `package-lock.json` only: it names every resolved
 * dependency, its version, and a SHA-512/256 integrity digest when the lockfile
 * carries one. No registry call, no credentials, no clock-dependent fields by
 * default (pass `--created <ISO>` to stamp a time explicitly, so two runs over
 * the same lockfile produce byte-identical output).
 *
 * This is evidence, not a vulnerability verdict: pinning and scanning remain
 * separate steps (`docs/supply-chain.md`).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface LockEntry {
  version?: string;
  resolved?: string;
  integrity?: string;
  dev?: boolean;
}

export interface SbomComponent {
  type: "library";
  name: string;
  version: string;
  purl: string;
  scope?: "required" | "optional";
  hashes?: Array<{ alg: "SHA-512" | "SHA-256" | "SHA-1"; content: string }>;
}

export interface Sbom {
  bomFormat: "CycloneDX";
  specVersion: "1.5";
  version: 1;
  metadata: {
    component: { type: "application"; name: string; version: string };
    timestamp?: string;
  };
  components: SbomComponent[];
}

/** `node_modules/@scope/pkg` → `@scope/pkg`; nested keys keep the last name. */
export function packageNameFromKey(key: string): string {
  const idx = key.lastIndexOf("node_modules/");
  return idx < 0 ? key : key.slice(idx + "node_modules/".length);
}

/** CycloneDX hash object from an SRI string (`sha512-<base64>`), if known. */
export function hashFromIntegrity(
  integrity: string,
): { alg: "SHA-512" | "SHA-256" | "SHA-1"; content: string } | undefined {
  const [alg, encoded] = integrity.split("-", 2);
  const map: Record<string, "SHA-512" | "SHA-256" | "SHA-1"> = {
    sha512: "SHA-512",
    sha256: "SHA-256",
    sha1: "SHA-1",
  };
  const normalized = alg === undefined ? undefined : map[alg.toLowerCase()];
  if (normalized === undefined || encoded === undefined || encoded === "") return undefined;
  let content: string;
  try {
    content = Buffer.from(encoded, "base64").toString("hex");
  } catch {
    return undefined;
  }
  if (content === "") return undefined;
  return { alg: normalized, content };
}

/** Build a stable SBOM from a parsed lockfile. Sorted by purl. */
export function buildSbom(
  pkg: { name?: string; version?: string },
  lock: { packages?: Record<string, LockEntry> },
  options: { created?: string } = {},
): Sbom {
  const components: SbomComponent[] = [];
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (key === "") continue;
    const name = packageNameFromKey(key);
    if (name === "" || entry.version === undefined) continue;
    const purl = `pkg:npm/${name.startsWith("@") ? name.replace(/\//gu, "%2F") : name}@${entry.version}`;
    const component: SbomComponent = {
      type: "library",
      name,
      version: entry.version,
      purl,
      ...(entry.dev === true ? { scope: "optional" as const } : { scope: "required" as const }),
    };
    const hash = entry.integrity === undefined ? undefined : hashFromIntegrity(entry.integrity);
    if (hash) component.hashes = [hash];
    components.push(component);
  }
  // Byte order, not locale order: the SBOM must be identical on every host.
  components.sort((a, b) =>
    Buffer.compare(Buffer.from(a.purl, "utf8"), Buffer.from(b.purl, "utf8")),
  );

  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      component: {
        type: "application",
        name: pkg.name ?? "do-sift",
        version: pkg.version ?? "0.0.0",
      },
      ...(options.created === undefined ? {} : { timestamp: options.created }),
    },
    components,
  };
}

/** sha256 of the serialized SBOM, so a release record can pin the artifact. */
export function sbomDigest(sbom: Sbom): string {
  return createHash("sha256").update(JSON.stringify(sbom), "utf8").digest("hex");
}

function main(): number {
  const root = process.cwd();
  const lockPath = join(root, "package-lock.json");
  if (!existsSync(lockPath)) {
    console.error("sbom: FAIL — package-lock.json not found (run npm install)");
    return 1;
  }
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    name?: string;
    version?: string;
  };
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
    packages?: Record<string, LockEntry>;
  };

  const createdIndex = process.argv.indexOf("--created");
  const created = createdIndex === -1 ? undefined : process.argv[createdIndex + 1];
  const sbom = buildSbom(pkg, lock, created === undefined ? {} : { created });
  if (sbom.components.length === 0) {
    console.error("sbom: FAIL — zero resolved components (INV-006: empty set is a failure)");
    return 1;
  }

  const outIndex = process.argv.indexOf("--out");
  const out = outIndex === -1 ? undefined : process.argv[outIndex + 1];
  const serialized = `${JSON.stringify(sbom, null, 2)}\n`;
  if (out === undefined) {
    process.stdout.write(serialized);
  } else {
    writeFileSync(out, serialized, { flag: "wx" });
    console.log(`sbom: wrote ${sbom.components.length} components to ${out}`);
    console.log(`sbom: sha256 ${sbomDigest(sbom)}`);
  }
  return 0;
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("sbom.ts") || process.argv[1].endsWith("sbom.js"));

if (isEntrypoint) process.exit(main());
