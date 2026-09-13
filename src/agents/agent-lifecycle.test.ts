import { randomUUID } from "node:crypto";

import { sql } from "kysely";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { app } from "../app.js";
import { db } from "../database/db.js";
import { registerOrganization } from "../organization-registration/registration.service.js";
import { createUser } from "../organization-registration/user.repository.js";
import * as sessionRepository from "../auth/sessions/session.repository.js";
import { generateSessionToken, hashSessionToken } from "../auth/sessions/session-token.js";
import { SESSION_ABSOLUTE_LIFETIME_MS } from "../auth/auth.constants.js";
import * as teamRepository from "../teams/team.repository.js";
import { deactivateTeam } from "../teams/teams.service.js";
import * as agentRepository from "./agent.repository.js";
import { deactivateAgent, reactivateAgent, reassignAgentTeam } from "./agents.service.js";

async function session(organizationId: string, userId: string) {
  const token = generateSessionToken();
  const row = await sessionRepository.createSession(db, {
    organizationId, userId, tokenHash: hashSessionToken(token), userAgent: null,
    absoluteExpiresAt: new Date(Date.now() + SESSION_ABSOLUTE_LIFETIME_MS),
  });
  return { id: row.id, cookie: `session=${token}` };
}

async function tenant() {
  const unique = randomUUID();
  const { organization, admin } = await registerOrganization({
    organizationName: "Agent lifecycle", organizationSlug: `agent-lifecycle-${unique}`,
    adminName: "Organization admin", adminEmail: `${unique}@example.com`,
    adminPassword: "a sufficiently long password",
  });
  const general = await teamRepository.findGeneralTeam(db, organization.id);
  if (!general) throw new Error("Expected registered General team");
  const { cookie } = await session(organization.id, admin.id);
  const csrf = await request(app).get("/auth/csrf").set("Cookie", cookie).expect(200);
  return { organizationId: organization.id, adminId: admin.id, generalId: general.id, cookie, csrf: csrf.body.csrfToken as string };
}

let own: Awaited<ReturnType<typeof tenant>>;
let other: Awaited<ReturnType<typeof tenant>>;
let customerId: string;
const forbiddenCookies: string[] = [];
const actions = ["deactivate", "reactivate", "revoke-sessions"] as const;

beforeAll(async () => {
  own = await tenant();
  other = await tenant();
  customerId = (await createUser(db, {
    organizationId: own.organizationId, name: "Customer", email: `${randomUUID()}@example.com`,
    passwordHash: "test-only-hash", role: "CUSTOMER",
  })).id;
  forbiddenCookies.push((await session(own.organizationId, customerId)).cookie);
  forbiddenCookies.push((await seedAgent()).sessions[0]!.cookie);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await db.destroy(); });

async function seedAgent(owner = own, sessionCount = 2) {
  const team = await teamRepository.createNormalTeam(db, owner.organizationId, `Retained-${randomUUID()}`);
  const user = await createUser(db, {
    organizationId: owner.organizationId, name: "Agent", email: `${randomUUID()}@example.com`,
    passwordHash: "test-only-hash", role: "AGENT", teamId: team.id,
  });
  const sessions = [];
  for (let i = 0; i < sessionCount; i++) sessions.push(await session(owner.organizationId, user.id));
  return { id: user.id, organizationId: owner.organizationId, team, sessions };
}

async function state(id: string, organizationId = own.organizationId) {
  const user = await db.selectFrom("users")
    .select(["id", "name", "email", "role", "team_id", "deactivated_at", "created_at", "updated_at"])
    .where("organization_id", "=", organizationId).where("id", "=", id).executeTakeFirstOrThrow();
  const sessions = await db.selectFrom("sessions").select(["id", "revoked_at"])
    .where("organization_id", "=", organizationId).where("user_id", "=", id).orderBy("id").execute();
  return { user, sessions };
}

function act(id: string, action: typeof actions[number]) {
  return request(app).post(`/agents/${id}/${action}`)
    .set("Cookie", own.cookie).set("X-CSRF-Token", own.csrf);
}

