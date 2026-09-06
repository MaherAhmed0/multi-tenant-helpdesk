import { randomUUID } from "node:crypto";

import request from "supertest";
import { describe, expect, it } from "vitest";

import { app } from "../app.js";
import { registerOrganization } from "./registration.service.js";

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
});
