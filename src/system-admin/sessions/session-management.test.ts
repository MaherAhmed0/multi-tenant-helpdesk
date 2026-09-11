import { randomUUID } from "node:crypto";

import { sql } from "kysely";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";

import { app } from "../../app.js";
import { db } from "../../database/db.js";
import { env } from "../../config/env.js";
import { createSystemAdmin } from "../system-admin.repository.js";
import {
  createSystemAdminSession,
  revokeSystemAdminSession,
  revokeSystemAdminSessions,
} from "./session.repository.js";
import { generateSystemAdminSessionToken } from "./session-token.js";
import { SYSTEM_ADMIN_SESSION_COOKIE_NAME } from "./session-cookie.js";
import {
  SYSTEM_ADMIN_SESSION_ABSOLUTE_LIFETIME_MS,
  SYSTEM_ADMIN_SESSION_IDLE_TIMEOUT_MS,
} from "./session.constants.js";

afterAll(async () => { await db.destroy(); });

async function createAdmin() {
  return createSystemAdmin(db, {
    email: `session-management-${randomUUID()}@example.com`,
    passwordHash: "test-only-password-hash",
    totpSecretCiphertext: "test-only-ciphertext",
    totpSecretIv: "test-only-iv",
    totpSecretAuthTag: "test-only-auth-tag",
  });
}

async function createSession(
  systemAdminId: string,
  userAgent = "Test device",
  absoluteExpiresAt = new Date(Date.now() + SYSTEM_ADMIN_SESSION_ABSOLUTE_LIFETIME_MS),
) {
  const { token, tokenHash } = generateSystemAdminSessionToken();
  const session = await createSystemAdminSession(db, {
    systemAdminId, tokenHash, absoluteExpiresAt, userAgent,
  });
  return { session, cookie: `${SYSTEM_ADMIN_SESSION_COOKIE_NAME}=${token}` };
}

function expectCookieCleared(cookies: unknown) {
  if (!Array.isArray(cookies) || cookies.length !== 1) {
    throw new Error("Expected exactly one cleared session cookie");
  }
  const cookie = cookies[0] as string;
  expect(cookie.startsWith(`${SYSTEM_ADMIN_SESSION_COOKIE_NAME}=;`)).toBe(true);
  expect(cookie.includes("; Path=/system-admin;")).toBe(true);
  expect(cookie.includes("; HttpOnly")).toBe(true);
  expect(cookie.includes("; SameSite=Strict")).toBe(true);
  expect(cookie.includes("; Secure")).toBe(env.sessionCookieSecure);
  expect(Date.parse(cookie.match(/; Expires=([^;]+)/)?.[1]!)).toBeLessThan(Date.now());
}

