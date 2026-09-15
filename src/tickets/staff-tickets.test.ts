import { randomUUID } from "node:crypto";

import type { Insertable } from "kysely";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { app } from "../app.js";
import { db } from "../database/db.js";
import type { TenantRole, TicketsTable } from "../database/types.js";
import { createOrganization } from "../organization-registration/organization.repository.js";
import { createUser } from "../organization-registration/user.repository.js";
import { createGeneralTeam, createNormalTeam } from "../teams/team.repository.js";
import { createSession } from "../auth/sessions/session.repository.js";
import { generateSessionToken, hashSessionToken } from "../auth/sessions/session-token.js";
import { SESSION_ABSOLUTE_LIFETIME_MS } from "../auth/auth.constants.js";
import * as messages from "./ticket-message.repository.js";

async function tenant() {
  const organization = await createOrganization(db, { name: "Staff ticket tenant", slug: `staff-tickets-${randomUUID()}` });
  const team = await createGeneralTeam(db, organization.id);
  return { id: organization.id, team };
}

async function principal(owner: Awaited<ReturnType<typeof tenant>>, role: TenantRole, name: string, email = `${randomUUID()}@example.com`) {
  const user = await createUser(db, {
    organizationId: owner.id, role, name, email, passwordHash: "test-only-hash",
    teamId: role === "AGENT" ? owner.team.id : null,
  });
  const token = generateSessionToken();
  await createSession(db, {
    organizationId: owner.id, userId: user.id, tokenHash: hashSessionToken(token), userAgent: null,
    absoluteExpiresAt: new Date(Date.now() + SESSION_ABSOLUTE_LIFETIME_MS),
  });
  return { ...user, cookie: `session=${token}` };
}

let own: Awaited<ReturnType<typeof tenant>>;
let other: typeof own;
let agent: Awaited<ReturnType<typeof principal>>;
let colleague: typeof agent;
let admin: typeof agent;
let customer: typeof agent;
let secondCustomer: typeof agent;
let otherTeam: Awaited<ReturnType<typeof createNormalTeam>>;
let cases: { ticket: Awaited<ReturnType<typeof seedTicket>>; visibleToAgent: boolean }[];
let foreignId: string;
let conversation: Awaited<ReturnType<typeof seedTicket>>;
let expectedMessages: object[];

function seedTicket(overrides: Partial<Insertable<TicketsTable>> = {}) {
  return db.insertInto("tickets").values({
    organization_id: own.id, customer_id: customer.id, subject: "Queue ticket",
    priority: "HIGH", created_at: new Date("2026-01-01T00:00:00Z"), ...overrides,
  }).returningAll().executeTakeFirstOrThrow();
}

