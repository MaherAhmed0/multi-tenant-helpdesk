import { randomUUID } from "node:crypto";

import { sql, type Insertable } from "kysely";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { app } from "../app.js";
import { db } from "../database/db.js";
import type { TenantRole, TicketsTable, TicketPriority } from "../database/types.js";
import { createOrganization } from "../organization-registration/organization.repository.js";
import { createUser } from "../organization-registration/user.repository.js";
import { createGeneralTeam, createNormalTeam } from "../teams/team.repository.js";
import { deactivateAgent, reassignAgentTeam } from "../agents/agents.service.js";
import { createSession } from "../auth/sessions/session.repository.js";
import { generateSessionToken, hashSessionToken } from "../auth/sessions/session-token.js";
import { updateTicketPriority } from "./tickets.service.js";
import * as priorities from "./ticket-priority.repository.js";

async function tenant() {
  const organization = await createOrganization(db, { name: "Priority tenant", slug: `priority-${randomUUID()}` });
  return { id: organization.id, team: await createGeneralTeam(db, organization.id) };
}

async function principal(owner: Awaited<ReturnType<typeof tenant>>, role: TenantRole, teamId = owner.team.id) {
  const user = await createUser(db, { organizationId: owner.id, role, name: "Priority actor", email: `${randomUUID()}@example.com`,
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
  return db.insertInto("tickets").values({ organization_id: own.id, customer_id: customer.id, subject: "Priority ticket",
    priority: "NORMAL", created_at: new Date("2026-01-01T00:00:00Z"), updated_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides }).returningAll().executeTakeFirstOrThrow();
}
function state(id: string) {
  return db.selectFrom("tickets").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
}
function change(id: string, priority: TicketPriority, actor = admin) {
  return request(app).patch(`/tickets/${id}/priority`).set("Cookie", actor.cookie).set("X-CSRF-Token", actor.csrf).send({ priority });
}

describe("staff ticket priority", () => {
  it.each(["OPEN", "IN_PROGRESS", "RESOLVED"] as const)("changes priority on %s while preserving every unrelated field", async (status) => {
    const ticket = await seedTicket({ status, assigned_team_id: own.team.id, assigned_agent_id: agent.id });
    for (const priority of ["LOW", "NORMAL", "HIGH", "URGENT"] as const) {
      const result = await change(ticket.id, priority).expect(200);
      expect(result.headers["cache-control"]).toBe("no-store");
      expect(result.body).toEqual({ id: ticket.id, subject: ticket.subject, status, priority, closedAt: null,
        createdAt: ticket.created_at.toISOString(), updatedAt: expect.any(String), customer: { name: customer.name },
        assignedTeam: { id: own.team.id, name: "General" }, assignedAgent: { id: agent.id, name: agent.name } });
      expect(await state(ticket.id)).toEqual({ ...ticket, priority, updated_at: new Date(result.body.updatedAt) });
      expect(new Date(result.body.updatedAt).getTime()).toBeGreaterThan(ticket.updated_at.getTime());
    }
  });

  it("distinguishes AGENT mutation authority from visibility; admins can update every assignment shape", async () => {
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
      const ticket = await seedTicket({ ...assignment, status: "RESOLVED" });
      await change(ticket.id, "HIGH", agent).expect(expected);
      if (expected !== 200) expect(await state(ticket.id)).toEqual(ticket);
      else expect(await state(ticket.id)).toEqual({ ...ticket, priority: "HIGH", updated_at: expect.any(Date) });
      await change(ticket.id, "URGENT", admin).expect(200);
    }
  });

  it("conceals foreign and voided tickets for both staff roles", async () => {
    const tickets = [await seedTicket({ organization_id: other.id, customer_id: foreignCustomer.id,
      assigned_agent_id: foreignAgent.id, assigned_team_id: other.team.id })];
    for (const assignment of [{ assigned_agent_id: agent.id }, { assigned_team_id: own.team.id }, {}]) {
      tickets.push(await seedTicket({ ...assignment, voided_at: new Date(), voided_by_user_id: admin.id, void_reason: "SPAM" }));
    }
    for (const actor of [agent, admin]) {
      for (const ticket of tickets) {
        expect((await change(ticket.id, "HIGH", actor).expect(404)).body).toEqual({ error: "Ticket not found" });
        expect(await state(ticket.id)).toEqual(ticket);
      }
      await change(randomUUID(), "HIGH", actor).expect(404);
    }
  });

  it("rejects CLOSED and same-priority requests without changing timestamps", async () => {
    const closed = await seedTicket({ status: "CLOSED", closed_at: new Date(), assigned_agent_id: agent.id });
    const unchanged = await seedTicket({ priority: "HIGH", assigned_agent_id: agent.id });
    for (const actor of [agent, admin]) {
      for (const ticket of [closed, unchanged]) {
        expect((await change(ticket.id, "HIGH", actor).expect(409)).body).toEqual({ error: "Ticket priority cannot be changed" });
        expect(await state(ticket.id)).toEqual(ticket);
      }
    }
  });

  it("requires staff authentication, CSRF, UUID params and a strict priority-only body", async () => {
    const ticket = await seedTicket({ assigned_agent_id: agent.id });
    await request(app).patch(`/tickets/${ticket.id}/priority`).send({ priority: "HIGH" }).expect(401);
    await change(ticket.id, "HIGH", customer).expect(403);
    for (const actor of [agent, admin]) {
      await request(app).patch(`/tickets/${ticket.id}/priority`).set("Cookie", actor.cookie).send({ priority: "HIGH" }).expect(403);
      await request(app).patch(`/tickets/${ticket.id}/priority`).set("Cookie", actor.cookie).set("X-CSRF-Token", "wrong").send({ priority: "HIGH" }).expect(403);
      await change("invalid", "HIGH", actor).expect(400);
    }
    for (const body of [{}, { priority: "invalid" }, { priority: null },
      ...["organizationId", "customerId", "teamId", "agentId", "status", "closedAt", "updatedAt"].map((key) => ({ priority: "HIGH", [key]: "untrusted" }))]) {
      await request(app).patch(`/tickets/${ticket.id}/priority`).set("Cookie", admin.cookie).set("X-CSRF-Token", admin.csrf).send(body).expect(400);
    }
    expect(await state(ticket.id)).toEqual(ticket);
  });

  it("keeps changed priority hidden from customer list/detail responses", async () => {
    const ticket = await seedTicket();
    await change(ticket.id, "URGENT").expect(200);
    const detail = await request(app).get(`/tickets/${ticket.id}`).set("Cookie", customer.cookie).expect(200);
    expect(Object.keys(detail.body).sort()).toEqual(["createdAt", "id", "messages", "status", "subject", "updatedAt"]);
    const list = await request(app).get("/tickets").set("Cookie", customer.cookie).expect(200);
    for (const row of list.body.tickets) {
      expect(Object.keys(row).sort()).toEqual(["createdAt", "id", "status", "subject", "updatedAt"]);
    }
  });
});

describe("priority concurrency", () => {
  it.each([
    ["AGENT", "assignment"], ["AGENT", "closed"], ["ORGANIZATION_ADMIN", "closed"],
    ["AGENT", "priority"], ["ORGANIZATION_ADMIN", "priority"], ["AGENT", "same-priority"],
  ] as const)("%s rechecks a winning concurrent %s change", async (role, firstChange) => {
    const ticket = await seedTicket({ assigned_team_id: own.team.id });
    let pending: Promise<request.Response> | undefined;
    let firstState = ticket;
    try {
      await db.transaction().execute(async (trx) => {
        firstState = await trx.updateTable("tickets").set(
          firstChange === "assignment" ? { assigned_agent_id: colleague.id }
            : firstChange === "closed" ? { status: "CLOSED", closed_at: new Date() }
              : { priority: firstChange === "same-priority" ? "URGENT" : "HIGH" },
        ).where("id", "=", ticket.id).returningAll().executeTakeFirstOrThrow();
        pending = change(ticket.id, "URGENT", role === "AGENT" ? agent : admin).then((response) => response);
        void pending.catch(() => {});
        await vi.waitFor(async () => {
          const waiting = await sql<{ count: string }>`select count(*) from pg_stat_activity
            where datname = current_database() and usename = current_user and wait_event_type = 'Lock'
            and query like 'update "tickets"%'`.execute(db);
          expect(Number(waiting.rows[0]!.count)).toBe(1);
        }, { timeout: 5000, interval: 20 });
      });
      expect((await pending)!.status).toBe(firstChange === "priority" ? 200 : 409);
      expect(await state(ticket.id)).toEqual(firstChange === "priority"
        ? { ...firstState, priority: "URGENT", updated_at: expect.any(Date) } : firstState);
    } finally { await pending; }
  }, 10000);

  it.each(["deactivate", "reassign"] as const)("rejects stale authorization when agent %s wins first", async (action) => {
    const team = await createNormalTeam(db, own.id, `Race ${randomUUID()}`);
    const actor = await principal(own, "AGENT", team.id);
    const ticket = await seedTicket({ assigned_team_id: team.id });
    let pending: Promise<unknown> | undefined;
    try {
      await db.transaction().execute(async (trx) => {
        await trx.updateTable("users").set(action === "deactivate" ? { deactivated_at: new Date() } : { team_id: own.team.id })
          .where("id", "=", actor.id).execute();
        // Model a request that already passed authentication before the lifecycle write.
        pending = updateTicketPriority(actor.auth, ticket.id, "HIGH").catch((error: unknown) => error);
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

  it.each(["deactivate", "reassign"] as const)("holds active/current-team authorization through commit before %s", async (action) => {
    const team = await createNormalTeam(db, own.id, `Race ${randomUUID()}`);
    const actor = await principal(own, "AGENT", team.id);
    const ticket = await seedTicket({ assigned_team_id: team.id });
    let unlock!: () => void; let reached!: () => void;
    const hold = new Promise<void>((resolve) => { unlock = resolve; });
    const locked = new Promise<void>((resolve) => { reached = resolve; });
    const original = priorities.attemptAgentPriorityUpdate;
    vi.spyOn(priorities, "attemptAgentPriorityUpdate").mockImplementationOnce(async (...args) => {
      reached(); await hold; return original(...args);
    });
    const pending = change(ticket.id, "HIGH", actor).then((response) => response);
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
      expect((await state(ticket.id)).priority).toBe("HIGH");
    } finally { unlock(); await Promise.allSettled([pending, lifecycle]); }
  }, 10000);
});
