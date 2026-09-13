import { createHash, randomUUID } from "node:crypto";

import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { app } from "../app.js";
import { db } from "../database/db.js";
import { registerOrganization } from "../organization-registration/registration.service.js";
import { createUser } from "../organization-registration/user.repository.js";
import { createSession } from "../auth/sessions/session.repository.js";
import { generateSessionToken, hashSessionToken } from "../auth/sessions/session-token.js";
import { SESSION_ABSOLUTE_LIFETIME_MS } from "../auth/auth.constants.js";
import { createNormalTeam, findGeneralTeam } from "../teams/team.repository.js";
import { generateInvitationToken, INVITATION_LIFETIME_MS } from "./invitation-token.js";
import * as invitationRepository from "./invitation.repository.js";
import { createInvitation } from "./invitations.service.js";

async function sessionCookie(organizationId: string, userId: string) {
  const token = generateSessionToken();
  await createSession(db, {
    organizationId, userId, tokenHash: hashSessionToken(token), userAgent: null,
    absoluteExpiresAt: new Date(Date.now() + SESSION_ABSOLUTE_LIFETIME_MS),
  });
  return `session=${token}`;
}

async function tenant() {
  const unique = randomUUID();
  const { organization, admin } = await registerOrganization({
    organizationName: "Invitations", organizationSlug: `invitations-${unique}`,
    adminName: "Admin", adminEmail: `${unique}@example.com`,
    adminPassword: "a sufficiently long password",
  });
  const cookie = await sessionCookie(organization.id, admin.id);
  const csrf = await request(app).get("/auth/csrf").set("Cookie", cookie).expect(200);
  return { organizationId: organization.id, admin, cookie, csrf: csrf.body.csrfToken as string };
}

let own: Awaited<ReturnType<typeof tenant>>;
let other: Awaited<ReturnType<typeof tenant>>;
const forbiddenCookies: string[] = [];

beforeAll(async () => {
  own = await tenant();
  other = await tenant();
  const general = await findGeneralTeam(db, own.organizationId);
  for (const role of ["AGENT", "CUSTOMER"] as const) {
    const user = await createUser(db, {
      organizationId: own.organizationId, name: role, email: `${randomUUID()}@example.com`,
      role, passwordHash: "test-only-hash", teamId: role === "AGENT" ? general!.id : null,
    });
    forbiddenCookies.push(await sessionCookie(own.organizationId, user.id));
  }
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await db.destroy(); });

function input() { return { name: "Invited Agent", email: `${randomUUID()}@example.com` }; }
function create(body: object = input(), owner = own) {
  return request(app).post("/agent-invitations")
    .set("Cookie", owner.cookie).set("X-CSRF-Token", owner.csrf).send(body);
}
function revoke(id: string, owner = own) {
  return request(app).post(`/agent-invitations/${id}/revoke`)
    .set("Cookie", owner.cookie).set("X-CSRF-Token", owner.csrf);
}
function rows(email: string, owner = own) {
  return db.selectFrom("tenant_user_invitations").selectAll()
    .where("organization_id", "=", owner.organizationId).where("email", "=", email)
    .orderBy("created_at").orderBy("id").execute();
}
async function seed(options: {
  owner?: typeof own; email?: string; role?: "AGENT" | "ORGANIZATION_ADMIN";
  state?: "pending" | "expired" | "revoked" | "consumed"; teamId?: string;
} = {}) {
  const owner = options.owner ?? own;
  const createdAt = new Date("2020-01-01T00:00:00Z");
  return db.insertInto("tenant_user_invitations").values({
    organization_id: owner.organizationId, name: "Seed invitation",
    email: options.email ?? input().email, role: options.role ?? "AGENT",
    target_team_id: options.teamId ?? null, token_hash: generateInvitationToken().tokenHash,
    created_at: createdAt,
    expires_at: options.state === "pending" || options.state === undefined
      ? new Date(Date.now() + INVITATION_LIFETIME_MS) : new Date("2020-01-02T00:00:00Z"),
    revoked_at: options.state === "revoked" ? new Date("2020-01-03T00:00:00Z") : null,
    consumed_at: options.state === "consumed" ? new Date("2020-01-03T00:00:00Z") : null,
  }).returningAll().executeTakeFirstOrThrow();
}

