/**
 * Packaged do-sift service entrypoint (OPS-05, plan 005-007). Runs under
 * tsx (node node_modules/tsx/dist/cli.mjs apps/server/src/index.ts); all
 * behavior is composed and tested in main.ts — this file only boots it.
 */
import { main } from "./main.js";

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
