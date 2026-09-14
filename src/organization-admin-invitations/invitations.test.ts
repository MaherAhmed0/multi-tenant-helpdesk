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
import { findGeneralTeam } from "../teams/team.repository.js";
import { generateInvitationToken, INVITATION_LIFETIME_MS } from "../agent-invitations/invitation-token.js";
import * as sharedRepository from "../agent-invitations/invitation.repository.js";
import * as adminRepository from "./invitation.repository.js";
import { createAdminInvitation } from "./invitations.service.js";

const base = "/organization-admin-invitations";
const safeFields = ["id", "name", "email", "state", "createdAt", "expiresAt", "revokedAt", "consumedAt"].sort();

async function session(organizationId: string, userId: string) {
  const token = generateSessionToken();
  await createSession(db, {
    organizationId, userId, tokenHash: hashSessionToken(token), userAgent: null,
    absoluteExpiresAt: new Date(Date.now() + SESSION_ABSOLUTE_LIFETIME_MS),
  });
  const cookie = `session=${token}`;
  const csrf = await request(app).get("/auth/csrf").set("Cookie", cookie).expect(200);
  return { cookie, csrf: csrf.body.csrfToken as string };
}

async function tenant() {
  const unique = randomUUID();
  const { organization, admin } = await registerOrganization({
    organizationName: "Admin invitations", organizationSlug: `admin-invitations-${unique}`,
    adminName: "Admin", adminEmail: `${unique}@example.com`,
    adminPassword: "a sufficiently long password",
  });
  const general = await findGeneralTeam(db, organization.id);
  return { organizationId: organization.id, admin, generalId: general!.id, ...await session(organization.id, admin.id) };
}

let own: Awaited<ReturnType<typeof tenant>>;
let other: typeof own;
let peer: Awaited<ReturnType<typeof session>>;
const existingUsers: { email: string; cookie: string }[] = [];
beforeAll(async () => {
  own = await tenant();
  other = await tenant();
  for (const role of ["AGENT", "CUSTOMER", "ORGANIZATION_ADMIN"] as const) {
    const user = await createUser(db, {
      organizationId: own.organizationId, name: role, email: `${randomUUID()}@example.com`,
      role, passwordHash: "test-only-hash", teamId: role === "AGENT" ? own.generalId : null,
    });
    const credential = await session(own.organizationId, user.id);
    existingUsers.push({ email: user.email, cookie: credential.cookie });
    if (role === "ORGANIZATION_ADMIN") peer = credential;
  }
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await db.destroy(); });

function input() { return { name: "Invited Admin", email: `${randomUUID()}@example.com` }; }
function create(body: object = input(), credential = own) {
  return request(app).post(base).set("Cookie", credential.cookie).set("X-CSRF-Token", credential.csrf).send(body);
}
function revoke(id: string, credential: typeof peer = own) {
  return request(app).post(`${base}/${id}/revoke`).set("Cookie", credential.cookie).set("X-CSRF-Token", credential.csrf);
}
function rows(email: string, owner = own) {
  return db.selectFrom("tenant_user_invitations").selectAll()
    .where("organization_id", "=", owner.organizationId).where("email", "=", email)
    .orderBy("created_at").orderBy("id").execute();
}
async function seed(options: {
  owner?: typeof own; role?: "AGENT" | "ORGANIZATION_ADMIN";
  state?: "pending" | "expired" | "revoked" | "consumed"; email?: string;
} = {}) {
  const owner = options.owner ?? own;
  const role = options.role ?? "ORGANIZATION_ADMIN";
  return db.insertInto("tenant_user_invitations").values({
    organization_id: owner.organizationId, name: "Seed invitation", email: options.email ?? input().email,
    role, target_team_id: role === "AGENT" ? owner.generalId : null,
    token_hash: generateInvitationToken().tokenHash,
    created_at: new Date("2020-01-01T00:00:00Z"),
    expires_at: options.state === undefined || options.state === "pending"
      ? new Date(Date.now() + INVITATION_LIFETIME_MS) : new Date("2020-01-02T00:00:00Z"),
    consumed_at: options.state === "consumed" ? new Date("2020-01-03T00:00:00Z") : null,
    revoked_at: options.state === "revoked" ? new Date("2020-01-03T00:00:00Z") : null,
  }).returningAll().executeTakeFirstOrThrow();
}

