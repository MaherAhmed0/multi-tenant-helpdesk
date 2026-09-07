import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("login_throttles")
    .addColumn("identifier_hash", "text", (col) => col.primaryKey())
    .addColumn("failed_attempts", "integer", (col) => col.notNull())
    .addColumn("window_started_at", "timestamptz", (col) => col.notNull())
    .addColumn("blocked_until", "timestamptz")
    .addColumn("updated_at", "timestamptz", (col) => col.notNull())
    .addCheckConstraint(
      "login_throttles_identifier_hash_check",
      sql`identifier_hash ~ '^[0-9a-f]{64}$'`,
    )
    .addCheckConstraint(
      "login_throttles_failed_attempts_check",
      sql`failed_attempts > 0`,
    )
    .addCheckConstraint(
      "login_throttles_timestamps_check",
      sql`updated_at >= window_started_at
        AND (blocked_until IS NULL OR blocked_until > window_started_at)`,
    )
    .execute();

  await sql`
    GRANT SELECT, INSERT, UPDATE, DELETE
    ON TABLE login_throttles
    TO helpdesk_app
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("login_throttles").execute();
}
