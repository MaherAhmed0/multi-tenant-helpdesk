import { randomUUID } from "node:crypto";

import { sql, type Insertable } from "kysely";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { app } from "../app.js";
import { db } from "../database/db.js";
import type { TenantRole, TicketsTable, TicketStatus } from "../database/types.js";
import { createOrganization } from "../organization-registration/organization.repository.js";
import { createUser } from "../organization-registration/user.repository.js";
import { createGeneralTeam, createNormalTeam } from "../teams/team.repository.js";
import { deactivateAgent, reassignAgentTeam } from "../agents/agents.service.js";
import { createSession } from "../auth/sessions/session.repository.js";
import { generateSessionToken, hashSessionToken } from "../auth/sessions/session-token.js";
import { updateTicketStatus } from "./tickets.service.js";
import * as transitions from "./ticket-status.repository.js";

async function tenant() {
  const organization = await createOrganization(db, { name: "Status tenant", slug: `status-${randomUUID()}` });
  return { id: organization.id, team: await createGeneralTeam(db, organization.id) };
}

async function principal(owner: Awaited<ReturnType<typeof tenant>>, role: TenantRole, teamId = owner.team.id) {
  const user = await createUser(db, { organizationId: owner.id, role, name: "Status actor", email: `${randomUUID()}@example.com`,
    passwordHash: "test-only-hash", teamId: role === "AGENT" ? teamId : null });
  const token = generateSessionToken();
  const session = await createSession(db, { organizationId: owner.id, userId: user.id, tokenHash: hashSessionToken(token),
    userAgent: null, absoluteExpiresAt: new Date(Date.now() + 3600000) });
  const cookie = `session=${token}`;
  const csrf = await request(app).get("/auth/csrf").set("Cookie", cookie).expect(200);
  return { ...user, cookie, csrf: csrf.body.csrfToken as string,
    auth: { organizationId: owner.id, userId: user.id, sessionId: session.id, role } };
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
  own = await tenant(); other = await tenant();
  agent = await principal(own, "AGENT"); colleague = await principal(own, "AGENT");
  customer = await principal(own, "CUSTOMER"); admin = await principal(own, "ORGANIZATION_ADMIN");
  foreignCustomer = await principal(other, "CUSTOMER"); foreignAgent = await principal(other, "AGENT");
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await db.destroy(); });

function seedTicket(overrides: Partial<Insertable<TicketsTable>> = {}) {
  return db.insertInto("tickets").values({ organization_id: own.id, customer_id: customer.id, subject: "Status ticket",
    priority: "HIGH", created_at: new Date("2026-01-01T00:00:00Z"), updated_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides }).returningAll().executeTakeFirstOrThrow();
}
function state(id: string) {
  return db.selectFrom("tickets").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
}
function change(id: string, status: TicketStatus, actor = admin) {
  return request(app).patch(`/tickets/${id}/status`).set("Cookie", actor.cookie).set("X-CSRF-Token", actor.csrf).send({ status });
}

const allowed: [TicketStatus, TicketStatus][] = [
  ["OPEN", "IN_PROGRESS"], ["OPEN", "RESOLVED"], ["OPEN", "CLOSED"],
  ["IN_PROGRESS", "OPEN"], ["IN_PROGRESS", "RESOLVED"], ["IN_PROGRESS", "CLOSED"],
  ["RESOLVED", "OPEN"], ["RESOLVED", "CLOSED"], ["CLOSED", "OPEN"],
];
const forbidden: [TicketStatus, TicketStatus][] = [
  ["OPEN", "OPEN"], ["IN_PROGRESS", "IN_PROGRESS"], ["RESOLVED", "RESOLVED"], ["CLOSED", "CLOSED"],
  ["RESOLVED", "IN_PROGRESS"], ["CLOSED", "IN_PROGRESS"], ["CLOSED", "RESOLVED"],
];

describe("staff status transition matrix", () => {
  it.each(allowed)("allows %s -> %s with consistent closed state and unchanged assignment", async (source, target) => {
    const ticket = await seedTicket({ status: source, closed_at: source === "CLOSED" ? new Date() : null,
      assigned_team_id: own.team.id, assigned_agent_id: agent.id });
    const result = await change(ticket.id, target).expect(200);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.body).toEqual({ id: ticket.id, subject: ticket.subject, status: target, priority: "HIGH",
      closedAt: target === "CLOSED" ? expect.any(String) : null,
      createdAt: ticket.created_at.toISOString(), updatedAt: expect.any(String),
      customer: { name: customer.name }, assignedTeam: { id: own.team.id, name: "General" },
      assignedAgent: { id: agent.id, name: agent.name } });
    expect(await state(ticket.id)).toEqual({ ...ticket, status: target,
      closed_at: target === "CLOSED" ? new Date(result.body.closedAt) : null, updated_at: new Date(result.body.updatedAt) });
    expect(new Date(result.body.updatedAt).getTime()).toBeGreaterThan(ticket.updated_at.getTime());
  });

  it.each(forbidden)("rejects %s -> %s without rewriting timestamps", async (source, target) => {
    const ticket = await seedTicket({ status: source, closed_at: source === "CLOSED" ? new Date() : null });
    expect((await change(ticket.id, target).expect(409)).body).toEqual({ error: "Ticket status cannot be changed" });
    expect(await state(ticket.id)).toEqual(ticket);
  });
});