beforeAll(async () => {
  own = await tenant();
  other = await tenant();
  agent = await principal(own, "AGENT", "Alex Support");
  colleague = await principal(own, "AGENT", "Sam Support");
  admin = await principal(own, "ORGANIZATION_ADMIN", "Morgan Support");
  customer = await principal(own, "CUSTOMER", "Sara Ahmed");
  secondCustomer = await principal(own, "CUSTOMER", "Second Customer");
  const foreignCustomer = await principal(other, "CUSTOMER", "Foreign Customer", customer.email);
  otherTeam = await createNormalTeam(db, own.id, "Other team");
  const otherAgent = await createUser(db, {
    organizationId: own.id, role: "AGENT", name: "Other Agent", email: `${randomUUID()}@example.com`,
    passwordHash: "test-only-hash", teamId: otherTeam.id,
  });
  conversation = await seedTicket({ assigned_team_id: own.team.id, assigned_agent_id: colleague.id, customer_id: secondCustomer.id });
  cases = [
    { ticket: await seedTicket({ assigned_agent_id: agent.id }), visibleToAgent: true },
    { ticket: await seedTicket({ assigned_team_id: own.team.id }), visibleToAgent: true },
    { ticket: conversation, visibleToAgent: true },
    { ticket: await seedTicket(), visibleToAgent: true },
    { ticket: await seedTicket({ assigned_team_id: otherTeam.id }), visibleToAgent: false },
    { ticket: await seedTicket({ assigned_agent_id: colleague.id }), visibleToAgent: false },
    { ticket: await seedTicket({ assigned_team_id: otherTeam.id, assigned_agent_id: otherAgent.id }), visibleToAgent: false },
    { ticket: await seedTicket({ assigned_team_id: own.team.id, status: "CLOSED", closed_at: new Date(), created_at: new Date("2026-01-02T00:00:00Z") }), visibleToAgent: true },
  ];
  // Exercise each OR branch against the outer void predicate.
  for (const assignment of [{ assigned_agent_id: agent.id }, { assigned_team_id: own.team.id }, {}]) {
    cases.push({ ticket: await seedTicket({ ...assignment, voided_at: new Date(), voided_by_user_id: admin.id, void_reason: "SPAM" }), visibleToAgent: false });
  }
  foreignId = (await seedTicket({ organization_id: other.id, customer_id: foreignCustomer.id })).id;
  const stored = await db.insertInto("ticket_messages").values([
    { organization_id: own.id, ticket_id: conversation.id, author_user_id: secondCustomer.id, body: "Question", created_at: new Date("2026-01-01T00:00:00Z") },
    { organization_id: own.id, ticket_id: conversation.id, author_user_id: colleague.id, body: "Public response", created_at: new Date("2026-01-02T00:00:00Z") },
  ]).returningAll().execute();
  expectedMessages = stored.map((row) => ({
    id: row.id, body: row.body, createdAt: row.created_at.toISOString(),
    author: row.author_user_id === secondCustomer.id ? { name: secondCustomer.name, type: "CUSTOMER" } : { name: colleague.name, type: "STAFF" },
  }));
  await db.insertInto("ticket_internal_notes").values({
    organization_id: own.id, ticket_id: conversation.id, author_user_id: admin.id, body: "PRIVATE INTERNAL NOTE",
  }).execute();
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await db.destroy(); });

function orderedIds(rows: typeof cases) {
  return [...rows].sort((a, b) => b.ticket.created_at.getTime() - a.ticket.created_at.getTime() || b.ticket.id.localeCompare(a.ticket.id))
    .map((row) => row.ticket.id);
}

