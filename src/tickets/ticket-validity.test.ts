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
import { createSession } from "../auth/sessions/session.repository.js";
import { generateSessionToken, hashSessionToken } from "../auth/sessions/session-token.js";
import { withdrawTicket, voidTicket, restoreTicket } from "./tickets.service.js";
import { deactivateAgent, reassignAgentTeam } from "../agents/agents.service.js";
import { deactivateTeam } from "../teams/teams.service.js";


async function tenant() {
  const organization = await createOrganization(db, { name: "Validity tenant", slug: `validity-${randomUUID()}` });
  return { id: organization.id, team: await createGeneralTeam(db, organization.id) };
}
async function principal(owner: Awaited<ReturnType<typeof tenant>>, role: TenantRole, teamId = owner.team.id) {
  const user = await createUser(db, { organizationId: owner.id, role, name: "Validity actor", email: `${randomUUID()}@example.com`,
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
beforeAll(async () => {
  own = await tenant(); other = await tenant();
  agent = await principal(own, "AGENT"); colleague = await principal(own, "AGENT");
  customer = await principal(own, "CUSTOMER"); admin = await principal(own, "ORGANIZATION_ADMIN");
  foreignCustomer = await principal(other, "CUSTOMER");
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await db.destroy(); });

function seedTicket(overrides: Partial<Insertable<TicketsTable>> = {}) {
  return db.insertInto("tickets").values({ organization_id: own.id, customer_id: customer.id, subject: "Validity ticket",
    priority: "HIGH", created_at: new Date("2026-01-01T00:00:00Z"), updated_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides }).returningAll().executeTakeFirstOrThrow();
}
function state(id: string) {
  return db.selectFrom("tickets").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
}

function action(id: string, path: "withdraw" | "void" | "restore", actor = admin, body: object = path === "void" ? { reason: "SPAM" } : {}) {
  return request(app).post(`/tickets/${id}/${path}`).set("Cookie", actor.cookie).set("X-CSRF-Token", actor.csrf).send(body);
}
async function expectHidden(id: string) {
  for (const actor of [customer, agent, admin]) {
    const list = await request(app).get("/tickets?limit=100").set("Cookie", actor.cookie).expect(200);
    expect(list.body.tickets.map((row: { id: string }) => row.id)).not.toContain(id);
    await request(app).get(`/tickets/${id}`).set("Cookie", actor.cookie).expect(404);
    await request(app).post(`/tickets/${id}/messages`).set("Cookie", actor.cookie)
      .set("X-CSRF-Token", actor.csrf).send({ message: "Cannot reply" }).expect(404);
  }
  for (const actor of [agent, admin]) {
    await request(app).get(`/tickets/${id}/internal-notes`).set("Cookie", actor.cookie).expect(404);
    await request(app).post(`/tickets/${id}/internal-notes`).set("Cookie", actor.cookie)
      .set("X-CSRF-Token", actor.csrf).send({ body: "Cannot add note" }).expect(404);
  }
}

describe("ticket validity", () => {
  it.each(["OPEN", "IN_PROGRESS", "RESOLVED"] as const)("withdraws own %s ticket without changing workflow/assignment", async (status) => {
    const ticket = await seedTicket({ status, assigned_team_id: own.team.id, assigned_agent_id: agent.id });
    const result = await action(ticket.id, "withdraw", customer).expect(200);
    expect(result.body).toEqual({ id: ticket.id, withdrawn: true });
    expect(result.headers["cache-control"]).toBe("no-store");
    const after = await state(ticket.id);
    expect(after).toEqual({ ...ticket, voided_at: expect.any(Date), voided_by_user_id: customer.id,
      void_reason: "CUSTOMER_WITHDRAWN", updated_at: expect.any(Date) });
    expect(after.updated_at.getTime()).toBeGreaterThan(ticket.updated_at.getTime());
    await action(ticket.id, "withdraw", customer).expect(404);
    expect(await state(ticket.id)).toEqual(after);
    await expectHidden(ticket.id);
    const restored = await action(ticket.id, "restore").expect(200);
    expect(restored.body).toMatchObject({ id: ticket.id, status, priority: "HIGH",
      assignedTeam: { id: own.team.id }, assignedAgent: { id: agent.id } });
    expect(await state(ticket.id)).toEqual({ ...ticket, updated_at: expect.any(Date) });
    for (const actor of [customer, agent, admin]) {
      await request(app).get(`/tickets/${ticket.id}`).set("Cookie", actor.cookie).expect(200);
      const list = await request(app).get("/tickets?limit=100").set("Cookie", actor.cookie).expect(200);
      expect(list.body.tickets.map((row: { id: string }) => row.id)).toContain(ticket.id);
    }
  });

  it("conceals other customers and tenants and rejects CLOSED withdrawal", async () => {
    const neighbor = await principal(own, "CUSTOMER");
    const tickets = [
      { ticket: await seedTicket({ customer_id: neighbor.id }), expected: 404 },
      { ticket: await seedTicket({ organization_id: other.id, customer_id: foreignCustomer.id }), expected: 404 },
      { ticket: await seedTicket({ status: "CLOSED", closed_at: new Date() }), expected: 409 },
      { ticket: await seedTicket({ voided_at: new Date(), voided_by_user_id: admin.id, void_reason: "INVALID" }), expected: 404 },
    ];
    for (const { ticket, expected } of tickets) {
      await action(ticket.id, "withdraw", customer).expect(expected);
      expect(await state(ticket.id)).toEqual(ticket);
    }
    await action(randomUUID(), "withdraw", customer).expect(404);
  });

  it.each(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"] as const)("admin voids %s tickets with every staff reason and preserves all unrelated fields", async (status) => {
    for (const reason of ["INVALID", "SPAM", "DUPLICATE"]) {
      for (const assignment of [{}, { assigned_team_id: own.team.id, assigned_agent_id: agent.id }]) {
        const ticket = await seedTicket({ ...assignment, status, closed_at: status === "CLOSED" ? new Date() : null });
        const result = await action(ticket.id, "void", admin, { reason }).expect(200);
        expect(result.headers["cache-control"]).toBe("no-store");
        expect(result.body).toEqual({ id: ticket.id, voided: true, reason });
        const after = await state(ticket.id);
        expect(after).toEqual({ ...ticket, voided_at: expect.any(Date), voided_by_user_id: admin.id,
          void_reason: reason, updated_at: expect.any(Date) });
        await action(ticket.id, "void", admin, { reason: "INVALID" }).expect(404);
        expect(await state(ticket.id)).toEqual(after);
        const resultRestore = await action(ticket.id, "restore").expect(200);
        expect(resultRestore.headers["cache-control"]).toBe("no-store");
        expect(resultRestore.body).toMatchObject({ id: ticket.id, status, priority: ticket.priority,
          closedAt: ticket.closed_at?.toISOString() ?? null });
        const restored = await state(ticket.id);
        expect(restored).toEqual({ ...ticket, updated_at: expect.any(Date) });
        await action(ticket.id, "restore").expect(404);
        expect(await state(ticket.id)).toEqual(restored);
      }
    }
  });

  it.each(["OPEN", "CLOSED"] as const)("requires AGENT assignment authority, not just visibility, on %s", async (status) => {
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
      const ticket = await seedTicket({ ...assignment, status, closed_at: status === "CLOSED" ? new Date() : null });
      await action(ticket.id, "void", agent).expect(expected);
      if (expected !== 200) expect(await state(ticket.id)).toEqual(ticket);
      else {
        const after = await state(ticket.id);
        expect(after).toEqual({ ...ticket, voided_at: expect.any(Date), voided_by_user_id: agent.id,
          void_reason: "SPAM", updated_at: expect.any(Date) });
        await action(ticket.id, "void", agent).expect(404);
        expect(await state(ticket.id)).toEqual(after);
      }
    }
  });

  it("conceals foreign/unknown tickets from staff void and dedicated restore", async () => {
    const foreign = await seedTicket({ organization_id: other.id, customer_id: foreignCustomer.id });
    for (const actor of [agent, admin]) {
      await action(foreign.id, "void", actor).expect(404);
      await action(randomUUID(), "void", actor).expect(404);
    }
    await action(foreign.id, "restore").expect(404);
    await db.updateTable("tickets").set({ voided_at: new Date(), voided_by_user_id: foreignCustomer.id, void_reason: "CUSTOMER_WITHDRAWN" })
      .where("id", "=", foreign.id).execute();
    const before = await state(foreign.id);
    await action(foreign.id, "restore").expect(404);
    expect(await state(foreign.id)).toEqual(before);
    await action(randomUUID(), "restore").expect(404);
  });

  it("preserves public messages/private notes across void and restore without exposing notes", async () => {
    const ticket = await seedTicket({ assigned_agent_id: agent.id });
    const message = await db.insertInto("ticket_messages").values({ organization_id: own.id, ticket_id: ticket.id,
      author_user_id: customer.id, body: "Public conversation" }).returningAll().executeTakeFirstOrThrow();
    const note = await db.insertInto("ticket_internal_notes").values({ organization_id: own.id, ticket_id: ticket.id,
      author_user_id: agent.id, body: "CONFIDENTIAL-NOTE" }).returningAll().executeTakeFirstOrThrow();
    await action(ticket.id, "void").expect(200);
    await expectHidden(ticket.id);
    await request(app).patch(`/tickets/${ticket.id}/internal-notes/${note.id}`).set("Cookie", agent.cookie)
      .set("X-CSRF-Token", agent.csrf).send({ body: "No edit" }).expect(404);
    await action(ticket.id, "restore").expect(200);
    const detail = await request(app).get(`/tickets/${ticket.id}`).set("Cookie", customer.cookie).expect(200);
    expect(detail.body.messages).toHaveLength(1);
    expect(detail.body.messages[0].body).toBe(message.body);
    expect(JSON.stringify(detail.body)).not.toContain("CONFIDENTIAL");
    expect(detail.body).not.toHaveProperty("internalNotes");
    await request(app).get(`/tickets/${ticket.id}/internal-notes`).set("Cookie", customer.cookie).expect(403);
    const staffNotes = await request(app).get(`/tickets/${ticket.id}/internal-notes`).set("Cookie", agent.cookie).expect(200);
    expect(staffNotes.body.notes[0].body).toBe(note.body);
    expect(await db.selectFrom("ticket_messages").selectAll().where("ticket_id", "=", ticket.id).execute()).toEqual([message]);
    expect(await db.selectFrom("ticket_internal_notes").selectAll().where("ticket_id", "=", ticket.id).execute()).toEqual([note]);
  });

  it.each(["deactivate", "move", "team"] as const)("restores current assignments after %s lifecycle cleanup, never historical assignments", async (operation) => {
    const team = await createNormalTeam(db, own.id, `Cleanup ${randomUUID()}`);
    const actor = await principal(own, "AGENT", team.id);
    const ticket = await seedTicket({ status: "RESOLVED", assigned_team_id: team.id, assigned_agent_id: actor.id });
    await action(ticket.id, "void").expect(200);
    if (operation === "deactivate") await deactivateAgent(own.id, actor.id);
    else if (operation === "move") await reassignAgentTeam(own.id, actor.id, own.team.id);
    else await deactivateTeam(own.id, team.id);
    const cleaned = await state(ticket.id);
    expect(cleaned.assigned_team_id).toBe(operation === "team" ? null : team.id);
    expect(cleaned.assigned_agent_id).toBe(operation === "team" ? actor.id : null);
    const result = await action(ticket.id, "restore").expect(200);
    expect(result.body).toMatchObject({ status: "RESOLVED", priority: "HIGH" });
    expect(await state(ticket.id)).toEqual({ ...cleaned, voided_at: null, voided_by_user_id: null,
      void_reason: null, updated_at: expect.any(Date) });
  });

  it("enforces roles, authentication, CSRF and strict request bodies/UUIDs", async () => {
    const ticket = await seedTicket({ assigned_agent_id: agent.id });
    for (const path of ["withdraw", "void", "restore"] as const) {
      await request(app).post(`/tickets/${ticket.id}/${path}`).send({}).expect(401);
      const actor = path === "withdraw" ? customer : admin;
      await request(app).post(`/tickets/${ticket.id}/${path}`).set("Cookie", actor.cookie)
        .send(path === "void" ? { reason: "SPAM" } : {}).expect(403);
      await request(app).post(`/tickets/${ticket.id}/${path}`).set("Cookie", actor.cookie).set("X-CSRF-Token", "wrong")
        .send(path === "void" ? { reason: "SPAM" } : {}).expect(403);
      await action("invalid", path, actor).expect(400);
      for (const key of ["organizationId", "customerId", "status", "assignedAgentId", "updatedAt"]) {
        await action(ticket.id, path, actor, { ...(path === "void" ? { reason: "SPAM" } : {}), [key]: "untrusted" }).expect(400);
      }
    }
    await action(ticket.id, "withdraw", customer, { reason: "SPAM" }).expect(400);
    await action(ticket.id, "restore", admin, { reason: "SPAM" }).expect(400);
    for (const body of [{}, { reason: "CUSTOMER_WITHDRAWN" }, { reason: "OTHER" }, { reason: 42 }])
      await action(ticket.id, "void", admin, body).expect(400);
    await action(ticket.id, "void", customer).expect(403);
    for (const actor of [agent, admin]) await action(ticket.id, "withdraw", actor).expect(403);
    for (const actor of [agent, customer]) await action(ticket.id, "restore", actor).expect(403);
    await request(app).post(`/tickets/${ticket.id}/void`).set("Cookie", agent.cookie).send({ reason: "SPAM" }).expect(403);
    expect(await state(ticket.id)).toEqual(ticket);
  });

  it("only one racing void establishes immutable winner metadata", async () => {
    const ticket = await seedTicket({ assigned_agent_id: agent.id });
    let pending: Promise<unknown>[] = [];
    try {
      await db.transaction().execute(async (trx) => {
        await trx.selectFrom("tickets").select("id").where("id", "=", ticket.id).forUpdate().execute();
        pending = [
          voidTicket(admin.auth, ticket.id, "SPAM").catch((error: unknown) => error),
          voidTicket(agent.auth, ticket.id, "DUPLICATE").catch((error: unknown) => error),
        ];
        await vi.waitFor(async () => {
          const waiting = await sql<{ count: string }>`select count(*) from pg_stat_activity
            where datname = current_database() and usename = current_user and wait_event_type = 'Lock'
            and query like 'update "tickets"%'`.execute(db);
          expect(Number(waiting.rows[0]!.count)).toBe(2);
        }, { timeout: 5000, interval: 20 });
      });
      const results = await Promise.all(pending);
      const winner = results.findIndex((result) => (result as { voided?: boolean }).voided);
      expect(winner).toBeGreaterThanOrEqual(0);
      expect(results[1 - winner]).toMatchObject({ statusCode: 404 });
      const row = await state(ticket.id);
      expect(row).toEqual({ ...ticket, voided_at: expect.any(Date), updated_at: expect.any(Date),
        voided_by_user_id: winner === 0 ? admin.id : agent.id, void_reason: winner === 0 ? "SPAM" : "DUPLICATE" });
    } finally { await Promise.allSettled(pending); }
  }, 10000);

  it("only one racing restore updates the row", async () => {
    const ticket = await seedTicket({ voided_at: new Date(), voided_by_user_id: admin.id, void_reason: "SPAM" });
    let pending: Promise<unknown>[] = [];
    try {
      await db.transaction().execute(async (trx) => {
        await trx.selectFrom("tickets").select("id").where("id", "=", ticket.id).forUpdate().execute();
        pending = [0, 1].map(() => restoreTicket(admin.auth, ticket.id).catch((error: unknown) => error));
        await vi.waitFor(async () => {
          const waiting = await sql<{ count: string }>`select count(*) from pg_stat_activity
            where datname = current_database() and usename = current_user and wait_event_type = 'Lock'
            and query like 'update "tickets"%'`.execute(db);
          expect(Number(waiting.rows[0]!.count)).toBe(2);
        }, { timeout: 5000, interval: 20 });
      });
      const results = await Promise.all(pending);
      const winner = results.findIndex((result) => (result as { id?: string }).id === ticket.id);
      expect(winner).toBeGreaterThanOrEqual(0);
      expect(results[1 - winner]).toMatchObject({ statusCode: 404 });
      expect(await state(ticket.id)).toEqual({ ...ticket, voided_at: null, voided_by_user_id: null, void_reason: null,
        updated_at: (results[winner] as { updatedAt: Date }).updatedAt });
    } finally { await Promise.allSettled(pending); }
  }, 10000);

  it.each(["deactivate", "reassign"] as const)("rejects stale AGENT void authorization when %s wins", async (operation) => {
    const team = await createNormalTeam(db, own.id, `Race ${randomUUID()}`);
    const actor = await principal(own, "AGENT", team.id);
    const ticket = await seedTicket({ assigned_team_id: team.id });
    let pending: Promise<unknown> | undefined;
    try {
      await db.transaction().execute(async (trx) => {
        await trx.updateTable("users").set(operation === "deactivate" ? { deactivated_at: new Date() } : { team_id: own.team.id })
          .where("id", "=", actor.id).execute();
        pending = voidTicket(actor.auth, ticket.id, "SPAM").catch((error: unknown) => error);
        await vi.waitFor(async () => {
          const waiting = await sql<{ count: string }>`select count(*) from pg_stat_activity
            where datname = current_database() and usename = current_user and wait_event_type = 'Lock'
            and query like '%for share%'`.execute(db);
          expect(Number(waiting.rows[0]!.count)).toBe(1);
        }, { timeout: 5000, interval: 20 });
      });
      expect(await pending).toMatchObject({ statusCode: operation === "deactivate" ? 401 : 404 });
      expect(await state(ticket.id)).toEqual(ticket);
    } finally { await pending; }
  }, 10000);

  it.each(["assignment", "closed"] as const)("rechecks the final UPDATE after %s wins the ticket lock", async (change) => {
    const ticket = await seedTicket({ assigned_team_id: own.team.id });
    let pending: Promise<unknown> | undefined;
    try {
      await db.transaction().execute(async (trx) => {
        await trx.updateTable("tickets").set(change === "assignment" ? { assigned_agent_id: colleague.id }
          : { status: "CLOSED", closed_at: new Date() }).where("id", "=", ticket.id).execute();
        pending = (change === "assignment" ? voidTicket(agent.auth, ticket.id, "SPAM")
          : withdrawTicket(customer.auth, ticket.id)).catch((error: unknown) => error);
        await vi.waitFor(async () => {
          const waiting = await sql<{ count: string }>`select count(*) from pg_stat_activity
            where datname = current_database() and usename = current_user and wait_event_type = 'Lock'
            and query like 'update "tickets"%'`.execute(db);
          expect(Number(waiting.rows[0]!.count)).toBe(1);
        }, { timeout: 5000, interval: 20 });
      });
      expect(await pending).toMatchObject({ statusCode: 409 });
      const row = await state(ticket.id);
      expect(row.voided_at).toBeNull();
      expect(row.voided_by_user_id).toBeNull();
      expect(row.void_reason).toBeNull();
      expect(row.updated_at).toEqual(ticket.updated_at);
    } finally { await pending; }
  }, 10000);
});
