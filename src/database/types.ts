import type { ColumnType, Generated } from "kysely";

export type TenantRole = "ORGANIZATION_ADMIN" | "AGENT" | "CUSTOMER";

export type TicketStatus = "OPEN" | "IN_PROGRESS" | "RESOLVED" | "CLOSED";
export type TicketPriority = "LOW" | "NORMAL" | "HIGH" | "URGENT";
export type TicketVoidReason =
  | "CUSTOMER_WITHDRAWN"
  | "INVALID"
  | "SPAM"
  | "DUPLICATE";

type GeneratedImmutable<T> = ColumnType<T, T | undefined, never>;

type Immutable<T> = ColumnType<T, T, never>;

export interface OrganizationsTable {
  id: GeneratedImmutable<string>;

  name: string;
  slug: string;

  deactivated_at: Date | null;

  created_at: GeneratedImmutable<Date>;
  updated_at: Generated<Date>;
}

export interface UsersTable {
  id: GeneratedImmutable<string>;

  organization_id: Immutable<string>;

  name: string;
  email: string;
  password_hash: string;
  role: TenantRole;
  team_id: string | null;

  deactivated_at: Date | null;

  created_at: GeneratedImmutable<Date>;
  updated_at: Generated<Date>;
}

export interface TeamsTable {
  id: GeneratedImmutable<string>;
  organization_id: Immutable<string>;
  name: string;
  is_general: Generated<boolean>;
  deactivated_at: Date | null;
  created_at: GeneratedImmutable<Date>;
}

export interface TenantUserInvitationsTable {
  id: GeneratedImmutable<string>;
  organization_id: Immutable<string>;
  name: string;
  email: string;
  role: "AGENT" | "ORGANIZATION_ADMIN";
  target_team_id: string | null;
  token_hash: Immutable<string>;
  expires_at: Immutable<Date>;
  revoked_at: Date | null;
  consumed_at: Date | null;
  created_at: GeneratedImmutable<Date>;
}

interface SessionsTable {
  id: GeneratedImmutable<string>;

  organization_id: Immutable<string>;
  user_id: Immutable<string>;

  token_hash: string;

  created_at: GeneratedImmutable<Date>;
  last_activity_at: Generated<Date>;
  absolute_expires_at: Date;

  revoked_at: Date | null;
  user_agent: string | null;
}

interface LoginThrottlesTable {
  identifier_hash: Immutable<string>;
  failed_attempts: number;
  window_started_at: Date;
  blocked_until: Date | null;
  updated_at: Date;
}

export interface SystemAdminsTable {
  id: GeneratedImmutable<string>;

  email: string;
  password_hash: string;

  totp_secret_ciphertext: string;
  totp_secret_iv: string;
  totp_secret_auth_tag: string;

  last_totp_time_step: number | null;

  deactivated_at: Date | null;

  created_at: GeneratedImmutable<Date>;
  updated_at: Generated<Date>;
}

export interface SystemAdminRecoveryCodesTable {
  id: GeneratedImmutable<string>;

  system_admin_id: Immutable<string>;
  code_hash: Immutable<string>;

  used_at: Date | null;
  created_at: GeneratedImmutable<Date>;
}

export interface SystemAdminAuthChallengesTable {
  id: GeneratedImmutable<string>;

  system_admin_id: Immutable<string>;
  token_hash: Immutable<string>;

  failed_attempts: Generated<number>;
  expires_at: Immutable<Date>;
  consumed_at: Date | null;
  created_at: GeneratedImmutable<Date>;
}

export interface SystemAdminSessionsTable {
  id: GeneratedImmutable<string>;

  system_admin_id: Immutable<string>;
  token_hash: Immutable<string>;

  created_at: GeneratedImmutable<Date>;
  last_activity_at: Generated<Date>;
  absolute_expires_at: Immutable<Date>;

  revoked_at: Date | null;
  user_agent: string | null;
}

// Services must enforce CUSTOMER ownership, AGENT assignment, active assignees/teams,
// and membership when both team and agent are assigned. On agent team reassignment,
// clear the agent from tickets assigned to the old team, preserving that team;
// agent-only ticket assignments remain intact. Initial description is a message,
// inserted in the same future service transaction as its ticket.
export interface TicketsTable {
  id: GeneratedImmutable<string>;
  organization_id: Immutable<string>;
  customer_id: Immutable<string>;
  subject: string;
  status: Generated<TicketStatus>;
  priority: Generated<TicketPriority>;
  assigned_team_id: string | null;
  assigned_agent_id: string | null;
  voided_at: Date | null;
  voided_by_user_id: string | null;
  void_reason: TicketVoidReason | null;
  created_at: GeneratedImmutable<Date>;
  updated_at: Generated<Date>;
  closed_at: Date | null;
}

export interface TicketMessagesTable {
  id: GeneratedImmutable<string>;
  organization_id: Immutable<string>;
  ticket_id: Immutable<string>;
  author_user_id: Immutable<string>;
  body: Immutable<string>;
  created_at: GeneratedImmutable<Date>;
}

// Services restrict visibility to staff and edits to the original author,
// including after ticket closure. Runtime grants permit only body/timestamp edits.
export interface TicketInternalNotesTable {
  id: GeneratedImmutable<string>;
  organization_id: Immutable<string>;
  ticket_id: Immutable<string>;
  author_user_id: Immutable<string>;
  body: string;
  created_at: GeneratedImmutable<Date>;
  updated_at: Generated<Date>;
}

export interface Database {
  organizations: OrganizationsTable;
  users: UsersTable;
  teams: TeamsTable;
  tenant_user_invitations: TenantUserInvitationsTable;
  tickets: TicketsTable;
  ticket_messages: TicketMessagesTable;
  ticket_internal_notes: TicketInternalNotesTable;
  sessions: SessionsTable;
  login_throttles: LoginThrottlesTable;
  system_admins: SystemAdminsTable;
  system_admin_recovery_codes: SystemAdminRecoveryCodesTable;
  system_admin_auth_challenges: SystemAdminAuthChallengesTable;
  system_admin_sessions: SystemAdminSessionsTable;
}
