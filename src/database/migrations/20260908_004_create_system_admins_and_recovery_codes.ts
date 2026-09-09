import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("system_admins")
    .addColumn("id", "uuid", (col) =>
      col
        .primaryKey()
        .notNull()
        .defaultTo(sql`uuidv7()`),
    )
    .addColumn("email", "text", (col) => col.notNull())
    .addColumn("password_hash", "text", (col) => col.notNull())
    .addColumn("totp_secret_ciphertext", "text", (col) => col.notNull())
    .addColumn("totp_secret_iv", "text", (col) => col.notNull())
    .addColumn("totp_secret_auth_tag", "text", (col) => col.notNull())
    .addColumn("last_totp_time_step", "integer")
    .addColumn("deactivated_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addUniqueConstraint("system_admins_email_unique", ["email"])
    .addCheckConstraint(
      "system_admins_email_check",
      sql`
        char_length(email) BETWEEN 1 AND 254
        AND email = lower(email)
        AND email = btrim(email)
      `,
    )
    .addCheckConstraint(
      "system_admins_password_hash_check",
      sql`char_length(btrim(password_hash)) > 0`,
    )
    .addCheckConstraint(
      "system_admins_totp_secret_check",
      sql`
        char_length(btrim(totp_secret_ciphertext)) > 0
        AND char_length(btrim(totp_secret_iv)) > 0
        AND char_length(btrim(totp_secret_auth_tag)) > 0
      `,
    )
    .addCheckConstraint(
      "system_admins_last_totp_time_step_check",
      sql`last_totp_time_step IS NULL OR last_totp_time_step >= 0`,
    )
    .execute();

  await db.schema
    .createTable("system_admin_recovery_codes")
    .addColumn("id", "uuid", (col) =>
      col
        .primaryKey()
        .notNull()
        .defaultTo(sql`uuidv7()`),
    )
    .addColumn("system_admin_id", "uuid", (col) =>
      col.notNull().references("system_admins.id").onDelete("restrict"),
    )
    .addColumn("code_hash", "text", (col) => col.notNull())
    .addColumn("used_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addUniqueConstraint("system_admin_recovery_codes_admin_hash_unique", [
      "system_admin_id",
      "code_hash",
    ])
    .addCheckConstraint(
      "system_admin_recovery_codes_code_hash_check",
      sql`code_hash ~ '^[0-9a-f]{64}$'`,
    )
    .execute();

  await sql`
    GRANT SELECT, INSERT, UPDATE
    ON TABLE system_admins, system_admin_recovery_codes
    TO helpdesk_app
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("system_admin_recovery_codes").execute();
  await db.schema.dropTable("system_admins").execute();
}
