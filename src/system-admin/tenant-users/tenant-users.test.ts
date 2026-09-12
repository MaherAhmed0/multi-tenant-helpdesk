import { randomUUID } from "node:crypto";

import argon2 from "argon2";
import { sql } from "kysely";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { app } from "../../app.js";
import { db } from "../../database/db.js";
import type { TenantRole } from "../../database/types.js";
import { createOrganization } from "../../organization-registration/organization.repository.js";
import { createUser } from "../../organization-registration/user.repository.js";
import { createGeneralTeam } from "../../teams/team.repository.js";
import { createSession } from "../../auth/sessions/session.repository.js";
import {
  generateSessionToken,
  hashSessionToken,
} from "../../auth/sessions/session-token.js";
import { SESSION_ABSOLUTE_LIFETIME_MS } from "../../auth/auth.constants.js";
import { SESSION_COOKIE_NAME } from "../../auth/sessions/session-cookie.js";
import { createSystemAdmin } from "../system-admin.repository.js";
import { createSystemAdminSession } from "../sessions/session.repository.js";
import { generateSystemAdminSessionToken } from "../sessions/session-token.js";
import { SYSTEM_ADMIN_SESSION_COOKIE_NAME } from "../sessions/session-cookie.js";
import { SYSTEM_ADMIN_SESSION_ABSOLUTE_LIFETIME_MS } from "../sessions/session.constants.js";
import * as sessionsRepository from "./platform-tenant-user-sessions.repository.js";
import { deactivateTenantUser } from "./tenant-users.service.js";

const actions = ["deactivate", "reactivate", "revoke-sessions"] as const;
const password = "a sufficiently long password";
let passwordHash: string;
let adminCookie: string;
let adminSessionId: string;

beforeAll(async () => {
  passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const admin = await createSystemAdmin(db, {
    email: `user-intervention-${randomUUID()}@example.com`,
    passwordHash: "test-only-hash",
    totpSecretCiphertext: "test-only-ciphertext",
    totpSecretIv: "test-only-iv",
    totpSecretAuthTag: "test-only-auth-tag",
  });
  const credential = generateSystemAdminSessionToken();
  const session = await createSystemAdminSession(db, {
    systemAdminId: admin.id,
    tokenHash: credential.tokenHash,
    absoluteExpiresAt: new Date(
      Date.now() + SYSTEM_ADMIN_SESSION_ABSOLUTE_LIFETIME_MS,
    ),
    userAgent: null,
  });
  adminCookie = `${SYSTEM_ADMIN_SESSION_COOKIE_NAME}=${credential.token}`;
  adminSessionId = session.id;
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await db.destroy();
});

async function tenantSession(organizationId: string, userId: string) {
  const token = generateSessionToken();
  const session = await createSession(db, {
    organizationId,
    userId,
    tokenHash: hashSessionToken(token),
    absoluteExpiresAt: new Date(Date.now() + SESSION_ABSOLUTE_LIFETIME_MS),
    userAgent: null,
  });
  return { id: session.id, cookie: `${SESSION_COOKIE_NAME}=${token}`, token };
}

async function createTenant(
  roles: TenantRole[] = ["ORGANIZATION_ADMIN", "AGENT", "CUSTOMER"],
) {
  const organization = await createOrganization(db, {
    name: "User intervention tenant",
    slug: `intervention-${randomUUID()}`,
  });
  const general = await createGeneralTeam(db, organization.id);
  const users = [];
  for (const role of roles) {
    const user = await createUser(db, {
      organizationId: organization.id,
      name: `Test ${role}`,
      email: `${randomUUID()}@example.com`,
      passwordHash,
      role,
      teamId: role === "AGENT" ? general.id : null,
    });
    users.push({
      ...user,
      session: await tenantSession(organization.id, user.id),
    });
  }
  return { organization, users };
}

async function readState(organizationId: string) {
  const organization = await db
    .selectFrom("organizations")
    .selectAll()
    .where("id", "=", organizationId)
    .executeTakeFirstOrThrow();
  const users = await db
    .selectFrom("users")
    .select([
      "id",
      "name",
      "email",
      "role",
      "deactivated_at",
      "created_at",
      "updated_at",
    ])
    .where("organization_id", "=", organizationId)
    .orderBy("id")
    .execute();
  const sessions = await db
    .selectFrom("sessions")
    .select(["id", "user_id", "revoked_at"])
    .where("organization_id", "=", organizationId)
    .orderBy("id")
    .execute();
  return { organization, users, sessions };
}

async function act(userId: string, action: (typeof actions)[number]) {
  const response = await request(app)
    .post(`/system-admin/tenant-users/${userId}/${action}`)
    .set("Cookie", adminCookie)
    .expect(204);
  expect(response.text).toBe("");
  expect(response.headers["set-cookie"]).toBeUndefined();
}

