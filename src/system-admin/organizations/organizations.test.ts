import { randomUUID } from "node:crypto";

import type { Selectable } from "kysely";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { app } from "../../app.js";
import { db } from "../../database/db.js";
import type { OrganizationsTable } from "../../database/types.js";
import { createUser } from "../../organization-registration/user.repository.js";
import { createSystemAdmin } from "../system-admin.repository.js";
import { createSystemAdminSession } from "../sessions/session.repository.js";
import { generateSystemAdminSessionToken } from "../sessions/session-token.js";
import { SYSTEM_ADMIN_SESSION_COOKIE_NAME } from "../sessions/session-cookie.js";
import { SYSTEM_ADMIN_SESSION_ABSOLUTE_LIFETIME_MS } from "../sessions/session.constants.js";
import { createSession } from "../../auth/sessions/session.repository.js";
import {
  generateSessionToken,
  hashSessionToken,
} from "../../auth/sessions/session-token.js";
import { SESSION_COOKIE_NAME } from "../../auth/sessions/session-cookie.js";
import { SESSION_ABSOLUTE_LIFETIME_MS } from "../../auth/auth.constants.js";

const unique = `platform-${randomUUID()}`;
let cookie: string;
let organizations: Selectable<OrganizationsTable>[];

beforeAll(async () => {
  const admin = await createSystemAdmin(db, {
    email: `${unique}@example.com`,
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
  cookie = `${SYSTEM_ADMIN_SESSION_COOKIE_NAME}=${credential.token}`;
  organizations = await db
    .insertInto("organizations")
    .values([
      {
        name: `Alpha ${unique} literal_%\\`,
        slug: `${unique}-first`,
        created_at: new Date("2020-01-01Z"),
      },
      {
        name: `Beta ${unique}`,
        slug: `${unique}-slug-only`,
        created_at: new Date("2020-01-02Z"),
      },
      {
        name: `Gamma ${unique}`,
        slug: `${unique}-third`,
        created_at: new Date("2020-01-02Z"),
        deactivated_at: new Date(),
      },
    ])
    .returningAll()
    .execute();
});
afterAll(async () => {
  await db.destroy();
});

function organizationJson(row: Selectable<OrganizationsTable>) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    deactivatedAt: row.deactivated_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const protectedPaths = [
  "/system-admin/organizations",
  `/system-admin/organizations/${randomUUID()}`,
  `/system-admin/organizations/${randomUUID()}/admins`,
  "/system-admin/overview",
];

describe("SYSTEM_ADMIN platform organization reads", () => {
  it.each(protectedPaths)(
    "requires SYSTEM_ADMIN authentication for %s",
    async (path) => {
      const response = await request(app).get(path).expect(401);
      expect(response.body).toEqual({ error: "Authentication required" });
    },
  );

  it("rejects a working tenant credential on every platform endpoint", async () => {
    const organization = organizations[0]!;
    const user = await createUser(db, {
      organizationId: organization.id,
      name: "Tenant administrator",
      email: `${randomUUID()}@example.com`,
      passwordHash: "test-only-password-hash",
      role: "ORGANIZATION_ADMIN",
    });
    const token = generateSessionToken();
    await createSession(db, {
      organizationId: organization.id,
      userId: user.id,
      tokenHash: hashSessionToken(token),
      absoluteExpiresAt: new Date(Date.now() + SESSION_ABSOLUTE_LIFETIME_MS),
      userAgent: null,
    });
    const tenantCookie = `${SESSION_COOKIE_NAME}=${token}`;
    await request(app).get("/auth/me").set("Cookie", tenantCookie).expect(200);
    for (const path of protectedPaths) {
      for (const presented of [
        tenantCookie,
        `${SYSTEM_ADMIN_SESSION_COOKIE_NAME}=${token}`,
      ]) {
        const response = await request(app)
          .get(path)
          .set("Cookie", presented)
          .expect(401);
        expect(response.body).toEqual({ error: "Authentication required" });
      }
    }
  });

  it("lists multiple organizations with exact safe fields and deterministic page ordering", async () => {
    const sorted = [...organizations].sort(
      (a, b) =>
        b.created_at.getTime() - a.created_at.getTime() ||
        b.id.localeCompare(a.id),
    );
    const response = await request(app)
      .get("/system-admin/organizations")
      .set("Cookie", cookie)
      .query({ search: unique })
      .expect(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      organizations: sorted.map(organizationJson),
      pagination: { page: 1, limit: 20, total: 3, totalPages: 1 },
    });
    for (const page of [1, 2, 3]) {
      const paged = await request(app)
        .get("/system-admin/organizations")
        .set("Cookie", cookie)
        .query({ search: unique, page, limit: 2 })
        .expect(200);
      expect(paged.body).toEqual({
        organizations: sorted
          .slice((page - 1) * 2, page * 2)
          .map(organizationJson),
        pagination: { page, limit: 2, total: 3, totalPages: 2 },
      });
    }
  });

  it.each(["active", "deactivated"])(
    "filters organizations by %s status",
    async (status) => {
      const response = await request(app)
        .get("/system-admin/organizations")
        .set("Cookie", cookie)
        .query({ search: unique, status })
        .expect(200);
      const expected = organizations.filter(
        (row) => (row.deactivated_at === null) === (status === "active"),
      );
      expect(response.body.organizations).toHaveLength(expected.length);
      expect(response.body.organizations).toEqual(
        expect.arrayContaining(expected.map(organizationJson)),
      );
      expect(response.body.pagination.total).toBe(expected.length);
    },
  );

  it.each(["name", "slug", "literal-wildcards"])(
    "searches %s without widening the match",
    async (field) => {
      const search =
        field === "name"
          ? `ALPHA ${unique.toUpperCase()}`
          : field === "slug"
            ? `${unique}-slug-only`
            : `Alpha ${unique} literal_%\\`;
      const response = await request(app)
        .get("/system-admin/organizations")
        .set("Cookie", cookie)
        .query({ search: ` ${search} ` })
        .expect(200);
      expect(response.body.organizations).toEqual([
        organizationJson(organizations[field === "slug" ? 1 : 0]!),
      ]);
    },
  );

  it("returns an empty page with zero totals when search has no matches", async () => {
    const response = await request(app)
      .get("/system-admin/organizations")
      .set("Cookie", cookie)
      .query({ search: randomUUID() })
      .expect(200);
    expect(response.body).toEqual({
      organizations: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });
  });

  it.each([
    { status: "invalid" },
    { page: "0" },
    { page: "-1" },
    { page: "1.5" },
    { page: "1000001" },
    { page: "1e2" },
    { limit: "0" },
    { limit: "101" },
    { limit: "" },
    { page: ["1", "2"] },
    { search: " " },
    { search: "a".repeat(256) },
    { organizationId: "client-scope" },
  ])("rejects invalid list input (case %#)", async (query) => {
    const response = await request(app)
      .get("/system-admin/organizations")
      .set("Cookie", cookie)
      .query(query)
      .expect(400);
    expect(response.body.error).toBe("Invalid organization query");
  });

  it("returns platform organization details including deactivated organizations", async () => {
    for (const organization of organizations) {
      const response = await request(app)
        .get(`/system-admin/organizations/${organization.id}`)
        .set("Cookie", cookie)
        .expect(200);
      expect(response.body).toEqual(organizationJson(organization));
    }
  });

  it.each(["", "/admins"])(
    "returns 404 for an unknown organization%s",
    async (suffix) => {
      const response = await request(app)
        .get(`/system-admin/organizations/${randomUUID()}${suffix}`)
        .set("Cookie", cookie)
        .expect(404);
      expect(response.body).toEqual({ error: "Organization not found" });
    },
  );

  it.each(["", "/admins"])(
    "rejects malformed resource IDs%s",
    async (suffix) => {
      const response = await request(app)
        .get(`/system-admin/organizations/not-a-uuid${suffix}`)
        .set("Cookie", cookie)
        .expect(400);
      expect(response.body.error).toBe("Invalid organization ID");
    },
  );

  it("returns only safe ORGANIZATION_ADMIN users of the target organization", async () => {
    const target = organizations[1]!;
    const foreign = organizations[2]!;
    const users = await db
      .insertInto("users")
      .values([
        {
          organization_id: target.id,
          role: "ORGANIZATION_ADMIN",
          name: "Active admin",
          email: `${randomUUID()}@example.com`,
          password_hash: "test-only-hash",
        },
        {
          organization_id: target.id,
          role: "ORGANIZATION_ADMIN",
          name: "Inactive admin",
          email: `${randomUUID()}@example.com`,
          password_hash: "test-only-hash",
          deactivated_at: new Date(),
        },
        {
          organization_id: target.id,
          role: "AGENT",
          name: "Agent",
          email: `${randomUUID()}@example.com`,
          password_hash: "test-only-hash",
        },
        {
          organization_id: target.id,
          role: "CUSTOMER",
          name: "Customer",
          email: `${randomUUID()}@example.com`,
          password_hash: "test-only-hash",
        },
        {
          organization_id: foreign.id,
          role: "ORGANIZATION_ADMIN",
          name: "Foreign admin",
          email: `${randomUUID()}@example.com`,
          password_hash: "test-only-hash",
        },
      ])
      .returning(["id", "name", "email", "deactivated_at", "created_at"])
      .execute();
    const response = await request(app)
      .get(`/system-admin/organizations/${target.id}/admins`)
      .set("Cookie", cookie)
      .expect(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.admins).toHaveLength(2);
    expect(response.body).toEqual({
      admins: expect.arrayContaining(
        users.slice(0, 2).map((user) => ({
          id: user.id,
          name: user.name,
          email: user.email,
          deactivatedAt: user.deactivated_at?.toISOString() ?? null,
          createdAt: user.created_at.toISOString(),
        })),
      ),
    });
  });
});
