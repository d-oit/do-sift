/**
 * Tenant membership storage (issue #120, plans 024 — MT-07, MT-09, MT-10).
 *
 * `tenant_members` is the authoritative answer to "may this user act inside
 * this tenant?". A provider's tenant claim is only a request; this directory
 * is what the kernel and the per-tenant runtimes consult before touching
 * tenant data.
 *
 * Reads fail closed: an unknown tenant, an unknown user, an empty id, or a
 * role value the schema does not define all resolve to `undefined` (not a
 * member) rather than throwing — a request path should deny, not 500.
 * Writes are strict: adding a member to a tenant that does not exist or with
 * an undefined role throws, because that is an operator bug, not a request.
 *
 * Every write also appends to `tenant_member_changes` inside the same
 * transaction (MT-10), so a role change and its receipt are never separated:
 * the log records the actor, the target, the action, and the before/after
 * roles. Repeating an existing role writes nothing and logs nothing.
 */
import type { Client, Row, Transaction } from "@libsql/client";
import {
  TENANT_ROLES,
  type MembershipDirectory,
  type TenantMemberChange,
  type TenantMemberChangeAction,
  type TenantRole,
} from "@do-sift/contracts";
import { now, str, strOrUndefined } from "./rows.js";

export interface TenantMemberRow {
  userId: string;
  role: TenantRole;
  createdAt: string;
}

/** Actor recorded for writes that did not come from an authenticated owner. */
export const SYSTEM_ACTOR = "system";
/** Default (and maximum) number of change rows one tenant history returns. */
export const TENANT_MEMBER_CHANGE_LIMIT = 50;

function parseRole(raw: string | undefined): TenantRole | undefined {
  if (raw === undefined) return undefined;
  return (TENANT_ROLES as readonly string[]).includes(raw) ? (raw as TenantRole) : undefined;
}

function changeFromRow(row: Row): TenantMemberChange {
  const fromRole = parseRole(strOrUndefined(row, "from_role"));
  const toRole = parseRole(strOrUndefined(row, "to_role"));
  return {
    id: Number(row["id"]),
    tenantId: str(row, "tenant_id"),
    actorUserId: str(row, "actor_user_id"),
    targetUserId: str(row, "target_user_id"),
    action: str(row, "action") as TenantMemberChangeAction,
    at: str(row, "created_at"),
    ...(fromRole === undefined ? {} : { fromRole }),
    ...(toRole === undefined ? {} : { toRole }),
  };
}

export class TenantMembershipDirectory implements MembershipDirectory {
  constructor(private readonly client: Client) {}

  /** The user's role in the tenant, or undefined when they are not a member. */
  async roleOf(tenantId: string, userId: string): Promise<TenantRole | undefined> {
    if (tenantId === "" || userId === "") return undefined;
    const res = await this.client.execute({
      sql: "SELECT role FROM tenant_members WHERE tenant_id = ? AND user_id = ?",
      args: [tenantId, userId],
    });
    const row = res.rows[0];
    if (!row) return undefined;
    return parseRole(str(row, "role"));
  }

  /** Every membership row of one tenant, ordered by user id. */
  async members(tenantId: string): Promise<TenantMemberRow[]> {
    const res = await this.client.execute({
      sql: "SELECT user_id, role, created_at FROM tenant_members WHERE tenant_id = ? ORDER BY user_id",
      args: [tenantId],
    });
    return res.rows.flatMap((row) => {
      const role = parseRole(str(row, "role"));
      if (role === undefined) return [];
      return [{ userId: str(row, "user_id"), role, createdAt: str(row, "created_at") }];
    });
  }

  /** Tenants this user belongs to (the inverse lookup a host UI needs). */
  async tenantsOf(userId: string): Promise<string[]> {
    if (userId === "") return [];
    const res = await this.client.execute({
      sql: "SELECT tenant_id FROM tenant_members WHERE user_id = ? ORDER BY tenant_id",
      args: [userId],
    });
    return res.rows.map((row) => str(row, "tenant_id"));
  }

