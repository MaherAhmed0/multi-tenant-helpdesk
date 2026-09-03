import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("organizations")
    .addColumn("id", "uuid", (col) =>
      col
        .primaryKey()
        .notNull()
        .defaultTo(sql`uuidv7()`),
    )
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("slug", "text", (col) => col.notNull())
    .addColumn("deactivated_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addUniqueConstraint("organizations_slug_unique", ["slug"])
    .addCheckConstraint(
      "organizations_name_check",
      sql`
        char_length(name) <= 255
        AND char_length(btrim(name)) >= 1
      `,
    )
    .addCheckConstraint(
      "organizations_slug_check",
      sql`
        char_length(slug) BETWEEN 1 AND 100
        AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
      `,
    )
    .execute();

  await db.schema
    .createTable("users")
    .addColumn("id", "uuid", (col) =>
      col
        .primaryKey()
        .notNull()
        .defaultTo(sql`uuidv7()`),
    )
    .addColumn("organization_id", "uuid", (col) =>
      col.notNull().references("organizations.id").onDelete("restrict"),
    )
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("email", "text", (col) => col.notNull())
    .addColumn("password_hash", "text", (col) => col.notNull())
    .addColumn("role", "text", (col) => col.notNull())
    .addColumn("deactivated_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addUniqueConstraint("users_organization_id_id_unique", [
      "organization_id",
      "id",
    ])
    .addUniqueConstraint("users_organization_id_email_unique", [
      "organization_id",
      "email",
    ])
    .addCheckConstraint(
      "users_name_check",
      sql`
        char_length(name) <= 255
        AND char_length(btrim(name)) >= 1
      `,
    )
    .addCheckConstraint(
      "users_email_check",
      sql`
        char_length(email) BETWEEN 1 AND 254
        AND email = lower(email)
        AND email = btrim(email)
      `,
    )
    .addCheckConstraint(
      "users_role_check",
      sql`
        role IN (
          'ORGANIZATION_ADMIN',
          'AGENT',
          'CUSTOMER'
        )
      `,
    )
    .execute();

  await sql`
    GRANT SELECT, INSERT, UPDATE
    ON TABLE organizations, users
    TO helpdesk_app
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("users").execute();

  await db.schema.dropTable("organizations").execute();
}
