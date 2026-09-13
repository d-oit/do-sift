import { createClient, type Client } from "@libsql/client";
import { beforeAll, describe, expect, it } from "vitest";
import { BudgetService, applyMigrations, loadMigrations, type DailyCaps } from "../src/index.js";

const REQUEST = {
  maxInputTokens: 4000,
  maxOutputTokens: 700,
  maxSearchCalls: 1,
  maxFetches: 3,
  deadlineMs: 30_000,
} as const;

const CAPS: DailyCaps = {
  maxInputTokens: 10_000,
  maxOutputTokens: 2_000,
  maxSearchCalls: 5,
  maxFetches: 20,
};

const T0 = Date.parse("2026-09-07T12:00:00.000Z"); // deterministic clock

let client: Client;
let budgets: BudgetService;

const OWNER_IDS = [
  "owner-1",
  "cap-owner",
  "day-owner",
  "other-owner",
  "race-owner",
  "settle-owner",
  "release-owner",
  "guard-owner",
  "attacker",
  "expire-owner",
  "report-owner",
] as const;

beforeAll(async () => {
  client = createClient({ url: ":memory:" });
  await applyMigrations(client, loadMigrations("migrations"));
  budgets = new BudgetService(client, CAPS);
  // usage_ledger.owner_id references owners(id) and libSQL enforces the FK
  for (const id of OWNER_IDS) {
    await client.execute({
      sql: "INSERT INTO owners (id, display_name, created_at) VALUES (?, ?, '2026-09-07T00:00:00Z') ON CONFLICT(id) DO NOTHING",
      args: [id, id],
    });
  }
});

async function stateOf(id: string): Promise<string> {
  const res = await client.execute("SELECT state FROM usage_ledger WHERE id = ?", [id]);
  return String(res.rows[0]?.state);
}

describe("reserve", () => {
  it("opens a reservation holding the ceilings with a deadline", async () => {
    const { id, reservation } = await budgets.reserve({
      ownerId: "owner-1",
      request: REQUEST,
      estimatedInputTokens: 3_500,
      nowMs: T0,
    });
    expect(reservation).toMatchObject({
      inputTokens: 4_000,
      outputTokens: 700,
      searchCalls: 1,
      fetches: 3,
    });
    expect(new Date(reservation.expiresAtMs).toISOString()).toBe(
      new Date(T0 + REQUEST.deadlineMs).toISOString(),
    );
    expect(await stateOf(id)).toBe("open");
  });

  it("rejects estimates above the request ceiling before touching the ledger", async () => {
    await expect(
      budgets.reserve({
        ownerId: "owner-1",
        request: REQUEST,
        estimatedInputTokens: 4_001,
        nowMs: T0,
      }),
    ).rejects.toThrow(/exceeds budget/);
  });

  it("refuses reservations past the daily input cap (holds accumulate)", async () => {
    const svc = new BudgetService(client, CAPS);
    await svc.reserve({
      ownerId: "cap-owner",
      request: REQUEST,
      estimatedInputTokens: 1,
      nowMs: T0,
    });
    await svc.reserve({
      ownerId: "cap-owner",
      request: REQUEST,
      estimatedInputTokens: 1,
      nowMs: T0,
    });
    // 4000 + 4000 held; a third reservation (4000) would need 12000 > 10000
    await expect(
      svc.reserve({ ownerId: "cap-owner", request: REQUEST, estimatedInputTokens: 1, nowMs: T0 }),
    ).rejects.toMatchObject({ kind: "cap-exceeded" });
  });

  it("caps are per owner and per UTC day", async () => {
    const svc = new BudgetService(client, { ...CAPS, maxInputTokens: 4_000 });
    await svc.reserve({
      ownerId: "day-owner",
      request: REQUEST,
      estimatedInputTokens: 1,
      nowMs: T0,
    });
    // same owner, different day → fresh allowance
    await expect(
      svc.reserve({
        ownerId: "day-owner",
        request: REQUEST,
        estimatedInputTokens: 1,
        nowMs: T0 + 24 * 60 * 60 * 1000,
      }),
    ).resolves.toBeDefined();
    // different owner, same day → fresh allowance
    await expect(
      svc.reserve({ ownerId: "other-owner", request: REQUEST, estimatedInputTokens: 1, nowMs: T0 }),
    ).resolves.toBeDefined();
  });

  it("lets exactly one of two concurrent over-cap reservations through", async () => {
    const svc = new BudgetService(client, { ...CAPS, maxInputTokens: 4_000 });
    const results = await Promise.allSettled([
      svc.reserve({ ownerId: "race-owner", request: REQUEST, estimatedInputTokens: 1, nowMs: T0 }),
      svc.reserve({ ownerId: "race-owner", request: REQUEST, estimatedInputTokens: 1, nowMs: T0 }),
    ]);
    // the invariant: never two open reservations totalling 8000 under a 4000 cap.
    // (the loser may be refused as cap-exceeded or at the driver's transaction
    // lock; both leave the ledger consistent)
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok).toHaveLength(1);
    expect(results.length - ok.length).toBe(1);
    const open = await client.execute(
      "SELECT COUNT(*) AS n FROM usage_ledger WHERE owner_id = 'race-owner' AND kind = 'reservation' AND state = 'open'",
    );
    expect(Number(open.rows[0]?.n)).toBe(1);
    const held = await svc.heldForDay("race-owner", T0);
    expect(held.inputTokens).toBe(4_000);
  });
});

