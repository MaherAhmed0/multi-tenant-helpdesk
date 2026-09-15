import { randomUUID } from "node:crypto";

import { sql, type Insertable } from "kysely";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { app } from "../app.js";
import { db } from "../database/db.js";
import type { TenantRole, TicketsTable } from "../database/types.js";
import { createOrganization } from "../organization-registration/organization.repository.js";
import { createUser } from "../organization-registration/user.repository.js";
import { createGeneralTeam, createNormalTeam } from "../teams/team.repository.js";
import { deactivateTeam, reactivateTeam } from "../teams/teams.service.js";
import { deactivateAgent, reactivateAgent, reassignAgentTeam } from "../agents/agents.service.js";
import { deactivateTenantUser } from "../system-admin/tenant-users/tenant-users.service.js";
import { createSession } from "../auth/sessions/session.repository.js";
import { generateSessionToken, hashSessionToken } from "../auth/sessions/session-token.js";
import * as assignments from "./ticket-assignment.repository.js";
import * as staffTickets from "./staff-ticket.repository.js";

async function tenant() {
  const organization = await createOrganization(db, { name: "Assignment tenant", slug: `assignments-${randomUUID()}` });
  const team = await createGeneralTeam(db, organization.id);
  return { id: organization.id, team };
}

async function principal(owner: Awaited<ReturnType<typeof tenant>>, role: TenantRole, teamId = owner.team.id) {
  const user = await createUser(db, {
    organizationId: owner.id, role, name: "Assignment actor", email: `${randomUUID()}@example.com`,
    passwordHash: "test-only-hash", teamId: role === "AGENT" ? teamId : null,
  });
  const token = generateSessionToken();
  const session = await createSession(db, {
    organizationId: owner.id, userId: user.id, tokenHash: hashSessionToken(token), userAgent: null,
    absoluteExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  const cookie = `session=${token}`;
  const csrf = await request(app).get("/auth/csrf").set("Cookie", cookie).expect(200);
  return { ...user, cookie, csrf: csrf.body.csrfToken as string, sessionId: session.id };
}

let own: Awaited<ReturnType<typeof tenant>>;
let other: typeof own;
let agent: Awaited<ReturnType<typeof principal>>;
let colleague: typeof agent;
let customer: typeof agent;
let admin: typeof agent;
let foreignCustomer: typeof agent;
let foreignAgent: typeof agent;

beforeAll(async () => {
  own = await tenant();
  other = await tenant();
  agent = await principal(own, "AGENT");
  colleague = await principal(own, "AGENT");
  customer = await principal(own, "CUSTOMER");
  admin = await principal(own, "ORGANIZATION_ADMIN");
  foreignCustomer = await principal(other, "CUSTOMER");
  foreignAgent = await principal(other, "AGENT");
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await db.destroy(); });

function seedTicket(overrides: Partial<Insertable<TicketsTable>> = {}) {
  return db.insertInto("tickets").values({
    organization_id: own.id, customer_id: customer.id, subject: "Claimable ticket", priority: "HIGH",
    created_at: new Date("2026-01-01T00:00:00Z"), updated_at: new Date("2026-01-01T00:00:00Z"), ...overrides,
  }).returningAll().executeTakeFirstOrThrow();
}
function ticketState(id: string) {
  return db.selectFrom("tickets").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
}
function userState(id: string) {
  return db.selectFrom("users").select(["team_id", "deactivated_at", "updated_at"])
    .where("organization_id", "=", own.id).where("id", "=", id).executeTakeFirstOrThrow();
}
function claim(id: string, actor = agent) {
  return request(app).post(`/tickets/${id}/claim`).set("Cookie", actor.cookie).set("X-CSRF-Token", actor.csrf);
}
function release(id: string, actor = agent) {
  return request(app).post(`/tickets/${id}/release`).set("Cookie", actor.cookie).set("X-CSRF-Token", actor.csrf);
}
function assign(id: string, body: { teamId: string | null; agentId: string | null }, actor = admin) {
  return request(app).put(`/tickets/${id}/assignment`).set("Cookie", actor.cookie).set("X-CSRF-Token", actor.csrf).send(body);
}
async function freshAgent() {
  const team = await createNormalTeam(db, own.id, `Team ${randomUUID()}`);
  return { team, actor: await principal(own, "AGENT", team.id) };
}
async function foreignTicket() {
  return seedTicket({ organization_id: other.id, customer_id: foreignCustomer.id,
    assigned_team_id: other.team.id, assigned_agent_id: foreignAgent.id });
}

describe("agent ticket claiming", () => {
  it.each(["OPEN", "IN_PROGRESS"] as const)("claims unassigned %s without changing workflow or priority", async (status) => {
    const ticket = await seedTicket({ status });
    const result = await claim(ticket.id).expect(200);
    expect(result.body).toEqual({
      id: ticket.id, subject: ticket.subject, status, priority: "HIGH", closedAt: null,
      createdAt: ticket.created_at.toISOString(), updatedAt: expect.any(String),
      customer: { name: customer.name }, assignedTeam: null, assignedAgent: { id: agent.id, name: agent.name },
    });
    expect(await ticketState(ticket.id)).toEqual({ ...ticket, assigned_agent_id: agent.id, updated_at: expect.any(Date) });
    expect(new Date(result.body.updatedAt).getTime()).toBeGreaterThan(ticket.updated_at.getTime());
    await request(app).get(`/tickets/${ticket.id}`).set("Cookie", agent.cookie).expect(200);
    await claim(ticket.id).expect(409);
  });

  it("claims its current team's ticket and preserves that team", async () => {
    const ticket = await seedTicket({ assigned_team_id: own.team.id });
    expect((await claim(ticket.id).expect(200)).body.assignedTeam).toEqual({ id: own.team.id, name: "General" });
    expect((await ticketState(ticket.id)).assigned_team_id).toBe(own.team.id);
  });

  it("hides inaccessible tickets and conflicts on visible non-claimable tickets", async () => {
    const team = await createNormalTeam(db, own.id, `Other ${randomUUID()}`);
    const hidden = [
      await seedTicket({ assigned_team_id: team.id }),
      await seedTicket({ assigned_agent_id: colleague.id }),
      await seedTicket({ voided_at: new Date(), voided_by_user_id: admin.id, void_reason: "SPAM" }),
      await foreignTicket(),
    ];
    for (const ticket of hidden) {
      expect((await claim(ticket.id).expect(404)).body).toEqual({ error: "Ticket not found" });
      expect(await ticketState(ticket.id)).toEqual(ticket);
    }
    const visible = [
      await seedTicket({ assigned_team_id: own.team.id, assigned_agent_id: colleague.id }),
      await seedTicket({ status: "RESOLVED" }),
      await seedTicket({ status: "CLOSED", closed_at: new Date() }),
    ];
    for (const ticket of visible) {
      expect((await claim(ticket.id).expect(409)).body).toEqual({ error: "Ticket is not claimable" });
      expect(await ticketState(ticket.id)).toEqual(ticket);
    }
    await claim(randomUUID()).expect(404);
  });

  it("enforces AGENT authentication, session CSRF and strict input", async () => {
    const ticket = await seedTicket();
    await request(app).post(`/tickets/${ticket.id}/claim`).expect(401);
    for (const actor of [customer, admin]) await claim(ticket.id, actor).expect(403);
    await request(app).post(`/tickets/${ticket.id}/claim`).set("Cookie", agent.cookie).expect(403);
    await request(app).post(`/tickets/${ticket.id}/claim`).set("Cookie", agent.cookie).set("X-CSRF-Token", "invalid").expect(403);
    await request(app).post(`/tickets/${ticket.id}/claim`).set("Cookie", agent.cookie).set("X-CSRF-Token", colleague.csrf).expect(403);
    for (const body of [{ agentId: colleague.id }, { organizationId: other.id }, { teamId: own.team.id }, { status: "IN_PROGRESS" }]) {
      await claim(ticket.id).send(body).expect(400);
    }
    await claim("not-a-uuid").expect(400);
    expect(await ticketState(ticket.id)).toEqual(ticket);
  });

  it("makes the conditional UPDATE authoritative after both visibility reads succeed", async () => {
    const ticket = await seedTicket();
    const original = staffTickets.findAgentTicketById;
    let arrived = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(staffTickets, "findAgentTicketById").mockImplementation(async (...args) => {
      const row = await original(...args);
      if (++arrived === 2) release();
      await bothRead;
      return row;
    });
    const results = await Promise.all([claim(ticket.id, agent), claim(ticket.id, colleague)]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const winner = results.find((result) => result.status === 200)!;
    expect((await ticketState(ticket.id)).assigned_agent_id).toBe(winner.body.assignedAgent.id);
  });
});

describe("ticket cleanup within lifecycle transactions", () => {
  it("also clears assignments in the existing platform AGENT-deactivation transaction", async () => {
    const { actor, team } = await freshAgent();
    const ticket = await seedTicket({ assigned_team_id: team.id, assigned_agent_id: actor.id });
    await deactivateTenantUser(actor.id);
    expect(await ticketState(ticket.id)).toEqual({ ...ticket, assigned_agent_id: null, updated_at: expect.any(Date) });
    expect((await userState(actor.id)).deactivated_at).toBeInstanceOf(Date);
    await claim((await seedTicket()).id, actor).expect(401);
  });

  it("requires organization scope even when supplied real agent/team IDs from another tenant", async () => {
    const ticket = await seedTicket({ assigned_team_id: own.team.id, assigned_agent_id: agent.id });
    await assignments.clearAgentTicketAssignments(db, other.id, agent.id);
    await assignments.clearIncompatibleAgentTicketAssignments(db, other.id, agent.id, other.team.id);
    await assignments.clearTeamTicketAssignments(db, other.id, own.team.id);
    expect(await ticketState(ticket.id)).toEqual(ticket);
  });

  it("deactivation clears all individual assignments, retains teams and is not undone by reactivation", async () => {
    const { actor, team } = await freshAgent();
    const tickets = [await seedTicket({ assigned_agent_id: actor.id }),
      await seedTicket({ assigned_agent_id: actor.id, assigned_team_id: team.id }),
      await seedTicket({ assigned_agent_id: actor.id, status: "CLOSED", closed_at: new Date(),
        voided_at: new Date(), voided_by_user_id: admin.id, void_reason: "SPAM" })];
    const untouched = [await seedTicket({ assigned_agent_id: colleague.id }), await foreignTicket()];
    await deactivateAgent(own.id, actor.id);
    await deactivateAgent(own.id, actor.id);
    for (const ticket of tickets) expect(await ticketState(ticket.id)).toEqual({ ...ticket, assigned_agent_id: null, updated_at: expect.any(Date) });
    for (const ticket of untouched) expect(await ticketState(ticket.id)).toEqual(ticket);
    expect(await userState(actor.id)).toMatchObject({ deactivated_at: expect.any(Date), team_id: team.id });
    await request(app).get("/auth/me").set("Cookie", actor.cookie).expect(401);
    const cleared = await Promise.all(tickets.map((ticket) => ticketState(ticket.id)));
    await reactivateAgent(own.id, actor.id);
    expect(await Promise.all(tickets.map((ticket) => ticketState(ticket.id)))).toEqual(cleared);
  });

  it("team reassignment only clears individual assignments incompatible with the destination", async () => {
    const { actor, team } = await freshAgent();
    const destination = await createNormalTeam(db, own.id, `Destination ${randomUUID()}`);
    const old = await seedTicket({ assigned_team_id: team.id, assigned_agent_id: actor.id });
    const unchanged = [await seedTicket({ assigned_agent_id: actor.id }),
      await seedTicket({ assigned_team_id: destination.id, assigned_agent_id: actor.id }),
      await seedTicket({ assigned_team_id: team.id, assigned_agent_id: colleague.id }), await foreignTicket()];
    await reassignAgentTeam(own.id, actor.id, destination.id);
    expect((await userState(actor.id)).team_id).toBe(destination.id);
    expect(await ticketState(old.id)).toEqual({ ...old, assigned_agent_id: null, updated_at: expect.any(Date) });
    for (const ticket of unchanged) expect(await ticketState(ticket.id)).toEqual(ticket);
  });

  it("team deactivation clears team assignments, preserves only active agents and does not restore assignments", async () => {
    const { actor, team } = await freshAgent();
    const inactive = await principal(own, "AGENT", team.id);
    await db.updateTable("users").set({ deactivated_at: new Date() }).where("id", "=", inactive.id).execute();
    const tickets = [await seedTicket({ assigned_team_id: team.id }),
      await seedTicket({ assigned_team_id: team.id, assigned_agent_id: actor.id }),
      await seedTicket({ assigned_team_id: team.id, assigned_agent_id: inactive.id })];
    const unchanged = [await seedTicket({ assigned_team_id: own.team.id, assigned_agent_id: colleague.id }), await foreignTicket()];
    await deactivateTeam(own.id, team.id);
    for (const ticket of tickets) expect(await ticketState(ticket.id)).toEqual({ ...ticket, assigned_team_id: null,
      assigned_agent_id: ticket.assigned_agent_id === actor.id ? actor.id : null, updated_at: expect.any(Date) });
    expect((await userState(actor.id)).team_id).toBe(own.team.id);
    for (const ticket of unchanged) expect(await ticketState(ticket.id)).toEqual(ticket);
    const cleared = await Promise.all(tickets.map((ticket) => ticketState(ticket.id)));
    await reactivateTeam(own.id, team.id);
    expect(await Promise.all(tickets.map((ticket) => ticketState(ticket.id)))).toEqual(cleared);
  });

  it.each(["deactivate", "reassign", "team"] as const)("rolls back %s and ticket cleanup together on failure", async (action) => {
    const { actor, team } = await freshAgent();
    const ticket = await seedTicket({ assigned_team_id: team.id, assigned_agent_id: actor.id });
    const before = await userState(actor.id);
    const failure = new Error("Test rollback after ticket cleanup");
    if (action === "deactivate") {
      const original = assignments.clearAgentTicketAssignments;
      vi.spyOn(assignments, "clearAgentTicketAssignments").mockImplementation(async (...args) => { await original(...args); throw failure; });
      await expect(deactivateAgent(own.id, actor.id)).rejects.toBe(failure);
    } else if (action === "reassign") {
      const original = assignments.clearIncompatibleAgentTicketAssignments;
      vi.spyOn(assignments, "clearIncompatibleAgentTicketAssignments").mockImplementation(async (...args) => { await original(...args); throw failure; });
      await expect(reassignAgentTeam(own.id, actor.id, own.team.id)).rejects.toBe(failure);
    } else {
      const original = assignments.clearTeamTicketAssignments;
      vi.spyOn(assignments, "clearTeamTicketAssignments").mockImplementation(async (...args) => { await original(...args); throw failure; });
      await expect(deactivateTeam(own.id, team.id)).rejects.toBe(failure);
    }
    expect(await ticketState(ticket.id)).toEqual(ticket);
    expect(await userState(actor.id)).toEqual(before);
    expect((await db.selectFrom("sessions").select("revoked_at").where("id", "=", actor.sessionId).executeTakeFirstOrThrow()).revoked_at).toBeNull();
    expect((await db.selectFrom("teams").select("deactivated_at").where("id", "=", team.id).executeTakeFirstOrThrow()).deactivated_at).toBeNull();
  });
});

describe("claim coordination with lifecycle user locks", () => {
  it.each(["deactivate", "reassign"] as const)("revalidates the claimant after waiting for %s", async (action) => {
    const { actor, team } = await freshAgent();
    const ticket = await seedTicket({ assigned_team_id: team.id });
    let pending: ReturnType<typeof assignments.attemptClaimTicket> | undefined;
    try {
      await db.transaction().execute(async (trx) => {
        await trx.updateTable("users").set(action === "deactivate" ? { deactivated_at: new Date() } : { team_id: own.team.id })
          .where("organization_id", "=", own.id).where("id", "=", actor.id).execute();
        pending = assignments.attemptClaimTicket(db, own.id, actor.id, ticket.id);
        void pending.catch(() => {});
        await vi.waitFor(async () => {
          const waiting = await sql<{ count: string }>`select count(*) from pg_stat_activity
            where datname = current_database() and usename = current_user and wait_event_type = 'Lock'
            and query like '%"claimant"%'`.execute(db);
          expect(Number(waiting.rows[0]!.count)).toBe(1);
        }, { timeout: 5000, interval: 20 });
      });
      expect(await pending).toBeUndefined();
      expect(await ticketState(ticket.id)).toEqual(ticket);
    } finally { await pending; }
  }, 10000);

  it.each(["deactivate", "reassign", "team"] as const)("cleans a winning claim when %s follows its user lock", async (action) => {
    const { actor, team } = await freshAgent();
    const ticket = await seedTicket({ assigned_team_id: team.id });
    let pending: Promise<unknown> | undefined;
    try {
      await db.transaction().execute(async (trx) => {
        expect(await assignments.attemptClaimTicket(trx, own.id, actor.id, ticket.id)).toBeDefined();
        pending = action === "deactivate" ? deactivateAgent(own.id, actor.id)
          : action === "reassign" ? reassignAgentTeam(own.id, actor.id, own.team.id) : deactivateTeam(own.id, team.id);
        void pending.catch(() => {});
        await vi.waitFor(async () => {
          const waiting = await sql<{ count: string }>`select count(*) from pg_stat_activity
            where datname = current_database() and usename = current_user and wait_event_type = 'Lock'
            and query like '%"users"%'`.execute(db);
          expect(Number(waiting.rows[0]!.count)).toBe(1);
        }, { timeout: 5000, interval: 20 });
      });
      await pending;
      expect(await ticketState(ticket.id)).toMatchObject({
        assigned_team_id: action === "team" ? null : team.id,
        assigned_agent_id: action === "team" ? actor.id : null,
      });
    } finally { await pending; }
  }, 10000);
});

describe("agent self-release", () => {
  it.each([false, true])("releases only the individual assignment (team retained=%s)", async (hasTeam) => {
    const ticket = await seedTicket({ assigned_agent_id: agent.id, assigned_team_id: hasTeam ? own.team.id : null,
      status: hasTeam ? "IN_PROGRESS" : "OPEN" });
    const result = await release(ticket.id).expect(200);
    expect(result.body).toEqual({
      id: ticket.id, subject: ticket.subject, status: ticket.status, priority: "HIGH", closedAt: null,
      createdAt: ticket.created_at.toISOString(), updatedAt: expect.any(String), customer: { name: customer.name },
      assignedAgent: null, assignedTeam: hasTeam ? { id: own.team.id, name: "General" } : null,
    });
    expect(await ticketState(ticket.id)).toEqual({ ...ticket, assigned_agent_id: null, updated_at: expect.any(Date) });
    expect(new Date(result.body.updatedAt).getTime()).toBeGreaterThan(ticket.updated_at.getTime());
    await release(ticket.id).expect(409);
  });

  it("conceals inaccessible tickets and refuses visible assignments it cannot release", async () => {
    const hidden = [await seedTicket({ assigned_agent_id: colleague.id }), await foreignTicket(),
      await seedTicket({ assigned_agent_id: agent.id, voided_at: new Date(), voided_by_user_id: admin.id, void_reason: "SPAM" })];
    for (const ticket of hidden) {
      expect((await release(ticket.id).expect(404)).body).toEqual({ error: "Ticket not found" });
      expect(await ticketState(ticket.id)).toEqual(ticket);
    }
    const visible = [await seedTicket({ assigned_team_id: own.team.id, assigned_agent_id: colleague.id }),
      await seedTicket({ assigned_agent_id: agent.id, status: "RESOLVED" }),
      await seedTicket({ assigned_agent_id: agent.id, status: "CLOSED", closed_at: new Date() })];
    for (const ticket of visible) {
      expect((await release(ticket.id).expect(409)).body).toEqual({ error: "Ticket is not releasable" });
      expect(await ticketState(ticket.id)).toEqual(ticket);
    }
  });

  it("requires AGENT authentication, CSRF, UUID params and an empty body", async () => {
    const ticket = await seedTicket({ assigned_agent_id: agent.id });
    await request(app).post(`/tickets/${ticket.id}/release`).expect(401);
    for (const actor of [customer, admin]) await release(ticket.id, actor).expect(403);
    await request(app).post(`/tickets/${ticket.id}/release`).set("Cookie", agent.cookie).expect(403);
    await request(app).post(`/tickets/${ticket.id}/release`).set("Cookie", agent.cookie).set("X-CSRF-Token", "invalid").expect(403);
    for (const body of [{ agentId: agent.id }, { teamId: null }, { organizationId: own.id }, { status: "OPEN" }]) {
      await release(ticket.id).send(body).expect(400);
    }
    await release("invalid").expect(400);
    expect(await ticketState(ticket.id)).toEqual(ticket);
  });

  it("does not clear a newer assignment after waiting on a concurrent ticket UPDATE", async () => {
    const ticket = await seedTicket({ assigned_team_id: own.team.id, assigned_agent_id: agent.id });
    let pending: Promise<request.Response> | undefined;
    try {
      await db.transaction().execute(async (trx) => {
        await assignments.replaceTicketAssignment(trx, own.id, ticket.id, { teamId: own.team.id, agentId: colleague.id });
        pending = release(ticket.id).then((response) => response);
        void pending.catch(() => {});
        await vi.waitFor(async () => {
          const waiting = await sql<{ count: string }>`select count(*) from pg_stat_activity
            where datname = current_database() and usename = current_user and wait_event_type = 'Lock'
            and query like 'update "tickets"%'`.execute(db);
          expect(Number(waiting.rows[0]!.count)).toBe(1);
        }, { timeout: 5000, interval: 20 });
      });
      expect((await pending)!.status).toBe(409);
      expect(await ticketState(ticket.id)).toMatchObject({ assigned_team_id: own.team.id, assigned_agent_id: colleague.id });
    } finally { await pending; }
  }, 10000);
});

describe("organization-admin assignment replacement", () => {
  it("replaces the complete state with team-only, agent-only, both, or neither", async () => {
    const ticket = await seedTicket({ status: "IN_PROGRESS", assigned_agent_id: colleague.id });
    for (const desired of [
      { teamId: own.team.id, agentId: null }, { teamId: null, agentId: agent.id },
      { teamId: own.team.id, agentId: agent.id }, { teamId: null, agentId: null },
    ]) {
      const result = await assign(ticket.id, desired).expect(200);
      expect(result.body).toEqual({
        id: ticket.id, subject: ticket.subject, status: "IN_PROGRESS", priority: "HIGH", closedAt: null,
        createdAt: ticket.created_at.toISOString(), updatedAt: expect.any(String), customer: { name: customer.name },
        assignedTeam: desired.teamId ? { id: own.team.id, name: "General" } : null,
        assignedAgent: desired.agentId ? { id: agent.id, name: agent.name } : null,
      });
      expect(await ticketState(ticket.id)).toEqual({ ...ticket, assigned_team_id: desired.teamId,
        assigned_agent_id: desired.agentId, updated_at: expect.any(Date) });
    }
  });

  it("rejects inactive, foreign, nonexistent, non-AGENT, and mismatched targets", async () => {
    const ticket = await seedTicket();
    const { actor, team } = await freshAgent();
    await deactivateAgent(own.id, actor.id);
    await deactivateTeam(own.id, team.id);
    const cases = [
      { teamId: team.id, agentId: null, status: 409 },
      { teamId: null, agentId: actor.id, status: 409 },
      { teamId: other.team.id, agentId: null, status: 404 },
      { teamId: null, agentId: foreignAgent.id, status: 404 },
      { teamId: randomUUID(), agentId: null, status: 404 },
      { teamId: null, agentId: randomUUID(), status: 404 },
      { teamId: null, agentId: customer.id, status: 404 },
      { teamId: null, agentId: admin.id, status: 404 },
      { teamId: (await createNormalTeam(db, own.id, `Mismatch ${randomUUID()}`)).id, agentId: agent.id, status: 409 },
    ];
    for (const { status, ...desired } of cases) {
      await assign(ticket.id, desired).expect(status);
      expect(await ticketState(ticket.id)).toEqual(ticket);
    }
  });

  it("hides foreign/voided tickets and refuses resolved/closed tickets", async () => {
    for (const ticket of [await foreignTicket(),
      await seedTicket({ voided_at: new Date(), voided_by_user_id: admin.id, void_reason: "SPAM" })]) {
      expect((await assign(ticket.id, { teamId: null, agentId: null }).expect(404)).body).toEqual({ error: "Ticket not found" });
      expect(await ticketState(ticket.id)).toEqual(ticket);
    }
    for (const status of ["RESOLVED", "CLOSED"] as const) {
      const ticket = await seedTicket({ status, closed_at: status === "CLOSED" ? new Date() : null });
      await assign(ticket.id, { teamId: null, agentId: agent.id }).expect(409);
      expect(await ticketState(ticket.id)).toEqual(ticket);
    }
  });

  it("requires organization-admin authentication, CSRF and both strict assignment fields", async () => {
    const ticket = await seedTicket();
    const desired = { teamId: null, agentId: null };
    await request(app).put(`/tickets/${ticket.id}/assignment`).send(desired).expect(401);
    for (const actor of [agent, customer]) await assign(ticket.id, desired, actor).expect(403);
    await request(app).put(`/tickets/${ticket.id}/assignment`).set("Cookie", admin.cookie).send(desired).expect(403);
    await request(app).put(`/tickets/${ticket.id}/assignment`).set("Cookie", admin.cookie).set("X-CSRF-Token", agent.csrf).send(desired).expect(403);
    for (const body of [{}, { teamId: null }, { agentId: null }, { ...desired, status: "OPEN" },
      { ...desired, organizationId: own.id }, { ...desired, agentId: "invalid" }, { ...desired, teamId: "invalid" }]) {
      await request(app).put(`/tickets/${ticket.id}/assignment`).set("Cookie", admin.cookie).set("X-CSRF-Token", admin.csrf).send(body).expect(400);
    }
    await assign("invalid", desired).expect(400);
    expect(await ticketState(ticket.id)).toEqual(ticket);
  });

  it("rechecks workflow eligibility in the UPDATE after an earlier visible read", async () => {
    const ticket = await seedTicket();
    const original = staffTickets.findOrganizationTicketById;
    vi.spyOn(staffTickets, "findOrganizationTicketById").mockImplementationOnce(async (...args) => {
      const row = await original(...args);
      await db.updateTable("tickets").set({ status: "CLOSED", closed_at: new Date() }).where("id", "=", ticket.id).execute();
      return row;
    });
    await assign(ticket.id, { teamId: own.team.id, agentId: agent.id }).expect(409);
    expect(await ticketState(ticket.id)).toMatchObject({ status: "CLOSED", assigned_agent_id: null, assigned_team_id: null });
  });

  it.each(["deactivate", "reassign", "team"] as const)("holds validation locks until commit before racing %s cleanup", async (action) => {
    const { actor, team } = await freshAgent();
    const ticket = await seedTicket();
    let unlock!: () => void;
    let reached!: () => void;
    const hold = new Promise<void>((resolve) => { unlock = resolve; });
    const locked = new Promise<void>((resolve) => { reached = resolve; });
    const original = assignments.replaceTicketAssignment;
    vi.spyOn(assignments, "replaceTicketAssignment").mockImplementationOnce(async (...args) => {
      reached();
      await hold;
      return original(...args);
    });
    const pendingAssignment = assign(ticket.id, { teamId: team.id, agentId: actor.id }).then((response) => response);
    let lifecycle: Promise<unknown> | undefined;
    try {
      await locked;
      lifecycle = action === "deactivate" ? deactivateAgent(own.id, actor.id)
        : action === "reassign" ? reassignAgentTeam(own.id, actor.id, own.team.id) : deactivateTeam(own.id, team.id);
      void lifecycle.catch(() => {});
      await vi.waitFor(async () => {
        const waiting = await sql<{ count: string }>`select count(*) from pg_stat_activity
          where datname = current_database() and usename = current_user and wait_event_type = 'Lock'`.execute(db);
        expect(Number(waiting.rows[0]!.count)).toBe(1);
      }, { timeout: 5000, interval: 20 });
      unlock();
      expect((await pendingAssignment).status).toBe(200);
      await lifecycle;
      expect(await ticketState(ticket.id)).toMatchObject({
        assigned_team_id: action === "team" ? null : team.id,
        assigned_agent_id: action === "team" ? actor.id : null,
      });
    } finally { unlock(); await Promise.allSettled([pendingAssignment, lifecycle]); }
  }, 10000);

  it.each(["deactivate", "reassign", "team"] as const)("revalidates target state when %s wins the row lock first", async (action) => {
    const { actor, team } = await freshAgent();
    const ticket = await seedTicket();
    let pending: Promise<request.Response> | undefined;
    try {
      await db.transaction().execute(async (trx) => {
        if (action === "team") {
          await trx.updateTable("teams").set({ deactivated_at: new Date() }).where("id", "=", team.id).execute();
        } else {
          await trx.updateTable("users").set(action === "deactivate" ? { deactivated_at: new Date() } : { team_id: own.team.id })
            .where("id", "=", actor.id).execute();
        }
        pending = assign(ticket.id, { teamId: team.id, agentId: actor.id }).then((response) => response);
        void pending.catch(() => {});
        await vi.waitFor(async () => {
          const waiting = await sql<{ count: string }>`select count(*) from pg_stat_activity
            where datname = current_database() and usename = current_user and wait_event_type = 'Lock'
            and query like '%for share%'`.execute(db);
          expect(Number(waiting.rows[0]!.count)).toBe(1);
        }, { timeout: 5000, interval: 20 });
      });
      expect((await pending)!.status).toBe(409);
      expect(await ticketState(ticket.id)).toEqual(ticket);
    } finally { await pending; }
  }, 10000);
});
