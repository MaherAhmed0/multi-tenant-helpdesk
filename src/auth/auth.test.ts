import { randomUUID } from "node:crypto";

import request from "supertest";
import { describe, expect, it } from "vitest";

import { app } from "../app.js";

function registrationInput() {
  const unique = randomUUID();

  return {
    organizationName: "Auth Test Organization",
    organizationSlug: `auth-${unique}`,
    adminName: "Auth Admin",
    adminEmail: `admin-${unique}@example.com`,
    adminPassword: "a sufficiently long password",
  };
}

describe("tenant authentication", () => {
  it("authenticates a logged-in session", async () => {
    const input = registrationInput();

    await request(app)
      .post("/organization-registration")
      .send(input)
      .expect(201);

    const agent = request.agent(app);

    const loginResponse = await agent
      .post("/auth/login")
      .send({
        organizationSlug: input.organizationSlug,
        email: input.adminEmail,
        password: input.adminPassword,
      })
      .expect(200);

    const response = await agent.get("/auth/me").expect(200);

    expect(response.body.user).toMatchObject({
      id: loginResponse.body.user.id,
      organizationId: loginResponse.body.user.organizationId,
      role: "ORGANIZATION_ADMIN",
    });
  });

  it("rejects a request without a session", async () => {
    await request(app).get("/auth/me").expect(401);
  });

  it("revokes the current session on logout", async () => {
    const input = registrationInput();

    await request(app)
      .post("/organization-registration")
      .send(input)
      .expect(201);

    const agent = request.agent(app);

    await agent
      .post("/auth/login")
      .send({
        organizationSlug: input.organizationSlug,
        email: input.adminEmail,
        password: input.adminPassword,
      })
      .expect(200);

    await agent.get("/auth/me").expect(200);

    await agent.post("/auth/logout").expect(204);

    await agent.get("/auth/me").expect(401);
  });
});
