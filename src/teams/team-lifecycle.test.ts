import { randomUUID } from "node:crypto";

import { sql } from "kysely";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { app } from "../app.js";
import { db } from "../database/db.js";
import { createOrganization } from "../organization-registration/organization.repository.js";
import { registerOrganization } from "../organization-registration/registration.service.js";
import { createUser } from "../organization-registration/user.repository.js";
import { createSession } from "../auth/sessions/session.repository.js";
import { generateSessionToken, hashSessionToken } from "../auth/sessions/session-token.js";
import { SESSION_ABSOLUTE_LIFETIME_MS } from "../auth/auth.constants.js";
import * as teamRepository from "./team.repository.js";
import * as agentRepository from "./team-agent.repository.js";
import { deactivateTeam } from "./teams.service.js";

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
    organizationName: "Team lifecycle", organizationSlug: `lifecycle-${unique}`,
    adminName: "Team admin", adminEmail: `${unique}@example.com`,
    adminPassword: "a sufficiently long password",
  });
  const general = await teamRepository.findGeneralTeam(db, organization.id);
  if (!general) throw new Error("Expected registered General team");
  const cookie = await sessionCookie(organization.id, admin.id);
  const csrf = await request(app).get("/auth/csrf").set("Cookie", cookie).expect(200);
  return { organizationId: organization.id, generalId: general.id, cookie, csrf: csrf.body.csrfToken as string };
}

let own: Awaited<ReturnType<typeof tenant>>;
let other: Awaited<ReturnType<typeof tenant>>;
const roleCookies: string[] = [];

beforeAll(async () => {
  own = await tenant();
  other = await tenant();
  for (const role of ["AGENT", "CUSTOMER"] as const) {
    const user = await createUser(db, {
      organizationId: own.organizationId, name: role, email: `${randomUUID()}@example.com`,
      passwordHash: "test-only-hash", role, teamId: role === "AGENT" ? own.generalId : null,
    });
    roleCookies.push(await sessionCookie(own.organizationId, user.id));
  }
  await createUser(db, {
    organizationId: other.organizationId, name: "Foreign agent", email: `${randomUUID()}@example.com`,
    passwordHash: "test-only-hash", role: "AGENT", teamId: other.generalId,
  });
});

afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await db.destroy(); });

async function teamWithAgents() {
  const team = await teamRepository.createNormalTeam(db, own.organizationId, `Team-${randomUUID()}`);
  const users = [];
  for (const inactive of [false, false, true]) {
    const user = await db.insertInto("users").values({
      organization_id: own.organizationId, name: "Assigned agent", email: `${randomUUID()}@example.com`,
      password_hash: "test-only-hash", role: "AGENT", team_id: team.id,
      deactivated_at: inactive ? new Date() : null,
    }).returning("id").executeTakeFirstOrThrow();
    users.push(user.id);
  }
  return { team, activeIds: users.slice(0, 2), inactiveId: users[2]! };
}

async function readState(organizationId: string) {
  const teams = await db.selectFrom("teams").selectAll()
    .where("organization_id", "=", organizationId).orderBy("id").execute();
  const users = await db.selectFrom("users").select(["id", "team_id", "role", "deactivated_at", "updated_at"])
    .where("organization_id", "=", organizationId).orderBy("id").execute();
  return { teams, users };
}

function act(teamId: string, action: "deactivate" | "reactivate") {
  return request(app).post(`/teams/${teamId}/${action}`)
    .set("Cookie", own.cookie).set("X-CSRF-Token", own.csrf).expect(200);
}

