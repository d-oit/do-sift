/**
 * #67 owner/evidence CLI. Read-only by design: it lists owners, summarises
 * one day's usage, lists evidence, and exports one owner's evidence to a new
 * file. It has no delete, write, or migrate path. Every data command requires
 * an explicit --owner, so ownership scoping is never implicit.
 */
import type { Client } from "@libsql/client";
import { writeFile } from "node:fs/promises";

export interface CliDeps {
  client: Client;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Writes a new file; must fail if the path already exists. */
  writeNewFile?: (path: string, content: string) => Promise<void>;
}

const USAGE = `usage: do-sift-cli <command> [options]

  owners list
  usage show --owner <id> --day <YYYY-MM-DD>
  evidence list --owner <id> [--limit <n>]
  evidence export --owner <id> --out <new-file.json>
`;

function parseFlags(args: string[]): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const token = args[i] ?? "";
    if (token.startsWith("--")) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CliUsageError(`missing value for ${token}`);
      }
      flags.set(token.slice(2), value);
      i++;
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

class CliUsageError extends Error {}

function requireOwner(flags: Map<string, string>): string {
  const owner = flags.get("owner");
  if (owner === undefined || owner === "") throw new CliUsageError("--owner is required");
  return owner;
}

/** One output line per row (header first), so callers can line-split safely. */
function emitTable(
  out: (line: string) => void,
  rows: Array<Record<string, unknown>>,
  columns: string[],
): void {
  out(columns.join("\t"));
  for (const row of rows) out(columns.map((c) => String(row[c] ?? "")).join("\t"));
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  try {
    const [group, action, ...rest] = argv;
    const { flags } = parseFlags(rest);
    if (group === "owners" && action === "list") {
      const result = await deps.client.execute(
        "SELECT id, display_name, created_at FROM owners ORDER BY id",
      );
      emitTable(deps.out, result.rows as unknown as Array<Record<string, unknown>>, [
        "id",
        "display_name",
        "created_at",
      ]);
      return 0;
    }
    if (group === "usage" && action === "show") {
      const owner = requireOwner(flags);
      const day = flags.get("day");
      if (day === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        throw new CliUsageError("--day must be YYYY-MM-DD");
      }
      const result = await deps.client.execute({
        sql: `SELECT kind, state, COUNT(*) AS entries,
                     COALESCE(SUM(input_tokens), 0) AS input_tokens,
                     COALESCE(SUM(output_tokens), 0) AS output_tokens,
                     COALESCE(SUM(search_calls), 0) AS search_calls,
                     COALESCE(SUM(fetches), 0) AS fetches
              FROM usage_ledger WHERE owner_id = ? AND day = ?
              GROUP BY kind, state ORDER BY kind, state`,
        args: [owner, day],
      });
      emitTable(deps.out, result.rows as unknown as Array<Record<string, unknown>>, [
        "kind",
        "state",
        "entries",
        "input_tokens",
        "output_tokens",
        "search_calls",
        "fetches",
      ]);
      return 0;
    }
    if (group === "evidence" && action === "list") {
      const owner = requireOwner(flags);
      const limit = Number(flags.get("limit") ?? "50");
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new CliUsageError("--limit must be an integer from 1 to 500");
      }
      const result = await deps.client.execute({
        sql: `SELECT id, canonical_url, fetched_at, title FROM documents
              WHERE owner_id = ? ORDER BY fetched_at DESC LIMIT ?`,
        args: [owner, limit],
      });
      emitTable(deps.out, result.rows as unknown as Array<Record<string, unknown>>, [
        "id",
        "canonical_url",
        "fetched_at",
        "title",
      ]);
      return 0;
    }
    if (group === "evidence" && action === "export") {
      const owner = requireOwner(flags);
      const out = flags.get("out");
      if (out === undefined || out === "") throw new CliUsageError("--out is required");
      const documents = await deps.client.execute({
        sql: `SELECT id, canonical_url, original_url, content_hash, fetched_at, published_at, title
              FROM documents WHERE owner_id = ? ORDER BY fetched_at, id`,
        args: [owner],
      });
      const passages = await deps.client.execute({
        sql: `SELECT id, document_id, heading, excerpt, extraction_status
              FROM passages WHERE owner_id = ? ORDER BY document_id, id`,
        args: [owner],
      });
      const payload = {
        owner,
        exportedAt: new Date().toISOString(),
        documents: documents.rows,
        passages: passages.rows,
      };
      const write = deps.writeNewFile ?? ((p, c) => writeFile(p, c, { flag: "wx" }));
      await write(out, `${JSON.stringify(payload, null, 2)}\n`);
      deps.out(
        `exported ${documents.rows.length} documents and ${passages.rows.length} passages to ${out}`,
      );
      return 0;
    }
    deps.err(USAGE);
    return 2;
  } catch (error) {
    if (error instanceof CliUsageError) {
      deps.err(`error: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    deps.err(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
