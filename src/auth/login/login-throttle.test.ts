import { randomUUID } from "node:crypto";

import argon2 from "argon2";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { app } from "../../app.js";
import { db } from "../../database/db.js";
import {
  LOGIN_FAILURE_THRESHOLD,
  LOGIN_OBSERVATION_WINDOW_MS,
  LOGIN_BLOCK_DURATION_MS,
} from "../auth.constants.js";
import { hashLoginIdentifier } from "./login-throttle-key.js";
import { recordLoginFailure } from "./login-throttle.repository.js";

function registrationInput() {
  const unique = randomUUID();

  return {
    organizationName: "Throttle Test Organization",
    organizationSlug: `throttle-${unique}`,
    adminName: "Throttle Admin",
    adminEmail: `admin-${unique}@example.com`,
    adminPassword: "a sufficiently long password",
  };
}

describe("tenant login throttling", () => {
  it.each([
    "wrong password",
    "missing user",
    "missing organization",
    "deactivated user",
    "deactivated organization",
  ])(
    "blocks the fifth failure for %s and skips verification while blocked",
    async (state) => {
      const input = registrationInput();
      const registration = await request(app)
        .post("/organization-registration")
        .send(input)
        .expect(201);

      if (state === "deactivated user") {
        await db
          .updateTable("users")
          .set({ deactivated_at: new Date() })
          .where("id", "=", registration.body.admin.id)
          .where("organization_id", "=", registration.body.organization.id)
          .execute();
      }
      if (state === "deactivated organization") {
        await db
          .updateTable("organizations")
          .set({ deactivated_at: new Date() })
          .where("id", "=", registration.body.organization.id)
          .execute();
      }

      const credentials = {
        organizationSlug:
          state === "missing organization"
            ? `missing-${randomUUID()}`
            : input.organizationSlug,
        email:
          state === "missing user"
            ? `missing-${randomUUID()}@example.com`
            : input.adminEmail,
        password:
          state === "wrong password"
            ? "incorrect password"
            : input.adminPassword,
      };
      const identifierHash = hashLoginIdentifier(
        credentials.organizationSlug,
        credentials.email,
      );

      for (let attempt = 1; attempt <= 5; attempt++) {
        const response = await request(app)
          .post("/auth/login")
          .set("X-Helpdesk-Client", "web")
          .send(
            attempt % 2 === 0
              ? {
                  ...credentials,
                  organizationSlug: ` ${credentials.organizationSlug.toUpperCase()} `,
                  email: ` ${credentials.email.toUpperCase()} `,
                }
              : credentials,
          )
          .expect(attempt < 5 ? 401 : 429);
        expect(response.body).toEqual({
          error:
            attempt < 5 ? "Invalid credentials" : "Too many login attempts",
        });
      }

      const blocked = await db
        .selectFrom("login_throttles")
        .selectAll()
        .where("identifier_hash", "=", identifierHash)
        .executeTakeFirstOrThrow();
      expect(blocked.failed_attempts).toBe(5);
      expect(
        blocked.blocked_until!.getTime() - blocked.updated_at.getTime(),
      ).toBe(60_000);

      const verification = vi.spyOn(argon2, "verify");
      try {
        const response = await request(app)
          .post("/auth/login")
          .set("X-Helpdesk-Client", "web")
          .send({ ...credentials, password: input.adminPassword })
          .expect(429);
        expect(response.body).toEqual({ error: "Too many login attempts" });
        expect(verification).not.toHaveBeenCalled();
      } finally {
        verification.mockRestore();
      }

      const unchanged = await db
        .selectFrom("login_throttles")
        .selectAll()
        .where("identifier_hash", "=", identifierHash)
        .executeTakeFirstOrThrow();
      expect(unchanged).toEqual(blocked);
    },
    10_000, // Multiple Argon2 verifications can contend during the full suite.
  );

  it("clears prior failures on successful authentication", async () => {
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
    const identifierHash = hashLoginIdentifier(
      input.organizationSlug,
      input.adminEmail,
    );

    for (let attempt = 0; attempt < 2; attempt++) {
      await request(app)
        .post("/auth/login")
        .set("X-Helpdesk-Client", "web")
        .send({ ...credentials, password: "incorrect password" })
        .expect(401);
    }
    const agent = request.agent(app);
    await agent
      .post("/auth/login")
      .set("X-Helpdesk-Client", "web")
      .send(credentials)
      .expect(200);
    await agent.get("/auth/me").expect(200);
    const cleared = await db
      .selectFrom("login_throttles")
      .selectAll()
      .where("identifier_hash", "=", identifierHash)
      .executeTakeFirst();
    expect(cleared).toBeUndefined();

    await request(app)
      .post("/auth/login")
      .set("X-Helpdesk-Client", "web")
      .send({ ...credentials, password: "incorrect password" })
      .expect(401);
    const fresh = await db
      .selectFrom("login_throttles")
      .selectAll()
      .where("identifier_hash", "=", identifierHash)
      .executeTakeFirstOrThrow();
    expect(fresh.failed_attempts).toBe(1);
    expect(fresh.blocked_until).toBeNull();
  });

  it.each([true, false])(
    "handles an expired block with observation window expired=%s",
    async (windowExpired) => {
      const input = registrationInput();
      const identifierHash = hashLoginIdentifier(
        input.organizationSlug,
        input.adminEmail,
      );
      const now = Date.now();
      const windowStart = new Date(
        now - (windowExpired ? LOGIN_OBSERVATION_WINDOW_MS + 1000 : 300_000),
      );
      await db
        .insertInto("login_throttles")
        .values({
          identifier_hash: identifierHash,
          failed_attempts: 5,
          window_started_at: windowStart,
          blocked_until: new Date(now - 1000),
          updated_at: new Date(now - LOGIN_BLOCK_DURATION_MS - 1000),
        })
        .execute();

      const response = await request(app)
        .post("/auth/login")
        .set("X-Helpdesk-Client", "web")
        .send({
          organizationSlug: input.organizationSlug,
          email: input.adminEmail,
          password: input.adminPassword,
        })
        .expect(windowExpired ? 401 : 429);
      expect(response.body).toEqual({
        error: windowExpired
          ? "Invalid credentials"
          : "Too many login attempts",
      });
      const throttle = await db
        .selectFrom("login_throttles")
        .selectAll()
        .where("identifier_hash", "=", identifierHash)
        .executeTakeFirstOrThrow();
      expect(throttle.failed_attempts).toBe(windowExpired ? 1 : 6);
      if (windowExpired) {
        expect(throttle.window_started_at.getTime()).toBeGreaterThan(
          windowStart.getTime(),
        );
        expect(throttle.window_started_at).toEqual(throttle.updated_at);
        expect(throttle.blocked_until).toBeNull();
      } else {
        expect(throttle.window_started_at).toEqual(windowStart);
        expect(
          throttle.blocked_until!.getTime() - throttle.updated_at.getTime(),
        ).toBe(60_000);
      }
    },
  );

  it("keeps different organization and email identities independent", async () => {
    const input = registrationInput();
    const credentials = {
      organizationSlug: input.organizationSlug,
      email: input.adminEmail,
      password: input.adminPassword,
    };
    for (let attempt = 1; attempt <= 5; attempt++) {
      await request(app)
        .post("/auth/login")
        .set("X-Helpdesk-Client", "web")
        .send(credentials)
        .expect(attempt < 5 ? 401 : 429);
    }
    for (const other of [
      { ...credentials, organizationSlug: `other-${randomUUID()}` },
      { ...credentials, email: `other-${randomUUID()}@example.com` },
    ]) {
      const response = await request(app)
        .post("/auth/login")
        .set("X-Helpdesk-Client", "web")
        .send(other)
        .expect(401);
      expect(response.body).toEqual({ error: "Invalid credentials" });
    }
  });

  it("does not count schema or login-CSRF rejections", async () => {
    const input = registrationInput();
    const credentials = {
      organizationSlug: input.organizationSlug,
      email: input.adminEmail,
      password: input.adminPassword,
    };
    await request(app).post("/auth/login").send(credentials).expect(403);
    await request(app)
      .post("/auth/login")
      .set("X-Helpdesk-Client", "incorrect")
      .send(credentials)
      .expect(403);
    await request(app)
      .post("/auth/login")
      .set("X-Helpdesk-Client", "web")
      .send({ ...credentials, password: "" })
      .expect(400);

    const throttle = await db
      .selectFrom("login_throttles")
      .selectAll()
      .where(
        "identifier_hash",
        "=",
        hashLoginIdentifier(input.organizationSlug, input.adminEmail),
      )
      .executeTakeFirst();
    expect(throttle).toBeUndefined();
  });

  it.each([false, true])(
    "records concurrent failures without lost increments (expired row=%s)",
    async (expiredRow) => {
      const input = registrationInput();
      const identifierHash = hashLoginIdentifier(
        input.organizationSlug,
        input.adminEmail,
      );
      if (expiredRow) {
        const past = new Date(Date.now() - LOGIN_OBSERVATION_WINDOW_MS - 1000);
        await db
          .insertInto("login_throttles")
          .values({
            identifier_hash: identifierHash,
            failed_attempts: 99,
            window_started_at: past,
            blocked_until: null,
            updated_at: past,
          })
          .execute();
      }

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          recordLoginFailure(db, {
            identifierHash,
            observationWindowMs: LOGIN_OBSERVATION_WINDOW_MS,
            blockDurationMs: LOGIN_BLOCK_DURATION_MS,
            failureThreshold: LOGIN_FAILURE_THRESHOLD,
          }),
        ),
      );
      expect(
        results.map((result) => result.failed_attempts).sort((a, b) => a - b),
      ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const throttle = await db
        .selectFrom("login_throttles")
        .selectAll()
        .where("identifier_hash", "=", identifierHash)
        .executeTakeFirstOrThrow();
      expect(throttle.failed_attempts).toBe(10);
      expect(
        throttle.blocked_until!.getTime() - throttle.updated_at.getTime(),
      ).toBe(60_000);
    },
  );
});
