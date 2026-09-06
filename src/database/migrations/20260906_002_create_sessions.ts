import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("sessions")
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`uuidv7()`))
    .addColumn("organization_id", "uuid", (col) => col.notNull())
    .addColumn("user_id", "uuid", (col) => col.notNull())
    .addColumn("token_hash", "text", (col) => col.notNull().unique())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addColumn("last_activity_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addColumn("absolute_expires_at", "timestamptz", (col) => col.notNull())
    .addColumn("revoked_at", "timestamptz")
    .addColumn("user_agent", "text")
    .addForeignKeyConstraint(
      "sessions_user_tenant_fk",
      ["organization_id", "user_id"],
      "users",
      ["organization_id", "id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .execute();

  await sql`
    GRANT SELECT, INSERT, UPDATE
    ON TABLE sessions
    TO helpdesk_app
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("sessions").execute();
}
