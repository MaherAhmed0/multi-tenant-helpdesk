import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await sql`REVOKE UPDATE ON TABLE tickets FROM helpdesk_app`.execute(db);
  await sql`
    GRANT UPDATE (
      subject, status, priority, assigned_team_id, assigned_agent_id,
      voided_at, voided_by_user_id, void_reason, updated_at, closed_at
    ) ON TABLE tickets TO helpdesk_app
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    REVOKE UPDATE (
      subject, status, priority, assigned_team_id, assigned_agent_id,
      voided_at, voided_by_user_id, void_reason, updated_at, closed_at
    ) ON TABLE tickets FROM helpdesk_app
  `.execute(db);
  await sql`GRANT UPDATE ON TABLE tickets TO helpdesk_app`.execute(db);
}
