import type { ColumnType, Generated } from "kysely";

export type TenantRole = "ORGANIZATION_ADMIN" | "AGENT" | "CUSTOMER";

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

  deactivated_at: Date | null;

  created_at: GeneratedImmutable<Date>;
  updated_at: Generated<Date>;
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

export interface Database {
  organizations: OrganizationsTable;
  users: UsersTable;
  sessions: SessionsTable;
  login_throttles: LoginThrottlesTable;
  system_admins: SystemAdminsTable;
  system_admin_recovery_codes: SystemAdminRecoveryCodesTable;
}
