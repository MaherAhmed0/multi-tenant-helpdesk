import { randomUUID } from "node:crypto";
import { sql } from "kysely";

import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { app } from "../app.js";
import { db } from "../database/db.js";
import type { TenantRole } from "../database/types.js";
import { createOrganization } from "../organization-registration/organization.repository.js";
import { createUser } from "../organization-registration/user.repository.js";
import { createGeneralTeam } from "../teams/team.repository.js";
import { createSession } from "../auth/sessions/session.repository.js";
import { generateSessionToken, hashSessionToken } from "../auth/sessions/session-token.js";
import { SESSION_ABSOLUTE_LIFETIME_MS } from "../auth/auth.constants.js";
import { addCustomerMessage, createCustomerTicket } from "./tickets.service.js";
import * as ticketRepository from "./ticket.repository.js";
import * as messageRepository from "./ticket-message.repository.js";

async function tenant() {
  const organization = await createOrganization(db, { name: "Ticket API tenant", slug: `ticket-api-${randomUUID()}` });
  const team = await createGeneralTeam(db, organization.id);
  return { organizationId: organization.id, teamId: team.id };
}

async function principal(owner: Awaited<ReturnType<typeof tenant>>, role: TenantRole = "CUSTOMER", email = `${randomUUID()}@example.com`) {
  const user = await createUser(db, {
    organizationId: owner.organizationId,
    name: role === "CUSTOMER" ? "Sara Ahmed" : role === "AGENT" ? "Alex Support" : "Morgan Support",
    email, role,
    passwordHash: "test-only-hash", teamId: role === "AGENT" ? owner.teamId : null,
  });
  const token = generateSessionToken();
  const session = await createSession(db, {
    organizationId: owner.organizationId, userId: user.id, tokenHash: hashSessionToken(token),
    userAgent: null, absoluteExpiresAt: new Date(Date.now() + SESSION_ABSOLUTE_LIFETIME_MS),
  });
  const cookie = `session=${token}`;
  const csrf = await request(app).get("/auth/csrf").set("Cookie", cookie).expect(200);
  return {
    auth: { organizationId: owner.organizationId, userId: user.id, sessionId: session.id, role },
    email, cookie, csrf: csrf.body.csrfToken as string,
  };
}

let own: Awaited<ReturnType<typeof tenant>>;
let other: typeof own;
let customer: Awaited<ReturnType<typeof principal>>;
let neighbor: typeof customer;
let foreign: typeof customer;
let agent: typeof customer;
let admin: typeof customer;
beforeAll(async () => {
  own = await tenant();
  other = await tenant();
  customer = await principal(own);
  neighbor = await principal(own);
  foreign = await principal(other, "CUSTOMER", customer.email);
  agent = await principal(own, "AGENT");
  admin = await principal(own, "ORGANIZATION_ADMIN");
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await db.destroy(); });

const input = { subject: "Help with billing", message: "Please explain this charge." };
const routes = [["post", "/tickets"], ["get", "/tickets"], ["get", "/tickets/not-an-id"], ["post", "/tickets/not-an-id/messages"]] as const;
function create(body: object = input, actor = customer) {
  return request(app).post("/tickets").set("Cookie", actor.cookie).set("X-CSRF-Token", actor.csrf).send(body);
}
function reply(ticketId: string, body: object = { message: "The problem still happens." }, actor = customer) {
  return request(app).post(`/tickets/${ticketId}/messages`).set("Cookie", actor.cookie)
    .set("X-CSRF-Token", actor.csrf).send(body);
}
function readTicket(ticketId: string) {
  return db.selectFrom("tickets").selectAll().where("organization_id", "=", own.organizationId)
    .where("customer_id", "=", customer.auth.userId).where("id", "=", ticketId).executeTakeFirstOrThrow();
}
function readMessages(ticketId: string) {
  return db.selectFrom("ticket_messages").selectAll().where("organization_id", "=", own.organizationId)
    .where("ticket_id", "=", ticketId).orderBy("id").execute();
}
function storedTickets(actor = customer) {
  return db.selectFrom("tickets").selectAll().where("organization_id", "=", actor.auth.organizationId)
    .where("customer_id", "=", actor.auth.userId).orderBy("id").execute();
}
function seedTicket(actor = customer, createdAt = new Date()) {
  return db.insertInto("tickets").values({
    organization_id: actor.auth.organizationId, customer_id: actor.auth.userId,
    subject: "Seeded ticket", created_at: createdAt,
  }).returningAll().executeTakeFirstOrThrow();
}

