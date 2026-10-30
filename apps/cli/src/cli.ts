/**
 * #67 owner/evidence CLI. It lists owners, summarises
 * one day's usage, lists evidence, exports one owner's evidence to a new
 * file, and performs owner-scoped retention pruning with dry-run protection.
 * Every data command requires an explicit --owner, so ownership scoping is never implicit.
 */
import type { Client } from "@libsql/client";
import {
  calculateRetentionCutoff,
  pruneOwnerHistory,
  validateRetentionCutoff,
} from "@do-sift/storage";
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
  retention prune --owner <id> [--retention-days <n> | --cutoff <iso>] [--dry-run] [--confirm]
`;

const BOOLEAN_FLAGS = new Set(["dry-run", "confirm"]);

function parseFlags(
  args: string[],
  booleanFlags: Set<string> = BOOLEAN_FLAGS,
): { positional: string[]; flags: Map<string, string | boolean> } {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < args.length; i++) {
    const token = args[i] ?? "";
    if (token.startsWith("--")) {
      const name = token.slice(2);
      if (booleanFlags.has(name)) {
        const next = args[i + 1];
        if (next === "true" || next === "false") {
          flags.set(name, next === "true");
          i++;
        } else {
          flags.set(name, true);
        }
      } else {
        const value = args[i + 1];
        if (value === undefined || value.startsWith("--")) {
          throw new CliUsageError(`missing value for ${token}`);
        }
        flags.set(name, value);
        i++;
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

class CliUsageError extends Error {}

function requireOwner(flags: Map<string, string | boolean>): string {
  const owner = flags.get("owner");
  if (owner === undefined || owner === "" || typeof owner !== "string") {
    throw new CliUsageError("--owner is required");
  }
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
    const { flags } = parseFlags(rest ?? []);
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
      if (day === undefined || typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
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
      if (out === undefined || out === "" || typeof out !== "string") {
        throw new CliUsageError("--out is required");
      }
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
    if (group === "retention" && action === "prune") {
      const owner = requireOwner(flags);
      const retentionDaysRaw = flags.get("retention-days");
      const cutoffRaw = flags.get("cutoff");

      if (retentionDaysRaw !== undefined && cutoffRaw !== undefined) {
        throw new CliUsageError("cannot specify both --retention-days and --cutoff");
      }
      if (retentionDaysRaw === undefined && cutoffRaw === undefined) {
        throw new CliUsageError("must specify either --retention-days or --cutoff");
      }

      let cutoffIso = "";
      if (retentionDaysRaw !== undefined) {
        const days = Number(retentionDaysRaw);
        if (!Number.isInteger(days) || days < 1) {
          throw new CliUsageError("--retention-days must be an integer >= 1");
        }
        cutoffIso = calculateRetentionCutoff(days);
      } else if (cutoffRaw !== undefined) {
        cutoffIso = String(cutoffRaw);
        try {
          validateRetentionCutoff(cutoffIso);
        } catch (e) {
          throw new CliUsageError(e instanceof Error ? e.message : String(e));
        }
      }

      const isDryRunFlag = flags.get("dry-run") === true;
      const isConfirmFlag = flags.get("confirm") === true;
      const dryRun = isDryRunFlag || !isConfirmFlag;

      const receipt = await pruneOwnerHistory(deps.client, owner, cutoffIso, { dryRun });
      deps.out(JSON.stringify(receipt, null, 2));
      return receipt.success ? 0 : 1;
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
