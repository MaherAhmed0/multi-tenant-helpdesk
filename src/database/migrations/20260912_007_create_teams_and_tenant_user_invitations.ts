import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("teams")
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
    .addColumn("is_general", "boolean", (col) => col.notNull().defaultTo(false))
    .addColumn("deactivated_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addUniqueConstraint("teams_organization_id_id_unique", [
      "organization_id",
      "id",
    ])
    .addCheckConstraint(
      "teams_name_check",
      sql`
      char_length(name) <= 255 AND char_length(btrim(name)) >= 1
    `,
    )
    .addCheckConstraint(
      "teams_general_check",
      sql`
      NOT is_general OR (name = 'General' AND deactivated_at IS NULL)
    `,
    )
    .execute();

  await db.schema
    .createIndex("teams_organization_normalized_name_unique")
    .on("teams")
    .unique()
    .expression(sql`organization_id, lower(btrim(name))`)
    .execute();
  await db.schema
    .createIndex("teams_organization_general_unique")
    .on("teams")
    .unique()
    .column("organization_id")
    .where(sql<boolean>`is_general = true`)
    .execute();

  // Let PostgreSQL generate UUIDv7 IDs for all existing organizations' General teams.
  await sql`
    INSERT INTO teams (organization_id, name, is_general)
    SELECT id, 'General', true FROM organizations
  `.execute(db);

  await db.schema.alterTable("users").addColumn("team_id", "uuid").execute();
  await sql`
    UPDATE users SET team_id = teams.id
    FROM teams
    WHERE users.organization_id = teams.organization_id
      AND users.role = 'AGENT' AND teams.is_general
  `.execute(db);

  // Enforce membership only after existing AGENT rows have their own General team.
  await db.schema
    .alterTable("users")
    .addCheckConstraint(
      "users_role_team_check",
      sql`
      (role = 'AGENT' AND team_id IS NOT NULL)
      OR (role <> 'AGENT' AND team_id IS NULL)
    `,
    )
    .execute();
  await db.schema
    .alterTable("users")
    .addForeignKeyConstraint(
      "users_team_tenant_fk",
      ["organization_id", "team_id"],
      "teams",
      ["organization_id", "id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .execute();
  await db.schema
    .createIndex("users_organization_team_idx")
    .on("users")
    .columns(["organization_id", "team_id"])
    .execute();

  await db.schema
    .createTable("tenant_user_invitations")
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
    .addColumn("role", "text", (col) => col.notNull())
    .addColumn("target_team_id", "uuid")
    .addColumn("token_hash", "text", (col) => col.notNull())
    .addColumn("expires_at", "timestamptz", (col) => col.notNull())
    .addColumn("revoked_at", "timestamptz")
    .addColumn("consumed_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addUniqueConstraint("tenant_user_invitations_token_hash_unique", [
      "token_hash",
    ])
    .addForeignKeyConstraint(
      "tenant_user_invitations_team_tenant_fk",
      ["organization_id", "target_team_id"],
      "teams",
      ["organization_id", "id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .addCheckConstraint(
      "tenant_user_invitations_name_check",
      sql`
      char_length(name) <= 255 AND char_length(btrim(name)) >= 1
    `,
    )
    .addCheckConstraint(
      "tenant_user_invitations_email_check",
      sql`
      char_length(email) BETWEEN 1 AND 254
      AND email = lower(email) AND email = btrim(email)
    `,
    )
    .addCheckConstraint(
      "tenant_user_invitations_role_check",
      sql`
      role IN ('AGENT', 'ORGANIZATION_ADMIN')
    `,
    )
    .addCheckConstraint(
      "tenant_user_invitations_role_team_check",
      sql`
      role = 'AGENT' OR target_team_id IS NULL
    `,
    )
    .addCheckConstraint(
      "tenant_user_invitations_token_hash_check",
      sql`token_hash ~ '^[0-9a-f]{64}$'`,
    )
    .addCheckConstraint(
      "tenant_user_invitations_expiry_check",
      sql`expires_at > created_at`,
    )
    .addCheckConstraint(
      "tenant_user_invitations_lifecycle_check",
      sql`
      consumed_at IS NULL OR revoked_at IS NULL
    `,
    )
    .execute();

  // Email is already normalized by CHECK. Expired open invitations still reserve it.
  await db.schema
    .createIndex("tenant_user_invitations_open_email_unique")
    .on("tenant_user_invitations")
    .unique()
    .columns(["organization_id", "email"])
    .where(sql<boolean>`consumed_at IS NULL AND revoked_at IS NULL`)
    .execute();

  await sql`
    GRANT SELECT, INSERT, UPDATE ON TABLE teams, tenant_user_invitations TO helpdesk_app
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("tenant_user_invitations").execute();
  await db.schema
    .alterTable("users")
    .dropConstraint("users_team_tenant_fk")
    .execute();
  await db.schema
    .alterTable("users")
    .dropConstraint("users_role_team_check")
    .execute();
  await db.schema.dropIndex("users_organization_team_idx").execute();
  await db.schema.alterTable("users").dropColumn("team_id").execute();
  await db.schema.dropTable("teams").execute();
}
