import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("tickets")
    .addColumn("id", "uuid", (col) =>
      col
        .primaryKey()
        .notNull()
        .defaultTo(sql`uuidv7()`),
    )
    .addColumn("organization_id", "uuid", (col) =>
      col.notNull().references("organizations.id").onDelete("restrict"),
    )
    .addColumn("customer_id", "uuid", (col) => col.notNull())
    .addColumn("subject", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull().defaultTo("OPEN"))
    .addColumn("priority", "text", (col) => col.notNull().defaultTo("NORMAL"))
    .addColumn("assigned_team_id", "uuid")
    .addColumn("assigned_agent_id", "uuid")
    .addColumn("voided_at", "timestamptz")
    .addColumn("voided_by_user_id", "uuid")
    .addColumn("void_reason", "text")
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addColumn("closed_at", "timestamptz")
    .addUniqueConstraint("tickets_organization_id_id_unique", [
      "organization_id",
      "id",
    ])
    .addForeignKeyConstraint(
      "tickets_customer_tenant_fk",
      ["organization_id", "customer_id"],
      "users",
      ["organization_id", "id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .addForeignKeyConstraint(
      "tickets_agent_tenant_fk",
      ["organization_id", "assigned_agent_id"],
      "users",
      ["organization_id", "id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .addForeignKeyConstraint(
      "tickets_team_tenant_fk",
      ["organization_id", "assigned_team_id"],
      "teams",
      ["organization_id", "id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .addForeignKeyConstraint(
      "tickets_voiding_user_tenant_fk",
      ["organization_id", "voided_by_user_id"],
      "users",
      ["organization_id", "id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .addCheckConstraint("tickets_subject_check", sql`subject ~ '[^[:space:]]'`)
    .addCheckConstraint(
      "tickets_status_check",
      sql`status IN ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED')`,
    )
    .addCheckConstraint(
      "tickets_priority_check",
      sql`priority IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')`,
    )
    .addCheckConstraint(
      "tickets_closed_at_check",
      sql`
      (status = 'CLOSED' AND closed_at IS NOT NULL)
      OR (status <> 'CLOSED' AND closed_at IS NULL)
    `,
    )
    .addCheckConstraint(
      "tickets_void_reason_check",
      sql`
      void_reason IN ('CUSTOMER_WITHDRAWN', 'INVALID', 'SPAM', 'DUPLICATE')
    `,
    )
    .addCheckConstraint(
      "tickets_void_metadata_check",
      sql`
      (voided_at IS NULL AND voided_by_user_id IS NULL AND void_reason IS NULL)
      OR (voided_at IS NOT NULL AND voided_by_user_id IS NOT NULL AND void_reason IS NOT NULL)
    `,
    )
    .execute();

  // Normal customer/organization lists and assignment queues exclude voided tickets.
  await db.schema
    .createIndex("tickets_customer_chronological_idx")
    .on("tickets")
    .columns(["organization_id", "customer_id", "created_at", "id"])
    .where(sql<boolean>`voided_at IS NULL`)
    .execute();
  await db.schema
    .createIndex("tickets_status_chronological_idx")
    .on("tickets")
    .columns(["organization_id", "status", "created_at", "id"])
    .where(sql<boolean>`voided_at IS NULL`)
    .execute();
  await db.schema
    .createIndex("tickets_agent_assignment_idx")
    .on("tickets")
    .columns(["organization_id", "assigned_agent_id"])
    .where(sql<boolean>`voided_at IS NULL AND assigned_agent_id IS NOT NULL`)
    .execute();
  await db.schema
    .createIndex("tickets_team_assignment_idx")
    .on("tickets")
    .columns(["organization_id", "assigned_team_id"])
    .where(sql<boolean>`voided_at IS NULL AND assigned_team_id IS NOT NULL`)
    .execute();

  await db.schema
    .createTable("ticket_messages")
    .addColumn("id", "uuid", (col) =>
      col
        .primaryKey()
        .notNull()
        .defaultTo(sql`uuidv7()`),
    )
    .addColumn("organization_id", "uuid", (col) => col.notNull())
    .addColumn("ticket_id", "uuid", (col) => col.notNull())
    .addColumn("author_user_id", "uuid", (col) => col.notNull())
    .addColumn("body", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addForeignKeyConstraint(
      "ticket_messages_ticket_tenant_fk",
      ["organization_id", "ticket_id"],
      "tickets",
      ["organization_id", "id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .addForeignKeyConstraint(
      "ticket_messages_author_tenant_fk",
      ["organization_id", "author_user_id"],
      "users",
      ["organization_id", "id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .addCheckConstraint(
      "ticket_messages_body_check",
      sql`body ~ '[^[:space:]]'`,
    )
    .execute();
  await db.schema
    .createIndex("ticket_messages_chronological_idx")
    .on("ticket_messages")
    .columns(["organization_id", "ticket_id", "created_at", "id"])
    .execute();

  await db.schema
    .createTable("ticket_internal_notes")
    .addColumn("id", "uuid", (col) =>
      col
        .primaryKey()
        .notNull()
        .defaultTo(sql`uuidv7()`),
    )
    .addColumn("organization_id", "uuid", (col) => col.notNull())
    .addColumn("ticket_id", "uuid", (col) => col.notNull())
    .addColumn("author_user_id", "uuid", (col) => col.notNull())
    .addColumn("body", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addForeignKeyConstraint(
      "ticket_internal_notes_ticket_tenant_fk",
      ["organization_id", "ticket_id"],
      "tickets",
      ["organization_id", "id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .addForeignKeyConstraint(
      "ticket_internal_notes_author_tenant_fk",
      ["organization_id", "author_user_id"],
      "users",
      ["organization_id", "id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .addCheckConstraint(
      "ticket_internal_notes_body_check",
      sql`body ~ '[^[:space:]]'`,
    )
    .execute();
  await db.schema
    .createIndex("ticket_internal_notes_chronological_idx")
    .on("ticket_internal_notes")
    .columns(["organization_id", "ticket_id", "created_at", "id"])
    .execute();

  await sql`GRANT SELECT, INSERT, UPDATE ON TABLE tickets TO helpdesk_app`.execute(
    db,
  );
  // Customer-visible messages are append-only for the runtime role.
  await sql`GRANT SELECT, INSERT ON TABLE ticket_messages, ticket_internal_notes TO helpdesk_app`.execute(
    db,
  );
  await sql`GRANT UPDATE (body, updated_at) ON TABLE ticket_internal_notes TO helpdesk_app`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("ticket_internal_notes").execute();
  await db.schema.dropTable("ticket_messages").execute();
  await db.schema.dropTable("tickets").execute();
}