describe("settle", () => {
  it("writes actuals, flips the reservation, and reports overruns honestly", async () => {
    const { id } = await budgets.reserve({
      ownerId: "settle-owner",
      request: REQUEST,
      estimatedInputTokens: 100,
      nowMs: T0,
    });
    const fine = await budgets.settle({
      ownerId: "settle-owner",
      reservationId: id,
      actual: { inputTokens: 3_800, outputTokens: 600, searchCalls: 1, fetches: 2 },
      nowMs: T0 + 1_000,
    });
    expect(fine.overrun).toBe(false);
    expect(await stateOf(id)).toBe("settled");
    expect(await stateOf(fine.settlementId)).toBe("settled");

    const { id: overrunId } = await budgets.reserve({
      ownerId: "settle-owner",
      request: REQUEST,
      estimatedInputTokens: 100,
      nowMs: T0 + 2_000,
    });
    const over = await budgets.settle({
      ownerId: "settle-owner",
      reservationId: overrunId,
      actual: { inputTokens: 4_200, outputTokens: 100 },
      nowMs: T0 + 3_000,
    });
    expect(over.overrun).toBe(true); // recorded, never hidden
    expect(over.deltaInput).toBe(200);
    expect(await stateOf(overrunId)).toBe("settled");
  });

  it("releases the hold: settled actuals replace reserved maxima", async () => {
    const svc = new BudgetService(client, { ...CAPS, maxInputTokens: 5_000 });
    const first = await svc.reserve({
      ownerId: "release-owner",
      request: REQUEST,
      estimatedInputTokens: 1,
      nowMs: T0,
    });
    await expect(
      svc.reserve({
        ownerId: "release-owner",
        request: REQUEST,
        estimatedInputTokens: 1,
        nowMs: T0,
      }),
    ).rejects.toMatchObject({ kind: "cap-exceeded" }); // 4000 held, second needs 8000 > 5000
    await svc.settle({
      ownerId: "release-owner",
      reservationId: first.id,
      actual: { inputTokens: 100, outputTokens: 10 },
      nowMs: T0 + 1_000,
    });
    // held is now the 100-token actual; a full reservation fits again
    await expect(
      svc.reserve({
        ownerId: "release-owner",
        request: REQUEST,
        estimatedInputTokens: 1,
        nowMs: T0 + 2_000,
      }),
    ).resolves.toBeDefined();
  });

  it("refuses unknown, cross-owner, and non-open reservations", async () => {
    const { id } = await budgets.reserve({
      ownerId: "guard-owner",
      request: REQUEST,
      estimatedInputTokens: 1,
      nowMs: T0,
    });
    await expect(
      budgets.settle({
        ownerId: "guard-owner",
        reservationId: "missing",
        actual: { inputTokens: 0, outputTokens: 0 },
        nowMs: T0,
      }),
    ).rejects.toMatchObject({ kind: "unknown-reservation" });
    // cross-owner settle is refused and leaves the reservation usable by its owner
    await expect(
      budgets.settle({
        ownerId: "attacker",
        reservationId: id,
        actual: { inputTokens: 0, outputTokens: 0 },
        nowMs: T0,
      }),
    ).rejects.toMatchObject({ kind: "unknown-reservation" });
    const done = await budgets.settle({
      ownerId: "guard-owner",
      reservationId: id,
      actual: { inputTokens: 1, outputTokens: 1 },
      nowMs: T0,
    });
    expect(done.overrun).toBe(false);
    await expect(
      budgets.settle({
        ownerId: "guard-owner",
        reservationId: id,
        actual: { inputTokens: 1, outputTokens: 1 },
        nowMs: T0,
      }),
    ).rejects.toMatchObject({ kind: "reservation-not-open" }); // no double settle
  });
});

describe("expireDue", () => {
  it("expires overdue holds and releases the cap budget", async () => {
    const svc = new BudgetService(client, { ...CAPS, maxInputTokens: 4_000 });
    const { id } = await svc.reserve({
      ownerId: "expire-owner",
      request: { ...REQUEST, deadlineMs: 10 },
      estimatedInputTokens: 1,
      nowMs: T0,
    });
    expect(await svc.expireDue("expire-owner", T0 + 5)).toBe(0); // not yet due
    expect(await svc.expireDue("expire-owner", T0 + 11)).toBe(1);
    expect(await stateOf(id)).toBe("expired");
    await expect(
      svc.settle({
        ownerId: "expire-owner",
        reservationId: id,
        actual: { inputTokens: 0, outputTokens: 0 },
        nowMs: T0 + 12,
      }),
    ).rejects.toMatchObject({ kind: "reservation-not-open" });
    // the expired hold no longer blocks a new reservation
    await expect(
      svc.reserve({
        ownerId: "expire-owner",
        request: REQUEST,
        estimatedInputTokens: 1,
        nowMs: T0 + 13,
      }),
    ).resolves.toBeDefined();
  });
});

describe("heldForDay", () => {
  it("reports open maxima plus settled actuals without double counting", async () => {
    const svc = new BudgetService(client, CAPS);
    const a = await svc.reserve({
      ownerId: "report-owner",
      request: REQUEST,
      estimatedInputTokens: 1,
      nowMs: T0,
    });
    expect(await svc.heldForDay("report-owner", T0)).toMatchObject({
      inputTokens: 4_000,
      outputTokens: 700,
    });
    await svc.settle({
      ownerId: "report-owner",
      reservationId: a.id,
      actual: { inputTokens: 500, outputTokens: 50 },
      nowMs: T0 + 1_000,
    });
    await svc.reserve({
      ownerId: "report-owner",
      request: REQUEST,
      estimatedInputTokens: 1,
      nowMs: T0 + 2_000,
    });
    const held = await svc.heldForDay("report-owner", T0 + 3_000);
    expect(held).toMatchObject({ inputTokens: 4_500, outputTokens: 750 }); // 500 actual + 4000 open, not 8000
  });
});
