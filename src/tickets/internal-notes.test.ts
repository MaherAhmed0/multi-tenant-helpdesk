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
import { addTicketNote, editTicketNote } from "./ticket-notes.service.js";
import * as notes from "./ticket-note.repository.js";

async function tenant() {
  const organization = await createOrganization(db, { name: "Notes tenant", slug: `notes-${randomUUID()}` });
  return { id: organization.id, team: await createGeneralTeam(db, organization.id) };
}
async function principal(owner: Awaited<ReturnType<typeof tenant>>, role: TenantRole, teamId = owner.team.id) {
  const user = await createUser(db, { organizationId: owner.id, role, name: "Note actor", email: `${randomUUID()}@example.com`,
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
  return db.insertInto("tickets").values({ organization_id: own.id, customer_id: customer.id, subject: "Notes ticket",
    priority: "HIGH", created_at: new Date("2026-01-01T00:00:00Z"), updated_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides }).returningAll().executeTakeFirstOrThrow();
}
function state(id: string) {
  return db.selectFrom("tickets").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
}
function storedNotes(id: string) {
  return db.selectFrom("ticket_internal_notes").selectAll().where("organization_id", "=", own.id).where("ticket_id", "=", id).execute();
}
function seedNote(ticketId: string, actor = admin, body = "Private note", createdAt = new Date("2026-01-01T00:00:00Z")) {
  return db.insertInto("ticket_internal_notes").values({
    organization_id: actor.auth.organizationId, ticket_id: ticketId, author_user_id: actor.id, body,
    created_at: createdAt, updated_at: createdAt,
  }).returningAll().executeTakeFirstOrThrow();
}
function read(id: string, actor = admin) {
  return request(app).get(`/tickets/${id}/internal-notes`).set("Cookie", actor.cookie);
}
function create(id: string, actor = admin, body: object = { body: "  Private note  " }) {
  return request(app).post(`/tickets/${id}/internal-notes`).set("Cookie", actor.cookie).set("X-CSRF-Token", actor.csrf).send(body);
}
function edit(id: string, noteId: string, actor = admin, body: object = { body: "  Edited private note  " }) {
  return request(app).patch(`/tickets/${id}/internal-notes/${noteId}`).set("Cookie", actor.cookie).set("X-CSRF-Token", actor.csrf).send(body);
}

describe("staff internal notes", () => {
  it.each(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"] as const)("documents %s without changing any ticket state", async (status) => {
    const ticket = await seedTicket({ status, closed_at: status === "CLOSED" ? new Date() : null,
      assigned_team_id: own.team.id, assigned_agent_id: agent.id });
    for (const actor of [admin, agent]) {
      const result = await create(ticket.id, actor).expect(201);
      expect(result.headers["cache-control"]).toBe("no-store");
      expect(result.body).toEqual({ id: expect.any(String), body: "Private note",
        author: { id: actor.id, name: actor.name }, createdAt: expect.any(String), updatedAt: expect.any(String) });
      const before = (await storedNotes(ticket.id)).find((note) => note.id === result.body.id)!;
      expect(before).toMatchObject({ organization_id: own.id, ticket_id: ticket.id, author_user_id: actor.id, body: "Private note" });
      const changed = await edit(ticket.id, result.body.id, actor).expect(200);
      expect(changed.headers["cache-control"]).toBe("no-store");
      const after = (await storedNotes(ticket.id)).find((note) => note.id === result.body.id)!;
      expect(after).toEqual({ ...before, body: "Edited private note", updated_at: expect.any(Date) });
      expect(after.updated_at.getTime()).toBeGreaterThanOrEqual(before.updated_at.getTime());
      expect(await state(ticket.id)).toEqual(ticket);
      expect(await db.selectFrom("ticket_messages").select("id").where("ticket_id", "=", ticket.id).execute()).toEqual([]);
      expect((await read(ticket.id, actor).expect(200)).body.notes).toContainEqual(changed.body);
    }
  });

  it.each(["OPEN", "CLOSED"] as const)("separates broad visibility from creation authority on %s tickets", async (status) => {
    const differentTeam = await createNormalTeam(db, own.id, `Other ${randomUUID()}`);
    const cases = [
      { assigned_agent_id: agent.id, assigned_team_id: null, readable: 200, writable: 201 },
      { assigned_agent_id: null, assigned_team_id: own.team.id, readable: 200, writable: 201 },
      { assigned_agent_id: null, assigned_team_id: null, readable: 200, writable: 409 },
      { assigned_agent_id: colleague.id, assigned_team_id: own.team.id, readable: 200, writable: 409 },
      { assigned_agent_id: colleague.id, assigned_team_id: null, readable: 404, writable: 404 },
      { assigned_agent_id: null, assigned_team_id: differentTeam.id, readable: 404, writable: 404 },
    ];
    for (const { readable, writable, ...assignment } of cases) {
      const ticket = await seedTicket({ ...assignment, status, closed_at: status === "CLOSED" ? new Date() : null });
      const note = await seedNote(ticket.id);
      const result = await read(ticket.id, agent).expect(readable);
      if (readable === 200) expect(result.body.notes.map((row: { id: string }) => row.id)).toEqual([note.id]);
      await create(ticket.id, agent).expect(writable);
      await create(ticket.id, admin).expect(201);
      await read(ticket.id, admin).expect(200);
      expect(await state(ticket.id)).toEqual(ticket);
    }
  });

  it("orders notes by timestamp/id and resolves current author names", async () => {
    const ticket = await seedTicket();
    const actor = await principal(own, "ORGANIZATION_ADMIN");
    const later = await seedNote(ticket.id, actor, "Later", new Date("2026-01-02T00:00:00Z"));
    const first = await seedNote(ticket.id, actor, "First");
    const second = await seedNote(ticket.id, actor, "Second");
    await db.updateTable("users").set({ name: "Updated author" }).where("id", "=", actor.id).execute();
    const result = await read(ticket.id).expect(200);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.body.notes.map((row: { id: string }) => row.id)).toEqual([first.id, second.id].sort().concat(later.id));
    for (const note of result.body.notes) expect(note.author).toEqual({ id: actor.id, name: "Updated author" });
  });

  it("requires authorship even for admins, plus current visibility rather than creation authority", async () => {
    const team = await createNormalTeam(db, own.id, `Edit ${randomUUID()}`);
    const actor = await principal(own, "AGENT", team.id);
    const ticket = await seedTicket({ assigned_team_id: team.id });
    const result = await create(ticket.id, actor).expect(201);
    await db.updateTable("tickets").set({ assigned_agent_id: colleague.id }).where("id", "=", ticket.id).execute();
    await create(ticket.id, actor).expect(409);
    await edit(ticket.id, result.body.id, actor).expect(200);
    for (const otherActor of [admin, colleague]) {
      const denied = await edit(ticket.id, result.body.id, otherActor).expect(404);
      expect(denied.body).toEqual({ error: "Internal note not found" });
    }
    const unrelated = await seedTicket();
    await edit(unrelated.id, result.body.id, admin).expect(404);
    await db.updateTable("users").set({ team_id: own.team.id }).where("id", "=", actor.id).execute();
    await edit(ticket.id, result.body.id, actor).expect(404);
    expect((await storedNotes(ticket.id))[0]!.body).toBe("Edited private note");
  });

  it("conceals foreign, voided and nonexistent tickets and foreign note IDs", async () => {
    const foreign = await seedTicket({ organization_id: other.id, customer_id: foreignCustomer.id });
    const foreignNote = await seedNote(foreign.id, foreignCustomer);
    const voided = await seedTicket({ assigned_agent_id: agent.id, voided_at: new Date(), voided_by_user_id: admin.id, void_reason: "SPAM" });
    const voidedNote = await seedNote(voided.id);
    const visible = await seedTicket({ assigned_agent_id: agent.id });
    for (const actor of [admin, agent]) {
      for (const id of [foreign.id, voided.id, randomUUID()]) {
        await read(id, actor).expect(404);
        await create(id, actor).expect(404);
        await edit(id, voidedNote.id, actor).expect(404);
      }
      await edit(visible.id, foreignNote.id, actor).expect(404);
      await edit(visible.id, randomUUID(), actor).expect(404);
    }
    expect(await state(voided.id)).toEqual(voided);
  });

  it("denies customers and keeps private content out of every public representation", async () => {
    const ticket = await seedTicket({ assigned_agent_id: agent.id });
    const note = await create(ticket.id, agent, { body: "CONFIDENTIAL-INTERNAL-CONTENT" }).expect(201);
    await edit(ticket.id, note.body.id, agent, { body: "CONFIDENTIAL-EDITED-CONTENT" }).expect(200);
    await read(ticket.id, customer).expect(403);
    await create(ticket.id, customer).expect(403);
    await edit(ticket.id, note.body.id, customer).expect(403);
    expect(await db.selectFrom("ticket_messages").select("id").where("ticket_id", "=", ticket.id).execute()).toEqual([]);
    expect(await state(ticket.id)).toEqual(ticket);
    const list = await request(app).get("/tickets").set("Cookie", customer.cookie).expect(200);
    const empty = await request(app).get(`/tickets/${ticket.id}`).set("Cookie", customer.cookie).expect(200);
    expect(empty.body.messages).toEqual([]);
    const reply = await request(app).post(`/tickets/${ticket.id}/messages`).set("Cookie", agent.cookie)
      .set("X-CSRF-Token", agent.csrf).send({ message: "Public reply" }).expect(201);
    const detail = await request(app).get(`/tickets/${ticket.id}`).set("Cookie", customer.cookie).expect(200);
    expect(detail.body.messages).toEqual([reply.body.message]);
    for (const result of [list, empty, reply, detail]) {
      expect(JSON.stringify(result.body)).not.toContain("CONFIDENTIAL");
      expect(JSON.stringify(result.body)).not.toContain("internalNotes");
      expect(JSON.stringify(result.body)).not.toContain(note.body.id);
    }
  });

  it("requires authentication, mutation CSRF, UUIDs and strict bounded bodies", async () => {
    const ticket = await seedTicket();
    const note = await seedNote(ticket.id);
    await request(app).get(`/tickets/${ticket.id}/internal-notes`).expect(401);
    await request(app).post(`/tickets/${ticket.id}/internal-notes`).send({ body: "Note" }).expect(401);
    await request(app).patch(`/tickets/${ticket.id}/internal-notes/${note.id}`).send({ body: "Note" }).expect(401);
    for (const token of [undefined, "wrong"]) {
      for (const method of ["post", "patch"] as const) {
        const req = request(app)[method](`/tickets/${ticket.id}/internal-notes${method === "patch" ? `/${note.id}` : ""}`).set("Cookie", admin.cookie);
        if (token) req.set("X-CSRF-Token", token);
        await req.send({ body: "Note" }).expect(403);
      }
    }
    await read("invalid").expect(400);
    await create("invalid").expect(400);
    await edit(ticket.id, "invalid").expect(400);
    for (const body of [{}, { body: "   " }, { body: 2 }, { body: "a".repeat(10001) },
      ...["authorId", "organizationId", "ticketId", "role", "createdAt"].map((key) => ({ body: "Note", [key]: "untrusted" }))]) {
      await create(ticket.id, admin, body).expect(400);
      await edit(ticket.id, note.id, admin, body).expect(400);
    }
    expect((await storedNotes(ticket.id))[0]).toEqual(note);
  });

  it.each(["deactivate", "reassign"] as const)("rejects create/edit when agent %s wins the actor lock first", async (action) => {
    const team = await createNormalTeam(db, own.id, `Race ${randomUUID()}`);
    const actor = await principal(own, "AGENT", team.id);
    const ticket = await seedTicket({ assigned_team_id: team.id });
    const note = await seedNote(ticket.id, actor);
    let pending: Promise<unknown>[] = [];
    try {
      await db.transaction().execute(async (trx) => {
        await trx.updateTable("users").set(action === "deactivate" ? { deactivated_at: new Date() } : { team_id: own.team.id })
          .where("id", "=", actor.id).execute();
        pending = [
          addTicketNote(actor.auth, ticket.id, "Stale creation").catch((error: unknown) => error),
          editTicketNote(actor.auth, ticket.id, note.id, "Stale edit").catch((error: unknown) => error),
        ];
        await vi.waitFor(async () => {
          const waiting = await sql<{ count: string }>`select count(*) from pg_stat_activity
            where datname = current_database() and usename = current_user and wait_event_type = 'Lock'
            and query like '%for share%'`.execute(db);
          expect(Number(waiting.rows[0]!.count)).toBe(2);
        }, { timeout: 5000, interval: 20 });
      });
      for (const result of await Promise.all(pending)) expect(result).toMatchObject({ statusCode: action === "deactivate" ? 401 : 404 });
      expect(await storedNotes(ticket.id)).toEqual([note]);
      expect(await state(ticket.id)).toEqual(ticket);
    } finally { await Promise.allSettled(pending); }
  }, 10000);

  it.each(["assign", "void"] as const)("revalidates creation after a concurrent ticket %s wins", async (action) => {
    const ticket = await seedTicket({ assigned_team_id: own.team.id });
    let pending: Promise<unknown> | undefined;
    try {
      await db.transaction().execute(async (trx) => {
        await trx.updateTable("tickets").set(action === "assign" ? { assigned_agent_id: colleague.id }
          : { voided_at: new Date(), voided_by_user_id: admin.id, void_reason: "SPAM" }).where("id", "=", ticket.id).execute();
        pending = addTicketNote(agent.auth, ticket.id, "Stale creation").catch((error: unknown) => error);
        await vi.waitFor(async () => {
          const waiting = await sql<{ count: string }>`select count(*) from pg_stat_activity
            where datname = current_database() and usename = current_user and wait_event_type = 'Lock'
            and query like '%for share%'`.execute(db);
          expect(Number(waiting.rows[0]!.count)).toBe(1);
        }, { timeout: 5000, interval: 20 });
      });
      expect(await pending).toMatchObject({ statusCode: action === "assign" ? 409 : 404 });
      expect(await storedNotes(ticket.id)).toEqual([]);
      expect((await state(ticket.id)).updated_at).toEqual(ticket.updated_at);
    } finally { await pending; }
  }, 10000);

  it("revalidates edit visibility when ticket reassignment wins first", async () => {
    const ticket = await seedTicket({ assigned_agent_id: agent.id });
    const note = await seedNote(ticket.id, agent);
    let pending: Promise<unknown> | undefined;
    try {
      await db.transaction().execute(async (trx) => {
        await trx.updateTable("tickets").set({ assigned_agent_id: colleague.id }).where("id", "=", ticket.id).execute();
        pending = editTicketNote(agent.auth, ticket.id, note.id, "Stale edit").catch((error: unknown) => error);
        await vi.waitFor(async () => {
          const waiting = await sql<{ count: string }>`select count(*) from pg_stat_activity
            where datname = current_database() and usename = current_user and wait_event_type = 'Lock'
            and query like '%for share%'`.execute(db);
          expect(Number(waiting.rows[0]!.count)).toBe(1);
        }, { timeout: 5000, interval: 20 });
      });
      expect(await pending).toMatchObject({ statusCode: 404 });
      expect(await storedNotes(ticket.id)).toEqual([note]);
    } finally { await pending; }
  }, 10000);

  it.each(["AGENT", "ORGANIZATION_ADMIN"] as const)("holds the %s ticket share lock through insertion without exclusive locking", async (role) => {
    const actor = role === "AGENT" ? agent : admin;
    const ticket = await seedTicket({ assigned_team_id: own.team.id });
    let unlock!: () => void; let reached!: () => void;
    const hold = new Promise<void>((resolve) => { unlock = resolve; });
    const locked = new Promise<void>((resolve) => { reached = resolve; });
    const original = notes.createTicketNote;
    vi.spyOn(notes, "createTicketNote").mockImplementationOnce(async (...args) => {
      reached(); await hold; return original(...args);
    });
    const pending = create(ticket.id, actor).then((response) => response);
    let competing: Promise<unknown> | undefined;
    try {
      await locked;
      // A second shared reader remains compatible; a ticket writer must wait.
      await db.transaction().execute(async (trx) => {
        await sql`set local lock_timeout = '1s'`.execute(trx);
        await trx.selectFrom("tickets").select("id").where("id", "=", ticket.id).forShare().execute();
      });
      competing = db.updateTable("tickets").set({ assigned_agent_id: colleague.id }).where("id", "=", ticket.id).execute();
      void competing.catch(() => {});
      await vi.waitFor(async () => {
        const waiting = await sql<{ count: string }>`select count(*) from pg_stat_activity
          where datname = current_database() and usename = current_user and wait_event_type = 'Lock'`.execute(db);
        expect(Number(waiting.rows[0]!.count)).toBe(1);
      }, { timeout: 5000, interval: 20 });
      unlock();
      expect((await pending).status).toBe(201);
      await competing;
      expect(await storedNotes(ticket.id)).toHaveLength(1);
      expect((await state(ticket.id)).updated_at).toEqual(ticket.updated_at);
    } finally { unlock(); await Promise.allSettled([pending, competing]); }
  }, 10000);
});