describe("SYSTEM_ADMIN self-service sessions", () => {
  it.each([
    { method: "post", path: "/logout" },
    { method: "get", path: "/sessions" },
    { method: "delete", path: "/sessions/not-a-uuid" },
    { method: "post", path: "/logout-all" },
  ] as const)("requires authentication for $method $path", async ({ method, path }) => {
    const response = await request(app)[method](`/system-admin/auth${path}`).expect(401);
    expect(response.body).toEqual({ error: "Authentication required" });
  });

  it("logs out only the current session, clears its cookie, and ignores supplied identity", async () => {
    const admin = await createAdmin();
    const current = await createSession(admin.id);
    const other = await createSession(admin.id);
    const response = await request(app).post("/system-admin/auth/logout")
      .set("Cookie", current.cookie)
      .send({ sessionId: other.session.id, systemAdminId: randomUUID() }).expect(204);
    expect(response.text).toBe("");
    expectCookieCleared(response.headers["set-cookie"]);
    await request(app).get("/system-admin/auth/me").set("Cookie", current.cookie).expect(401);
    await request(app).get("/system-admin/auth/me").set("Cookie", other.cookie).expect(200);
    const row = await db.selectFrom("system_admin_sessions").select("revoked_at")
      .where("id", "=", current.session.id).executeTakeFirstOrThrow();
    expect(row.revoked_at).toBeInstanceOf(Date);
  });

  it("lists only usable owned sessions with safe metadata and exactly one current session", async () => {
    const admin = await createAdmin();
    const foreignAdmin = await createAdmin();
    const current = await createSession(admin.id, "Current device");
    const other = await createSession(admin.id, "Other device");
    await createSession(foreignAdmin.id, "Foreign device");
    const revoked = await createSession(admin.id);
    await revokeSystemAdminSession(db, revoked.session.id);
    await createSession(admin.id, "Absolute expired", new Date(0));
    const idle = await createSession(admin.id, "Idle expired");
    await db.updateTable("system_admin_sessions").set({
      last_activity_at: sql<Date>`clock_timestamp() -
        ${SYSTEM_ADMIN_SESSION_IDLE_TIMEOUT_MS + 1000} * interval '1 millisecond'`,
    }).where("id", "=", idle.session.id).execute();

    const response = await request(app).get("/system-admin/auth/sessions")
      .set("Cookie", current.cookie).query({ systemAdminId: foreignAdmin.id }).expect(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.body.sessions.length).toBe(2);
    expect(response.body).toEqual({ sessions: expect.arrayContaining([
      {
        id: current.session.id,
        createdAt: current.session.createdAt.toISOString(),
        lastActivityAt: expect.any(String),
        absoluteExpiresAt: current.session.absoluteExpiresAt.toISOString(),
        userAgent: "Current device", isCurrent: true,
      },
      {
        id: other.session.id,
        createdAt: other.session.createdAt.toISOString(),
        lastActivityAt: other.session.lastActivityAt.toISOString(),
        absoluteExpiresAt: other.session.absoluteExpiresAt.toISOString(),
        userAgent: "Other device", isCurrent: false,
      },
    ]) });
  });

  it("revokes owned sessions without enumerating targets or affecting another admin", async () => {
    const admin = await createAdmin();
    const foreignAdmin = await createAdmin();
    const current = await createSession(admin.id);
    const other = await createSession(admin.id);
    const foreign = await createSession(foreignAdmin.id);
    const revoked = await request(app)
      .delete(`/system-admin/auth/sessions/${other.session.id}`)
      .set("Cookie", current.cookie).send({ systemAdminId: foreignAdmin.id }).expect(204);
    expect(revoked.headers["set-cookie"]).toBeUndefined();
    await request(app).get("/system-admin/auth/me").set("Cookie", other.cookie).expect(401);
    const before = await db.selectFrom("system_admin_sessions").select("revoked_at")
      .where("id", "=", other.session.id).executeTakeFirstOrThrow();

    for (const id of [other.session.id, foreign.session.id, randomUUID(), "not-a-uuid"]) {
      const response = await request(app).delete(`/system-admin/auth/sessions/${id}`)
        .set("Cookie", current.cookie).send({ systemAdminId: foreignAdmin.id }).expect(204);
      expect(response.text).toBe("");
      expect(response.headers["set-cookie"]).toBeUndefined();
    }
    const after = await db.selectFrom("system_admin_sessions").select("revoked_at")
      .where("id", "=", other.session.id).executeTakeFirstOrThrow();
    expect(after.revoked_at).toEqual(before.revoked_at);
    await request(app).get("/system-admin/auth/me").set("Cookie", foreign.cookie).expect(200);
    await request(app).get("/system-admin/auth/me").set("Cookie", current.cookie).expect(200);

    const self = await request(app)
      .delete(`/system-admin/auth/sessions/${current.session.id.toUpperCase()}`)
      .set("Cookie", current.cookie).expect(204);
    expectCookieCleared(self.headers["set-cookie"]);
    await request(app).get("/system-admin/auth/me").set("Cookie", current.cookie).expect(401);
  });

  it("logs out all owned sessions and preserves other admins and earlier revocation times", async () => {
    const admin = await createAdmin();
    const foreignAdmin = await createAdmin();
    const current = await createSession(admin.id);
    const other = await createSession(admin.id);
    await createSession(admin.id, "Expired device", new Date(0));
    const prior = await createSession(admin.id);
    const earlier = new Date(Date.now() - 60_000);
    await db.updateTable("system_admin_sessions").set({ revoked_at: earlier })
      .where("id", "=", prior.session.id).execute();
    const foreign = await createSession(foreignAdmin.id);

    const response = await request(app).post("/system-admin/auth/logout-all")
      .set("Cookie", current.cookie).send({ systemAdminId: foreignAdmin.id }).expect(204);
    expect(response.text).toBe("");
    expectCookieCleared(response.headers["set-cookie"]);
    for (const { cookie } of [current, other]) {
      await request(app).get("/system-admin/auth/me").set("Cookie", cookie).expect(401);
    }
    await request(app).get("/system-admin/auth/me").set("Cookie", foreign.cookie).expect(200);
    const rows = await db.selectFrom("system_admin_sessions").select(["id", "revoked_at"])
      .where("system_admin_id", "=", admin.id).orderBy("id").execute();
    expect(rows.length).toBe(4);
    expect(rows.every((row) => row.revoked_at !== null)).toBe(true);
    expect(rows.find((row) => row.id === prior.session.id)?.revoked_at).toEqual(earlier);

    // Repeat at the persistence boundary: an HTTP retry now fails authentication.
    await revokeSystemAdminSessions(db, admin.id);
    const repeated = await db.selectFrom("system_admin_sessions").select(["id", "revoked_at"])
      .where("system_admin_id", "=", admin.id).orderBy("id").execute();
    expect(repeated).toEqual(rows);
  });
});
