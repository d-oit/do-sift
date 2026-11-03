/**
 * Tenant role policy (issue #120, plan 024 — MT-12): membership admits a user,
 * the recorded role then narrows what they may do, and an absent role allows
 * nothing.
 */
import { describe, expect, it } from "vitest";
import { TENANT_ROLE_ACTIONS, TENANT_ROLES, roleAllows } from "../src/index.js";

describe("roleAllows (MT-12)", () => {
  it("keeps a viewer read-only", () => {
    expect(roleAllows("viewer", "read")).toBe(true);
    expect(roleAllows("viewer", "research")).toBe(false);
    expect(roleAllows("viewer", "admin")).toBe(false);
  });

  it("lets a member run research but not administer", () => {
    expect(roleAllows("member", "read")).toBe(true);
    expect(roleAllows("member", "research")).toBe(true);
    expect(roleAllows("member", "admin")).toBe(false);
  });

  it("lets an owner do everything", () => {
    expect(roleAllows("owner", "read")).toBe(true);
    expect(roleAllows("owner", "research")).toBe(true);
    expect(roleAllows("owner", "admin")).toBe(true);
  });

  it("fails closed when the caller has no recorded role", () => {
    for (const action of TENANT_ROLE_ACTIONS) {
      expect(roleAllows(undefined, action)).toBe(false);
    }
  });

  it("decides every role and action pair", () => {
    for (const role of TENANT_ROLES) {
      for (const action of TENANT_ROLE_ACTIONS) {
        expect(typeof roleAllows(role, action)).toBe("boolean");
      }
    }
    expect([...TENANT_ROLE_ACTIONS]).toEqual(["read", "research", "admin"]);
  });
});
