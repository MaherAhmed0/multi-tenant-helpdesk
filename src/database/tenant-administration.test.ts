import { randomBytes, randomUUID } from "node:crypto";

import type { Insertable } from "kysely";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "./db.js";
import type { TenantUserInvitationsTable } from "./types.js";
import { createOrganization } from "../organization-registration/organization.repository.js";
import { createGeneralTeam } from "../teams/team.repository.js";

let organizationId: string;
let otherOrganizationId: string;
let generalId: string;
let otherGeneralId: string;

beforeAll(async () => {
  const organization = await createOrganization(db, { name: "Schema tenant", slug: `schema-${randomUUID()}` });
  const other = await createOrganization(db, { name: "Other schema tenant", slug: `schema-${randomUUID()}` });
  organizationId = organization.id;
  otherOrganizationId = other.id;
  generalId = (await createGeneralTeam(db, organizationId)).id;
  otherGeneralId = (await createGeneralTeam(db, otherOrganizationId)).id;
});

afterAll(async () => { await db.destroy(); });

function insertInvitation(overrides: Partial<Insertable<TenantUserInvitationsTable>> = {}) {
  return db.insertInto("tenant_user_invitations").values({
    organization_id: organizationId,
    name: "Invited person",
    email: `${randomUUID()}@example.com`,
    role: "AGENT",
    token_hash: randomBytes(32).toString("hex"),
    expires_at: new Date(Date.now() + 60 * 60 * 1000),
    ...overrides,
  }).returningAll().executeTakeFirstOrThrow();
}

