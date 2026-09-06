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

export interface Database {
  organizations: OrganizationsTable;
  users: UsersTable;
  sessions: SessionsTable;
}