describe("agent invitation administration", () => {
  it("creates normalized AGENT metadata and returns a new raw token only on creation", async () => {
    const data = input();
    const response = await create({ name: "  Invited Agent  ", email: ` ${data.email.toUpperCase()} ` }).expect(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(Object.keys(response.body).sort()).toEqual(["invitation", "token"]);
    expect(response.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(response.body.token, "base64url")).toHaveLength(32);
    expect(response.body.invitation).toEqual({
      id: expect.any(String), name: data.name, email: data.email, state: "pending",
      targetTeam: null, createdAt: expect.any(String), expiresAt: expect.any(String),
      consumedAt: null, revokedAt: null,
    });
    const stored = (await rows(data.email))[0]!;
    expect(stored.id[14]).toBe("7");
    expect(stored.role).toBe("AGENT");
    expect(stored.target_team_id).toBeNull();
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.token_hash).toBe(createHash("sha256").update(response.body.token).digest("hex"));
    expect(stored.token_hash).not.toBe(response.body.token);
    expect(JSON.stringify(stored)).not.toContain(response.body.token);
    expect(stored.expires_at.getTime() - stored.created_at.getTime()).toBe(INVITATION_LIFETIME_MS);
    expect(await db.selectFrom("users").select("id").where("organization_id", "=", own.organizationId)
      .where("email", "=", data.email).execute()).toEqual([]);
    const listed = await request(app).get("/agent-invitations").set("Cookie", own.cookie).expect(200);
    expect(JSON.stringify(listed.body)).not.toContain(response.body.token);
    expect(JSON.stringify(listed.body)).not.toContain(stored.token_hash);
    const revoked = await revoke(stored.id).expect(200);
    expect(Object.keys(revoked.body).sort()).toEqual(Object.keys(response.body.invitation).sort());
    expect(JSON.stringify(revoked.body)).not.toContain(response.body.token);
    expect(JSON.stringify(revoked.body)).not.toContain(stored.token_hash);
    const next = await create().expect(201);
    expect(next.body.token).not.toBe(response.body.token);
  });

  it("accepts an active same-tenant team without selecting General for an omitted team", async () => {
    const team = await createNormalTeam(db, own.organizationId, `Invite-${randomUUID()}`);
    const data = { ...input(), teamId: team.id };
    const response = await create(data).expect(201);
    expect(response.body.invitation.targetTeam).toEqual({
      id: team.id, name: team.name, isGeneral: false, deactivatedAt: null,
    });
    expect((await rows(data.email))[0]!.target_team_id).toBe(team.id);
  });

  it("rejects inactive teams and hides foreign or nonexistent teams", async () => {
    const team = await createNormalTeam(db, own.organizationId, `Inactive-${randomUUID()}`);
    await db.updateTable("teams").set({ deactivated_at: new Date() })
      .where("organization_id", "=", own.organizationId).where("id", "=", team.id).execute();
    await create({ ...input(), teamId: team.id }).expect(409);
    const foreign = await findGeneralTeam(db, other.organizationId);
    for (const teamId of [foreign!.id, randomUUID()]) {
      expect((await create({ ...input(), teamId }).expect(404)).body).toEqual({ error: "Team not found" });
    }
  });

  it("rejects any existing same-organization user, including inactive users, but permits another tenant's email", async () => {
    await create({ name: "Agent", email: own.admin.email }).expect(409);
    const user = await createUser(db, {
      organizationId: own.organizationId, ...input(), role: "CUSTOMER", passwordHash: "test-only-hash",
    });
    await db.updateTable("users").set({ deactivated_at: new Date() })
      .where("organization_id", "=", own.organizationId).where("id", "=", user.id).execute();
    await create({ name: "Agent", email: user.email }).expect(409);
    await create({ name: "Agent", email: other.admin.email }).expect(201);
  });

  it("rejects an unexpired duplicate with the same conflict returned for database uniqueness", async () => {
    const data = input();
    await create(data).expect(201);
    const duplicate = await create({ ...data, email: ` ${data.email.toUpperCase()} ` }).expect(409);
    expect(duplicate.body).toEqual({ error: "Email already has a pending invitation" });
    expect(await rows(data.email)).toHaveLength(1);
    // Unexpired invitations of either role reserve the email without being changed.
    const adminInvite = await seed({ role: "ORGANIZATION_ADMIN" });
    expect((await create({ name: "Agent", email: adminInvite.email }).expect(409)).body).toEqual(duplicate.body);
    expect((await rows(adminInvite.email))[0]!.revoked_at).toBeNull();
  });

  it.each(["AGENT", "ORGANIZATION_ADMIN"] as const)("atomically replaces an expired %s invitation with a fresh AGENT credential", async (role) => {
    const old = await seed({ state: "expired", role });
    const response = await create({ name: "Replacement", email: old.email }).expect(201);
    const stored = await rows(old.email);
    expect(stored).toHaveLength(2);
    expect(stored[0]!.revoked_at).toBeInstanceOf(Date);
    expect(stored[0]!.token_hash).toBe(old.token_hash);
    expect(stored[1]!.id).toBe(response.body.invitation.id);
    expect(stored[1]!.id).not.toBe(old.id);
    expect(stored[1]!.token_hash).not.toBe(old.token_hash);
    expect(stored[1]!.revoked_at).toBeNull();
    expect(stored[1]!.role).toBe("AGENT");
    expect(response.body.invitation.state).toBe("pending");
  });

  it.each(["AGENT", "ORGANIZATION_ADMIN"] as const)("rolls back expired %s closure when validation or replacement fails", async (role) => {
    const old = await seed({ state: "expired", role });
    await create({ name: old.name, email: old.email, teamId: randomUUID() }).expect(404);
    expect(await rows(old.email)).toEqual([old]);
    const insert = invitationRepository.insertInvitation;
    vi.spyOn(invitationRepository, "insertInvitation").mockImplementationOnce(async (trx, data) => {
      const closed = await trx.selectFrom("tenant_user_invitations").select("revoked_at")
        .where("organization_id", "=", own.organizationId).where("id", "=", old.id).executeTakeFirstOrThrow();
      expect(closed.revoked_at).toBeInstanceOf(Date);
      await insert(trx, data);
      throw new Error("Test replacement persistence failure");
    });
    await expect(createInvitation(own.organizationId, { name: old.name, email: old.email }))
      .rejects.toThrow("Test replacement persistence failure");
    expect(await rows(old.email)).toEqual([old]);
  });

  it.each(["new", "expired"] as const)("concurrent %s invitation creates leave exactly one open invitation", async (kind) => {
    const data = input();
    if (kind === "expired") await seed({ email: data.email, state: "expired" });
    if (kind === "new") {
      const find = invitationRepository.findOpenInvitationForUpdate;
      let arrived = 0;
      let release!: () => void;
      const bothRead = new Promise<void>((resolve) => { release = resolve; });
      vi.spyOn(invitationRepository, "findOpenInvitationForUpdate").mockImplementation(async (...args) => {
        const result = await find(...args);
        if (++arrived === 2) release();
        await bothRead;
        return result;
      });
    }
    const responses = await Promise.all([create(data), create(data)]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(responses.find((response) => response.status === 409)!.body)
      .toEqual({ error: "Email already has a pending invitation" });
    const stored = await rows(data.email);
    expect(stored.filter((row) => row.revoked_at === null && row.consumed_at === null)).toHaveLength(1);
    expect(stored).toHaveLength(kind === "expired" ? 2 : 1);
  });

  it("lists only this tenant's AGENT invitations, derives states, and paginates deterministically", async () => {
    const owner = await tenant();
    const team = await createNormalTeam(db, owner.organizationId, "Invitation team");
    const seeded = [];
    for (const state of ["pending", "expired", "revoked", "consumed"] as const) {
      seeded.push(await seed({ owner, state, teamId: team.id }));
    }
    await seed({ owner, role: "ORGANIZATION_ADMIN" });
    await seed({ owner: other });
    const response = await request(app).get("/agent-invitations").set("Cookie", owner.cookie).expect(200);
    const orderedIds = seeded.map((row) => row.id).sort().reverse();
    expect(response.body.invitations.map((row: { id: string }) => row.id)).toEqual(orderedIds);
    expect(response.body.pagination).toEqual({ page: 1, limit: 20, total: 4, totalPages: 1 });
    for (const item of response.body.invitations) {
      expect(Object.keys(item).sort()).toEqual([
        "id", "name", "email", "state", "targetTeam", "createdAt", "expiresAt", "revokedAt", "consumedAt",
      ].sort());
      expect(item.targetTeam.id).toBe(team.id);
    }
    for (const status of ["pending", "expired", "revoked", "consumed"]) {
      const filtered = await request(app).get("/agent-invitations").query({ status })
        .set("Cookie", owner.cookie).expect(200);
      expect(filtered.body.invitations).toHaveLength(1);
      expect(filtered.body.invitations[0].state).toBe(status);
      expect(filtered.body.pagination.total).toBe(1);
    }
    const page = await request(app).get("/agent-invitations").query({ page: 2, limit: 2 })
      .set("Cookie", owner.cookie).expect(200);
    expect(page.body.invitations.map((row: { id: string }) => row.id)).toEqual(orderedIds.slice(2));
    expect(page.body.pagination).toEqual({ page: 2, limit: 2, total: 4, totalPages: 2 });
  });

  it.each(["pending", "expired"] as const)("revokes %s invitations idempotently without changing users", async (state) => {
    const invitation = await seed({ state });
    const before = await db.selectFrom("users").selectAll()
      .where("organization_id", "=", own.organizationId).orderBy("id").execute();
    const first = await revoke(invitation.id).expect(200);
    expect(first.body.state).toBe("revoked");
    expect(first.body.revokedAt).toEqual(expect.any(String));
    expect((await revoke(invitation.id).expect(200)).body).toEqual(first.body);
    expect(await db.selectFrom("users").selectAll()
      .where("organization_id", "=", own.organizationId).orderBy("id").execute()).toEqual(before);
  });

  it("rejects consumed invitations and hides foreign, missing and non-AGENT invitations", async () => {
    const consumed = await seed({ state: "consumed" });
    expect((await revoke(consumed.id).expect(409)).body).toEqual({ error: "Invitation has already been used" });
    expect(await rows(consumed.email)).toEqual([consumed]);
    const foreign = await seed({ owner: other });
    const adminInvitation = await seed({ role: "ORGANIZATION_ADMIN" });
    for (const id of [foreign.id, adminInvitation.id, randomUUID()]) {
      expect((await revoke(id).expect(404)).body).toEqual({ error: "Invitation not found" });
    }
    expect(await rows(foreign.email, other)).toEqual([foreign]);
    expect(await rows(adminInvitation.email)).toEqual([adminInvitation]);
  });

  it("requires tenant authentication, organization-admin authorization and mutation CSRF", async () => {
    const id = randomUUID();
    for (const [method, path] of [
      ["get", "/agent-invitations"], ["post", "/agent-invitations"],
      ["post", `/agent-invitations/${id}/revoke`],
    ] as const) {
      await request(app)[method](path).expect(401);
      for (const cookie of forbiddenCookies) {
        await request(app)[method](path).set("Cookie", cookie).expect(403);
      }
      if (method === "post") {
        for (const token of [undefined, "invalid", other.csrf]) {
          const req = request(app).post(path).set("Cookie", own.cookie);
          if (token !== undefined) req.set("X-CSRF-Token", token);
          await req.send(input()).expect(403);
        }
      }
    }
    await request(app).get("/agent-invitations").set("Cookie", own.cookie).expect(200);
  });

  it("rejects malformed input and client-selected role or organization authority", async () => {
    for (const body of [
      {}, { ...input(), name: " " }, { ...input(), email: "invalid" },
      { ...input(), teamId: null }, { ...input(), teamId: "invalid" },
      { ...input(), role: "AGENT" }, { ...input(), organizationId: other.organizationId },
      { ...input(), name: "a".repeat(256) },
    ]) await create(body).expect(400);
    await revoke("invalid").expect(400);
    for (const query of [
      { status: "invalid" }, { page: "0" }, { page: "1.5" }, { limit: "101" },
      { limit: "-1" }, { organizationId: other.organizationId },
    ]) {
      await request(app).get("/agent-invitations").query(query).set("Cookie", own.cookie).expect(400);
    }
  });
});