describe("SYSTEM_ADMIN tenant-user intervention", () => {
  it.each(actions)("requires authentication for %s", async (action) => {
    const response = await request(app)
      .post(`/system-admin/tenant-users/${randomUUID()}/${action}`)
      .expect(401);
    expect(response.body).toEqual({ error: "Authentication required" });
  });

  it("rejects genuine tenant credentials, including under the privileged cookie name", async () => {
    const tenant = await createTenant();
    const user = tenant.users[1]!;
    await request(app)
      .get("/auth/me")
      .set("Cookie", user.session.cookie)
      .expect(200);
    const before = await readState(tenant.organization.id);
    for (const action of actions) {
      for (const cookie of [
        user.session.cookie,
        `${SYSTEM_ADMIN_SESSION_COOKIE_NAME}=${user.session.token}`,
      ]) {
        const response = await request(app)
          .post(`/system-admin/tenant-users/${user.id}/${action}`)
          .set("Cookie", cookie)
          .expect(401);
        expect(response.body).toEqual({ error: "Authentication required" });
      }
    }
    expect(await readState(tenant.organization.id)).toEqual(before);
  });

  it.each(actions)(
    "returns 404 for unknown users during %s",
    async (action) => {
      const response = await request(app)
        .post(`/system-admin/tenant-users/${randomUUID()}/${action}`)
        .set("Cookie", adminCookie)
        .expect(404);
      expect(response.body).toEqual({ error: "Tenant user not found" });
    },
  );

  it.each(actions)("rejects malformed IDs during %s", async (action) => {
    const response = await request(app)
      .post(`/system-admin/tenant-users/not-a-uuid/${action}`)
      .set("Cookie", adminCookie)
      .expect(400);
    expect(response.body.error).toBe("Invalid tenant user ID");
  });

  it.each(["AGENT", "CUSTOMER"] as const)(
    "deactivates only the target %s and revokes again on repetition",
    async (role) => {
      const tenant = await createTenant();
      const foreign = await createTenant();
      const user = tenant.users.find((candidate) => candidate.role === role)!;
      const second = await tenantSession(tenant.organization.id, user.id);
      const old = await tenantSession(tenant.organization.id, user.id);
      const earlier = new Date(Date.now() - 60_000);
      await db
        .updateTable("sessions")
        .set({ revoked_at: earlier })
        .where("id", "=", old.id)
        .execute();
      const before = await readState(tenant.organization.id);
      const foreignBefore = await readState(foreign.organization.id);
      await request(app)
        .post(`/system-admin/tenant-users/${user.id}/deactivate`)
        .set("Cookie", adminCookie)
        .send({
          organizationId: foreign.organization.id,
          userId: foreign.users[1]!.id,
          role: "ORGANIZATION_ADMIN",
          email: "forged@example.com",
        })
        .expect(204);
      const first = await readState(tenant.organization.id);
      const updated = first.users.find(
        (candidate) => candidate.id === user.id,
      )!;
      const original = before.users.find(
        (candidate) => candidate.id === user.id,
      )!;
      expect(updated).toEqual({
        ...original,
        deactivated_at: expect.any(Date),
        updated_at: expect.any(Date),
      });
      expect(first.organization).toEqual(before.organization);
      expect(
        first.users.filter((candidate) => candidate.id !== user.id),
      ).toEqual(before.users.filter((candidate) => candidate.id !== user.id));
      expect(
        first.sessions.filter((session) => session.user_id !== user.id),
      ).toEqual(
        before.sessions.filter((session) => session.user_id !== user.id),
      );
      expect(
        first.sessions
          .filter((session) => session.user_id === user.id)
          .every((session) => session.revoked_at !== null),
      ).toBe(true);
      expect(
        first.sessions.find((session) => session.id === old.id)?.revoked_at,
      ).toEqual(earlier);
      expect(await readState(foreign.organization.id)).toEqual(foreignBefore);
      for (const session of [user.session, second]) {
        await request(app)
          .get("/auth/me")
          .set("Cookie", session.cookie)
          .expect(401);
      }
      const additional = await tenantSession(tenant.organization.id, user.id);
      await act(user.id, "deactivate");
      const repeated = await readState(tenant.organization.id);
      expect(repeated.users).toEqual(first.users);
      expect(
        repeated.sessions.filter((session) => session.id !== additional.id),
      ).toEqual(first.sessions);
      expect(
        repeated.sessions.find((session) => session.id === additional.id)
          ?.revoked_at,
      ).toBeInstanceOf(Date);
      const privileged = await db
        .selectFrom("system_admin_sessions")
        .select("revoked_at")
        .where("id", "=", adminSessionId)
        .executeTakeFirstOrThrow();
      expect(privileged.revoked_at).toBeNull();
      await request(app)
        .get("/system-admin/auth/me")
        .set("Cookie", adminCookie)
        .expect(200);
    },
  );

  it("allows one admin deactivation but protects the remaining active admin without partial effects", async () => {
    const tenant = await createTenant([
      "ORGANIZATION_ADMIN",
      "ORGANIZATION_ADMIN",
    ]);
    const [first, last] = tenant.users;
    await act(first!.id, "deactivate");
    const before = await readState(tenant.organization.id);
    const response = await request(app)
      .post(`/system-admin/tenant-users/${last!.id}/deactivate`)
      .set("Cookie", adminCookie)
      .expect(409);
    expect(response.body).toEqual({
      error: "Cannot deactivate the last active organization admin",
    });
    expect(await readState(tenant.organization.id)).toEqual(before);
    await request(app)
      .get("/auth/me")
      .set("Cookie", last!.session.cookie)
      .expect(200);
    // Repeating an already-inactive admin's command must not trip the last-admin guard.
    const additional = await tenantSession(tenant.organization.id, first!.id);
    await act(first!.id, "deactivate");
    const repeated = await readState(tenant.organization.id);
    expect(repeated.users).toEqual(before.users);
    expect(
      repeated.sessions.find((session) => session.id === additional.id)
        ?.revoked_at,
    ).toBeInstanceOf(Date);
  });

  it("allows the final admin to be deactivated when its organization is already inactive", async () => {
    const tenant = await createTenant(["ORGANIZATION_ADMIN"]);
    await db
      .updateTable("organizations")
      .set({ deactivated_at: new Date() })
      .where("id", "=", tenant.organization.id)
      .execute();
    await act(tenant.users[0]!.id, "deactivate");
    const state = await readState(tenant.organization.id);
    expect(state.users[0]!.deactivated_at).toBeInstanceOf(Date);
    expect(state.sessions[0]!.revoked_at).toBeInstanceOf(Date);
  });

  it("serializes simultaneous admin deactivations and rechecks after real organization lock waits", async () => {
    const tenant = await createTenant([
      "ORGANIZATION_ADMIN",
      "ORGANIZATION_ADMIN",
    ]);
    const attempts: Promise<request.Response>[] = [];
    try {
      await db.transaction().execute(async (trx) => {
        await trx
          .selectFrom("organizations")
          .select("id")
          .where("id", "=", tenant.organization.id)
          .forUpdate()
          .execute();
        for (const user of tenant.users) {
          attempts.push(
            request(app)
              .post(`/system-admin/tenant-users/${user.id}/deactivate`)
              .set("Cookie", adminCookie)
              .then((response) => response),
          );
        }
        // Wait for actual DB lock contention, not an assumed request timing/order.
        await vi.waitFor(
          async () => {
            const result = await sql<{ waiting: string }>`
            SELECT count(*) AS waiting FROM pg_stat_activity
            WHERE datname = current_database() AND usename = current_user
              AND wait_event_type = 'Lock'
              AND query LIKE '%organizations%' AND query LIKE '%for update%'
          `.execute(db);
            expect(Number(result.rows[0]!.waiting)).toBe(2);
          },
          { timeout: 5000, interval: 20 },
        );
      });
      const responses = await Promise.all(attempts);
      expect(responses.map((response) => response.status).sort()).toEqual([
        204, 409,
      ]);
      const state = await readState(tenant.organization.id);
      expect(state.organization.deactivated_at).toBeNull();
      expect(
        state.users.filter((user) => user.deactivated_at === null),
      ).toHaveLength(1);
      const winner = state.users.find((user) => user.deactivated_at !== null)!;
      expect(
        state.sessions.find((session) => session.user_id === winner.id)
          ?.revoked_at,
      ).toBeInstanceOf(Date);
      expect(
        state.sessions.find((session) => session.user_id !== winner.id)
          ?.revoked_at,
      ).toBeNull();
    } finally {
      await Promise.allSettled(attempts);
    }
  }, 10_000);

  it("rolls back user deactivation and session writes when session revocation fails", async () => {
    const tenant = await createTenant();
    const user = tenant.users[1]!;
    const before = await readState(tenant.organization.id);
    const revoke = sessionsRepository.revokePlatformTenantUserSessions;
    const failure = new Error("Test-only session revocation failure");
    vi.spyOn(
      sessionsRepository,
      "revokePlatformTenantUserSessions",
    ).mockImplementationOnce(async (executor, organizationId, userId) => {
      expect(executor.isTransaction).toBe(true);
      const updated = await executor
        .selectFrom("users")
        .select("deactivated_at")
        .where("id", "=", userId)
        .executeTakeFirstOrThrow();
      expect(updated.deactivated_at).toBeInstanceOf(Date);
      await revoke(executor, organizationId, userId);
      throw failure;
    });
    await expect(deactivateTenantUser(user.id)).rejects.toBe(failure);
    expect(await readState(tenant.organization.id)).toEqual(before);
  });

  it("reactivates idempotently without restoring sessions or changing identity/profile fields", async () => {
    const tenant = await createTenant();
    const user = tenant.users[1]!;
    await act(user.id, "deactivate");
    const before = await readState(tenant.organization.id);
    await act(user.id, "reactivate");
    const active = await readState(tenant.organization.id);
    expect(active.organization).toEqual(before.organization);
    expect(active.sessions).toEqual(before.sessions);
    expect(active.users.find((candidate) => candidate.id === user.id)).toEqual({
      ...before.users.find((candidate) => candidate.id === user.id),
      deactivated_at: null,
      updated_at: expect.any(Date),
    });
    await act(user.id, "reactivate");
    expect(await readState(tenant.organization.id)).toEqual(active);
    await request(app)
      .get("/auth/me")
      .set("Cookie", user.session.cookie)
      .expect(401);
  });

  it.each([false, true])(
    "rejects user reactivation under an inactive organization (user inactive=%s)",
    async (inactive) => {
      const tenant = await createTenant();
      const user = tenant.users[1]!;
      if (inactive) await act(user.id, "deactivate");
      await db
        .updateTable("organizations")
        .set({ deactivated_at: new Date() })
        .where("id", "=", tenant.organization.id)
        .execute();
      const before = await readState(tenant.organization.id);
      const response = await request(app)
        .post(`/system-admin/tenant-users/${user.id}/reactivate`)
        .set("Cookie", adminCookie)
        .expect(409);
      expect(response.body).toEqual({
        error: "Cannot reactivate a user in a deactivated organization",
      });
      expect(await readState(tenant.organization.id)).toEqual(before);
    },
  );

  it.each([false, true])(
    "revokes only target sessions without changing access state (user inactive=%s)",
    async (inactive) => {
      const tenant = await createTenant();
      const foreign = await createTenant();
      const user = tenant.users[1]!;
      await tenantSession(tenant.organization.id, user.id);
      if (inactive) {
        await db
          .updateTable("users")
          .set({ deactivated_at: new Date() })
          .where("id", "=", user.id)
          .execute();
        await db
          .updateTable("organizations")
          .set({ deactivated_at: new Date() })
          .where("id", "=", tenant.organization.id)
          .execute();
      }
      const before = await readState(tenant.organization.id);
      const foreignBefore = await readState(foreign.organization.id);
      await act(user.id, "revoke-sessions");
      const after = await readState(tenant.organization.id);
      expect(after.organization).toEqual(before.organization);
      expect(after.users).toEqual(before.users);
      expect(
        after.sessions.filter((session) => session.user_id !== user.id),
      ).toEqual(
        before.sessions.filter((session) => session.user_id !== user.id),
      );
      expect(
        after.sessions
          .filter((session) => session.user_id === user.id)
          .every((session) => session.revoked_at !== null),
      ).toBe(true);
      expect(await readState(foreign.organization.id)).toEqual(foreignBefore);
      await act(user.id, "revoke-sessions");
      expect(await readState(tenant.organization.id)).toEqual(after);
      await request(app)
        .get("/auth/me")
        .set("Cookie", user.session.cookie)
        .expect(401);
      await request(app)
        .get("/system-admin/auth/me")
        .set("Cookie", adminCookie)
        .expect(200);
      if (!inactive) {
        const response = await request(app)
          .post("/auth/login")
          .set("X-Helpdesk-Client", "web")
          .send({
            organizationSlug: tenant.organization.slug,
            email: user.email,
            password,
          })
          .expect(200);
        const cookie = response.headers["set-cookie"]?.[0]?.split(";")[0];
        if (!cookie) throw new Error("Expected a new tenant session cookie");
        await request(app).get("/auth/me").set("Cookie", cookie).expect(200);
      }
    },
  );

  it("succeeds for an existing user with no sessions", async () => {
    const tenant = await createTenant();
    const user = await createUser(db, {
      organizationId: tenant.organization.id,
      name: "No sessions",
      email: `${randomUUID()}@example.com`,
      passwordHash,
      role: "CUSTOMER",
    });
    const before = await readState(tenant.organization.id);
    await act(user.id, "revoke-sessions");
    expect(await readState(tenant.organization.id)).toEqual(before);
  });
});