describe("team lifecycle", () => {
  it("moves only active agents from the target team and deactivates it atomically", async () => {
    const target = await teamWithAgents();
    const unrelated = await teamWithAgents();
    const before = await readState(own.organizationId);
    const foreignBefore = await readState(other.organizationId);
    const response = await act(target.team.id, "deactivate");
    expect(response.body).toEqual({
      ...target.team, createdAt: target.team.createdAt.toISOString(), deactivatedAt: expect.any(String),
    });
    const after = await readState(own.organizationId);
    expect(after.users).toEqual(before.users.map((user) => target.activeIds.includes(user.id)
      ? { ...user, team_id: own.generalId, updated_at: expect.any(Date) } : user));
    expect(after.teams).toEqual(before.teams.map((team) => team.id === target.team.id
      ? { ...team, deactivated_at: new Date(response.body.deactivatedAt) } : team));
    expect(after.users.find((user) => user.id === target.inactiveId)?.team_id).toBe(target.team.id);
    expect(after.users.find((user) => user.id === unrelated.activeIds[0])?.team_id).toBe(unrelated.team.id);
    expect(await readState(other.organizationId)).toEqual(foreignBefore);
  });

  it("does no further movement or timestamp changes for an already-deactivated team", async () => {
    const target = await teamWithAgents();
    const first = await act(target.team.id, "deactivate");
    const move = vi.spyOn(agentRepository, "moveActiveTeamAgents");
    const before = await readState(own.organizationId);
    const repeated = await act(target.team.id, "deactivate");
    expect(repeated.body).toEqual(first.body);
    expect(move).not.toHaveBeenCalled();
    expect(await readState(own.organizationId)).toEqual(before);
  });

  it("reactivates idempotently without restoring memberships", async () => {
    const target = await teamWithAgents();
    await act(target.team.id, "deactivate");
    const before = await readState(own.organizationId);
    const response = await act(target.team.id, "reactivate");
    expect(response.body).toEqual({ ...target.team, createdAt: target.team.createdAt.toISOString() });
    const after = await readState(own.organizationId);
    expect(after.users).toEqual(before.users);
    expect(after.teams).toEqual(before.teams.map((team) => team.id === target.team.id
      ? { ...team, deactivated_at: null } : team));
    expect((await act(target.team.id, "reactivate")).body).toEqual(response.body);
    expect(await readState(own.organizationId)).toEqual(after);
  });

  it("rejects General deactivation and returns its current state on reactivation", async () => {
    const before = await readState(own.organizationId);
    const response = await request(app).post(`/teams/${own.generalId}/deactivate`)
      .set("Cookie", own.cookie).set("X-CSRF-Token", own.csrf).expect(409);
    expect(response.body).toEqual({ error: "General team cannot be deactivated" });
    const general = await act(own.generalId, "reactivate");
    expect(general.body).toMatchObject({ id: own.generalId, isGeneral: true, deactivatedAt: null });
    expect(await readState(own.organizationId)).toEqual(before);
  });

  it.each(["deactivate", "reactivate"] as const)("enforces authentication, role, CSRF and params for %s", async (action) => {
    const path = `/teams/not-a-uuid/${action}`;
    const missing = await request(app).post(path).expect(401);
    expect(missing.body).toEqual({ error: "Authentication required" });
    for (const cookie of roleCookies) {
      const forbidden = await request(app).post(path).set("Cookie", cookie).expect(403);
      expect(forbidden.body).toEqual({ error: "Request forbidden" });
    }
    for (const token of [undefined, "invalid", other.csrf]) {
      const operation = request(app).post(path).set("Cookie", own.cookie);
      if (token) operation.set("X-CSRF-Token", token);
      expect((await operation.expect(403)).body).toEqual({ error: "Invalid CSRF token" });
    }
    const invalid = await request(app).post(path).set("Cookie", own.cookie)
      .set("X-CSRF-Token", own.csrf).expect(400);
    expect(invalid.body.error).toBe("Invalid team ID");
  });

  it.each(["deactivate", "reactivate"] as const)("returns the same 404 for unknown and foreign teams on %s", async (action) => {
    const foreign = await teamRepository.createNormalTeam(db, other.organizationId, `Foreign-${randomUUID()}`);
    const before = await readState(other.organizationId);
    for (const id of [randomUUID(), foreign.id, other.generalId]) {
      const response = await request(app).post(`/teams/${id}/${action}`)
        .set("Cookie", own.cookie).set("X-CSRF-Token", own.csrf)
        .query({ organizationId: other.organizationId }).send({ organizationId: other.organizationId }).expect(404);
      expect(response.body).toEqual({ error: "Team not found" });
    }
    expect(await readState(other.organizationId)).toEqual(before);
  });

  it("rolls back agent movement and team state if deactivation fails after movement", async () => {
    const target = await teamWithAgents();
    const before = await readState(own.organizationId);
    const mark = teamRepository.markTeamDeactivated;
    const failure = new Error("Test-only deactivation failure");
    vi.spyOn(teamRepository, "markTeamDeactivated").mockImplementationOnce(async (executor, organizationId, teamId) => {
      expect(executor.isTransaction).toBe(true);
      const moved = await executor.selectFrom("users").select("team_id")
        .where("organization_id", "=", organizationId).where("id", "in", target.activeIds).execute();
      expect(moved).toEqual(target.activeIds.map(() => ({ team_id: own.generalId })));
      await mark(executor, organizationId, teamId);
      throw failure;
    });
    await expect(deactivateTeam(own.organizationId, target.team.id)).rejects.toBe(failure);
    expect(await readState(own.organizationId)).toEqual(before);
  });

  it("fails without partial writes if the organization's General team is missing", async () => {
    const organization = await createOrganization(db, { name: "Missing General fixture", slug: `missing-${randomUUID()}` });
    const team = await teamRepository.createNormalTeam(db, organization.id, "Normal");
    await createUser(db, {
      organizationId: organization.id, name: "Agent", email: `${randomUUID()}@example.com`,
      passwordHash: "test-only-hash", role: "AGENT", teamId: team.id,
    });
    const before = await readState(organization.id);
    await expect(deactivateTeam(organization.id, team.id)).rejects.toThrow("Organization General team is missing");
    expect(await readState(organization.id)).toEqual(before);
  });

  it("rechecks after real row-lock waits so concurrent deactivations move agents only once", async () => {
    const target = await teamWithAgents();
    const move = vi.spyOn(agentRepository, "moveActiveTeamAgents");
    const attempts: ReturnType<typeof deactivateTeam>[] = [];
    try {
      await db.transaction().execute(async (trx) => {
        await trx.selectFrom("teams").select("id")
          .where("organization_id", "=", own.organizationId).where("id", "=", target.team.id)
          .forUpdate().execute();
        attempts.push(deactivateTeam(own.organizationId, target.team.id));
        attempts.push(deactivateTeam(own.organizationId, target.team.id));
        await vi.waitFor(async () => {
          const result = await sql<{ waiting: string }>`
            SELECT count(*) AS waiting FROM pg_stat_activity
            WHERE datname = current_database() AND usename = current_user
              AND wait_event_type = 'Lock'
              AND query LIKE '%teams%' AND query LIKE '%for update%'
          `.execute(db);
          expect(Number(result.rows[0]!.waiting)).toBe(2);
        }, { timeout: 5000, interval: 20 });
      });
      const [first, second] = await Promise.all(attempts);
      expect(first!.deactivatedAt).toBeInstanceOf(Date);
      expect(second).toEqual(first);
      expect(move).toHaveBeenCalledTimes(1);
      const state = await readState(own.organizationId);
      expect(state.users.filter((user) => target.activeIds.includes(user.id))
        .every((user) => user.team_id === own.generalId)).toBe(true);
    } finally {
      await Promise.allSettled(attempts);
    }
  }, 10_000);
});