describe("organization-admin invitation administration", () => {
  it("creates normalized admin invitations without teams and exposes raw tokens only at creation", async () => {
    const data = input();
    const response = await create({ name: ` ${data.name} `, email: ` ${data.email.toUpperCase()} ` }).expect(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(Object.keys(response.body).sort()).toEqual(["invitation", "token"]);
    expect(Object.keys(response.body.invitation).sort()).toEqual(safeFields);
    expect(response.body.invitation).toMatchObject({ name: data.name, email: data.email, state: "pending" });
    expect(response.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(response.body.token, "base64url")).toHaveLength(32);
    const [stored] = await rows(data.email);
    expect(stored!.id[14]).toBe("7");
    expect(stored).toMatchObject({ role: "ORGANIZATION_ADMIN", target_team_id: null, consumed_at: null, revoked_at: null });
    expect(stored!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored!.token_hash).toBe(createHash("sha256").update(response.body.token).digest("hex"));
    expect(stored!.token_hash).not.toBe(response.body.token);
    expect(JSON.stringify(stored)).not.toContain(response.body.token);
    expect(stored!.expires_at.getTime() - stored!.created_at.getTime()).toBe(INVITATION_LIFETIME_MS);
    expect(await db.selectFrom("users").select("id").where("organization_id", "=", own.organizationId)
      .where("email", "=", data.email).execute()).toEqual([]);
    const list = await request(app).get(base).set("Cookie", own.cookie).expect(200);
    const revoked = await revoke(stored!.id).expect(200);
    for (const body of [list.body, revoked.body]) {
      expect(JSON.stringify(body)).not.toContain(response.body.token);
      expect(JSON.stringify(body)).not.toContain(stored!.token_hash);
    }
    expect(Object.keys(revoked.body).sort()).toEqual(safeFields);
    const next = await create().expect(201);
    expect(next.body.token).not.toBe(response.body.token);
  });

  it("rejects existing users of every tenant role and permits the same email in another tenant", async () => {
    for (const user of [own.admin, ...existingUsers]) {
      expect((await create({ name: "Admin", email: user.email }).expect(409)).body)
        .toEqual({ error: "A user with this email already exists" });
    }
    await create({ name: "Admin", email: other.admin.email }).expect(201);
  });

  it.each(["AGENT", "ORGANIZATION_ADMIN"] as const)("rejects an unexpired %s invitation without changing it", async (role) => {
    const old = await seed({ role });
    expect((await create({ name: "Admin", email: old.email }).expect(409)).body)
      .toEqual({ error: "Email already has a pending invitation" });
    expect(await rows(old.email)).toEqual([old]);
  });

  it.each(["AGENT", "ORGANIZATION_ADMIN"] as const)("replaces an expired %s invitation atomically with a teamless admin invitation", async (role) => {
    const old = await seed({ role, state: "expired" });
    const result = await create({ name: "Replacement", email: old.email }).expect(201);
    const stored = await rows(old.email);
    expect(stored).toHaveLength(2);
    expect(stored[0]).toEqual({ ...old, revoked_at: expect.any(Date) });
    expect(stored[1]).toMatchObject({
      id: result.body.invitation.id, role: "ORGANIZATION_ADMIN", target_team_id: null, revoked_at: null, consumed_at: null,
    });
    expect(stored[1]!.token_hash).not.toBe(old.token_hash);
  });

  it.each(["AGENT", "ORGANIZATION_ADMIN"] as const)("rolls back expired %s closure if replacement insertion fails", async (role) => {
    const old = await seed({ role, state: "expired" });
    const insert = adminRepository.insertAdminInvitation;
    vi.spyOn(adminRepository, "insertAdminInvitation").mockImplementationOnce(async (trx, data) => {
      const closed = await trx.selectFrom("tenant_user_invitations").select("revoked_at")
        .where("organization_id", "=", own.organizationId).where("id", "=", old.id).executeTakeFirstOrThrow();
      expect(closed.revoked_at).toBeInstanceOf(Date);
      return insert(trx, { ...data, tokenHash: "invalid" });
    });
    await expect(createAdminInvitation(own.organizationId, { name: old.name, email: old.email })).rejects.toMatchObject({
      code: "23514", constraint: "tenant_user_invitations_token_hash_check",
    });
    expect(await rows(old.email)).toEqual([old]);
  });

  it.each(["AGENT", "ORGANIZATION_ADMIN"] as const)("uses database uniqueness against a concurrent %s creation", async (role) => {
    const data = input();
    const find = sharedRepository.findOpenInvitationForUpdate;
    let arrived = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(sharedRepository, "findOpenInvitationForUpdate").mockImplementation(async (...args) => {
      const result = await find(...args);
      if (++arrived === 2) release();
      await bothRead;
      return result;
    });
    const competitor = role === "AGENT"
      ? request(app).post("/agent-invitations").set("Cookie", own.cookie).set("X-CSRF-Token", own.csrf).send(data)
      : create(data);
    const results = await Promise.all([create(data), competitor]);
    expect(results.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(results.find((response) => response.status === 409)!.body)
      .toEqual({ error: "Email already has a pending invitation" });
    expect(await rows(data.email)).toHaveLength(1);
  });

  it("lists only this tenant's admin invitations with lifecycle filtering and stable pagination", async () => {
    const owner = await tenant();
    const expected = [];
    for (const state of ["pending", "expired", "revoked", "consumed"] as const) {
      expected.push(await seed({ owner, state }));
    }
    await seed({ owner, role: "AGENT" });
    await seed({ owner: other });
    const list = await request(app).get(base).set("Cookie", owner.cookie).expect(200);
    const ids = expected.map((row) => row.id).sort().reverse();
    expect(list.body.invitations.map((row: { id: string }) => row.id)).toEqual(ids);
    expect(list.body.pagination).toEqual({ page: 1, limit: 20, total: 4, totalPages: 1 });
    for (const row of list.body.invitations) expect(Object.keys(row).sort()).toEqual(safeFields);
    for (const status of ["pending", "expired", "revoked", "consumed"]) {
      const filtered = await request(app).get(base).query({ status }).set("Cookie", owner.cookie).expect(200);
      expect(filtered.body.invitations).toHaveLength(1);
      expect(filtered.body.invitations[0].state).toBe(status);
    }
    const page = await request(app).get(base).query({ page: 2, limit: 2 }).set("Cookie", owner.cookie).expect(200);
    expect(page.body.invitations.map((row: { id: string }) => row.id)).toEqual(ids.slice(2));
    expect(page.body.pagination).toEqual({ page: 2, limit: 2, total: 4, totalPages: 2 });
  });

  it.each(["pending", "expired"] as const)("lets a peer admin revoke a %s invitation idempotently without modifying users", async (state) => {
    const invitation = state === "pending" ? (await create().expect(201)).body.invitation : await seed({ state });
    const before = await db.selectFrom("users").selectAll()
      .where("organization_id", "=", own.organizationId).orderBy("id").execute();
    const first = await revoke(invitation.id, peer).expect(200);
    expect(first.body.state).toBe("revoked");
    expect(first.body.revokedAt).toEqual(expect.any(String));
    expect((await revoke(invitation.id).expect(200)).body).toEqual(first.body);
    expect(await db.selectFrom("users").selectAll()
      .where("organization_id", "=", own.organizationId).orderBy("id").execute()).toEqual(before);
  });

  it("rejects consumed invitations and hides foreign, AGENT and nonexistent invitations", async () => {
    const consumed = await seed({ state: "consumed" });
    expect((await revoke(consumed.id).expect(409)).body).toEqual({ error: "Invitation has already been used" });
    expect(await rows(consumed.email)).toEqual([consumed]);
    const foreign = await seed({ owner: other });
    const agent = await seed({ role: "AGENT" });
    for (const id of [foreign.id, agent.id, randomUUID()]) {
      expect((await revoke(id).expect(404)).body).toEqual({ error: "Invitation not found" });
    }
    expect(await rows(foreign.email, other)).toEqual([foreign]);
    expect(await rows(agent.email)).toEqual([agent]);
  });

  it("requires tenant-admin authentication and CSRF for both mutations", async () => {
    for (const [method, path] of [["get", base], ["post", base], ["post", `${base}/${randomUUID()}/revoke`]] as const) {
      await request(app)[method](path).expect(401);
      for (const user of existingUsers.slice(0, 2)) {
        await request(app)[method](path).set("Cookie", user.cookie).expect(403);
      }
      if (method === "post") {
        for (const token of [undefined, "invalid", other.csrf]) {
          const req = request(app).post(path).set("Cookie", own.cookie);
          if (token) req.set("X-CSRF-Token", token);
          await req.send(input()).expect(403);
        }
      }
    }
    await request(app).get(base).set("Cookie", peer.cookie).expect(200);
  });

  it("rejects client role, organization, team and malformed fields", async () => {
    for (const body of [
      {}, { ...input(), name: " " }, { ...input(), email: "invalid" },
      { ...input(), role: "ORGANIZATION_ADMIN" }, { ...input(), organizationId: other.organizationId },
      { ...input(), teamId: own.generalId }, { ...input(), teamId: null },
    ]) await create(body).expect(400);
    await revoke("invalid").expect(400);
    for (const query of [{ status: "invalid" }, { page: "0" }, { limit: "101" }, { organizationId: other.organizationId }]) {
      await request(app).get(base).query(query).set("Cookie", own.cookie).expect(400);
    }
  });
});
