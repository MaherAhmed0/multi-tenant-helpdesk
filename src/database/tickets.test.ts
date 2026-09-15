import { randomUUID } from "node:crypto";

import type { Insertable } from "kysely";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "./db.js";
import type { TicketsTable } from "./types.js";
import { createOrganization } from "../organization-registration/organization.repository.js";
import { createUser } from "../organization-registration/user.repository.js";
import { createGeneralTeam } from "../teams/team.repository.js";

async function tenant() {
  const organization = await createOrganization(db, {
    name: "Ticket schema tenant",
    slug: `tickets-${randomUUID()}`,
  });
  const team = await createGeneralTeam(db, organization.id);
  const customer = await createUser(db, {
    organizationId: organization.id,
    name: "Customer",
    email: `${randomUUID()}@example.com`,
    passwordHash: "test-only-hash",
    role: "CUSTOMER",
  });
  const agent = await createUser(db, {
    organizationId: organization.id,
    name: "Agent",
    email: `${randomUUID()}@example.com`,
    passwordHash: "test-only-hash",
    role: "AGENT",
    teamId: team.id,
  });
  const ticket = await db
    .insertInto("tickets")
    .values({
      organization_id: organization.id,
      customer_id: customer.id,
      subject: "Initial ticket",
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return { organization, team, customer, agent, ticket };
}

let own: Awaited<ReturnType<typeof tenant>>;
let other: typeof own;
beforeAll(async () => {
  own = await tenant();
  other = await tenant();
});
afterAll(async () => {
  await db.destroy();
});

function insertTicket(overrides: Partial<Insertable<TicketsTable>> = {}) {
  return db
    .insertInto("tickets")
    .values({
      organization_id: own.organization.id,
      customer_id: own.customer.id,
      subject: "Help with billing",
      ...overrides,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

describe("ticket database foundation", () => {
  it("denies raw SQL updates to ticket identity while permitting mutable workflow fields", async () => {
    const ticket = await insertTicket();
    for (const column of ["id", "organization_id", "customer_id", "created_at"]) {
      await expect(sql`
        UPDATE tickets SET ${sql.ref(column)} = ${sql.ref(column)}
        WHERE organization_id = ${own.organization.id} AND id = ${ticket.id}
      `.execute(db)).rejects.toMatchObject({ code: "42501" });
    }
    const updated = await db.updateTable("tickets")
      .set({ status: "IN_PROGRESS", priority: "HIGH", updated_at: new Date() })
      .where("organization_id", "=", own.organization.id).where("id", "=", ticket.id)
      .returningAll().executeTakeFirstOrThrow();
    expect(updated).toMatchObject({
      id: ticket.id, organization_id: ticket.organization_id, customer_id: ticket.customer_id,
      created_at: ticket.created_at, status: "IN_PROGRESS", priority: "HIGH",
    });
  });

  it("uses UUIDv7, timestamp and lifecycle defaults for an own-tenant customer", async () => {
    const ticket = await insertTicket();
    expect(ticket.id[14]).toBe("7");
    expect(ticket).toMatchObject({
      organization_id: own.organization.id,
      customer_id: own.customer.id,
      status: "OPEN",
      priority: "NORMAL",
      assigned_team_id: null,
      assigned_agent_id: null,
      voided_at: null,
      voided_by_user_id: null,
      void_reason: null,
      closed_at: null,
      created_at: expect.any(Date),
      updated_at: expect.any(Date),
    });
    expect(ticket.updated_at).toEqual(ticket.created_at);
    expect(ticket).not.toHaveProperty("description");
  });

  it("allows same-tenant assignments and complete void metadata independently of workflow status", async () => {
    const ticket = await insertTicket({
      assigned_team_id: own.team.id,
      assigned_agent_id: own.agent.id,
      voided_at: new Date(),
      voided_by_user_id: own.agent.id,
      void_reason: "DUPLICATE",
    });
    expect(ticket).toMatchObject({
      status: "OPEN",
      assigned_team_id: own.team.id,
      assigned_agent_id: own.agent.id,
      void_reason: "DUPLICATE",
    });
    await db
      .updateTable("tickets")
      .set({ voided_at: null, voided_by_user_id: null, void_reason: null })
      .where("organization_id", "=", own.organization.id)
      .where("id", "=", ticket.id)
      .execute();
    // Agent-only assignment is deliberately structurally valid.
    expect(
      await insertTicket({ assigned_agent_id: own.agent.id }),
    ).toMatchObject({ assigned_team_id: null });
  });

  it.each([
    ["customer_id", "tickets_customer_tenant_fk"],
    ["assigned_agent_id", "tickets_agent_tenant_fk"],
    ["assigned_team_id", "tickets_team_tenant_fk"],
    ["voided_by_user_id", "tickets_voiding_user_tenant_fk"],
  ] as const)("rejects cross-tenant %s", async (field, constraint) => {
    const foreignId =
      field === "assigned_team_id"
        ? other.team.id
        : field === "customer_id"
          ? other.customer.id
          : other.agent.id;
    await expect(
      insertTicket({
        [field]: foreignId,
        ...(field === "voided_by_user_id"
          ? { voided_at: new Date(), void_reason: "SPAM" as const }
          : {}),
      }),
    ).rejects.toMatchObject({ code: "23503", constraint });
  });

  it("rejects unknown organizations", async () => {
    await expect(
      insertTicket({ organization_id: randomUUID() }),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("rejects invalid status, priority and void reason even when TypeScript validation is bypassed", async () => {
    const ticket = await insertTicket();
    // Raw SQL through Kysely intentionally bypasses the TypeScript unions.
    await expect(
      sql`UPDATE tickets SET status = 'SPAM' WHERE organization_id = ${own.organization.id} AND id = ${ticket.id}`.execute(
        db,
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "tickets_status_check",
    });
    await expect(
      sql`UPDATE tickets SET priority = 'CRITICAL' WHERE organization_id = ${own.organization.id} AND id = ${ticket.id}`.execute(
        db,
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "tickets_priority_check",
    });
    await expect(
      sql`
      UPDATE tickets SET voided_at = CURRENT_TIMESTAMP, voided_by_user_id = ${own.agent.id}, void_reason = 'OTHER'
      WHERE organization_id = ${own.organization.id} AND id = ${ticket.id}
    `.execute(db),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "tickets_void_reason_check",
    });
  });

  it.each([
    [true, false, false],
    [false, true, false],
    [false, false, true],
    [true, true, false],
    [true, false, true],
    [false, true, true],
  ])(
    "rejects partial void metadata (timestamp=%s, actor=%s, reason=%s)",
    async (timestamp, actor, reason) => {
      await expect(
        insertTicket({
          voided_at: timestamp ? new Date() : null,
          voided_by_user_id: actor ? own.agent.id : null,
          void_reason: reason ? "CUSTOMER_WITHDRAWN" : null,
        }),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "tickets_void_metadata_check",
      });
    },
  );

  it("requires closed_at exactly when CLOSED", async () => {
    await expect(insertTicket({ status: "CLOSED" })).rejects.toMatchObject({
      code: "23514",
      constraint: "tickets_closed_at_check",
    });
    for (const status of ["OPEN", "IN_PROGRESS", "RESOLVED"] as const) {
      await expect(
        insertTicket({ status, closed_at: new Date() }),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "tickets_closed_at_check",
      });
      await expect(insertTicket({ status })).resolves.toMatchObject({
        status,
        closed_at: null,
      });
    }
    await expect(
      insertTicket({ status: "CLOSED", closed_at: new Date() }),
    ).resolves.toMatchObject({ status: "CLOSED", closed_at: expect.any(Date) });
  });

  it.each(["", "   ", "\t\r\n"])(
    "rejects blank subjects (%j)",
    async (subject) => {
      await expect(insertTicket({ subject })).rejects.toMatchObject({
        code: "23514",
        constraint: "tickets_subject_check",
      });
    },
  );

  describe.each(["ticket_messages", "ticket_internal_notes"] as const)(
    "%s",
    (table) => {
      it("creates a separate timestamped UUIDv7 resource with same-tenant relationships", async () => {
        const row = await db
          .insertInto(table)
          .values({
            organization_id: own.organization.id,
            ticket_id: own.ticket.id,
            author_user_id: own.customer.id,
            body: "Initial description or note",
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        expect(row.id[14]).toBe("7");
        expect(row.created_at).toBeInstanceOf(Date);
        if (table === "ticket_messages")
          expect(row).not.toHaveProperty("updated_at");
        else expect(row).toHaveProperty("updated_at", row.created_at);
      });

      it.each(["ticket", "author"] as const)(
        "rejects a cross-tenant %s",
        async (reference) => {
          await expect(
            db
              .insertInto(table)
              .values({
                organization_id: own.organization.id,
                ticket_id:
                  reference === "ticket" ? other.ticket.id : own.ticket.id,
                author_user_id:
                  reference === "author" ? other.agent.id : own.agent.id,
                body: "Tenant boundary test",
              })
              .execute(),
          ).rejects.toMatchObject({
            code: "23503",
            constraint: `${table}_${reference}_tenant_fk`,
          });
        },
      );

      it.each(["", "   ", "\t\r\n"])(
        "rejects blank bodies (%j)",
        async (body) => {
          await expect(
            db
              .insertInto(table)
              .values({
                organization_id: own.organization.id,
                ticket_id: own.ticket.id,
                author_user_id: own.agent.id,
                body,
              })
              .execute(),
          ).rejects.toMatchObject({
            code: "23514",
            constraint: `${table}_body_check`,
          });
        },
      );
    },
  );

  it("keeps messages immutable for runtime while allowing only note content/timestamp edits", async () => {
    const message = await db
      .insertInto("ticket_messages")
      .values({
        organization_id: own.organization.id,
        ticket_id: own.ticket.id,
        author_user_id: own.customer.id,
        body: "Original message",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await expect(
      sql`UPDATE ticket_messages SET body = 'Changed' WHERE id = ${message.id}`.execute(
        db,
      ),
    ).rejects.toMatchObject({ code: "42501" });
    const note = await db
      .insertInto("ticket_internal_notes")
      .values({
        organization_id: own.organization.id,
        ticket_id: own.ticket.id,
        author_user_id: own.agent.id,
        body: "Original note",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await expect(
      db
        .updateTable("ticket_internal_notes")
        .set({ body: "Edited note", updated_at: new Date() })
        .where("organization_id", "=", own.organization.id)
        .where("id", "=", note.id)
        .returning("body")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ body: "Edited note" });
    await expect(
      sql`UPDATE ticket_internal_notes SET author_user_id = ${own.customer.id} WHERE id = ${note.id}`.execute(
        db,
      ),
    ).rejects.toMatchObject({ code: "42501" });
    const privileges = await sql<{
      table_name: string;
      can_delete: boolean;
      can_truncate: boolean;
    }>`
      SELECT table_name, has_table_privilege(current_user, table_name, 'DELETE') AS can_delete,
        has_table_privilege(current_user, table_name, 'TRUNCATE') AS can_truncate
      FROM (VALUES ('tickets'), ('ticket_messages'), ('ticket_internal_notes')) AS tables(table_name)
    `.execute(db);
    expect(privileges.rows).toHaveLength(3);
    for (const row of privileges.rows) {
      expect(row).toMatchObject({ can_delete: false, can_truncate: false });
    }
  });
});
