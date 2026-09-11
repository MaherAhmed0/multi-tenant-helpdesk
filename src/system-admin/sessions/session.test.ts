import { createHash, randomUUID } from "node:crypto";

import { sql } from "kysely";
import { afterAll, describe, expect, it } from "vitest";

import { db } from "../../database/db.js";
import {
  SYSTEM_ADMIN_SESSION_ABSOLUTE_LIFETIME_MS,
  SYSTEM_ADMIN_SESSION_IDLE_TIMEOUT_MS,
} from "./session.constants.js";
import {
  generateSystemAdminSessionToken,
  hashSystemAdminSessionToken,
} from "./session-token.js";
import {
  createSystemAdminSession,
  findActiveSystemAdminSession,
  revokeSystemAdminSession,
  updateSystemAdminSessionActivity,
} from "./session.repository.js";
import { createSystemAdmin } from "../system-admin.repository.js";

afterAll(async () => {
  await db.destroy();
});

async function createTestSession(
  absoluteExpiresAt = new Date(Date.now() + SYSTEM_ADMIN_SESSION_ABSOLUTE_LIFETIME_MS),
) {
  // Prepared placeholders: these tests never authenticate or decrypt MFA data.
  const admin = await createSystemAdmin(db, {
    email: `session-${randomUUID()}@example.com`,
    passwordHash: "test-only-password-hash",
    totpSecretCiphertext: "test-only-ciphertext",
    totpSecretIv: "test-only-iv",
    totpSecretAuthTag: "test-only-auth-tag",
  });
  const credential = generateSystemAdminSessionToken();
  const session = await createSystemAdminSession(db, {
    systemAdminId: admin.id,
    tokenHash: credential.tokenHash,
    absoluteExpiresAt,
    userAgent: "Session test client",
  });
  return { admin, credential, session };
}

