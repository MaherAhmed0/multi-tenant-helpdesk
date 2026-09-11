import { randomUUID } from "node:crypto";

import argon2 from "argon2";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { app } from "../../app.js";
import { db } from "../../database/db.js";
import { createOrganization } from "../../organization-registration/organization.repository.js";
import { createUser } from "../../organization-registration/user.repository.js";
import { createSession } from "../../auth/sessions/session.repository.js";
import { generateSessionToken, hashSessionToken } from "../../auth/sessions/session-token.js";
import { SESSION_ABSOLUTE_LIFETIME_MS } from "../../auth/auth.constants.js";
import { SESSION_COOKIE_NAME } from "../../auth/sessions/session-cookie.js";
import { createSystemAdmin } from "../system-admin.repository.js";
import { createSystemAdminSession } from "../sessions/session.repository.js";
import { generateSystemAdminSessionToken } from "../sessions/session-token.js";
import { SYSTEM_ADMIN_SESSION_COOKIE_NAME } from "../sessions/session-cookie.js";
import { SYSTEM_ADMIN_SESSION_ABSOLUTE_LIFETIME_MS } from "../sessions/session.constants.js";
import * as sessionRepository from "./platform-organization-sessions.repository.js";
import { deactivateOrganization } from "./organizations.service.js";

const password = "a sufficiently long password";
const actions = ["deactivate", "reactivate", "revoke-sessions"] as const;
let passwordHash: string;
let adminCookie: string;
let adminSessionId: string;

beforeAll(async () => {
  passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const admin = await createSystemAdmin(db, {
    email: `lifecycle-${randomUUID()}@example.com`, passwordHash: "test-only-hash",
    totpSecretCiphertext: "test-only-ciphertext", totpSecretIv: "test-only-iv",
    totpSecretAuthTag: "test-only-auth-tag",
  });
  const credential = generateSystemAdminSessionToken();
  const session = await createSystemAdminSession(db, {
    systemAdminId: admin.id, tokenHash: credential.tokenHash,
    absoluteExpiresAt: new Date(Date.now() + SYSTEM_ADMIN_SESSION_ABSOLUTE_LIFETIME_MS), userAgent: null,
  });
  adminCookie = `${SYSTEM_ADMIN_SESSION_COOKIE_NAME}=${credential.token}`;
  adminSessionId = session.id;
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await db.destroy(); });

async function tenantSession(organizationId: string, userId: string) {
  const token = generateSessionToken();
  const session = await createSession(db, {
    organizationId, userId, tokenHash: hashSessionToken(token),
    absoluteExpiresAt: new Date(Date.now() + SESSION_ABSOLUTE_LIFETIME_MS), userAgent: null,
  });
  return { id: session.id, cookie: `${SESSION_COOKIE_NAME}=${token}`, token };
}

async function createTenant() {
  const organization = await createOrganization(db, { name: "Lifecycle tenant", slug: `lifecycle-${randomUUID()}` });
  const admin = await createUser(db, {
    organizationId: organization.id, name: "Tenant admin", email: `${randomUUID()}@example.com`,
    passwordHash, role: "ORGANIZATION_ADMIN",
  });
  const agent = await createUser(db, {
    organizationId: organization.id, name: "Tenant agent", email: `${randomUUID()}@example.com`,
    passwordHash, role: "AGENT",
  });
  const sessions = [await tenantSession(organization.id, admin.id), await tenantSession(organization.id, agent.id)];
  return { organization, admin, agent, sessions };
}

async function readState(organizationId: string) {
  const organization = await db.selectFrom("organizations").selectAll()
    .where("id", "=", organizationId).executeTakeFirstOrThrow();
  const users = await db.selectFrom("users").select(["id", "deactivated_at", "updated_at"])
    .where("organization_id", "=", organizationId).orderBy("id").execute();
  const sessions = await db.selectFrom("sessions").select(["id", "revoked_at"])
    .where("organization_id", "=", organizationId).orderBy("id").execute();
  return { organization, users, sessions };
}

