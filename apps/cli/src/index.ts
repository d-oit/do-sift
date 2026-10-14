/**
 * do-sift owner/evidence CLI entrypoint (#67). Run:
 *   npx tsx apps/cli/src/index.ts <command> [options] [--db <url>]
 * The database URL comes from --db, then DO_SIFT_DB_URL, then file:do-sift.db.
 * Remote (Turso) auth tokens are NOT read here: the CLI supports local files
 * and unauthenticated libsql URLs only, so no secret enters this process.
 */
import { createClient } from "@libsql/client";
import { runCli } from "./cli.js";

const argv = process.argv.slice(2);
let dbUrl = process.env["DO_SIFT_DB_URL"] ?? "file:do-sift.db";
const dbIndex = argv.indexOf("--db");
if (dbIndex !== -1) {
  const value = argv[dbIndex + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error("error: --db requires a value");
    process.exit(2);
  }
  dbUrl = value;
  argv.splice(dbIndex, 2);
}

const client = createClient({ url: dbUrl });
try {
  const code = await runCli(argv, {
    client,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
  process.exitCode = code;
} finally {
  client.close();
}
