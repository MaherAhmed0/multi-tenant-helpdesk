import { randomUUID } from "node:crypto";

import { sql } from "kysely";
import request from "supertest";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { app } from "../app.js";
import { db } from "../database/db.js";
import { env } from "../config/env.js";
import { SYSTEM_ADMIN_SESSION_COOKIE_NAME } from "./session-cookie.js";
import {
  SYSTEM_ADMIN_SESSION_ABSOLUTE_LIFETIME_MS,
  SYSTEM_ADMIN_SESSION_IDLE_TIMEOUT_MS,
} from "./session.constants.js";
import { generateSystemAdminSessionToken } from "./session-token.js";
import * as sessionRepository from "./session.repository.js";
import { createSystemAdmin } from "./system-admin.repository.js";

afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await db.destroy(); });

async function createTestSession() {
  // Prepared fixture values: session authentication never reads these credentials.
  const admin = await createSystemAdmin(db, {
    email: `auth-${randomUUID()}@example.com`,
    passwordHash: "test-only-password-hash",
    totpSecretCiphertext: "test-only-ciphertext",
    totpSecretIv: "test-only-iv",
    totpSecretAuthTag: "test-only-auth-tag",
  });
  const credential = generateSystemAdminSessionToken();
  const session = await sessionRepository.createSystemAdminSession(db, {
    systemAdminId: admin.id,
    tokenHash: credential.tokenHash,
    absoluteExpiresAt: new Date(Date.now() + SYSTEM_ADMIN_SESSION_ABSOLUTE_LIFETIME_MS),
    userAgent: null,
  });
  return { admin, session, cookie: `${SYSTEM_ADMIN_SESSION_COOKIE_NAME}=${credential.token}` };
}

const unusableStates = ["revoked", "absolute-expired", "idle-expired", "deactivated"] as const;

async function invalidateSession(
  sessionId: string,
  adminId: string,
  state: typeof unusableStates[number],
) {
  if (state === "revoked") {
    await sessionRepository.revokeSystemAdminSession(db, sessionId);
  } else if (state === "absolute-expired") {
    // Test-only time manipulation; production treats the absolute deadline as immutable.
    await sql`UPDATE system_admin_sessions
      SET absolute_expires_at = clock_timestamp() - interval '1 second'
      WHERE id = ${sessionId}`.execute(db);
  } else if (state === "idle-expired") {
    await db.updateTable("system_admin_sessions").set({
      last_activity_at: sql<Date>`clock_timestamp() -
        ${SYSTEM_ADMIN_SESSION_IDLE_TIMEOUT_MS + 1000} * interval '1 millisecond'`,
    }).where("id", "=", sessionId).execute();
  } else {
    await db.updateTable("system_admins")
      .set({ deactivated_at: sql<Date>`clock_timestamp()` })
      .where("id", "=", adminId).execute();
  }
}

function expectClearedCookie(cookies: unknown) {
  if (!Array.isArray(cookies) || cookies.length !== 1) {
    throw new Error("Expected exactly one session cookie to be cleared");
  }
  const cookie = cookies[0] as string;
  expect(cookie.startsWith(`${SYSTEM_ADMIN_SESSION_COOKIE_NAME}=;`)).toBe(true);
  expect(cookie.includes("; Path=/system-admin;")).toBe(true);
  expect(cookie.includes("; HttpOnly")).toBe(true);
  expect(cookie.includes("; SameSite=Strict")).toBe(true);
  expect(cookie.includes("; Secure")).toBe(env.sessionCookieSecure);
  const expires = cookie.match(/; Expires=([^;]+)/)?.[1];
  expect(Date.parse(expires!)).toBeLessThan(Date.now());
}

