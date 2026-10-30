/**
 * #67 owner/evidence CLI. Read-only by design: it lists owners, summarises
 * one day's usage, lists evidence, exports evidence, and lists/shows research runs.
 * It has no delete, write, or migrate path. Every data command requires
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
  research list --owner <id> [--limit <n>] [--since <YYYY-MM-DD|ISO>] [--until <YYYY-MM-DD|ISO>] [--status <completed|failed|pending|degraded>] [--show-question]
  research show --owner <id> --request <id> [--show-question] [--out <new-file.json>]
`;

const BOOLEAN_FLAGS = new Set(["show-question"]);

function parseFlags(args: string[]): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const token = args[i] ?? "";
    if (token.startsWith("--")) {
      const flagName = token.slice(2);
      if (BOOLEAN_FLAGS.has(flagName)) {
        flags.set(flagName, "true");
      } else {
        const value = args[i + 1];
        if (value === undefined || value.startsWith("--")) {
          throw new CliUsageError(`missing value for ${token}`);
        }
        flags.set(flagName, value);
        i++;
      }
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

function parseLimit(flags: Map<string, string>): number {
  const raw = flags.get("limit") ?? "50";
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new CliUsageError("--limit must be an integer from 1 to 500");
  }
  return limit;
}

function parseTimestamp(flagName: string, value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return flagName === "until" ? `${value}T23:59:59.999Z` : `${value}T00:00:00.000Z`;
  }
  const date = new Date(value);
  if (isNaN(date.getTime())) {
    throw new CliUsageError(`--${flagName} must be a valid YYYY-MM-DD or ISO 8601 date string`);
  }
  return value;
}

function parseStatus(rawStatus: string | undefined): string | undefined {
  if (rawStatus === undefined) return undefined;
  const valid = ["completed", "failed", "pending", "degraded"];
  if (!valid.includes(rawStatus)) {
    throw new CliUsageError(`--status must be one of: ${valid.join(", ")}`);
  }
  return rawStatus;
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
      const limit = parseLimit(flags);
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
    if (group === "research" && action === "list") {
      const owner = requireOwner(flags);
      const limit = parseLimit(flags);
      const rawSince = flags.get("since");
      const rawUntil = flags.get("until");
      const since = rawSince !== undefined ? parseTimestamp("since", rawSince) : undefined;
      const until = rawUntil !== undefined ? parseTimestamp("until", rawUntil) : undefined;
      const statusFilter = parseStatus(flags.get("status"));
      const showQuestion = flags.get("show-question") === "true";

      const conditions: string[] = ["r.owner_id = ?", "r.mode = 'search'"];
      const sqlArgs: Array<string | number> = [owner];

      if (since !== undefined) {
        conditions.push("r.created_at >= ?");
        sqlArgs.push(since);
      }
      if (until !== undefined) {
        conditions.push("r.created_at <= ?");
        sqlArgs.push(until);
      }
      if (statusFilter !== undefined) {
        if (statusFilter === "completed") {
          conditions.push("r.status = 'completed'");
        } else if (statusFilter === "failed") {
          conditions.push("r.status = 'failed'");
        } else if (statusFilter === "pending") {
          conditions.push("r.status = 'pending'");
        } else if (statusFilter === "degraded") {
          conditions.push(
            "(r.status = 'failed' OR (r.status = 'completed' AND (SELECT COUNT(*) FROM documents d WHERE d.owner_id = r.owner_id AND d.request_id = r.id) = 0))",
          );
        }
      }

      sqlArgs.push(limit);

      const sql = `
        SELECT
          r.id,
          r.status,
          r.created_at,
          r.completed_at,
          r.question,
          (SELECT COUNT(*) FROM documents d WHERE d.owner_id = r.owner_id AND d.request_id = r.id) AS documents_stored,
          (SELECT COUNT(*) FROM passages p WHERE p.owner_id = r.owner_id AND p.document_id IN (SELECT id FROM documents d WHERE d.owner_id = r.owner_id AND d.request_id = r.id)) AS passages_stored,
          (SELECT COALESCE(SUM(u.fetches), 0) FROM usage_ledger u WHERE u.owner_id = r.owner_id AND u.request_id = r.id AND u.kind = 'settlement') AS fetches,
          (SELECT COALESCE(SUM(u.search_calls), 0) FROM usage_ledger u WHERE u.owner_id = r.owner_id AND u.request_id = r.id AND u.kind = 'settlement') AS search_calls
        FROM requests r
        WHERE ${conditions.join(" AND ")}
        ORDER BY r.created_at DESC
        LIMIT ?
      `;

      const result = await deps.client.execute({ sql, args: sqlArgs });

      const formattedRows = result.rows.map((row) => {
        const rawStatus = String(row.status);
        const docsCount = Number(row.documents_stored ?? 0);
        let effectiveStatus = rawStatus;
        if (rawStatus === "completed" && docsCount === 0) {
          effectiveStatus = "degraded";
        }
        return {
          id: row.id,
          status: effectiveStatus,
          created_at: row.created_at,
          completed_at: row.completed_at ?? "",
          documents_stored: docsCount,
          passages_stored: row.passages_stored ?? 0,
          fetches: row.fetches ?? 0,
          search_calls: row.search_calls ?? 0,
          question: showQuestion ? row.question : "[REDACTED]",
        };
      });

      emitTable(deps.out, formattedRows as unknown as Array<Record<string, unknown>>, [
        "id",
        "status",
        "created_at",
        "completed_at",
        "documents_stored",
        "passages_stored",
        "fetches",
        "search_calls",
        "question",
      ]);
      return 0;
    }
    if (group === "research" && action === "show") {
      const owner = requireOwner(flags);
      const requestId = flags.get("request");
      if (requestId === undefined || requestId === "") {
        throw new CliUsageError("--request is required");
      }
      const showQuestion = flags.get("show-question") === "true";
      const out = flags.get("out");

      const reqRes = await deps.client.execute({
        sql: "SELECT id, owner_id, mode, question, status, created_at, completed_at FROM requests WHERE owner_id = ? AND id = ? AND mode = 'search'",
        args: [owner, requestId],
      });

      const reqRow = reqRes.rows[0];
      if (!reqRow) {
        deps.err(`error: research request ${requestId} not found for owner ${owner}`);
        return 1;
      }

      const docsRes = await deps.client.execute({
        sql: "SELECT id, canonical_url, original_url, content_hash, title, fetched_at, relevance_score FROM documents WHERE owner_id = ? AND request_id = ? ORDER BY fetched_at, id",
        args: [owner, requestId],
      });

      const passagesRes = await deps.client.execute({
        sql: "SELECT p.id, p.document_id, p.heading, p.extraction_status, p.noise_class, p.created_at FROM passages p JOIN documents d ON p.document_id = d.id AND p.owner_id = d.owner_id WHERE p.owner_id = ? AND d.request_id = ? ORDER BY p.document_id, p.id",
        args: [owner, requestId],
      });

      const embeddedRes = await deps.client.execute({
        sql: "SELECT COUNT(DISTINCT pe.passage_id) AS embedded_count FROM passage_embeddings pe JOIN passages p ON pe.passage_id = p.id AND pe.owner_id = p.owner_id JOIN documents d ON p.document_id = d.id AND p.owner_id = d.owner_id WHERE pe.owner_id = ? AND d.request_id = ?",
        args: [owner, requestId],
      });

      const usageRes = await deps.client.execute({
        sql: "SELECT kind, state, COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens, COALESCE(SUM(search_calls), 0) AS search_calls, COALESCE(SUM(fetches), 0) AS fetches FROM usage_ledger WHERE owner_id = ? AND request_id = ? GROUP BY kind, state",
        args: [owner, requestId],
      });

      let totalSearchCalls = 0;
      let totalFetches = 0;
      for (const u of usageRes.rows) {
        if (String(u.kind) === "settlement") {
          totalSearchCalls += Number(u.search_calls ?? 0);
          totalFetches += Number(u.fetches ?? 0);
        }
      }

      const createdAtStr = String(reqRow.created_at);
      const completedAtStr = reqRow.completed_at ? String(reqRow.completed_at) : undefined;
      let durationMs: number | undefined;
      if (completedAtStr) {
        durationMs = new Date(completedAtStr).getTime() - new Date(createdAtStr).getTime();
      }

      const rawStatus = String(reqRow.status);
      const docsCount = docsRes.rows.length;
      let effectiveStatus = rawStatus;
      if (rawStatus === "completed" && docsCount === 0) {
        effectiveStatus = "degraded";
      }

      const embeddedCount = Number(embeddedRes.rows[0]?.embedded_count ?? 0);

      const receipt = {
        request: {
          id: String(reqRow.id),
          ownerId: String(reqRow.owner_id),
          mode: String(reqRow.mode),
          status: effectiveStatus,
          rawStatus: rawStatus,
          question: showQuestion ? String(reqRow.question) : "[REDACTED]",
          createdAt: createdAtStr,
          completedAt: completedAtStr ?? null,
          durationMs: durationMs ?? null,
        },
        counters: {
          documentsStored: docsCount,
          passagesStored: passagesRes.rows.length,
          embeddedPassages: embeddedCount,
          searchCalls: totalSearchCalls,
          fetches: totalFetches,
        },
        documents: docsRes.rows.map((d) => {
          const score =
            d.relevance_score !== null && d.relevance_score !== undefined
              ? Number(d.relevance_score)
              : null;
          return {
            id: String(d.id),
            canonical_url: String(d.canonical_url),
            original_url: String(d.original_url),
            title: d.title ? String(d.title) : null,
            fetched_at: String(d.fetched_at),
            relevance_score: score,
            canonicalUrl: String(d.canonical_url),
            originalUrl: String(d.original_url),
            fetchedAt: String(d.fetched_at),
            relevanceScore: score,
          };
        }),
        usage: usageRes.rows,
      };

      if (out !== undefined && out !== "") {
        const write = deps.writeNewFile ?? ((p, c) => writeFile(p, c, { flag: "wx" }));
        await write(out, `${JSON.stringify(receipt, null, 2)}\n`);
        deps.out(`exported research run receipt for ${requestId} to ${out}`);
        return 0;
      }

      deps.out(`request_id\t${receipt.request.id}`);
      deps.out(`owner_id\t${receipt.request.ownerId}`);
      deps.out(`status\t${receipt.request.status}`);
      deps.out(`created_at\t${receipt.request.createdAt}`);
      deps.out(`completed_at\t${receipt.request.completedAt ?? ""}`);
      deps.out(`duration_ms\t${receipt.request.durationMs ?? ""}`);
      deps.out(`question\t${receipt.request.question}`);
      deps.out(`documents_stored\t${receipt.counters.documentsStored}`);
      deps.out(`passages_stored\t${receipt.counters.passagesStored}`);
      deps.out(`embedded_passages\t${receipt.counters.embeddedPassages}`);
      deps.out(`search_calls\t${receipt.counters.searchCalls}`);
      deps.out(`fetches\t${receipt.counters.fetches}`);

      if (receipt.documents.length > 0) {
        deps.out("");
        deps.out("documents:");
        emitTable(deps.out, receipt.documents as unknown as Array<Record<string, unknown>>, [
          "id",
          "canonical_url",
          "title",
          "fetched_at",
          "relevance_score",
        ]);
      }

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