describe("customer ticket API", () => {
  it("requires authentication on every route and CUSTOMER role on mutations before validation", async () => {
    for (const [method, path] of routes) {
      expect((await request(app)[method](path).send({}).expect(401)).body).toEqual({ error: "Authentication required" });
      for (const staff of [agent, admin]) {
        if (method !== "post") continue;
        expect((await request(app)[method](path).set("Cookie", staff.cookie)
          .set("X-CSRF-Token", staff.csrf).send(input).expect(403)).body).toEqual({ error: "Request forbidden" });
      }
    }
  });

  it("creates a default ticket and its first public message using only session identity", async () => {
    const result = await create({ subject: ` ${input.subject} `, message: `\n ${input.message} \t` })
      .query({ organizationId: other.organizationId, customerId: foreign.auth.userId }).expect(201);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.body).toEqual({
      id: expect.any(String), subject: input.subject, status: "OPEN",
      createdAt: expect.any(String), updatedAt: expect.any(String),
      messages: [{ id: expect.any(String), body: input.message, author: { name: "Sara Ahmed", type: "CUSTOMER" }, createdAt: expect.any(String) }],
    });
    const ticket = (await storedTickets()).find((row) => row.id === result.body.id)!;
    expect(ticket.id[14]).toBe("7");
    expect(ticket).toMatchObject({
      organization_id: own.organizationId, customer_id: customer.auth.userId, subject: input.subject,
      status: "OPEN", priority: "NORMAL", assigned_team_id: null, assigned_agent_id: null,
      voided_at: null, voided_by_user_id: null, void_reason: null, closed_at: null,
    });
    const messages = await db.selectFrom("ticket_messages").selectAll()
      .where("organization_id", "=", own.organizationId).where("ticket_id", "=", ticket.id).execute();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ author_user_id: customer.auth.userId, body: input.message });
  });

  it("requires valid session-bound CSRF and rejects client state and malformed content", async () => {
    const before = await storedTickets();
    for (const token of [undefined, "invalid", foreign.csrf]) {
      const operation = request(app).post("/tickets").set("Cookie", customer.cookie).send(input);
      if (token) operation.set("X-CSRF-Token", token);
      expect((await operation.expect(403)).body).toEqual({ error: "Invalid CSRF token" });
    }
    for (const extra of [
      { organizationId: other.organizationId }, { organization_id: other.organizationId },
      { customerId: neighbor.auth.userId }, { customer_id: neighbor.auth.userId }, { userId: neighbor.auth.userId },
      { role: "CUSTOMER" }, { status: "CLOSED" }, { priority: "URGENT" },
      { assignedTeamId: own.teamId }, { assigned_agent_id: agent.auth.userId },
      { voided_at: null }, { description: "Duplicate description" },
    ]) await create({ ...input, ...extra }).expect(400);
    for (const body of [
      {}, { ...input, subject: "\n\t " }, { ...input, message: "\n\t " },
      { ...input, subject: "a".repeat(256) }, { ...input, message: "a".repeat(10_001) },
      { ...input, message: 42 },
    ]) await create(body).expect(400);
    expect(await storedTickets()).toEqual(before);
  });

  it("rolls back the ticket when initial message persistence fails", async () => {
    const insert = ticketRepository.createTicket;
    const message = messageRepository.createTicketMessage;
    let ticketId: string | undefined;
    vi.spyOn(ticketRepository, "createTicket").mockImplementationOnce(async (...args) => {
      const row = await insert(...args);
      ticketId = row.id;
      return row;
    });
    vi.spyOn(messageRepository, "createTicketMessage").mockImplementationOnce((executor, data) =>
      message(executor, { ...data, body: "   " }),
    );
    await expect(createCustomerTicket(customer.auth, input)).rejects.toMatchObject({ constraint: "ticket_messages_body_check" });
    expect(ticketId).toBeDefined();
    expect(await db.selectFrom("tickets").select("id").where("organization_id", "=", own.organizationId)
      .where("id", "=", ticketId!).execute()).toEqual([]);
    expect(await db.selectFrom("ticket_messages").select("id").where("organization_id", "=", own.organizationId)
      .where("ticket_id", "=", ticketId!).execute()).toEqual([]);
  });

  it("does not insert a message if ticket persistence fails", async () => {
    const message = vi.spyOn(messageRepository, "createTicketMessage");
    await expect(createCustomerTicket(customer.auth, { ...input, subject: "" }))
      .rejects.toMatchObject({ constraint: "tickets_subject_check" });
    expect(message).not.toHaveBeenCalled();
  });

  it.each(["customer", "organization"])("uses existing authentication to block a deactivated %s", async (target) => {
    const owner = await tenant();
    const actor = await principal(owner);
    if (target === "customer") {
      await db.updateTable("users").set({ deactivated_at: new Date() })
        .where("organization_id", "=", owner.organizationId).where("id", "=", actor.auth.userId).execute();
    } else {
      await db.updateTable("organizations").set({ deactivated_at: new Date() }).where("id", "=", owner.organizationId).execute();
    }
    for (const [method, path] of routes) {
      expect((await request(app)[method](path).set("Cookie", actor.cookie).set("X-CSRF-Token", actor.csrf)
        .send(input).expect(401)).body).toEqual({ error: "Authentication required" });
    }
    expect(await storedTickets(actor)).toEqual([]);
  });

  it("paginates only owned non-voided tickets with deterministic newest-first ordering", async () => {
    const actor = await principal(own);
    const date = new Date("2026-01-01T00:00:00Z");
    const first = await seedTicket(actor, date);
    const second = await seedTicket(actor, date);
    const newest = await seedTicket(actor, new Date("2026-01-02T00:00:00Z"));
    const voided = await seedTicket(actor);
    await db.updateTable("tickets").set({ voided_at: new Date(), voided_by_user_id: actor.auth.userId, void_reason: "CUSTOMER_WITHDRAWN" })
      .where("organization_id", "=", own.organizationId).where("id", "=", voided.id).execute();
    await seedTicket(neighbor);
    await seedTicket(foreign);
    const ordered = [newest.id, ...[first.id, second.id].sort().reverse()];
    const page = await request(app).get("/tickets?page=1&limit=2").set("Cookie", actor.cookie).expect(200);
    expect(page.body.tickets.map((row: { id: string }) => row.id)).toEqual(ordered.slice(0, 2));
    expect(page.body.pagination).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
    expect(page.headers["cache-control"]).toBe("no-store");
    for (const row of page.body.tickets) expect(Object.keys(row).sort()).toEqual(["createdAt", "id", "status", "subject", "updatedAt"]);
    const next = await request(app).get("/tickets?page=2&limit=2").set("Cookie", actor.cookie).expect(200);
    expect(next.body.tickets.map((row: { id: string }) => row.id)).toEqual(ordered.slice(2));
    const ownList = await request(app).get("/tickets").set("Cookie", customer.cookie).expect(200);
    const foreignList = await request(app).get("/tickets").set("Cookie", foreign.cookie).expect(200);
    const ownIds = ownList.body.tickets.map((row: { id: string }) => row.id);
    expect(foreignList.body.tickets.length).toBeGreaterThan(0);
    for (const row of foreignList.body.tickets) expect(ownIds).not.toContain(row.id);
  });

  it("returns only the authorized public conversation in chronological order, never internal notes", async () => {
    const ticket = await seedTicket();
    const rows = await db.insertInto("ticket_messages").values([
      { organization_id: own.organizationId, ticket_id: ticket.id, author_user_id: agent.auth.userId, body: "Staff reply", created_at: new Date("2026-01-02T00:00:00Z") },
      { organization_id: own.organizationId, ticket_id: ticket.id, author_user_id: admin.auth.userId, body: "Administrator reply", created_at: new Date("2026-01-03T00:00:00Z") },
      { organization_id: own.organizationId, ticket_id: ticket.id, author_user_id: customer.auth.userId, body: "Initial message", created_at: new Date("2026-01-01T00:00:00Z") },
      { organization_id: own.organizationId, ticket_id: ticket.id, author_user_id: customer.auth.userId, body: "Follow-up", created_at: new Date("2026-01-02T00:00:00Z") },
    ]).returningAll().execute();
    await db.insertInto("ticket_internal_notes").values({
      organization_id: own.organizationId, ticket_id: ticket.id, author_user_id: agent.auth.userId, body: "CONFIDENTIAL INTERNAL NOTE",
    }).execute();
    const detail = await request(app).get(`/tickets/${ticket.id}`).set("Cookie", customer.cookie).expect(200);
    const ordered = rows.sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id));
    const authors = {
      [customer.auth.userId]: { name: "Sara Ahmed", type: "CUSTOMER" },
      [agent.auth.userId]: { name: "Alex Support", type: "STAFF" },
      [admin.auth.userId]: { name: "Morgan Support", type: "STAFF" },
    };
    expect(detail.body).toEqual({
      id: ticket.id, subject: ticket.subject, status: "OPEN", createdAt: ticket.created_at.toISOString(), updatedAt: ticket.updated_at.toISOString(),
      messages: ordered.map((row) => ({ id: row.id, body: row.body, author: authors[row.author_user_id], createdAt: row.created_at.toISOString() })),
    });
    expect(detail.headers["cache-control"]).toBe("no-store");
    await db.updateTable("users").set({ name: "Renamed Support" })
      .where("organization_id", "=", own.organizationId).where("id", "=", agent.auth.userId).execute();
    const refreshed = await request(app).get(`/tickets/${ticket.id}`).set("Cookie", customer.cookie).expect(200);
    const staffMessage = refreshed.body.messages.find((message: { body: string }) => message.body === "Staff reply");
    expect(staffMessage.author).toEqual({ name: "Renamed Support", type: "STAFF" });
    expect(Object.keys(staffMessage).sort()).toEqual(["author", "body", "createdAt", "id"]);
    expect(JSON.stringify(refreshed.body)).not.toContain(agent.auth.userId);
  });

  it("hides other customers, other tenants, voided tickets and unknown IDs behind the same not-found response", async () => {
    const neighborTicket = await seedTicket(neighbor);
    const foreignTicket = await seedTicket(foreign);
    const voided = await seedTicket();
    await db.updateTable("tickets").set({ voided_at: new Date(), voided_by_user_id: customer.auth.userId, void_reason: "CUSTOMER_WITHDRAWN" })
      .where("organization_id", "=", own.organizationId).where("id", "=", voided.id).execute();
    const readMessages = vi.spyOn(messageRepository, "listTicketMessages");
    for (const id of [neighborTicket.id, foreignTicket.id, voided.id, randomUUID()]) {
      expect((await request(app).get(`/tickets/${id}`).set("Cookie", customer.cookie).expect(404)).body).toEqual({ error: "Ticket not found" });
    }
    expect(readMessages).not.toHaveBeenCalled();
  });

  it("rejects malformed IDs and invalid pagination or client ownership filters", async () => {
    await request(app).get("/tickets/not-an-id").set("Cookie", customer.cookie).expect(400);
    for (const query of [
      { page: "0" }, { page: "1.5" }, { page: "1000001" }, { limit: "101" }, { limit: "0" },
      { organizationId: other.organizationId }, { customerId: neighbor.auth.userId },
    ]) await request(app).get("/tickets").query(query).set("Cookie", customer.cookie).expect(400);
  });

  it.each(["OPEN", "IN_PROGRESS", "RESOLVED"] as const)("adds a public message to %s, reopening only RESOLVED", async (status) => {
    const ticket = await seedTicket();
    const before = await db.updateTable("tickets").set({
      status, priority: "HIGH", assigned_team_id: own.teamId, assigned_agent_id: agent.auth.userId,
      updated_at: new Date("2020-01-01T00:00:00Z"),
    }).where("organization_id", "=", own.organizationId).where("id", "=", ticket.id)
      .returningAll().executeTakeFirstOrThrow();
    const result = await reply(ticket.id, { message: " \n Still broken. \t " }).expect(201);
    const expectedStatus = status === "RESOLVED" ? "OPEN" : status;
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.body).toEqual({
      message: { id: expect.any(String), body: "Still broken.", author: { name: "Sara Ahmed", type: "CUSTOMER" }, createdAt: expect.any(String) },
      ticketStatus: expectedStatus,
    });
    const after = await readTicket(ticket.id);
    expect(after).toEqual({ ...before, status: expectedStatus, updated_at: expect.any(Date) });
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    expect(after.closed_at).toBeNull();
    const messages = await readMessages(ticket.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: result.body.message.id, organization_id: own.organizationId, author_user_id: customer.auth.userId, body: "Still broken." });
  });

  it("rejects replies to CLOSED tickets before inserting anything", async () => {
    const ticket = await seedTicket();
    const before = await db.updateTable("tickets").set({ status: "CLOSED", closed_at: new Date() })
      .where("organization_id", "=", own.organizationId).where("id", "=", ticket.id)
      .returningAll().executeTakeFirstOrThrow();
    const insert = vi.spyOn(messageRepository, "createTicketMessage");
    expect((await reply(ticket.id).expect(409)).body).toEqual({ error: "Cannot reply to a closed ticket" });
    expect(insert).not.toHaveBeenCalled();
    expect(await readTicket(ticket.id)).toEqual(before);
    expect(await readMessages(ticket.id)).toEqual([]);
  });

  it("hides unowned, cross-tenant, missing and voided reply targets", async () => {
    const neighborTicket = await seedTicket(neighbor);
    const foreignTicket = await seedTicket(foreign);
    const voided = await seedTicket();
    await db.updateTable("tickets").set({ voided_at: new Date(), voided_by_user_id: customer.auth.userId, void_reason: "CUSTOMER_WITHDRAWN" })
      .where("organization_id", "=", own.organizationId).where("id", "=", voided.id).execute();
    const insert = vi.spyOn(messageRepository, "createTicketMessage");
    for (const id of [neighborTicket.id, foreignTicket.id, randomUUID(), voided.id]) {
      expect((await reply(id).expect(404)).body).toEqual({ error: "Ticket not found" });
    }
    expect(insert).not.toHaveBeenCalled();
  });

  it("requires reply CSRF and validates only the bounded message body and UUID", async () => {
    const ticket = await seedTicket();
    const before = await readTicket(ticket.id);
    for (const token of [undefined, "invalid", foreign.csrf]) {
      const operation = request(app).post(`/tickets/${ticket.id}/messages`).set("Cookie", customer.cookie).send({ message: "Reply" });
      if (token) operation.set("X-CSRF-Token", token);
      expect((await operation.expect(403)).body).toEqual({ error: "Invalid CSRF token" });
    }
    for (const body of [
      {}, { message: " \n\t " }, { message: "a".repeat(10_001) }, { message: 42 },
      { message: "Reply", authorId: agent.auth.userId }, { message: "Reply", organizationId: other.organizationId },
      { message: "Reply", customerId: neighbor.auth.userId }, { message: "Reply", role: "AGENT" },
      { message: "Reply", status: "OPEN" }, { message: "Reply", subject: "Changed" },
    ]) await reply(ticket.id, body).expect(400);
    await reply("not-an-id").expect(400);
    expect(await readMessages(ticket.id)).toEqual([]);
    expect(await readTicket(ticket.id)).toEqual(before);
  });

  it.each(["OPEN", "RESOLVED"] as const)("rolls back %s message and ticket state if persistence fails", async (status) => {
    const ticket = await seedTicket();
    const before = await db.updateTable("tickets").set({ status, updated_at: new Date("2020-01-01T00:00:00Z") })
      .where("organization_id", "=", own.organizationId).where("id", "=", ticket.id)
      .returningAll().executeTakeFirstOrThrow();
    const insert = messageRepository.createTicketMessage;
    vi.spyOn(messageRepository, "createTicketMessage").mockImplementationOnce(async (...args) => {
      await insert(...args);
      throw new Error("Test message insert failure");
    });
    await expect(addCustomerMessage(customer.auth, ticket.id, { message: "Reply" })).rejects.toThrow("Test message insert failure");
    expect(await readMessages(ticket.id)).toEqual([]);
    expect(await readTicket(ticket.id)).toEqual(before);

    const operation = status === "RESOLVED" ? "reopenResolvedTicket" : "touchTicket";
    const update = ticketRepository[operation];
    vi.spyOn(ticketRepository, operation).mockImplementationOnce(async (...args) => {
      await update(...args);
      throw new Error("Test ticket update failure");
    });
    await expect(addCustomerMessage(customer.auth, ticket.id, { message: "Reply" })).rejects.toThrow("Test ticket update failure");
    expect(await readMessages(ticket.id)).toEqual([]);
    expect(await readTicket(ticket.id)).toEqual(before);
  });

  it.each(["CLOSED", "voided"] as const)("revalidates a concurrent %s change after waiting for the ticket lock", async (state) => {
    const ticket = await seedTicket();
    await db.updateTable("tickets").set({ status: "RESOLVED" })
      .where("organization_id", "=", own.organizationId).where("id", "=", ticket.id).execute();
    let pending: Promise<unknown> | undefined;
    try {
      await db.transaction().execute(async (trx) => {
        await trx.updateTable("tickets").set(state === "CLOSED"
          ? { status: "CLOSED", closed_at: new Date() }
          : { voided_at: new Date(), voided_by_user_id: customer.auth.userId, void_reason: "CUSTOMER_WITHDRAWN" })
          .where("organization_id", "=", own.organizationId).where("id", "=", ticket.id).execute();
        pending = addCustomerMessage(customer.auth, ticket.id, { message: "Concurrent reply" }).catch((error: unknown) => error);
        await vi.waitFor(async () => {
          const result = await sql<{ waiting: string }>`
            SELECT count(*) AS waiting FROM pg_stat_activity
            WHERE datname = current_database() AND usename = current_user AND wait_event_type = 'Lock'
              AND query LIKE '%tickets%' AND query LIKE '%for update%'
          `.execute(db);
          expect(Number(result.rows[0]!.waiting)).toBe(1);
        }, { timeout: 5000, interval: 20 });
      });
      expect(await pending).toMatchObject({ statusCode: state === "CLOSED" ? 409 : 404 });
      expect(await readMessages(ticket.id)).toEqual([]);
      const after = await readTicket(ticket.id);
      expect(after.status).toBe(state === "CLOSED" ? "CLOSED" : "RESOLVED");
      if (state === "voided") expect(after.voided_at).not.toBeNull();
    } finally {
      if (pending) await Promise.allSettled([pending]);
    }
  }, 10_000);
});
