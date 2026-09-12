import { randomUUID } from "node:crypto";

import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";

import { app } from "../../app.js";
import { db } from "../../database/db.js";
import { createGeneralTeam } from "../../teams/team.repository.js";
import { createSystemAdmin } from "../system-admin.repository.js";
import { createSystemAdminSession } from "../sessions/session.repository.js";
import { generateSystemAdminSessionToken } from "../sessions/session-token.js";
import { SYSTEM_ADMIN_SESSION_COOKIE_NAME } from "../sessions/session-cookie.js";
import { SYSTEM_ADMIN_SESSION_ABSOLUTE_LIFETIME_MS } from "../sessions/session.constants.js";

afterAll(async () => {
  await db.destroy();
});

async function createPlatformCookie() {
  const admin = await createSystemAdmin(db, {
    email: `overview-${randomUUID()}@example.com`,
    passwordHash: "test-only-password-hash",
    totpSecretCiphertext: "test-only-ciphertext",
    totpSecretIv: "test-only-iv",
    totpSecretAuthTag: "test-only-auth-tag",
  });
  const credential = generateSystemAdminSessionToken();
  await createSystemAdminSession(db, {
    systemAdminId: admin.id,
    tokenHash: credential.tokenHash,
    absoluteExpiresAt: new Date(
      Date.now() + SYSTEM_ADMIN_SESSION_ABSOLUTE_LIFETIME_MS,
    ),
    userAgent: null,
  });
  return `${SYSTEM_ADMIN_SESSION_COOKIE_NAME}=${credential.token}`;
}

describe("SYSTEM_ADMIN platform overview", () => {
  it("counts organization/account states and each tenant role without counting privileged identities", async () => {
    const cookie = await createPlatformCookie();
    const baseline = await request(app)
      .get("/system-admin/overview")
      .set("Cookie", cookie)
      .expect(200);
    const before = baseline.body;
    expect(before.organizations.total).toBe(
      before.organizations.active + before.organizations.deactivated,
    );
    expect(before.tenantUsers.total).toBe(
      before.tenantUsers.active + before.tenantUsers.deactivated,
    );
    expect(before.tenantUsers.total).toBe(
      before.tenantUsers.byRole.ORGANIZATION_ADMIN +
        before.tenantUsers.byRole.AGENT +
        before.tenantUsers.byRole.CUSTOMER,
    );

    // Unique additive fixtures keep the test independent of existing test-database rows.
    const organizations = await db
      .insertInto("organizations")
      .values([
        { name: "Overview active one", slug: `overview-${randomUUID()}` },
        { name: "Overview active two", slug: `overview-${randomUUID()}` },
        {
          name: "Overview deactivated",
          slug: `overview-${randomUUID()}`,
          deactivated_at: new Date(),
        },
      ])
      .returning("id")
      .execute();
    const teams = await Promise.all(
      organizations.map((organization) =>
        createGeneralTeam(db, organization.id),
      ),
    );
    await db
      .insertInto("users")
      .values([
        {
          organization_id: organizations[0]!.id,
          role: "ORGANIZATION_ADMIN",
          name: "Active admin",
          email: `${randomUUID()}@example.com`,
          password_hash: "test-only-hash",
        },
        {
          organization_id: organizations[1]!.id,
          role: "ORGANIZATION_ADMIN",
          name: "Inactive admin",
          email: `${randomUUID()}@example.com`,
          password_hash: "test-only-hash",
          deactivated_at: new Date(),
        },
        {
          organization_id: organizations[0]!.id,
          team_id: teams[0]!.id,
          role: "AGENT",
          name: "Active agent",
          email: `${randomUUID()}@example.com`,
          password_hash: "test-only-hash",
        },
        {
          organization_id: organizations[1]!.id,
          team_id: teams[1]!.id,
          role: "AGENT",
          name: "Inactive agent",
          email: `${randomUUID()}@example.com`,
          password_hash: "test-only-hash",
          deactivated_at: new Date(),
        },
        {
          organization_id: organizations[1]!.id,
          role: "CUSTOMER",
          name: "Customer",
          email: `${randomUUID()}@example.com`,
          password_hash: "test-only-hash",
        },
        // This account is active even though its parent organization is deactivated.
        {
          organization_id: organizations[2]!.id,
          role: "CUSTOMER",
          name: "Customer",
          email: `${randomUUID()}@example.com`,
          password_hash: "test-only-hash",
        },
      ])
      .execute();
    await createPlatformCookie(); // Neither this principal nor its session contributes to tenant counts.

    const response = await request(app)
      .get("/system-admin/overview")
      .set("Cookie", cookie)
      .expect(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      organizations: {
        total: before.organizations.total + 3,
        active: before.organizations.active + 2,
        deactivated: before.organizations.deactivated + 1,
      },
      tenantUsers: {
        total: before.tenantUsers.total + 6,
        active: before.tenantUsers.active + 4,
        deactivated: before.tenantUsers.deactivated + 2,
        byRole: {
          ORGANIZATION_ADMIN: before.tenantUsers.byRole.ORGANIZATION_ADMIN + 2,
          AGENT: before.tenantUsers.byRole.AGENT + 2,
          CUSTOMER: before.tenantUsers.byRole.CUSTOMER + 2,
        },
      },
    });
  });
});
