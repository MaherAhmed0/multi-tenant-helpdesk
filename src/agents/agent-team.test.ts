import { randomUUID } from "node:crypto";

import { sql } from "kysely";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { app } from "../app.js";
import { db } from "../database/db.js";
import { registerOrganization } from "../organization-registration/registration.service.js";
import { createUser } from "../organization-registration/user.repository.js";
import { createSession } from "../auth/sessions/session.repository.js";
import { generateSessionToken, hashSessionToken } from "../auth/sessions/session-token.js";
import { SESSION_ABSOLUTE_LIFETIME_MS } from "../auth/auth.constants.js";
import * as teamRepository from "../teams/team.repository.js";
import { deactivateTeam } from "../teams/teams.service.js";
import * as agentRepository from "./agent.repository.js";
import { reassignAgentTeam } from "./agents.service.js";

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
    organizationName: "Agent assignment", organizationSlug: `assignment-${unique}`,
    adminName: "Organization admin", adminEmail: `${unique}@example.com`,
    adminPassword: "a sufficiently long password",
  });
  const general = await teamRepository.findGeneralTeam(db, organization.id);
  if (!general) throw new Error("Expected registered General team");
  const cookie = await sessionCookie(organization.id, admin.id);
  const csrf = await request(app).get("/auth/csrf").set("Cookie", cookie).expect(200);
  return {
    organizationId: organization.id, adminId: admin.id, generalId: general.id,
    cookie, csrf: csrf.body.csrfToken as string,
  };
}

let own: Awaited<ReturnType<typeof tenant>>;
let other: Awaited<ReturnType<typeof tenant>>;
let customerId: string;
let customerCookie: string;
let agentCookie: string;

beforeAll(async () => {
  own = await tenant();
  other = await tenant();
  customerId = (await createUser(db, {
    organizationId: own.organizationId, name: "Customer", email: `${randomUUID()}@example.com`,
    passwordHash: "test-only-hash", role: "CUSTOMER",
  })).id;
  customerCookie = await sessionCookie(own.organizationId, customerId);
  agentCookie = await sessionCookie(own.organizationId, (await agent()).id);
});

afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await db.destroy(); });

async function agent(inactive = false, owner = own) {
  return db.insertInto("users").values({
    organization_id: owner.organizationId, name: "Agent", email: `${randomUUID()}@example.com`,
    password_hash: "test-only-hash", role: "AGENT", team_id: owner.generalId,
    deactivated_at: inactive ? new Date() : null,
  }).returning("id").executeTakeFirstOrThrow();
}

function destination() {
  return teamRepository.createNormalTeam(db, own.organizationId, `Destination-${randomUUID()}`);
}

function move(agentId: string, teamId: string) {
  return request(app).put(`/agents/${agentId}/team`)
    .set("Cookie", own.cookie).set("X-CSRF-Token", own.csrf).send({ teamId });
}

function readUser(id: string, organizationId = own.organizationId) {
  return db.selectFrom("users")
    .select(["id", "name", "email", "role", "team_id", "deactivated_at", "created_at", "updated_at"])
    .where("organization_id", "=", organizationId).where("id", "=", id).executeTakeFirstOrThrow();
}

