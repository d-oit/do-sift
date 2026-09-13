import { createClient, type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { JobQueue, applyMigrations, loadMigrations } from "../src/index.js";

const T0 = Date.parse("2026-09-08T12:00:00.000Z");

let client: Client;
let queue: JobQueue;

// fresh DB per test: the queue is FIFO per owner, so leftovers from one
// test would otherwise leak into the next test's leaseNext
beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await applyMigrations(client, loadMigrations("migrations"));
  queue = new JobQueue(client, { maxAttempts: 3, leaseMs: 60_000 });
  for (const id of ["owner-a", "owner-b"]) {
    await client.execute({
      sql: "INSERT INTO owners (id, display_name, created_at) VALUES (?, ?, '2026-09-08T00:00:00Z') ON CONFLICT(id) DO NOTHING",
      args: [id, id],
    });
  }
});

describe("enqueue + leaseNext", () => {
  it("enqueues as queued with zero attempts", async () => {
    const id = await queue.enqueue("owner-a", "fetch", { url: "https://example.org/" }, T0);
    const job = await queue.get("owner-a", id);
    expect(job).toMatchObject({ status: "queued", attempts: 0, kind: "fetch" });
    expect(job?.payload).toEqual({ url: "https://example.org/" });
  });

  it("leases in FIFO order and stamps attempts and lease deadline", async () => {
    const first = await queue.enqueue("owner-a", "fetch", { n: 1 }, T0 + 1);
    const second = await queue.enqueue("owner-a", "fetch", { n: 2 }, T0 + 2);
    const lease1 = await queue.leaseNext("owner-a", T0 + 10);
    expect(lease1?.id).toBe(first);
    expect(lease1).toMatchObject({ status: "leased", attempts: 1 });
    expect(lease1?.leaseUntil).toBe(new Date(T0 + 10 + 60_000).toISOString());
    const lease2 = await queue.leaseNext("owner-a", T0 + 11);
    expect(lease2?.id).toBe(second);
    const lease3 = await queue.leaseNext("owner-a", T0 + 12); // nothing left
    expect(lease3).toBeUndefined();
  });

  it("never leases across owners", async () => {
    const id = await queue.enqueue("owner-a", "fetch", {}, T0 + 20);
    // owner B sees nothing of owner A's queue
    expect(await queue.leaseNext("owner-b", T0 + 21)).toBeUndefined();
    expect(await queue.get("owner-b", id)).toBeUndefined(); // cross-owner negative
    // and B cannot complete or fail A's job
    await expect(queue.complete("owner-b", id, T0 + 22)).rejects.toThrow(/not completable/);
    await expect(queue.fail("owner-b", id, "boom", T0 + 23)).rejects.toThrow(/unknown job/);
  });
});

describe("lease expiry (crash recovery)", () => {
  it("reclaims a job whose lease expired and keeps counting attempts", async () => {
    const id = await queue.enqueue("owner-a", "fetch", { n: "crash" }, T0 + 30);
    const first = await queue.leaseNext("owner-a", T0 + 31);
    expect(first?.id).toBe(id);
    // worker dies; before expiry the job is not re-leasable
    expect(await queue.leaseNext("owner-a", T0 + 40)).toBeUndefined();
    // after expiry it comes back, attempts incremented
    const reclaimed = await queue.leaseNext("owner-a", T0 + 31 + 60_000 + 1);
    expect(reclaimed?.id).toBe(id);
    expect(reclaimed?.attempts).toBe(2);
  });
});

describe("fail → retry → dead-letter", () => {
  it("requeues with the error recorded while attempts remain", async () => {
    const id = await queue.enqueue("owner-a", "fetch", { n: "retry" }, T0 + 40);
    await queue.leaseNext("owner-a", T0 + 41);
    const outcome = await queue.fail("owner-a", id, "transient error", T0 + 42);
    expect(outcome).toBe("requeued");
    const job = await queue.get("owner-a", id);
    expect(job).toMatchObject({ status: "queued", lastError: "transient error" });
    expect(job?.leaseUntil).toBeUndefined();
  });

  it("dead-letters at maxAttempts and never re-leases", async () => {
    const id = await queue.enqueue("owner-a", "fetch", { n: "poison" }, T0 + 50);
    for (let round = 1; round <= 3; round++) {
      const leased = await queue.leaseNext("owner-a", T0 + 50 + round * 10);
      expect(leased?.id).toBe(id);
      const outcome = await queue.fail(
        "owner-a",
        id,
        `attempt ${round} failed`,
        T0 + 50 + round * 10 + 1,
      );
      expect(outcome).toBe(round < 3 ? "requeued" : "dead");
    }
    const dead = await queue.get("owner-a", id);
    expect(dead).toMatchObject({ status: "dead", attempts: 3, lastError: "attempt 3 failed" });
    // dead jobs are invisible to leaseNext even after their (cleared) lease window
    expect(await queue.leaseNext("owner-a", T0 + 500_000)).toBeUndefined();
    // and a dead job cannot fail or complete again
    await expect(queue.fail("owner-a", id, "again", T0 + 91)).rejects.toThrow(
      /only queued\/leased/,
    );
    await expect(queue.complete("owner-a", id, T0 + 92)).rejects.toThrow(/not completable/);
  });

  it("completes a leased job and removes it from the runnable set", async () => {
    const id = await queue.enqueue("owner-a", "fetch", { n: "done" }, T0 + 60);
    await queue.leaseNext("owner-a", T0 + 61);
    await queue.complete("owner-a", id, T0 + 62);
    expect(await queue.get("owner-a", id)).toMatchObject({ status: "done" });
    expect(await queue.leaseNext("owner-a", T0 + 63)).toBeUndefined();
  });
});