describe("status mutation authorization", () => {
  it("separates AGENT mutation authority from visibility while admins can change all assignment shapes", async () => {
    const differentTeam = await createNormalTeam(db, own.id, `Other ${randomUUID()}`);
    const cases = [
      { assigned_agent_id: agent.id, assigned_team_id: null, expected: 200 },
      { assigned_agent_id: agent.id, assigned_team_id: own.team.id, expected: 200 },
      { assigned_agent_id: null, assigned_team_id: own.team.id, expected: 200 },
      { assigned_agent_id: null, assigned_team_id: null, expected: 409 },
      { assigned_agent_id: colleague.id, assigned_team_id: own.team.id, expected: 409 },
      { assigned_agent_id: colleague.id, assigned_team_id: null, expected: 404 },
      { assigned_agent_id: null, assigned_team_id: differentTeam.id, expected: 404 },
    ];
    for (const { expected, ...assignment } of cases) {
      const ticket = await seedTicket(assignment);
      await change(ticket.id, "RESOLVED", agent).expect(expected);
      if (expected !== 200) expect(await state(ticket.id)).toEqual(ticket);
      else expect(await state(ticket.id)).toMatchObject({ ...assignment, status: "RESOLVED", priority: "HIGH" });
      await change(ticket.id, "CLOSED", admin).expect(200);
    }
  });

  it("conceals cross-tenant and voided tickets for both staff roles and every agent visibility branch", async () => {
    const tickets = [await seedTicket({ organization_id: other.id, customer_id: foreignCustomer.id,
      assigned_agent_id: foreignAgent.id, assigned_team_id: other.team.id })];
    for (const assignment of [{ assigned_agent_id: agent.id }, { assigned_team_id: own.team.id }, {}]) {
      tickets.push(await seedTicket({ ...assignment, voided_at: new Date(), voided_by_user_id: admin.id, void_reason: "SPAM" }));
    }
    for (const actor of [agent, admin]) {
      for (const ticket of tickets) {
        expect((await change(ticket.id, "RESOLVED", actor).expect(404)).body).toEqual({ error: "Ticket not found" });
        expect(await state(ticket.id)).toEqual(ticket);
      }
      await change(randomUUID(), "RESOLVED", actor).expect(404);
    }
  });

  it("requires staff authentication, session CSRF, UUID params and a strict status-only body", async () => {
    const ticket = await seedTicket({ assigned_agent_id: agent.id });
    await request(app).patch(`/tickets/${ticket.id}/status`).send({ status: "CLOSED" }).expect(401);
    await change(ticket.id, "CLOSED", customer).expect(403);
    for (const actor of [agent, admin]) {
      await request(app).patch(`/tickets/${ticket.id}/status`).set("Cookie", actor.cookie).send({ status: "CLOSED" }).expect(403);
      await request(app).patch(`/tickets/${ticket.id}/status`).set("Cookie", actor.cookie).set("X-CSRF-Token", "wrong").send({ status: "CLOSED" }).expect(403);
      await change("invalid", "CLOSED", actor).expect(400);
    }
    for (const body of [{}, { status: "invalid" }, { status: null },
      ...["organizationId", "customerId", "teamId", "agentId", "priority", "closedAt", "updatedAt"].map((key) => ({ status: "CLOSED", [key]: "untrusted" }))]) {
      await request(app).patch(`/tickets/${ticket.id}/status`).set("Cookie", admin.cookie).set("X-CSRF-Token", admin.csrf).send(body).expect(400);
    }
    expect(await state(ticket.id)).toEqual(ticket);
  });

  it("still reopens a staff-resolved ticket when its customer replies", async () => {
    const ticket = await seedTicket({ assigned_agent_id: agent.id });
    await change(ticket.id, "RESOLVED", agent).expect(200);
    await request(app).post(`/tickets/${ticket.id}/messages`).set("Cookie", customer.cookie)
      .set("X-CSRF-Token", customer.csrf).send({ message: "Still not fixed" }).expect(201);
    expect(await state(ticket.id)).toMatchObject({ status: "OPEN", closed_at: null, assigned_agent_id: agent.id, priority: "HIGH" });
  });
});

