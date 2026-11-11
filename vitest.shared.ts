import { availableParallelism } from "node:os";

/**
 * Worker-pool size, derived rather than pinned.
 *
 * Vitest's default is availableParallelism(), which forks one worker per test
 * file (94 here). The real-browser e2e then starves next to them: 34s for a
 * file that takes 3.5s alone, and its hook hits the ceiling. Half the cores
 * keeps the browser test honest on a big machine; the floor keeps small CI
 * runners from serialising the suite one file at a time.
 *
 * Shared by vitest.config.ts and vitest.unit.config.ts so the two runner
 * pools cannot drift apart.
 */
const CPU_COUNT = Math.max(1, availableParallelism());
export const MAX_WORKERS = CPU_COUNT <= 4 ? CPU_COUNT : Math.min(8, Math.ceil(CPU_COUNT / 2));

/**
 * Real-browser and git-spawning tests (BRW-04 e2e, set-isolation) exceed
 * vitest's 5s defaults when many workers run in parallel on Windows. The e2e
 * genuinely launches chromium now, so the budget must cover a browser
 * start/stop rather than a no-op.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;