describe("SYSTEM_ADMIN sessions", () => {
  it("generates distinct 32-byte tokens with lowercase SHA-256 hashes", () => {
    const first = generateSystemAdminSessionToken();
    const second = generateSystemAdminSessionToken();
    // Do not print credentials even if an assertion fails.
    expect(first.token === second.token).toBe(false);
    expect(first.tokenHash === second.tokenHash).toBe(false);
    expect(/^[A-Za-z0-9_-]{43}$/.test(first.token)).toBe(true);
    expect(Buffer.from(first.token, "base64url").length).toBe(32);
    expect(/^[0-9a-f]{64}$/.test(first.tokenHash)).toBe(true);
    expect(first.token === first.tokenHash).toBe(false);
    expect(first.tokenHash === createHash("sha256").update(first.token).digest("hex"))
      .toBe(true);
    expect(hashSystemAdminSessionToken(first.token) === first.tokenHash).toBe(true);
  });

  it("stores only the hash and resolves an active session to its privileged identity", async () => {
    const { admin, credential, session } = await createTestSession();
    expect(session.revokedAt).toBeNull();
    expect(session.createdAt).toEqual(session.lastActivityAt);
    expect(session.userAgent).toBe("Session test client");
    expect(Object.keys(session).sort()).toEqual([
      "absoluteExpiresAt", "createdAt", "id", "lastActivityAt",
      "revokedAt", "systemAdminId", "userAgent",
    ]);
    const stored = await db.selectFrom("system_admin_sessions").selectAll()
      .where("id", "=", session.id).executeTakeFirstOrThrow();
    expect(stored.token_hash === credential.tokenHash).toBe(true);
    expect(JSON.stringify(stored).includes(credential.token)).toBe(false);
    expect(await findActiveSystemAdminSession(db, credential.tokenHash)).toEqual({
      sessionId: session.id,
      systemAdminId: admin.id,
      email: admin.email,
      lastActivityAt: session.lastActivityAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
    });
    expect(await findActiveSystemAdminSession(db, credential.token)).toBeUndefined();
    expect(await findActiveSystemAdminSession(db, generateSystemAdminSessionToken().tokenHash))
      .toBeUndefined();
  });

  it.each(["revoked", "absolute-expired", "idle-expired", "deactivated"])(
    "does not resolve or refresh a %s session",
    async (state) => {
      const { admin, credential, session } = await createTestSession(
        state === "absolute-expired" ? new Date(Date.now() - 1000) : undefined,
      );
      if (state === "revoked") {
        await revokeSystemAdminSession(db, session.id);
      } else if (state === "idle-expired") {
        await db.updateTable("system_admin_sessions").set({
          last_activity_at: sql<Date>`clock_timestamp() -
            ${SYSTEM_ADMIN_SESSION_IDLE_TIMEOUT_MS + 1000} * interval '1 millisecond'`,
        }).where("id", "=", session.id).execute();
      } else if (state === "deactivated") {
        await db.updateTable("system_admins")
          .set({ deactivated_at: sql<Date>`clock_timestamp()` })
          .where("id", "=", admin.id).execute();
      }
      const before = await db.selectFrom("system_admin_sessions").selectAll()
        .where("id", "=", session.id).executeTakeFirstOrThrow();
      expect(await findActiveSystemAdminSession(db, credential.tokenHash)).toBeUndefined();
      expect(await updateSystemAdminSessionActivity(db, session.id)).toBeUndefined();
      const after = await db.selectFrom("system_admin_sessions").selectAll()
        .where("id", "=", session.id).executeTakeFirstOrThrow();
      expect(after.last_activity_at).toEqual(before.last_activity_at);
      expect(after.revoked_at).toEqual(before.revoked_at);
    },
  );

  it("refreshes activity monotonically under concurrent updates without extending absolute expiry", async () => {
    const { credential, session } = await createTestSession();
    const before = await db.updateTable("system_admin_sessions")
      .set({ last_activity_at: sql<Date>`clock_timestamp() - interval '10 minutes'` })
      .where("id", "=", session.id).returning("last_activity_at")
      .executeTakeFirstOrThrow();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => updateSystemAdminSessionActivity(db, session.id)),
    );
    expect(results.every((result) => result !== undefined)).toBe(true);
    const activityTimes = results.map((result) => result!.lastActivityAt.getTime());
    expect(Math.min(...activityTimes)).toBeGreaterThan(before.last_activity_at.getTime());
    const active = await findActiveSystemAdminSession(db, credential.tokenHash);
    expect(active?.lastActivityAt.getTime()).toBe(Math.max(...activityTimes));
    expect(active?.absoluteExpiresAt).toEqual(session.absoluteExpiresAt);
  });

  it("does not move activity backwards when a stored timestamp is ahead of database time", async () => {
    const { session } = await createTestSession();
    // Simulate a backwards clock adjustment without changing any actual clock.
    const before = await db.updateTable("system_admin_sessions")
      .set({ last_activity_at: sql<Date>`clock_timestamp() + interval '1 minute'` })
      .where("id", "=", session.id).returning("last_activity_at")
      .executeTakeFirstOrThrow();
    const updated = await updateSystemAdminSessionActivity(db, session.id);
    expect(updated?.lastActivityAt).toEqual(before.last_activity_at);
  });

  it("revokes once under concurrency and preserves the row and first revocation time", async () => {
    const { credential, session } = await createTestSession();
    const results = await Promise.all([
      revokeSystemAdminSession(db, session.id),
      revokeSystemAdminSession(db, session.id),
    ]);
    const successful = results.filter((result) => result !== undefined);
    expect(successful.length).toBe(1);
    expect(successful[0]?.revokedAt).toBeInstanceOf(Date);
    expect(await revokeSystemAdminSession(db, session.id)).toBeUndefined();
    expect(await revokeSystemAdminSession(db, randomUUID())).toBeUndefined();
    expect(await findActiveSystemAdminSession(db, credential.tokenHash)).toBeUndefined();
    const stored = await db.selectFrom("system_admin_sessions").select("revoked_at")
      .where("id", "=", session.id).executeTakeFirstOrThrow();
    expect(stored.revoked_at).toEqual(successful[0]?.revokedAt);
  });

  it.each([false, true])("rejects invalid or duplicate hashes (duplicate=%s)", async (duplicate) => {
    const { admin, credential } = await createTestSession();
    await expect(createSystemAdminSession(db, {
      systemAdminId: admin.id,
      tokenHash: duplicate ? credential.tokenHash : "invalid-hash",
      absoluteExpiresAt: new Date(Date.now() + SYSTEM_ADMIN_SESSION_ABSOLUTE_LIFETIME_MS),
      userAgent: null,
    })).rejects.toMatchObject({ code: duplicate ? "23505" : "23514" });
  });
});
