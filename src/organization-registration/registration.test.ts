import { randomUUID } from "node:crypto";

import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { app } from "../app.js";
import { db } from "../database/db.js";
import * as teamRepository from "../teams/team.repository.js";
import { registerOrganization } from "./registration.service.js";

afterEach(() => vi.restoreAllMocks());

function validRegistration() {
  const unique = randomUUID();

  return {
    organizationName: "Acme Support",
    organizationSlug: `acme-${unique}`,
    adminName: "Maher",
    adminEmail: `maher-${unique}@example.com`,
    adminPassword: "a sufficiently long password",
  };
}

describe("POST /organization-registration", () => {
  it("registers an organization and its first admin", async () => {
    const input = validRegistration();

    const response = await request(app)
      .post("/organization-registration")
      .send(input)
      .expect(201);

    expect(response.body.organization).toMatchObject({
      name: input.organizationName,
      slug: input.organizationSlug,
    });

    expect(response.body.admin).toMatchObject({
      name: input.adminName,
      email: input.adminEmail,
      role: "ORGANIZATION_ADMIN",
    });

    expect(response.body.admin).not.toHaveProperty("passwordHash");
    const teams = await db
      .selectFrom("teams")
      .selectAll()
      .where("organization_id", "=", response.body.organization.id)
      .execute();
    expect(teams).toEqual([
      expect.objectContaining({
        name: "General",
        is_general: true,
        deactivated_at: null,
      }),
    ]);
    const admin = await db
      .selectFrom("users")
      .select("team_id")
      .where("id", "=", response.body.admin.id)
      .executeTakeFirstOrThrow();
    expect(admin.team_id).toBeNull();
  });

  it("rejects invalid registration data", async () => {
    const input = validRegistration();

    const response = await request(app)
      .post("/organization-registration")
      .send({
        ...input,
        adminEmail: "invalid-email",
      })
      .expect(400);

    expect(response.body.error).toBe("Invalid registration data");
  });

  it("rejects an existing organization slug", async () => {
    const input = validRegistration();

    await request(app)
      .post("/organization-registration")
      .send(input)
      .expect(201);

    const response = await request(app)
      .post("/organization-registration")
      .send({
        ...validRegistration(),
        organizationSlug: input.organizationSlug,
      })
      .expect(409);

    expect(response.body).toMatchObject({
      error: "Organization slug already exists",
    });
  });

  it("rolls back the organization if admin creation fails", async () => {
    const input = validRegistration();

    await expect(
      registerOrganization({
        ...input,
        adminName: "a".repeat(300),
      }),
    ).rejects.toThrow();

    await request(app)
      .post("/organization-registration")
      .send(input)
      .expect(201);
  });

  it("rolls back registration if General creation fails", async () => {
    const input = validRegistration();
    vi.spyOn(teamRepository, "createGeneralTeam").mockImplementationOnce(
      async (executor, organizationId) => {
        expect(executor.isTransaction).toBe(true);
        await executor
          .insertInto("teams")
          .values({
            organization_id: organizationId,
            name: "Wrong General name",
            is_general: true,
          })
          .execute();
        throw new Error(
          "Expected General integrity check to reject the insert",
        );
      },
    );
    await expect(registerOrganization(input)).rejects.toMatchObject({
      constraint: "teams_general_check",
    });
    expect(
      await db
        .selectFrom("organizations")
        .select("id")
        .where("slug", "=", input.organizationSlug)
        .execute(),
    ).toEqual([]);
    expect(
      await db
        .selectFrom("users")
        .select("id")
        .where("email", "=", input.adminEmail)
        .execute(),
    ).toEqual([]);
    await registerOrganization(input);
  });
});
