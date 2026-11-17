/**
 * Export a versioned evaluation snapshot (#155, ADR 0013).
 *
 * Input: a JSON file of `SnapshotRecord[]` (or `{records:[...]}`).
 * Output: `<out>.json` (canonical) and `<out>.manifest.json`.
 *
 * Deterministic for the same logical input; refuses to overwrite an existing
 * file unless `--force` is given explicitly; writes through a temporary file
 * and renames, so a failed export leaves no partial artifact.
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  SNAPSHOT_SCHEMA_VERSION,
  assertSnapshotCompatible,
  buildSnapshotManifest,
  normalizeSnapshot,
  type SnapshotRecord,
} from "@do-sift/contracts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const value = process.argv[i + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

function fail(message: string): never {
  console.error(`snapshot: FAIL — ${message}`);
  process.exit(1);
}

function atomicWrite(path: string, content: string, force: boolean): void {
  if (!force && existsSync(path)) {
    throw new Error(`${path} already exists; pass --force to replace it`);
  }
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, content, { flag: "wx" });
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

function main(): number {
  const input = arg("in");
  const out = arg("out");
  const datasetVersion = arg("dataset-version");
  const codeRevision = arg("code-revision");
  if (input === undefined || out === undefined) fail("--in and --out are required");
  if (datasetVersion === undefined) fail("--dataset-version is required");
  if (codeRevision === undefined) fail("--code-revision is required");

  const parsed = JSON.parse(readFileSync(input, "utf8")) as unknown;
  const records = (Array.isArray(parsed) ? parsed : (parsed as { records?: unknown }).records) as
    SnapshotRecord[] | undefined;
  if (!Array.isArray(records)) fail("input must be a record array or {records: [...]}");
  if (records.length === 0) fail("refusing to write an empty snapshot (INV-006)");

  const normalized = normalizeSnapshot(records);
  const createdAt = arg("created");
  const manifest = buildSnapshotManifest(normalized, {
    datasetVersion,
    codeRevision,
    ...(createdAt === undefined ? {} : { createdAt }),
  });
  assertSnapshotCompatible(manifest, normalized);

  const force = process.argv.includes("--force");
  atomicWrite(out, `${JSON.stringify({ manifest, records: normalized }, null, 2)}\n`, force);

  // The sidecar manifest is the artifact a reader pins; keep it in sync.
  const sidecar = join(dirname(out), `${basename(out)}.manifest.json`);
  atomicWrite(sidecar, `${JSON.stringify(manifest, null, 2)}\n`, force);

  console.log(
    `snapshot: wrote ${manifest.rowCount} rows (schema ${SNAPSHOT_SCHEMA_VERSION}) to ${out}; sha256 ${manifest.sha256}`,
  );
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
