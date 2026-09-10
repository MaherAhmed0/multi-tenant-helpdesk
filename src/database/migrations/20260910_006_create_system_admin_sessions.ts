import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("system_admin_sessions")
    .addColumn("id", "uuid", (col) =>
      col
        .primaryKey()
        .notNull()
        .defaultTo(sql`uuidv7()`),
    )
    .addColumn("system_admin_id", "uuid", (col) =>
      col.notNull().references("system_admins.id").onDelete("restrict"),
    )
    .addColumn("token_hash", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addColumn("last_activity_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addColumn("absolute_expires_at", "timestamptz", (col) => col.notNull())
    .addColumn("revoked_at", "timestamptz")
    .addColumn("user_agent", "text")
    .addUniqueConstraint("system_admin_sessions_token_hash_unique", [
      "token_hash",
    ])
    .addCheckConstraint(
      "system_admin_sessions_token_hash_check",
      sql`token_hash ~ '^[0-9a-f]{64}$'`,
    )
    .execute();

  await sql`
    GRANT SELECT, INSERT, UPDATE
    ON TABLE system_admin_sessions
    TO helpdesk_app
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("system_admin_sessions").execute();
}
