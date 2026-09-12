import { randomUUID } from "node:crypto";

import request from "supertest";
import { describe, expect, it } from "vitest";

import { app } from "../app.js";
import { db } from "../database/db.js";
import { SESSION_IDLE_TIMEOUT_MS } from "./auth.constants.js";

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
  it("requires the browser login header and authenticates a logged-in session", async () => {
    const input = registrationInput();

    await request(app)
      .post("/organization-registration")
      .send(input)
      .expect(201);

    const agent = request.agent(app);

    const credentials = {
      organizationSlug: input.organizationSlug,
      email: input.adminEmail,
      password: input.adminPassword,
    };
    const missingHeader = await agent
      .post("/auth/login")
      .send(credentials)
      .expect(403);
    expect(missingHeader.body).toEqual({ error: "Request forbidden" });
    expect(missingHeader.headers["set-cookie"]).toBeUndefined();

    const incorrectHeader = await agent
      .post("/auth/login")
      .set("X-Helpdesk-Client", "incorrect")
      .send(credentials)
      .expect(403);
    expect(incorrectHeader.body).toEqual(missingHeader.body);

    // The header gate runs before input validation or credential authentication.
    await agent.post("/auth/login").send({}).expect(403);
    await agent.get("/auth/me").expect(401);

    const loginResponse = await agent
      .post("/auth/login")
      .set("X-Helpdesk-Client", "web")
      .send(credentials)
      .expect(200);

    const response = await agent.get("/auth/me").expect(200);

    expect(response.body.user).toMatchObject({
      id: loginResponse.body.user.id,
      organizationId: loginResponse.body.user.organizationId,
      role: "ORGANIZATION_ADMIN",
    });
  });

  it("rejects a request without a session", async () => {
    const response = await request(app).get("/auth/me").expect(401);

    expect(response.body).toEqual({ error: "Authentication required" });

    await request(app).get("/auth/sessions").expect(401);
    await request(app).get("/auth/csrf").expect(401);
    await request(app).delete(`/auth/sessions/${randomUUID()}`).expect(401);
    await request(app).post("/auth/logout-all").expect(401);
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
      .set("X-Helpdesk-Client", "web")
      .send({
        organizationSlug: input.organizationSlug,
        email: input.adminEmail,
        password: input.adminPassword,
      })
      .expect(200);

    await agent.get("/auth/me").expect(200);

    const csrf = await agent.get("/auth/csrf").expect(200);
    await agent
      .post("/auth/logout")
      .set("X-CSRF-Token", csrf.body.csrfToken)
      .expect(204);

    await agent.get("/auth/me").expect(401);
  });

  it("lists only usable sessions and identifies the current session", async () => {
    const input = registrationInput();
    await request(app)
      .post("/organization-registration")
      .send(input)
      .expect(201);

    const credentials = {
      organizationSlug: input.organizationSlug,
      email: input.adminEmail,
      password: input.adminPassword,
    };
    const agent = request.agent(app);
    const current = await agent
      .post("/auth/login")
      .set("X-Helpdesk-Client", "web")
      .set("User-Agent", "Current browser")
      .send(credentials)
      .expect(200);
    const other = await request(app)
      .post("/auth/login")
      .set("X-Helpdesk-Client", "web")
      .set("User-Agent", "Other browser")
      .send(credentials)
      .expect(200);

    // Exercise each exclusion independently without waiting for real expiration.
    for (const state of ["revoked", "absolute-expired", "idle-expired"]) {
      const login = await request(app)
        .post("/auth/login")
        .set("X-Helpdesk-Client", "web")
        .send(credentials)
        .expect(200);
      const past = new Date(Date.now() - SESSION_IDLE_TIMEOUT_MS - 1000);
      await db
        .updateTable("sessions")
        .set(
          state === "revoked"
            ? { revoked_at: new Date() }
            : state === "absolute-expired"
              ? { absolute_expires_at: past }
              : { last_activity_at: past },
        )
        .where("id", "=", login.body.session.id)
        .where("user_id", "=", current.body.user.id)
        .where("organization_id", "=", current.body.user.organizationId)
        .execute();
    }

    const response = await agent.get("/auth/sessions").expect(200);
    expect(response.body).toEqual({
      sessions: [
        {
          id: other.body.session.id,
          createdAt: expect.any(String),
          lastActivityAt: expect.any(String),
          absoluteExpiresAt: other.body.session.absoluteExpiresAt,
          userAgent: "Other browser",
          isCurrent: false,
        },
        {
          id: current.body.session.id,
          createdAt: expect.any(String),
          lastActivityAt: expect.any(String),
          absoluteExpiresAt: current.body.session.absoluteExpiresAt,
          userAgent: "Current browser",
          isCurrent: true,
        },
      ],
    });
  });

  it("revokes only the selected session and clears the cookie for self-revocation", async () => {
    const input = registrationInput();
    await request(app)
      .post("/organization-registration")
      .send(input)
      .expect(201);
    const credentials = {
      organizationSlug: input.organizationSlug,
      email: input.adminEmail,
      password: input.adminPassword,
    };
    const first = request.agent(app);
    const second = request.agent(app);
    const firstLogin = await first
      .post("/auth/login")
      .set("X-Helpdesk-Client", "web")
      .send(credentials)
      .expect(200);
    const secondLogin = await second
      .post("/auth/login")
      .set("X-Helpdesk-Client", "web")
      .send(credentials)
      .expect(200);
    const currentCookie = firstLogin.headers["set-cookie"]?.[0]?.split(";")[0];
    if (!currentCookie) {
      throw new Error("Login did not set a session cookie");
    }

    const csrf = await first.get("/auth/csrf").expect(200);
    first.set("X-CSRF-Token", csrf.body.csrfToken);

    await first
      .delete(`/auth/sessions/${secondLogin.body.session.id}`)
      .expect(204);
    await second.get("/auth/me").expect(401);
    await first.get("/auth/me").expect(200);
    await first
      .delete(`/auth/sessions/${secondLogin.body.session.id}`)
      .expect(204);
    await first.delete(`/auth/sessions/${randomUUID()}`).expect(204);
    await first.delete("/auth/sessions/not-a-uuid").expect(204);

    const response = await first
      .delete(`/auth/sessions/${firstLogin.body.session.id.toUpperCase()}`)
      .expect(204);
    expect(response.headers["set-cookie"]).toEqual([
      expect.stringContaining("session=;"),
    ]);
    await first.get("/auth/me").expect(401);
    await request(app).get("/auth/me").set("Cookie", currentCookie).expect(401);
  });

  it("isolates session management by account and logs out all of the account's sessions", async () => {
    const input = registrationInput();
    const registration = await request(app)
      .post("/organization-registration")
      .send(input)
      .expect(201);
    const credentials = {
      organizationSlug: input.organizationSlug,
      email: input.adminEmail,
      password: input.adminPassword,
    };
    const first = request.agent(app);
    const second = request.agent(app);
    const firstLogin = await first
      .post("/auth/login")
      .set("X-Helpdesk-Client", "web")
      .send(credentials)
      .expect(200);
    await second
      .post("/auth/login")
      .set("X-Helpdesk-Client", "web")
      .send(credentials)
      .expect(200);
    const csrf = await first.get("/auth/csrf").expect(200);
    first.set("X-CSRF-Token", csrf.body.csrfToken);
    const currentCookie = firstLogin.headers["set-cookie"]?.[0]?.split(";")[0];
    if (!currentCookie) {
      throw new Error("Login did not set a session cookie");
    }

    // No user-creation endpoint exists yet; seed a second user in the same tenant.
    const admin = await db
      .selectFrom("users")
      .select("password_hash")
      .where("id", "=", registration.body.admin.id)
      .where("organization_id", "=", registration.body.organization.id)
      .executeTakeFirstOrThrow();
    const colleagueEmail = `colleague-${randomUUID()}@example.com`;
    const general = await db
      .selectFrom("teams")
      .select("id")
      .where("organization_id", "=", registration.body.organization.id)
      .where("is_general", "=", true)
      .executeTakeFirstOrThrow();
    await db
      .insertInto("users")
      .values({
        organization_id: registration.body.organization.id,
        name: "Colleague",
        email: colleagueEmail,
        password_hash: admin.password_hash,
        role: "AGENT",
        team_id: general.id,
      })
      .execute();
    const colleague = request.agent(app);
    const colleagueLogin = await colleague
      .post("/auth/login")
      .set("X-Helpdesk-Client", "web")
      .send({ ...credentials, email: colleagueEmail })
      .expect(200);

    const foreignInput = {
      ...registrationInput(),
      adminEmail: input.adminEmail,
    };
    await request(app)
      .post("/organization-registration")
      .send(foreignInput)
      .expect(201);
    const foreign = request.agent(app);
    const foreignLogin = await foreign
      .post("/auth/login")
      .set("X-Helpdesk-Client", "web")
      .send({
        organizationSlug: foreignInput.organizationSlug,
        email: foreignInput.adminEmail,
        password: foreignInput.adminPassword,
      })
      .expect(200);

    const listing = await first
      .get("/auth/sessions")
      .query({
        userId: colleagueLogin.body.user.id,
        organizationId: foreignLogin.body.user.organizationId,
      })
      .expect(200);
    expect(listing.body.sessions).toHaveLength(2);
    expect(listing.body.sessions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: colleagueLogin.body.session.id }),
      ]),
    );
    expect(listing.body.sessions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: foreignLogin.body.session.id }),
      ]),
    );

    for (const login of [colleagueLogin, foreignLogin]) {
      await first
        .delete(`/auth/sessions/${login.body.session.id}`)
        .send({
          userId: login.body.user.id,
          organizationId: login.body.user.organizationId,
        })
        .expect(204);
    }
    await colleague.get("/auth/me").expect(200);
    await foreign.get("/auth/me").expect(200);

    const response = await first
      .post("/auth/logout-all")
      .send({
        userId: colleagueLogin.body.user.id,
        organizationId: foreignLogin.body.user.organizationId,
      })
      .expect(204);
    expect(response.headers["set-cookie"]).toEqual([
      expect.stringContaining("session=;"),
    ]);
    await first.get("/auth/me").expect(401);
    await request(app).get("/auth/me").set("Cookie", currentCookie).expect(401);
    await second.get("/auth/me").expect(401);
    await colleague.get("/auth/me").expect(200);
    await foreign.get("/auth/me").expect(200);
  });
  it.each([
    { method: "post", route: "/auth/logout" },
    { method: "delete", route: "/auth/sessions/:sessionId" },
    { method: "post", route: "/auth/logout-all" },
  ] as const)(
    "requires a session-bound CSRF token for $method $route",
    async ({ method, route }) => {
      const input = registrationInput();
      await request(app)
        .post("/organization-registration")
        .send(input)
        .expect(201);
      const credentials = {
        organizationSlug: input.organizationSlug,
        email: input.adminEmail,
        password: input.adminPassword,
      };
      const first = request.agent(app);
      const second = request.agent(app);
      const login = await first
        .post("/auth/login")
        .set("X-Helpdesk-Client", "web")
        .send(credentials)
        .expect(200);
      await second
        .post("/auth/login")
        .set("X-Helpdesk-Client", "web")
        .send(credentials)
        .expect(200);

      const csrf = await first.get("/auth/csrf").expect(200);
      expect(csrf.body).toEqual({
        csrfToken: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(csrf.headers["cache-control"]).toBe("no-store");
      expect(csrf.headers["set-cookie"]).toBeUndefined();
      const repeated = await first.get("/auth/csrf").expect(200);
      expect(repeated.body).toEqual(csrf.body);
      const otherCsrf = await second.get("/auth/csrf").expect(200);
      expect(otherCsrf.body.csrfToken).not.toBe(csrf.body.csrfToken);

      const path = route.replace(":sessionId", login.body.session.id);
      const missing = await first[method](path).expect(403);
      expect(missing.body).toEqual({ error: "Invalid CSRF token" });

      // Cover mismatched lengths and a wrong token of the expected byte length.
      const changedToken =
        (csrf.body.csrfToken[0] === "0" ? "1" : "0") +
        csrf.body.csrfToken.slice(1);
      for (const token of [
        "invalid",
        csrf.body.csrfToken + "0",
        changedToken,
      ]) {
        const invalid = await first[method](path)
          .set("X-CSRF-Token", token)
          .expect(403);
        expect(invalid.body).toEqual(missing.body);
      }

      const crossSession = await second[method](path)
        .set("X-CSRF-Token", csrf.body.csrfToken)
        .expect(403);
      expect(crossSession.body).toEqual(missing.body);
      await first.get("/auth/me").expect(200);
      await second.get("/auth/me").expect(200);

      await first[method](path)
        .set("X-CSRF-Token", csrf.body.csrfToken)
        .expect(204);
      await first.get("/auth/me").expect(401);
    },
  );
});