describe("tenant administration database constraints", () => {
  it("reserves normalized team names within an organization even after deactivation", async () => {
    const name = `Billing-${randomUUID()}`;
    await db.insertInto("teams").values({ organization_id: organizationId, name, deactivated_at: new Date() }).execute();
    await expect(db.insertInto("teams").values({
      organization_id: organizationId, name: `  ${name.toUpperCase()}  `,
    }).execute()).rejects.toMatchObject({ code: "23505", constraint: "teams_organization_normalized_name_unique" });
    await expect(db.insertInto("teams").values({
      organization_id: otherOrganizationId, name: ` ${name.toLowerCase()} `,
    }).execute()).resolves.toHaveLength(1);
  });

  it("rejects a second General and enforces its name and active state", async () => {
    // Both unique indexes protect this insert; PostgreSQL may report either first.
    await expect(createGeneralTeam(db, organizationId)).rejects.toMatchObject({ code: "23505" });
    await expect(db.updateTable("teams").set({ name: "Renamed" }).where("id", "=", generalId).execute())
      .rejects.toMatchObject({ constraint: "teams_general_check" });
    await expect(db.updateTable("teams").set({ deactivated_at: new Date() }).where("id", "=", generalId).execute())
      .rejects.toMatchObject({ constraint: "teams_general_check" });
  });

  it.each([
    ["AGENT", null],
    ["CUSTOMER", "general"],
    ["ORGANIZATION_ADMIN", "general"],
  ] as const)("rejects invalid %s membership", async (role, team) => {
    await expect(db.insertInto("users").values({
      organization_id: organizationId, name: "Invalid membership", email: `${randomUUID()}@example.com`,
      password_hash: "test-only-hash", role, team_id: team === null ? null : generalId,
    }).execute()).rejects.toMatchObject({ constraint: "users_role_team_check" });
  });

  it("allows own-team agents and rejects cross-organization membership", async () => {
    const values = {
      organization_id: organizationId, name: "Agent", email: `${randomUUID()}@example.com`,
      password_hash: "test-only-hash", role: "AGENT" as const,
    };
    await expect(db.insertInto("users").values({ ...values, team_id: otherGeneralId }).execute())
      .rejects.toMatchObject({ code: "23503", constraint: "users_team_tenant_fk" });
    await expect(db.insertInto("users").values({ ...values, team_id: generalId }).execute()).resolves.toHaveLength(1);
  });

  it("allows an inactive agent to retain an inactive team", async () => {
    const team = await db.insertInto("teams").values({
      organization_id: organizationId, name: `Inactive-${randomUUID()}`, deactivated_at: new Date(),
    }).returning("id").executeTakeFirstOrThrow();
    await expect(db.insertInto("users").values({
      organization_id: organizationId, name: "Inactive agent", email: `${randomUUID()}@example.com`,
      password_hash: "test-only-hash", role: "AGENT", team_id: team.id, deactivated_at: new Date(),
    }).execute()).resolves.toHaveLength(1);
    await expect(insertInvitation({ target_team_id: team.id })).resolves.toMatchObject({ target_team_id: team.id });
  });

  it.each(["AGENT", "ORGANIZATION_ADMIN"] as const)("supports %s invitations with no target team", async (role) => {
    await expect(insertInvitation({ role })).resolves.toMatchObject({ role, target_team_id: null });
  });

  it("allows an AGENT invitation to target its own organization's team", async () => {
    await expect(insertInvitation({ target_team_id: generalId })).resolves.toMatchObject({ target_team_id: generalId });
  });

  it("rejects CUSTOMER invitations at the database boundary", async () => {
    const invitation = await insertInvitation();
    // Deliberately bypass the narrowed TypeScript role union to exercise PostgreSQL.
    await expect(sql`UPDATE tenant_user_invitations SET role = 'CUSTOMER' WHERE id = ${invitation.id}`.execute(db))
      .rejects.toMatchObject({ constraint: "tenant_user_invitations_role_check" });
  });

  it("rejects administrator target teams and cross-organization invitation targets", async () => {
    await expect(insertInvitation({ role: "ORGANIZATION_ADMIN", target_team_id: generalId }))
      .rejects.toMatchObject({ constraint: "tenant_user_invitations_role_team_check" });
    await expect(insertInvitation({ target_team_id: otherGeneralId }))
      .rejects.toMatchObject({ code: "23503", constraint: "tenant_user_invitations_team_tenant_fk" });
  });

  it("reserves an expired open invitation's normalized email only in its organization", async () => {
    const invitation = await insertInvitation({
      created_at: new Date(Date.now() - 120_000), expires_at: new Date(Date.now() - 60_000),
    });
    await expect(insertInvitation({ email: invitation.email, role: "ORGANIZATION_ADMIN" }))
      .rejects.toMatchObject({ constraint: "tenant_user_invitations_open_email_unique" });
    await expect(insertInvitation({ email: invitation.email, organization_id: otherOrganizationId }))
      .resolves.toMatchObject({ email: invitation.email });
    await expect(insertInvitation({ email: ` ${invitation.email.toUpperCase()} ` }))
      .rejects.toMatchObject({ constraint: "tenant_user_invitations_email_check" });
  });

  it.each(["consumed_at", "revoked_at"] as const)("allows replacement after %s is set", async (field) => {
    const invitation = await insertInvitation();
    await db.updateTable("tenant_user_invitations").set({ [field]: new Date() }).where("id", "=", invitation.id).execute();
    await expect(insertInvitation({ email: invitation.email })).resolves.toMatchObject({ email: invitation.email });
  });

  it("rejects consumed-and-revoked invitations and expiration at creation", async () => {
    await expect(insertInvitation({ consumed_at: new Date(), revoked_at: new Date() }))
      .rejects.toMatchObject({ constraint: "tenant_user_invitations_lifecycle_check" });
    const timestamp = new Date();
    await expect(insertInvitation({ created_at: timestamp, expires_at: timestamp }))
      .rejects.toMatchObject({ constraint: "tenant_user_invitations_expiry_check" });
  });

  it("requires globally unique lowercase SHA-256 invitation hashes", async () => {
    const invitation = await insertInvitation();
    await expect(insertInvitation({ token_hash: invitation.token_hash, organization_id: otherOrganizationId }))
      .rejects.toMatchObject({ constraint: "tenant_user_invitations_token_hash_unique" });
    await expect(insertInvitation({ token_hash: "A".repeat(64) }))
      .rejects.toMatchObject({ constraint: "tenant_user_invitations_token_hash_check" });
  });
});