describe("tenant-admin agent lifecycle", () => {
  it("deactivates without moving teams and revokes every target session only", async () => {
    const target = await seedAgent();
    const colleague = await seedAgent();
    const foreign = await seedAgent(other);
    const before = await state(target.id);
    const colleagueBefore = await state(colleague.id);
    const foreignBefore = await state(foreign.id, other.organizationId);
    const response = await act(target.id, "deactivate").expect(200);
    expect(response.body).toEqual({
      id: target.id, name: before.user.name, email: before.user.email,
      deactivatedAt: expect.any(String), createdAt: before.user.created_at.toISOString(),
      team: { id: target.team.id, name: target.team.name, isGeneral: false, deactivatedAt: null },
    });
    const after = await state(target.id);
    expect(after.user).toEqual({ ...before.user, deactivated_at: new Date(response.body.deactivatedAt), updated_at: expect.any(Date) });
    expect(after.sessions).toHaveLength(2);
    expect(after.sessions.every((row) => row.revoked_at !== null)).toBe(true);
    for (const credential of target.sessions) {
      await request(app).get("/auth/me").set("Cookie", credential.cookie).expect(401);
    }
    expect(await state(colleague.id)).toEqual(colleagueBefore);
    expect(await state(foreign.id, other.organizationId)).toEqual(foreignBefore);
  });

  it("repeated deactivation preserves account timestamps while revoking newly existing sessions", async () => {
    const target = await seedAgent();
    const first = await act(target.id, "deactivate").expect(200);
    const before = await state(target.id);
    const extra = await session(own.organizationId, target.id);
    expect((await act(target.id, "deactivate").expect(200)).body).toEqual(first.body);
    const after = await state(target.id);
    expect(after.user).toEqual(before.user);
    expect(after.sessions.filter((row) => row.id !== extra.id)).toEqual(before.sessions);
    expect(after.sessions.find((row) => row.id === extra.id)?.revoked_at).toBeInstanceOf(Date);
  });

  it.each([false, true])("reactivates with the correct retained/General team (retained inactive=%s), without restoring sessions", async (inactiveTeam) => {
    const target = await seedAgent();
    await act(target.id, "deactivate").expect(200);
    if (inactiveTeam) await deactivateTeam(own.organizationId, target.team.id);
    const before = await state(target.id);
    const response = await act(target.id, "reactivate").expect(200);
    const teamId = inactiveTeam ? own.generalId : target.team.id;
    expect(response.body.deactivatedAt).toBeNull();
    expect(response.body.team).toMatchObject({ id: teamId, isGeneral: inactiveTeam, deactivatedAt: null });
    const after = await state(target.id);
    expect(after.user).toEqual({ ...before.user, deactivated_at: null, team_id: teamId, updated_at: expect.any(Date) });
    expect(after.sessions).toEqual(before.sessions);
    for (const credential of target.sessions) {
      await request(app).get("/auth/me").set("Cookie", credential.cookie).expect(401);
    }
    const lockTeam = vi.spyOn(teamRepository, "findTeamForShare");
    expect((await act(target.id, "reactivate").expect(200)).body).toEqual(response.body);
    expect(lockTeam).not.toHaveBeenCalled();
    expect(await state(target.id)).toEqual(after);
  });

  it.each([false, true])("force logout changes only session revocation (agent inactive=%s)", async (inactive) => {
    const target = await seedAgent();
    if (inactive) await db.updateTable("users").set({ deactivated_at: new Date() })
      .where("organization_id", "=", own.organizationId).where("id", "=", target.id).execute();
    const before = await state(target.id);
    const response = await act(target.id, "revoke-sessions").expect(204);
    expect(response.text).toBe("");
    expect(response.headers["set-cookie"]).toBeUndefined();
    const after = await state(target.id);
    expect(after.user).toEqual(before.user);
    expect(after.sessions.every((row) => row.revoked_at !== null)).toBe(true);
    await act(target.id, "revoke-sessions").expect(204);
    expect(await state(target.id)).toEqual(after);
    for (const credential of target.sessions) {
      await request(app).get("/auth/me").set("Cookie", credential.cookie).expect(401);
    }
  });

  it("force logout succeeds when no sessions exist", async () => {
    const target = await seedAgent(own, 0);
    const before = await state(target.id);
    await act(target.id, "revoke-sessions").expect(204);
    expect(await state(target.id)).toEqual(before);
  });

  it.each(actions)("protects %s with authentication, role, CSRF and UUID validation", async (action) => {
    const path = `/agents/not-a-uuid/${action}`;
    expect((await request(app).post(path).expect(401)).body).toEqual({ error: "Authentication required" });
    for (const cookie of forbiddenCookies) {
      expect((await request(app).post(path).set("Cookie", cookie).expect(403)).body).toEqual({ error: "Request forbidden" });
    }
    for (const token of [undefined, "invalid", other.csrf]) {
      const operation = request(app).post(path).set("Cookie", own.cookie);
      if (token) operation.set("X-CSRF-Token", token);
      expect((await operation.expect(403)).body).toEqual({ error: "Invalid CSRF token" });
    }
    expect((await act("not-a-uuid", action).expect(400)).body.error).toBe("Invalid agent ID");
  });

  it.each(actions)("returns the same 404 for foreign, unknown and non-AGENT targets on %s", async (action) => {
    const foreign = await seedAgent(other);
    const before = await state(foreign.id, other.organizationId);
    for (const id of [randomUUID(), foreign.id, customerId, own.adminId]) {
      const response = await act(id, action).query({ organizationId: other.organizationId })
        .send({ organizationId: other.organizationId, userId: foreign.id }).expect(404);
      expect(response.body).toEqual({ error: "Agent not found" });
    }
    expect(await state(foreign.id, other.organizationId)).toEqual(before);
  });

  it("rolls back deactivation and session revocation together on persistence failure", async () => {
    const target = await seedAgent();
    const before = await state(target.id);
    const revoke = sessionRepository.revokeAccountSessions;
    const failure = new Error("Test-only revocation failure");
    vi.spyOn(sessionRepository, "revokeAccountSessions").mockImplementationOnce(async (executor, input) => {
      expect(executor.isTransaction).toBe(true);
      const user = await executor.selectFrom("users").select("deactivated_at")
        .where("organization_id", "=", input.organizationId).where("id", "=", input.userId).executeTakeFirstOrThrow();
      expect(user.deactivated_at).toBeInstanceOf(Date);
      await revoke(executor, input);
      throw failure;
    });
    await expect(deactivateAgent(own.organizationId, target.id)).rejects.toBe(failure);
    expect(await state(target.id)).toEqual(before);
  });

  it("fails without changing the inactive agent if General is unexpectedly missing", async () => {
    const target = await seedAgent();
    await deactivateAgent(own.organizationId, target.id);
    await deactivateTeam(own.organizationId, target.team.id);
    const before = await state(target.id);
    vi.spyOn(teamRepository, "findGeneralTeam").mockResolvedValueOnce(undefined);
    await expect(reactivateAgent(own.organizationId, target.id)).rejects.toThrow("Organization General team is missing");
    expect(await state(target.id)).toEqual(before);
  });

  it("serializes reactivation behind deactivation of the same agent", async () => {
    const target = await seedAgent();
    const revoke = sessionRepository.revokeAccountSessions;
    let reactivation: ReturnType<typeof reactivateAgent> | undefined;
    vi.spyOn(sessionRepository, "revokeAccountSessions").mockImplementationOnce(async (executor, input) => {
      reactivation = reactivateAgent(own.organizationId, target.id);
      await vi.waitFor(async () => {
        const result = await sql<{ waiting: string }>`
          SELECT count(*) AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND usename = current_user AND wait_event_type = 'Lock'
            AND query LIKE '%users%' AND query LIKE '%for update%'
        `.execute(db);
        expect(Number(result.rows[0]!.waiting)).toBe(1);
      }, { timeout: 5000, interval: 20 });
      await revoke(executor, input);
    });
    try {
      await deactivateAgent(own.organizationId, target.id);
      expect((await reactivation)!.deactivatedAt).toBeNull();
      const after = await state(target.id);
      expect(after.user.deactivated_at).toBeNull();
      expect(after.sessions.every((row) => row.revoked_at !== null)).toBe(true);
    } finally {
      if (reactivation) await Promise.allSettled([reactivation]);
    }
  }, 10_000);

  it("holds the retained-team share lock through reactivation, then team deactivation moves the agent to General", async () => {
    const target = await seedAgent();
    await deactivateAgent(own.organizationId, target.id);
    const mark = agentRepository.markAgentReactivated;
    let deactivation: ReturnType<typeof deactivateTeam> | undefined;
    vi.spyOn(agentRepository, "markAgentReactivated").mockImplementationOnce(async (executor, organizationId, agentId, teamId) => {
      expect(executor.isTransaction).toBe(true);
      deactivation = deactivateTeam(organizationId, teamId);
      await vi.waitFor(async () => {
        const result = await sql<{ waiting: string }>`
          SELECT count(*) AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND usename = current_user AND wait_event_type = 'Lock'
            AND query LIKE '%teams%' AND query LIKE '%for update%'
        `.execute(db);
        expect(Number(result.rows[0]!.waiting)).toBe(1);
      }, { timeout: 5000, interval: 20 });
      return mark(executor, organizationId, agentId, teamId);
    });
    try {
      const active = await reactivateAgent(own.organizationId, target.id);
      expect(active.team.id).toBe(target.team.id);
      await deactivation;
      const after = await state(target.id);
      expect(after.user).toMatchObject({ deactivated_at: null, team_id: own.generalId });
      expect((await teamRepository.findTeam(db, own.organizationId, target.team.id))!.deactivatedAt).toBeInstanceOf(Date);
    } finally {
      if (deactivation) await Promise.allSettled([deactivation]);
    }
  }, 10_000);

  it("coordinates reactivation, reassignment and team deactivation under three-request contention", async () => {
    const target = await seedAgent();
    await deactivateAgent(own.organizationId, target.id);
    const share = teamRepository.findTeamForShare;
    const pending: Promise<unknown>[] = [];
    vi.spyOn(teamRepository, "findTeamForShare").mockImplementationOnce(async (executor, organizationId, teamId) => {
      // Reactivation owns the agent; assignment holds a shared team lock and waits for that agent.
      pending.push(reassignAgentTeam(organizationId, target.id, teamId)
        .then((value) => ({ value }), (error: unknown) => ({ error })));
      await vi.waitFor(async () => {
        const result = await sql<{ waiting: string }>`
          SELECT count(*) AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND usename = current_user AND wait_event_type = 'Lock'
            AND query LIKE '%update "users"%'
        `.execute(db);
        expect(Number(result.rows[0]!.waiting)).toBe(1);
      }, { timeout: 5000, interval: 20 });
      pending.push(deactivateTeam(organizationId, teamId)
        .then((value) => ({ value }), (error: unknown) => ({ error })));
      await vi.waitFor(async () => {
        const result = await sql<{ waiting: string }>`
          SELECT count(*) AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND usename = current_user AND wait_event_type = 'Lock'
            AND query LIKE '%teams%' AND query LIKE '%for update%'
        `.execute(db);
        expect(Number(result.rows[0]!.waiting)).toBe(1);
      }, { timeout: 5000, interval: 20 });
      return share(executor, organizationId, teamId);
    });
    try {
      await reactivateAgent(own.organizationId, target.id);
      for (const outcome of await Promise.all(pending)) expect(outcome).not.toHaveProperty("error");
      expect((await state(target.id)).user).toMatchObject({ deactivated_at: null, team_id: own.generalId });
      expect((await teamRepository.findTeam(db, own.organizationId, target.team.id))!.deactivatedAt).toBeInstanceOf(Date);
    } finally {
      await Promise.allSettled(pending);
    }
  }, 15_000);

  it("waits for team deactivation, then reactivates the retained inactive member in General", async () => {
    const target = await seedAgent();
    await deactivateAgent(own.organizationId, target.id);
    const mark = teamRepository.markTeamDeactivated;
    let reactivation: ReturnType<typeof reactivateAgent> | undefined;
    vi.spyOn(teamRepository, "markTeamDeactivated").mockImplementationOnce(async (executor, organizationId, teamId) => {
      const result = await mark(executor, organizationId, teamId);
      reactivation = reactivateAgent(organizationId, target.id);
      await vi.waitFor(async () => {
        const waiting = await sql<{ waiting: string }>`
          SELECT count(*) AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND usename = current_user AND wait_event_type = 'Lock'
            AND query LIKE '%teams%' AND query LIKE '%for share%'
        `.execute(db);
        expect(Number(waiting.rows[0]!.waiting)).toBe(1);
      }, { timeout: 5000, interval: 20 });
      return result;
    });
    try {
      await deactivateTeam(own.organizationId, target.team.id);
      expect(await reactivation).toMatchObject({ deactivatedAt: null, team: { id: own.generalId, isGeneral: true } });
      expect((await state(target.id)).user).toMatchObject({ deactivated_at: null, team_id: own.generalId });
    } finally {
      if (reactivation) await Promise.allSettled([reactivation]);
    }
  }, 10_000);
});