  /**
   * Record (or change) a membership. Throws for an unknown tenant or an
   * unknown role — silently creating either would widen access. The change is
   * logged with `actorUserId`; a request that re-sends the existing role is a
   * no-op that writes and logs nothing.
   */
  async add(
    tenantId: string,
    userId: string,
    role: TenantRole,
    actorUserId: string = SYSTEM_ACTOR,
  ): Promise<void> {
    if (tenantId === "") throw new Error("tenant membership needs a non-empty tenant id");
    if (userId === "") throw new Error("tenant membership needs a non-empty user id");
    if (!(TENANT_ROLES as readonly string[]).includes(role)) {
      throw new Error(`unknown tenant role "${String(role)}"`);
    }
    const tenant = await this.client.execute({
      sql: "SELECT id FROM tenants WHERE id = ?",
      args: [tenantId],
    });
    if (tenant.rows.length === 0) {
      throw new Error(`unknown tenant "${tenantId}": create it before adding members`);
    }
    const tx = await this.client.transaction("write");
    try {
      const existing = await tx.execute({
        sql: "SELECT role FROM tenant_members WHERE tenant_id = ? AND user_id = ?",
        args: [tenantId, userId],
      });
      const row = existing.rows[0];
      const fromRole = row === undefined ? undefined : parseRole(str(row, "role"));
      if (fromRole === role) {
        await tx.commit();
        return;
      }
      await tx.execute({
        sql: "INSERT INTO tenant_members (tenant_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(tenant_id, user_id) DO UPDATE SET role = excluded.role",
        args: [tenantId, userId, role, now()],
      });
      await this.logChange(tx, {
        tenantId,
        actorUserId,
        targetUserId: userId,
        action: fromRole === undefined ? "added" : "role-changed",
        ...(fromRole === undefined ? {} : { fromRole }),
        toRole: role,
      });
      await tx.commit();
    } catch (error) {
      await tx.rollback().catch(() => undefined);
      throw error;
    }
  }

  /** Drop one membership; returns whether a row was removed (and logged). */
  async remove(
    tenantId: string,
    userId: string,
    actorUserId: string = SYSTEM_ACTOR,
  ): Promise<boolean> {
    const tx = await this.client.transaction("write");
    try {
      const existing = await tx.execute({
        sql: "SELECT role FROM tenant_members WHERE tenant_id = ? AND user_id = ?",
        args: [tenantId, userId],
      });
      const row = existing.rows[0];
      const fromRole = row === undefined ? undefined : parseRole(str(row, "role"));
      if (fromRole === undefined) {
        await tx.rollback();
        return false;
      }
      await tx.execute({
        sql: "DELETE FROM tenant_members WHERE tenant_id = ? AND user_id = ?",
        args: [tenantId, userId],
      });
      await this.logChange(tx, {
        tenantId,
        actorUserId,
        targetUserId: userId,
        action: "removed",
        fromRole,
      });
      await tx.commit();
      return true;
    } catch (error) {
      await tx.rollback().catch(() => undefined);
      throw error;
    }
  }

  /**
   * Recent membership changes of one tenant, newest first. Bounded so one
   * request can never walk an unbounded log; the table is the durable record
   * and is never pruned by this class.
   */
  async changes(
    tenantId: string,
    limit: number = TENANT_MEMBER_CHANGE_LIMIT,
  ): Promise<TenantMemberChange[]> {
    if (tenantId === "") return [];
    const capped = Math.max(1, Math.min(Math.trunc(limit), TENANT_MEMBER_CHANGE_LIMIT));
    const res = await this.client.execute({
      sql: "SELECT id, tenant_id, actor_user_id, target_user_id, action, from_role, to_role, created_at FROM tenant_member_changes WHERE tenant_id = ? ORDER BY id DESC LIMIT ?",
      args: [tenantId, capped],
    });
    return res.rows.map(changeFromRow);
  }

  private async logChange(
    tx: Transaction,
    change: {
      tenantId: string;
      actorUserId: string;
      targetUserId: string;
      action: TenantMemberChangeAction;
      fromRole?: TenantRole | undefined;
      toRole?: TenantRole | undefined;
    },
  ): Promise<void> {
    await tx.execute({
      sql: "INSERT INTO tenant_member_changes (tenant_id, actor_user_id, target_user_id, action, from_role, to_role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      args: [
        change.tenantId,
        change.actorUserId,
        change.targetUserId,
        change.action,
        change.fromRole ?? null,
        change.toRole ?? null,
        now(),
      ],
    });
  }
}