describe("agent team reassignment", () => {
  it("moves between active teams and General using the existing safe representation", async () => {
    const target = await agent();
    const first = await destination();
    const second = await destination();
    for (const team of [first, second, { id: own.generalId, name: "General", isGeneral: true, deactivatedAt: null }]) {
      const before = await readUser(target.id);
      const response = await move(target.id, team.id).expect(200);
      expect(response.body).toEqual({
        id: target.id, name: before.name, email: before.email,
        deactivatedAt: null, createdAt: before.created_at.toISOString(),
        team: { id: team.id, name: team.name, isGeneral: team.isGeneral, deactivatedAt: null },
      });
      expect((await request(app).get(`/agents/${target.id}`).set("Cookie", own.cookie).expect(200)).body)
        .toEqual(response.body);
      expect(await readUser(target.id)).toEqual({ ...before, team_id: team.id, updated_at: expect.any(Date) });
    }
  });

  it("moves an inactive agent without reactivating it", async () => {
    const target = await agent(true);
    const team = await destination();
    const before = await readUser(target.id);
    const response = await move(target.id, team.id).expect(200);
    expect(response.body.deactivatedAt).toBe(before.deactivated_at!.toISOString());
    expect(await readUser(target.id)).toEqual({ ...before, team_id: team.id, updated_at: expect.any(Date) });
  });

  it("preserves the full user state and timestamp for same-team requests", async () => {
    const target = await agent();
    const before = await readUser(target.id);
    const first = await move(target.id, own.generalId).expect(200);
    expect((await move(target.id, own.generalId).expect(200)).body).toEqual(first.body);
    expect(await readUser(target.id)).toEqual(before);
  });

  it("rejects an inactive destination without changing either resource", async () => {
    const target = await agent();
    const team = await destination();
    await deactivateTeam(own.organizationId, team.id);
    const before = await readUser(target.id);
    const response = await move(target.id, team.id).expect(409);
    expect(response.body).toEqual({ error: "Cannot assign an agent to a deactivated team" });
    expect(await readUser(target.id)).toEqual(before);
    expect((await teamRepository.findTeam(db, own.organizationId, team.id))!.deactivatedAt).toBeInstanceOf(Date);
  });

  it("returns 404 for unknown, foreign and non-AGENT targets without changing them", async () => {
    const foreign = await agent(false, other);
    const before = await readUser(foreign.id, other.organizationId);
    for (const id of [randomUUID(), foreign.id, own.adminId, customerId]) {
      expect((await move(id, own.generalId).expect(404)).body).toEqual({ error: "Agent not found" });
    }
    expect(await readUser(foreign.id, other.organizationId)).toEqual(before);
  });

  it("returns the same 404 for foreign and unknown destination teams", async () => {
    const target = await agent();
    const before = await readUser(target.id);
    for (const teamId of [randomUUID(), other.generalId]) {
      expect((await move(target.id, teamId).expect(404)).body).toEqual({ error: "Team not found" });
    }
    expect(await readUser(target.id)).toEqual(before);
  });

  it("requires authentication, organization-admin authorization and session-bound CSRF before validation", async () => {
    const path = "/agents/not-a-uuid/team";
    expect((await request(app).put(path).expect(401)).body).toEqual({ error: "Authentication required" });
    for (const cookie of [agentCookie, customerCookie]) {
      expect((await request(app).put(path).set("Cookie", cookie).expect(403)).body)
        .toEqual({ error: "Request forbidden" });
    }
    for (const token of [undefined, "invalid", other.csrf]) {
      const operation = request(app).put(path).set("Cookie", own.cookie);
      if (token) operation.set("X-CSRF-Token", token);
      expect((await operation.expect(403)).body).toEqual({ error: "Invalid CSRF token" });
    }
  });

  it("validates both UUIDs and rejects extra body fields", async () => {
    expect((await move("not-a-uuid", own.generalId).expect(400)).body.error).toBe("Invalid agent ID");
    const target = await agent();
    for (const body of [{}, { teamId: "not-a-uuid" }, { teamId: own.generalId, organizationId: other.organizationId },
      { teamId: own.generalId, role: "CUSTOMER" }]) {
      const response = await request(app).put(`/agents/${target.id}/team`).set("Cookie", own.cookie)
        .set("X-CSRF-Token", own.csrf).send(body).expect(400);
      expect(response.body.error).toBe("Invalid agent team data");
    }
  });

  it("rolls back the assignment if the resulting representation cannot be read", async () => {
    const target = await agent();
    const team = await destination();
    const before = await readUser(target.id);
    const failure = new Error("Test-only readback failure");
    vi.spyOn(agentRepository, "findAgent").mockImplementationOnce(async (executor, organizationId, agentId) => {
      expect(executor.isTransaction).toBe(true);
      const changed = await executor.selectFrom("users").select("team_id")
        .where("organization_id", "=", organizationId).where("id", "=", agentId).executeTakeFirstOrThrow();
      expect(changed.team_id).toBe(team.id);
      throw failure;
    });
    await expect(reassignAgentTeam(own.organizationId, target.id, team.id)).rejects.toBe(failure);
    expect(await readUser(target.id)).toEqual(before);
  });

  it("holds the destination share lock until commit, then deactivation moves the assigned agent to General", async () => {
    const target = await agent();
    const team = await destination();
    const update = agentRepository.updateAgentTeam;
    let deactivation: ReturnType<typeof deactivateTeam> | undefined;
    vi.spyOn(agentRepository, "updateAgentTeam").mockImplementationOnce(async (executor, organizationId, agentId, teamId) => {
      expect(executor.isTransaction).toBe(true);
      deactivation = deactivateTeam(organizationId, teamId);
      await vi.waitFor(async () => {
        const result = await sql<{ waiting: string }>`
          SELECT count(*) AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND usename = current_user
            AND wait_event_type = 'Lock'
            AND query LIKE '%teams%' AND query LIKE '%for update%'
        `.execute(db);
        expect(Number(result.rows[0]!.waiting)).toBe(1);
      }, { timeout: 5000, interval: 20 });
      return update(executor, organizationId, agentId, teamId);
    });
    try {
      const assigned = await reassignAgentTeam(own.organizationId, target.id, team.id);
      expect(assigned.team.id).toBe(team.id);
      await deactivation;
      expect((await readUser(target.id)).team_id).toBe(own.generalId);
      expect((await teamRepository.findTeam(db, own.organizationId, team.id))!.deactivatedAt).toBeInstanceOf(Date);
    } finally {
      if (deactivation) await Promise.allSettled([deactivation]);
    }
  }, 10_000);

  it("rechecks destination state after waiting for deactivation to commit", async () => {
    const target = await agent();
    const team = await destination();
    const before = await readUser(target.id);
    const mark = teamRepository.markTeamDeactivated;
    let assignment: Promise<unknown> | undefined;
    vi.spyOn(teamRepository, "markTeamDeactivated").mockImplementationOnce(async (executor, organizationId, teamId) => {
      const deactivated = await mark(executor, organizationId, teamId);
      assignment = reassignAgentTeam(organizationId, target.id, teamId)
        .then((value) => ({ value }), (error: unknown) => ({ error }));
      await vi.waitFor(async () => {
        const result = await sql<{ waiting: string }>`
          SELECT count(*) AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND usename = current_user
            AND wait_event_type = 'Lock'
            AND query LIKE '%teams%' AND query LIKE '%for share%'
        `.execute(db);
        expect(Number(result.rows[0]!.waiting)).toBe(1);
      }, { timeout: 5000, interval: 20 });
      return deactivated;
    });
    try {
      await deactivateTeam(own.organizationId, team.id);
      expect(await assignment).toMatchObject({ error: {
        statusCode: 409, message: "Cannot assign an agent to a deactivated team",
      } });
      expect(await readUser(target.id)).toEqual(before);
    } finally {
      if (assignment) await assignment;
    }
  }, 10_000);
});
