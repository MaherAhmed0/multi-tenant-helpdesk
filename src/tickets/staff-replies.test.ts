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
import { deactivateAgent, reassignAgentTeam } from "../agents/agents.service.js";
import { createSession } from "../auth/sessions/session.repository.js";
import { generateSessionToken, hashSessionToken } from "../auth/sessions/session-token.js";
import { addTicketMessage } from "./tickets.service.js";
import * as replies from "./ticket-reply.repository.js";
import * as messages from "./ticket-message.repository.js";

async function tenant() {
  const organization = await createOrganization(db, { name: "Reply tenant", slug: `reply-${randomUUID()}` });
  return { id: organization.id, team: await createGeneralTeam(db, organization.id) };
}

async function principal(owner: Awaited<ReturnType<typeof tenant>>, role: TenantRole, teamId = owner.team.id) {
  const user = await createUser(db, { organizationId: owner.id, role, name: "Reply actor", email: `${randomUUID()}@example.com`,
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
  return db.insertInto("tickets").values({ organization_id: own.id, customer_id: customer.id, subject: "Reply ticket",
    priority: "NORMAL", created_at: new Date("2026-01-01T00:00:00Z"), updated_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides }).returningAll().executeTakeFirstOrThrow();
}
function state(id: string) {
  return db.selectFrom("tickets").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
}
function reply(id: string, actor = admin, body: object = { message: "  Public reply  " }) {
  return request(app).post(`/tickets/${id}/messages`).set("Cookie", actor.cookie).set("X-CSRF-Token", actor.csrf).send(body);
}
function storedMessages(id: string) {
  return db.selectFrom("ticket_messages").selectAll().where("organization_id", "=", own.id).where("ticket_id", "=", id).execute();
}

describe("staff public replies", () => {
  it.each([
    ["AGENT", "OPEN"], ["AGENT", "IN_PROGRESS"], ["AGENT", "RESOLVED"],
    ["ORGANIZATION_ADMIN", "OPEN"], ["ORGANIZATION_ADMIN", "IN_PROGRESS"], ["ORGANIZATION_ADMIN", "RESOLVED"],
  ] as const)("%s replies to %s with only public author data and no workflow changes", async (role, status) => {
    const actor = role === "AGENT" ? agent : admin;
    const ticket = await seedTicket({ status, assigned_team_id: own.team.id, assigned_agent_id: agent.id });
    const result = await reply(ticket.id, actor).expect(201);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.body).toEqual({ ticketStatus: status, message: {
      id: expect.any(String), body: "Public reply", createdAt: expect.any(String), author: { name: actor.name, type: "STAFF" },
    } });
    expect(await storedMessages(ticket.id)).toEqual([{
      id: result.body.message.id, organization_id: own.id, ticket_id: ticket.id, author_user_id: actor.id,
      body: "Public reply", created_at: new Date(result.body.message.createdAt),
    }]);
    const after = await state(ticket.id);
    expect(after).toEqual({ ...ticket, updated_at: expect.any(Date) });
    expect(after.updated_at.getTime()).toBeGreaterThan(ticket.updated_at.getTime());
    expect(await db.selectFrom("ticket_internal_notes").selectAll().where("organization_id", "=", own.id)
      .where("ticket_id", "=", ticket.id).execute()).toEqual([]);
    const detail = await request(app).get(`/tickets/${ticket.id}`).set("Cookie", customer.cookie).expect(200);
    expect(detail.body.messages).toEqual([result.body.message]);
    expect(Object.keys(detail.body).sort()).toEqual(["createdAt", "id", "messages", "status", "subject", "updatedAt"]);
  });

  it("separates AGENT visibility from reply authority while admins ignore assignment", async () => {
    const differentTeam = await createNormalTeam(db, own.id, `Other ${randomUUID()}`);
    const cases = [
      { assigned_agent_id: agent.id, assigned_team_id: null, expected: 201 },
      { assigned_agent_id: null, assigned_team_id: own.team.id, expected: 201 },
      { assigned_agent_id: null, assigned_team_id: null, expected: 409 },
      { assigned_agent_id: colleague.id, assigned_team_id: own.team.id, expected: 409 },
      { assigned_agent_id: colleague.id, assigned_team_id: null, expected: 404 },
      { assigned_agent_id: null, assigned_team_id: differentTeam.id, expected: 404 },
    ];
    for (const { expected, ...assignment } of cases) {
      const ticket = await seedTicket(assignment);
      await reply(ticket.id, agent).expect(expected);
      if (expected !== 201) {
        expect(await storedMessages(ticket.id)).toEqual([]);
        expect(await state(ticket.id)).toEqual(ticket);
      }
      await reply(ticket.id, admin).expect(201);
    }
  });

  it("blocks CLOSED, foreign, voided and unknown tickets for both staff roles", async () => {
    const closed = await seedTicket({ status: "CLOSED", closed_at: new Date(), assigned_agent_id: agent.id });
    const foreign = await seedTicket({ organization_id: other.id, customer_id: foreignCustomer.id,
      assigned_agent_id: foreignAgent.id, assigned_team_id: other.team.id });
    const voided = [];
    for (const assignment of [{ assigned_agent_id: agent.id }, { assigned_team_id: own.team.id }, {}]) {
      voided.push(await seedTicket({ ...assignment, voided_at: new Date(), voided_by_user_id: admin.id, void_reason: "SPAM" }));
    }
    for (const actor of [agent, admin]) {
      for (const ticket of [closed, foreign, ...voided]) {
        await reply(ticket.id, actor).expect(ticket.id === closed.id ? 409 : 404);
        expect(await state(ticket.id)).toEqual(ticket);
        expect(await db.selectFrom("ticket_messages").select("id").where("organization_id", "=", ticket.organization_id)
          .where("ticket_id", "=", ticket.id).execute()).toEqual([]);
      }
      await reply(randomUUID(), actor).expect(404);
    }
  });

  it("requires authentication, CSRF, UUID params and the existing strict message schema", async () => {
    const ticket = await seedTicket({ assigned_agent_id: agent.id });
    await request(app).post(`/tickets/${ticket.id}/messages`).send({ message: "Reply" }).expect(401);
    for (const actor of [agent, admin]) {
      await request(app).post(`/tickets/${ticket.id}/messages`).set("Cookie", actor.cookie).send({ message: "Reply" }).expect(403);
      await request(app).post(`/tickets/${ticket.id}/messages`).set("Cookie", actor.cookie).set("X-CSRF-Token", "wrong").send({ message: "Reply" }).expect(403);
      await reply("invalid", actor).expect(400);
      for (const body of [{}, { message: " \n\t " }, { message: "a".repeat(10_001) }, { message: 42 },
        ...["authorId", "organizationId", "role", "status", "teamId", "agentId", "author"].map((key) => ({ message: "Reply", [key]: "untrusted" }))]) {
        await reply(ticket.id, actor, body).expect(400);
      }
    }
    expect(await storedMessages(ticket.id)).toEqual([]);
    expect(await state(ticket.id)).toEqual(ticket);
  });

  it("keeps customer ownership, public author mapping and RESOLVED reopening distinct from staff", async () => {
    const ticket = await seedTicket({ status: "RESOLVED" });
    await reply(ticket.id, admin).expect(201);
    expect((await state(ticket.id)).status).toBe("RESOLVED");
    const result = await reply(ticket.id, customer, { message: "Customer follow-up" }).expect(201);
    expect(result.body).toMatchObject({ ticketStatus: "OPEN", message: { author: { name: customer.name, type: "CUSTOMER" } } });
    const neighbor = await principal(own, "CUSTOMER");
    await reply(ticket.id, neighbor).expect(404);
    await reply(ticket.id, foreignCustomer).expect(404);
    await db.updateTable("tickets").set({ status: "CLOSED", closed_at: new Date() }).where("id", "=", ticket.id).execute();
    await reply(ticket.id, customer).expect(409);
    expect(await storedMessages(ticket.id)).toHaveLength(2);
  });

  it.each([
    ["AGENT", "insert"], ["AGENT", "touch"], ["ORGANIZATION_ADMIN", "insert"], ["ORGANIZATION_ADMIN", "touch"],
  ] as const)("rolls back %s reply and ticket activity after %s failure", async (role, failure) => {
    const actor = role === "AGENT" ? agent : admin;
    const ticket = await seedTicket({ assigned_agent_id: agent.id, status: "RESOLVED" });
    const error = new Error("Test reply persistence failure");
    if (failure === "insert") {
      const original = messages.createTicketMessage;
      vi.spyOn(messages, "createTicketMessage").mockImplementationOnce(async (...args) => { await original(...args); throw error; });
    } else {
      const original = replies.touchStaffReplyTicket;
      vi.spyOn(replies, "touchStaffReplyTicket").mockImplementationOnce(async (...args) => { await original(...args); throw error; });
    }
    await expect(addTicketMessage(actor.auth, ticket.id, { message: "Reply" })).rejects.toBe(error);
    expect(await storedMessages(ticket.id)).toEqual([]);
    expect(await state(ticket.id)).toEqual(ticket);
  });
});

describe("staff reply concurrency", () => {
  it.each([
    ["AGENT", "closed"], ["ORGANIZATION_ADMIN", "closed"],
    ["AGENT", "voided"], ["ORGANIZATION_ADMIN", "voided"],
    ["AGENT", "team-only reassigned"], ["AGENT", "direct reassigned"],
  ] as const)("%s cannot insert after a concurrent %s change wins", async (role, firstChange) => {
    const ticket = await seedTicket({ assigned_team_id: own.team.id,
      assigned_agent_id: firstChange === "direct reassigned" ? agent.id : null });
    let pending: Promise<request.Response> | undefined;
    try {
      await db.transaction().execute(async (trx) => {
        await trx.updateTable("tickets").set(firstChange === "closed" ? { status: "CLOSED", closed_at: new Date() }
          : firstChange === "voided" ? { voided_at: new Date(), voided_by_user_id: admin.id, void_reason: "SPAM" }
            : { assigned_agent_id: colleague.id }).where("id", "=", ticket.id).execute();
        pending = reply(ticket.id, role === "AGENT" ? agent : admin).then((response) => response);
        void pending.catch(() => {});
        await vi.waitFor(async () => {
          const waiting = await sql<{ count: string }>`select count(*) from pg_stat_activity
            where datname = current_database() and usename = current_user and wait_event_type = 'Lock'
            and query like '%"tickets"%' and query like '%for update%'`.execute(db);
          expect(Number(waiting.rows[0]!.count)).toBe(1);
        }, { timeout: 5000, interval: 20 });
      });
      expect((await pending)!.status).toBe(firstChange === "voided" && role === "ORGANIZATION_ADMIN" ? 404 : 409);
      expect(await storedMessages(ticket.id)).toEqual([]);
      expect((await state(ticket.id)).updated_at).toEqual(ticket.updated_at);
    } finally { await pending; }
  }, 10000);

  it.each(["deactivate", "reassign"] as const)("rejects stale agent authorization when %s wins first", async (action) => {
    const team = await createNormalTeam(db, own.id, `Race ${randomUUID()}`);
    const actor = await principal(own, "AGENT", team.id);
    const ticket = await seedTicket({ assigned_team_id: team.id });
    let pending: Promise<unknown> | undefined;
    try {
      await db.transaction().execute(async (trx) => {
        await trx.updateTable("users").set(action === "deactivate" ? { deactivated_at: new Date() } : { team_id: own.team.id })
          .where("id", "=", actor.id).execute();
        pending = addTicketMessage(actor.auth, ticket.id, { message: "Stale reply" }).catch((error: unknown) => error);
        await vi.waitFor(async () => {
          const waiting = await sql<{ count: string }>`select count(*) from pg_stat_activity
            where datname = current_database() and usename = current_user and wait_event_type = 'Lock'
            and query like '%for share%'`.execute(db);
          expect(Number(waiting.rows[0]!.count)).toBe(1);
        }, { timeout: 5000, interval: 20 });
      });
      expect(await pending).toMatchObject({ statusCode: action === "deactivate" ? 401 : 404 });
      expect(await storedMessages(ticket.id)).toEqual([]);
      expect(await state(ticket.id)).toEqual(ticket);
    } finally { await pending; }
  }, 10000);

  it.each(["deactivate", "reassign", "close"] as const)("holds reply authorization until commit before %s", async (action) => {
    const team = await createNormalTeam(db, own.id, `Race ${randomUUID()}`);
    const actor = await principal(own, "AGENT", team.id);
    const ticket = await seedTicket({ assigned_team_id: team.id });
    let unlock!: () => void; let reached!: () => void;
    const hold = new Promise<void>((resolve) => { unlock = resolve; });
    const locked = new Promise<void>((resolve) => { reached = resolve; });
    const original = replies.touchStaffReplyTicket;
    vi.spyOn(replies, "touchStaffReplyTicket").mockImplementationOnce(async (...args) => {
      reached(); await hold; return original(...args);
    });
    const pending = reply(ticket.id, actor).then((response) => response);
    let competing: Promise<unknown> | undefined;
    try {
      await locked;
      competing = action === "deactivate" ? deactivateAgent(own.id, actor.id)
        : action === "reassign" ? reassignAgentTeam(own.id, actor.id, own.team.id)
          : db.updateTable("tickets").set({ status: "CLOSED", closed_at: new Date() }).where("id", "=", ticket.id).execute();
      void competing.catch(() => {});
      await vi.waitFor(async () => {
        const waiting = await sql<{ count: string }>`select count(*) from pg_stat_activity
          where datname = current_database() and usename = current_user and wait_event_type = 'Lock'`.execute(db);
        expect(Number(waiting.rows[0]!.count)).toBe(1);
      }, { timeout: 5000, interval: 20 });
      unlock();
      expect((await pending).status).toBe(201);
      await competing;
      expect(await storedMessages(ticket.id)).toHaveLength(1);
    } finally { unlock(); await Promise.allSettled([pending, competing]); }
  }, 10000);
});