describe("status concurrency", () => {
  it.each([
    ["AGENT", "CLOSED"], ["AGENT", "IN_PROGRESS"],
    ["ORGANIZATION_ADMIN", "CLOSED"], ["ORGANIZATION_ADMIN", "IN_PROGRESS"],
  ] as const)("%s cannot overwrite the winner %s using a stale OPEN source", async (role, winner) => {
    const ticket = await seedTicket({ assigned_agent_id: agent.id });
    let pending: Promise<request.Response> | undefined;
    try {
      await db.transaction().execute(async (trx) => {
        expect(await transitions.attemptAdminStatusTransition(trx, own.id, ticket.id, "OPEN", winner)).toBeDefined();
        pending = change(ticket.id, winner === "CLOSED" ? "IN_PROGRESS" : "CLOSED", role === "AGENT" ? agent : admin)
          .then((response) => response);
        void pending.catch(() => {});
        await vi.waitFor(async () => {
          const waiting = await sql<{ count: string }>`select count(*) from pg_stat_activity
            where datname = current_database() and usename = current_user and wait_event_type = 'Lock'
            and query like 'update "tickets"%'`.execute(db);
          expect(Number(waiting.rows[0]!.count)).toBe(1);
        }, { timeout: 5000, interval: 20 });
      });
      expect((await pending)!.status).toBe(409);
      expect((await state(ticket.id)).status).toBe(winner);
    } finally { await pending; }
  }, 10000);

  it("rechecks assignment authority after waiting for a competing assignment change", async () => {
    const ticket = await seedTicket({ assigned_agent_id: agent.id, assigned_team_id: own.team.id });
    let pending: Promise<request.Response> | undefined;
    try {
      await db.transaction().execute(async (trx) => {
        await trx.updateTable("tickets").set({ assigned_agent_id: colleague.id }).where("id", "=", ticket.id).execute();
        pending = change(ticket.id, "RESOLVED", agent).then((response) => response);
        await vi.waitFor(async () => {
          const waiting = await sql<{ count: string }>`select count(*) from pg_stat_activity
            where datname = current_database() and usename = current_user and wait_event_type = 'Lock'
            and query like 'update "tickets"%'`.execute(db);
          expect(Number(waiting.rows[0]!.count)).toBe(1);
        }, { timeout: 5000, interval: 20 });
      });
      expect((await pending)!.status).toBe(409);
      expect(await state(ticket.id)).toMatchObject({ status: "OPEN", assigned_agent_id: colleague.id });
    } finally { await pending; }
  }, 10000);

  it.each(["deactivate", "reassign"] as const)("rejects stale agent facts when %s wins first", async (action) => {
    const team = await createNormalTeam(db, own.id, `Race ${randomUUID()}`);
    const actor = await principal(own, "AGENT", team.id);
    const ticket = await seedTicket({ assigned_team_id: team.id });
    let pending: Promise<unknown> | undefined;
    try {
      await db.transaction().execute(async (trx) => {
        await trx.updateTable("users").set(action === "deactivate" ? { deactivated_at: new Date() } : { team_id: own.team.id })
          .where("id", "=", actor.id).execute();
        // Model an already-authenticated request waiting for its authoritative user lock.
        pending = updateTicketStatus(actor.auth, ticket.id, "RESOLVED").catch((error: unknown) => error);
        await vi.waitFor(async () => {
          const waiting = await sql<{ count: string }>`select count(*) from pg_stat_activity
            where datname = current_database() and usename = current_user and wait_event_type = 'Lock'
            and query like '%for share%'`.execute(db);
          expect(Number(waiting.rows[0]!.count)).toBe(1);
        }, { timeout: 5000, interval: 20 });
      });
      expect(await pending).toMatchObject({ statusCode: action === "deactivate" ? 401 : 404 });
      expect(await state(ticket.id)).toEqual(ticket);
    } finally { await pending; }
  }, 10000);

  it.each(["deactivate", "reassign"] as const)("holds the active/current-team lock until status commit before %s", async (action) => {
    const team = await createNormalTeam(db, own.id, `Race ${randomUUID()}`);
    const actor = await principal(own, "AGENT", team.id);
    const ticket = await seedTicket({ assigned_team_id: team.id });
    let unlock!: () => void; let reached!: () => void;
    const hold = new Promise<void>((resolve) => { unlock = resolve; });
    const locked = new Promise<void>((resolve) => { reached = resolve; });
    const original = transitions.attemptAgentStatusTransition;
    vi.spyOn(transitions, "attemptAgentStatusTransition").mockImplementationOnce(async (...args) => {
      reached(); await hold; return original(...args);
    });
    const pending = change(ticket.id, "RESOLVED", actor).then((response) => response);
    let lifecycle: Promise<unknown> | undefined;
    try {
      await locked;
      lifecycle = action === "deactivate" ? deactivateAgent(own.id, actor.id) : reassignAgentTeam(own.id, actor.id, own.team.id);
      void lifecycle.catch(() => {});
      await vi.waitFor(async () => {
        const waiting = await sql<{ count: string }>`select count(*) from pg_stat_activity
          where datname = current_database() and usename = current_user and wait_event_type = 'Lock'`.execute(db);
        expect(Number(waiting.rows[0]!.count)).toBe(1);
      }, { timeout: 5000, interval: 20 });
      unlock();
      expect((await pending).status).toBe(200);
      await lifecycle;
      expect((await state(ticket.id)).status).toBe("RESOLVED");
    } finally { unlock(); await Promise.allSettled([pending, lifecycle]); }
  }, 10000);
});