async function act(organizationId: string, action: typeof actions[number]) {
  const response = await request(app).post(`/system-admin/organizations/${organizationId}/${action}`)
    .set("Cookie", adminCookie).expect(204);
  expect(response.text).toBe("");
  expect(response.headers["set-cookie"]).toBeUndefined();
}

async function loginTenant(tenant: Awaited<ReturnType<typeof createTenant>>) {
  const response = await request(app).post("/auth/login").set("X-Helpdesk-Client", "web")
    .send({ organizationSlug: tenant.organization.slug, email: tenant.admin.email, password }).expect(200);
  const cookie = response.headers["set-cookie"]?.[0]?.split(";")[0];
  if (!cookie) throw new Error("Expected a tenant session cookie");
  await request(app).get("/auth/me").set("Cookie", cookie).expect(200);
}

describe("SYSTEM_ADMIN organization lifecycle", () => {
  it.each(actions)("requires authentication for %s", async (action) => {
    const response = await request(app).post(`/system-admin/organizations/${randomUUID()}/${action}`).expect(401);
    expect(response.body).toEqual({ error: "Authentication required" });
  });

  it("rejects working tenant credentials for all lifecycle actions without changing state", async () => {
    const tenant = await createTenant();
    const session = tenant.sessions[0]!;
    await request(app).get("/auth/me").set("Cookie", session.cookie).expect(200);
    const before = await readState(tenant.organization.id);
    for (const action of actions) {
      for (const cookie of [session.cookie, `${SYSTEM_ADMIN_SESSION_COOKIE_NAME}=${session.token}`]) {
        const response = await request(app).post(`/system-admin/organizations/${tenant.organization.id}/${action}`)
          .set("Cookie", cookie).expect(401);
        expect(response.body).toEqual({ error: "Authentication required" });
      }
    }
    expect(await readState(tenant.organization.id)).toEqual(before);
  });

  it.each(actions)("returns 404 for an unknown organization during %s", async (action) => {
    const response = await request(app).post(`/system-admin/organizations/${randomUUID()}/${action}`)
      .set("Cookie", adminCookie).expect(404);
    expect(response.body).toEqual({ error: "Organization not found" });
  });

  it.each(actions)("rejects malformed organization IDs during %s", async (action) => {
    const response = await request(app).post(`/system-admin/organizations/not-a-uuid/${action}`)
      .set("Cookie", adminCookie).expect(400);
    expect(response.body.error).toBe("Invalid organization ID");
  });

  it("deactivates and revokes only target tenant sessions, including on repeated requests", async () => {
    const target = await createTenant();
    const other = await createTenant();
    const before = await readState(target.organization.id);
    const otherBefore = await readState(other.organization.id);
    const previouslyRevoked = await tenantSession(target.organization.id, target.admin.id);
    const earlier = new Date(Date.now() - 60_000);
    await db.updateTable("sessions").set({ revoked_at: earlier }).where("id", "=", previouslyRevoked.id).execute();

    // Request-body identifiers cannot redirect the privileged resource target.
    await request(app).post(`/system-admin/organizations/${target.organization.id}/deactivate`)
      .set("Cookie", adminCookie).send({ organizationId: other.organization.id }).expect(204);
    const first = await readState(target.organization.id);
    expect(first.organization.deactivated_at).toBeInstanceOf(Date);
    expect(first.users).toEqual(before.users);
    expect(first.sessions.every((session) => session.revoked_at !== null)).toBe(true);
    expect(first.sessions.find((session) => session.id === previouslyRevoked.id)?.revoked_at).toEqual(earlier);
    expect(await readState(other.organization.id)).toEqual(otherBefore);
    for (const session of target.sessions) {
      await request(app).get("/auth/me").set("Cookie", session.cookie).expect(401);
    }
    await request(app).get("/auth/me").set("Cookie", other.sessions[0]!.cookie).expect(200);
    await request(app).get("/system-admin/auth/me").set("Cookie", adminCookie).expect(200);
    const privileged = await db.selectFrom("system_admin_sessions").select("revoked_at")
      .where("id", "=", adminSessionId).executeTakeFirstOrThrow();
    expect(privileged.revoked_at).toBeNull();

    const additional = await tenantSession(target.organization.id, target.admin.id);
    await act(target.organization.id, "deactivate");
    const repeated = await readState(target.organization.id);
    expect(repeated.organization).toEqual(first.organization);
    expect(repeated.sessions.filter((session) => session.id !== additional.id)).toEqual(first.sessions);
    expect(repeated.sessions.find((session) => session.id === additional.id)?.revoked_at).toBeInstanceOf(Date);
    await request(app).post("/auth/login").set("X-Helpdesk-Client", "web")
      .send({ organizationSlug: target.organization.slug, email: target.admin.email, password }).expect(401);
  });

  it("rolls back organization state and session revocation when revocation fails", async () => {
    const target = await createTenant();
    const before = await readState(target.organization.id);
    const revoke = sessionRepository.revokePlatformOrganizationSessions;
    const failure = new Error("Test-only revocation failure");
    vi.spyOn(sessionRepository, "revokePlatformOrganizationSessions").mockImplementationOnce(async (executor, id) => {
      expect(executor.isTransaction).toBe(true);
      const organization = await executor.selectFrom("organizations").select("deactivated_at")
        .where("id", "=", id).executeTakeFirstOrThrow();
      expect(organization.deactivated_at).toBeInstanceOf(Date);
      await revoke(executor, id);
      throw failure;
    });
    await expect(deactivateOrganization(target.organization.id)).rejects.toBe(failure);
    expect(await readState(target.organization.id)).toEqual(before);
  });

  it("reactivates idempotently without restoring sessions or changing user states", async () => {
    const target = await createTenant();
    await db.updateTable("users").set({ deactivated_at: new Date() }).where("id", "=", target.agent.id).execute();
    await act(target.organization.id, "deactivate");
    const before = await readState(target.organization.id);
    await act(target.organization.id, "reactivate");
    const active = await readState(target.organization.id);
    expect(active.organization.deactivated_at).toBeNull();
    expect(active.users).toEqual(before.users);
    expect(active.sessions).toEqual(before.sessions);
    await act(target.organization.id, "reactivate");
    expect(await readState(target.organization.id)).toEqual(active);
    for (const session of target.sessions) {
      await request(app).get("/auth/me").set("Cookie", session.cookie).expect(401);
    }
    await loginTenant(target);
  });

  it.each([false, true])("revokes tenant sessions without changing lifecycle state (inactive=%s)", async (inactive) => {
    const target = await createTenant();
    const other = await createTenant();
    if (inactive) {
      await db.updateTable("organizations").set({ deactivated_at: new Date() })
        .where("id", "=", target.organization.id).execute();
    }
    const before = await readState(target.organization.id);
    const otherBefore = await readState(other.organization.id);
    await act(target.organization.id, "revoke-sessions");
    const after = await readState(target.organization.id);
    expect(after.organization).toEqual(before.organization);
    expect(after.users).toEqual(before.users);
    expect(after.sessions.every((session) => session.revoked_at !== null)).toBe(true);
    expect(await readState(other.organization.id)).toEqual(otherBefore);
    await act(target.organization.id, "revoke-sessions");
    expect(await readState(target.organization.id)).toEqual(after);
    for (const session of target.sessions) {
      await request(app).get("/auth/me").set("Cookie", session.cookie).expect(401);
    }
    await request(app).get("/system-admin/auth/me").set("Cookie", adminCookie).expect(200);
    if (!inactive) await loginTenant(target);
  });

  it("succeeds for an existing organization with no sessions", async () => {
    const organization = await createOrganization(db, { name: "Empty tenant", slug: `empty-${randomUUID()}` });
    const before = await readState(organization.id);
    await act(organization.id, "revoke-sessions");
    expect(await readState(organization.id)).toEqual(before);
  });
});