describe("SYSTEM_ADMIN session authentication and /me", () => {
  it("returns only the server-derived principal and refreshes activity monotonically", async () => {
    const { admin, session, cookie } = await createTestSession();
    await db.updateTable("system_admin_sessions")
      .set({ last_activity_at: sql<Date>`clock_timestamp() - interval '10 minutes'` })
      .where("id", "=", session.id).execute();
    const before = await db.selectFrom("system_admin_sessions").selectAll()
      .where("id", "=", session.id).executeTakeFirstOrThrow();

    const response = await request(app).get("/system-admin/auth/me")
      .set("Cookie", cookie)
      .set("X-System-Admin-Id", randomUUID())
      .query({ systemAdminId: randomUUID(), email: "forged@example.com", sessionId: randomUUID() })
      .expect(200);
    expect(response.body).toEqual({ id: admin.id, email: admin.email });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["set-cookie"]).toBeUndefined();
    const first = await db.selectFrom("system_admin_sessions").selectAll()
      .where("id", "=", session.id).executeTakeFirstOrThrow();
    expect(first.last_activity_at.getTime()).toBeGreaterThan(before.last_activity_at.getTime());
    await request(app).get("/system-admin/auth/me").set("Cookie", cookie).expect(200);
    const second = await db.selectFrom("system_admin_sessions").selectAll()
      .where("id", "=", session.id).executeTakeFirstOrThrow();
    expect(second.last_activity_at.getTime()).toBeGreaterThanOrEqual(first.last_activity_at.getTime());
    expect(second.absolute_expires_at).toEqual(before.absolute_expires_at);
    expect(second.created_at).toEqual(before.created_at);
    expect(second.token_hash === before.token_hash).toBe(true);
  });

  it("returns generic 401 for a missing cookie without clearing it", async () => {
    const response = await request(app).get("/system-admin/auth/me").expect(401);
    expect(response.body).toEqual({ error: "Authentication required" });
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it.each(["", "not-a-token", generateSystemAdminSessionToken().token, encodeURIComponent('j:{"token":"invalid"}')])(
    "rejects and clears an invalid/unknown cookie (case %#)", async (token) => {
      const response = await request(app).get("/system-admin/auth/me")
        .set("Cookie", `${SYSTEM_ADMIN_SESSION_COOKIE_NAME}=${token}`).expect(401);
      expect(response.body).toEqual({ error: "Authentication required" });
      expectClearedCookie(response.headers["set-cookie"]);
    },
  );

  it.each(unusableStates)("rejects and clears a %s session", async (state) => {
    const { admin, session, cookie } = await createTestSession();
    await invalidateSession(session.id, admin.id, state);
    const before = await db.selectFrom("system_admin_sessions").select("last_activity_at")
      .where("id", "=", session.id).executeTakeFirstOrThrow();
    const response = await request(app).get("/system-admin/auth/me")
      .set("Cookie", cookie).expect(401);
    expect(response.body).toEqual({ error: "Authentication required" });
    expectClearedCookie(response.headers["set-cookie"]);
    const after = await db.selectFrom("system_admin_sessions").select("last_activity_at")
      .where("id", "=", session.id).executeTakeFirstOrThrow();
    expect(after.last_activity_at).toEqual(before.last_activity_at);
  });

  it.each(unusableStates)("rejects a session that becomes %s between lookup and refresh", async (state) => {
    const { admin, session, cookie } = await createTestSession();
    const find = sessionRepository.findActiveSystemAdminSession;
    const refresh = vi.spyOn(sessionRepository, "updateSystemAdminSessionActivity");
    vi.spyOn(sessionRepository, "findActiveSystemAdminSession")
      .mockImplementationOnce(async (executor, tokenHash) => {
        const stale = await find(executor, tokenHash);
        expect(stale).toBeDefined();
        // Commit the state change before returning the now-stale lookup result.
        await invalidateSession(session.id, admin.id, state);
        return stale;
      });
    const response = await request(app).get("/system-admin/auth/me")
      .set("Cookie", cookie).expect(401);
    expect(response.body).toEqual({ error: "Authentication required" });
    expectClearedCookie(response.headers["set-cookie"]);
    expect(refresh.mock.calls.length).toBe(1);
    await expect(refresh.mock.results[0]?.value).resolves.toBeUndefined();
  });

  it("rejects genuine tenant credentials, including under the privileged cookie name", async () => {
    const unique = randomUUID();
    const email = `tenant-${unique}@example.com`;
    const password = "a sufficiently long password";
    const slug = `tenant-${unique}`;
    await request(app).post("/organization-registration").send({
      organizationName: "Tenant isolation test", organizationSlug: slug,
      adminName: "Tenant admin", adminEmail: email, adminPassword: password,
    }).expect(201);
    const login = await request(app).post("/auth/login")
      .set("X-Helpdesk-Client", "web")
      .send({ organizationSlug: slug, email, password }).expect(200);
    const tenantCookie = login.headers["set-cookie"]?.[0]?.split(";")[0];
    if (!tenantCookie?.startsWith("session=")) throw new Error("Tenant login did not set its cookie");
    await request(app).get("/auth/me").set("Cookie", tenantCookie).expect(200);
    const missing = await request(app).get("/system-admin/auth/me")
      .set("Cookie", tenantCookie).expect(401);
    expect(missing.body).toEqual({ error: "Authentication required" });
    expect(missing.headers["set-cookie"]).toBeUndefined();
    const renamed = await request(app).get("/system-admin/auth/me")
      .set("Cookie", `${SYSTEM_ADMIN_SESSION_COOKIE_NAME}=${tenantCookie.slice("session=".length)}`)
      .expect(401);
    expect(renamed.body).toEqual(missing.body);
    expectClearedCookie(renamed.headers["set-cookie"]);
  });
});
