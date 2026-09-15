/**
 * Legacy noise-class backfill (SRC-13). Passages stored before SRC-12
 * keep `noise_class` NULL and are always included by the read-time noise
 * filter — this converges an existing store at run time, mirroring the
 * RET-03 embed-on-store backfill's shape: owner-scoped, idempotent
 * (classified rows are never re-selected), advisory at the call site.
 *
 * The classifier is INJECTED: storage cannot depend on a plugin (the
 * dependency direction is plugins → storage), so the harness passes its
 * pure heuristic in. The classification is a pure function of the
 * immutable excerpt text — deterministic, no information loss — which is
 * what makes annotating legacy receipts post-hoc honest.
 */
import type { Client, InStatement } from "@libsql/client";
import type { PassageNoiseClass } from "./repositories.js";

export async function backfillPassageNoiseClasses(
  client: Client,
  ownerId: string,
  classify: (text: string) => PassageNoiseClass | undefined,
): Promise<number> {
  const pending = await client.execute({
    sql: "SELECT id, excerpt FROM passages WHERE owner_id = ? AND noise_class IS NULL",
    args: [ownerId],
  });
  const updates: InStatement[] = [];
  for (const row of pending.rows) {
    const noiseClass = classify(String(row.excerpt));
    if (noiseClass !== undefined) {
      updates.push({
        sql: "UPDATE passages SET noise_class = ? WHERE id = ? AND owner_id = ?",
        args: [noiseClass, String(row.id), ownerId],
      });
    }
  }
  if (updates.length === 0) return 0;
  await client.batch(updates, "write");
  return updates.length;
}
