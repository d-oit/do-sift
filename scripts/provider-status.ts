/**
 * Read-only provider status view (#171).
 *
 * Reads a JSON array (or `{providers:[...]}`) of `ProviderRecord`s and prints
 * the registry. This never calls a provider: health is whatever the records
 * already say, and an absent price is `unknown`. Configuration, permission,
 * availability, and health are separate columns so a paid provider cannot look
 * "available" merely because it is configured.
 *
 * `--format json` emits the machine-readable status list; the default is one
 * line per provider for an operator.
 */
import { readFileSync } from "node:fs";
import { buildProviderRegistry, describeProvider, type ProviderRecord } from "@do-sift/contracts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const value = process.argv[i + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

function main(): number {
  const input = arg("in");
  if (input === undefined) throw new Error("--in <providers.json> is required");
  const parsed = JSON.parse(readFileSync(input, "utf8")) as unknown;
  const providers = (
    Array.isArray(parsed) ? parsed : (parsed as { providers?: unknown }).providers
  ) as ProviderRecord[] | undefined;
  if (!Array.isArray(providers)) throw new Error("input must be an array or {providers: [...]}");
  if (providers.length === 0) throw new Error("refusing to report an empty registry (INV-006)");

  const statuses = buildProviderRegistry(providers);
  if (arg("format") === "json") {
    process.stdout.write(`${JSON.stringify({ providers: statuses }, null, 2)}\n`);
    return 0;
  }
  for (const status of statuses) {
    console.log(describeProvider(status));
  }
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(
    `provider-status: FAIL — ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