describe("tenant staff ticket reads", () => {
  it.each(["AGENT", "ORGANIZATION_ADMIN"] as const)("lists exactly the non-voided %s queue with deterministic pagination and staff projection", async (role) => {
    const actor = role === "AGENT" ? agent : admin;
    const visible = cases.filter((row) => role === "AGENT" ? row.visibleToAgent : row.ticket.voided_at === null);
    const expected = orderedIds(visible);
    const result = await request(app).get("/tickets").set("Cookie", actor.cookie).expect(200);
    expect(result.body.tickets.map((ticket: { id: string }) => ticket.id)).toEqual(expected);
    expect(result.body.pagination).toEqual({ page: 1, limit: 20, total: expected.length, totalPages: 1 });
    expect(result.headers["cache-control"]).toBe("no-store");
    for (const ticket of result.body.tickets) {
      expect(Object.keys(ticket).sort()).toEqual(["assignedAgent", "assignedTeam", "closedAt", "createdAt", "customer", "id", "priority", "status", "subject", "updatedAt"]);
      expect(Object.keys(ticket.customer)).toEqual(["name"]);
    }
    const unassigned = result.body.tickets.find((ticket: { id: string }) => ticket.id === cases[3]!.ticket.id);
    expect(unassigned).toMatchObject({ assignedTeam: null, assignedAgent: null, customer: { name: customer.name }, priority: "HIGH" });
    const second = await request(app).get("/tickets?page=2&limit=2").set("Cookie", actor.cookie).expect(200);
    expect(second.body.tickets.map((ticket: { id: string }) => ticket.id)).toEqual(expected.slice(2, 4));
    expect(second.body.pagination).toEqual({ page: 2, limit: 2, total: expected.length, totalPages: Math.ceil(expected.length / 2) });
  });

  it("uses the same visibility matrix for agent detail, including closed tickets", async () => {
    for (const row of cases) {
      const response = await request(app).get(`/tickets/${row.ticket.id}`).set("Cookie", agent.cookie)
        .expect(row.visibleToAgent ? 200 : 404);
      if (row.visibleToAgent) expect(response.body).toMatchObject({ id: row.ticket.id, status: row.ticket.status });
      else expect(response.body).toEqual({ error: "Ticket not found" });
    }
  });

  it.each(["AGENT", "ORGANIZATION_ADMIN"] as const)("returns %s detail with customer contact, assignments and only public messages", async (role) => {
    const actor = role === "AGENT" ? agent : admin;
    const result = await request(app).get(`/tickets/${conversation.id}`).set("Cookie", actor.cookie).expect(200);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.body).toEqual({
      id: conversation.id, subject: conversation.subject, status: conversation.status, priority: conversation.priority,
      createdAt: conversation.created_at.toISOString(), updatedAt: conversation.updated_at.toISOString(), closedAt: null,
      customer: { name: secondCustomer.name, email: secondCustomer.email },
      assignedTeam: { id: own.team.id, name: "General" }, assignedAgent: { id: colleague.id, name: colleague.name },
      messages: expectedMessages,
    });
  });

  it("allows organization-admin detail for tickets outside the agent queue but hides voided and foreign tickets", async () => {
    for (const row of cases.filter((row) => row.ticket.voided_at === null)) {
      await request(app).get(`/tickets/${row.ticket.id}`).set("Cookie", admin.cookie).expect(200);
    }
    const read = vi.spyOn(messages, "listTicketMessages");
    for (const actor of [agent, admin]) {
      for (const id of [foreignId, randomUUID(), ...cases.filter((row) => row.ticket.voided_at !== null).map((row) => row.ticket.id)]) {
        expect((await request(app).get(`/tickets/${id}`).set("Cookie", actor.cookie).expect(404)).body)
          .toEqual({ error: "Ticket not found" });
      }
    }
    for (const row of cases.filter((row) => !row.visibleToAgent)) {
      await request(app).get(`/tickets/${row.ticket.id}`).set("Cookie", agent.cookie).expect(404);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps customer projection minimal and staff blocked from both customer mutations", async () => {
    const detail = await request(app).get(`/tickets/${conversation.id}`).set("Cookie", secondCustomer.cookie).expect(200);
    expect(detail.body).toEqual({
      id: conversation.id, subject: conversation.subject, status: conversation.status,
      createdAt: conversation.created_at.toISOString(), updatedAt: conversation.updated_at.toISOString(), messages: expectedMessages,
    });
    for (const actor of [agent, admin]) {
      const csrf = await request(app).get("/auth/csrf").set("Cookie", actor.cookie).expect(200);
      for (const path of ["/tickets", `/tickets/${conversation.id}/messages`]) {
        expect((await request(app).post(path).set("Cookie", actor.cookie).set("X-CSRF-Token", csrf.body.csrfToken)
          .send({ subject: "New ticket", message: "Reply" }).expect(403)).body).toEqual({ error: "Request forbidden" });
      }
    }
  });

  it("resolves current team membership with the existing cookie and rejects client team/tenant filters", async () => {
    await db.updateTable("users").set({ team_id: otherTeam.id })
      .where("organization_id", "=", own.id).where("id", "=", agent.id).where("role", "=", "AGENT").execute();
    const visible = cases.filter(({ ticket }) => ticket.voided_at === null && (
      ticket.assigned_agent_id === agent.id || ticket.assigned_team_id === otherTeam.id ||
      (ticket.assigned_team_id === null && ticket.assigned_agent_id === null)
    ));
    const result = await request(app).get("/tickets").set("Cookie", agent.cookie).expect(200);
    expect(result.body.tickets.map((ticket: { id: string }) => ticket.id)).toEqual(orderedIds(visible));
    await request(app).get(`/tickets/${conversation.id}`).set("Cookie", agent.cookie).expect(404);
    await request(app).get(`/tickets/${cases[4]!.ticket.id}`).set("Cookie", agent.cookie).expect(200);
    for (const actor of [agent, admin]) {
      for (const query of [{ teamId: own.team.id }, { organizationId: other.id }, { status: "CLOSED" }, { priority: "HIGH" }]) {
        await request(app).get("/tickets").query(query).set("Cookie", actor.cookie).expect(400);
      }
    }
  });
});
