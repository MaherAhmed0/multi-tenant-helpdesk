import { randomUUID } from "node:crypto";

import argon2 from "argon2";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { app } from "../app.js";
import { db } from "../database/db.js";
import { hashLoginIdentifier } from "../auth/login/login-throttle-key.js";
import { hashSessionToken } from "../auth/sessions/session-token.js";
import { getSessionCookieOptions } from "../auth/sessions/session-cookie.js";
import { registerOrganization } from "../organization-registration/registration.service.js";
import { createUser } from "../organization-registration/user.repository.js";
import { findGeneralTeam } from "../teams/team.repository.js";
import { registerCustomer } from "./onboarding.service.js";

const password = "a sufficiently long customer password";
const otherPassword = "another sufficiently long password";
const email = `${randomUUID()}@example.com`;
const invalidCredentials = { error: "Invalid credentials" };

async function tenant() {
  const unique = randomUUID();
  return registerOrganization({
    organizationName: "Customer login", organizationSlug: `login-${unique}`,
    adminName: "Admin", adminEmail: `${unique}@example.com`, adminPassword: password,
  });
}
let own: Awaited<ReturnType<typeof tenant>>;
let other: typeof own;
let customer: Awaited<ReturnType<typeof registerCustomer>>;
let otherCustomer: typeof customer;
beforeAll(async () => {
  own = await tenant();
  other = await tenant();
  customer = await registerCustomer(own.organization.slug, { name: "Customer", email, password });
  otherCustomer = await registerCustomer(other.organization.slug, { name: "Other Customer", email, password: otherPassword });
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await db.destroy(); });

function path(slug = own.organization.slug) {
  return `/public/organizations/${encodeURIComponent(slug)}/customers/login`;
}
function login(body: object = { email, password }, slug = own.organization.slug) {
  return request(app).post(path(slug)).set("X-Helpdesk-Client", "web").send(body);
}
function sessions(userId: string, organizationId = own.organization.id) {
  return db.selectFrom("sessions").selectAll()
    .where("organization_id", "=", organizationId).where("user_id", "=", userId).execute();
}
function throttle(accountEmail: string, slug = own.organization.slug) {
  return db.selectFrom("login_throttles").selectAll()
    .where("identifier_hash", "=", hashLoginIdentifier(slug, accountEmail)).executeTakeFirst();
}

describe("public customer login", () => {
  it("creates normal tenant sessions and preserves cookie, authentication and CSRF behavior", async () => {
    const result = await login({ email: ` ${email.toUpperCase()} `, password }, ` ${own.organization.slug.toUpperCase()} `)
      .set("User-Agent", "Customer login test").expect(200);
    expect(result.body).toEqual({
      user: { id: customer.id, organizationId: own.organization.id, name: customer.name, email, role: "CUSTOMER" },
      session: { id: expect.any(String), absoluteExpiresAt: expect.any(String) },
    });
    expect(result.headers["cache-control"]).toBe("no-store");
    const cookies = result.headers["set-cookie"] as unknown as string[];
    expect(cookies).toHaveLength(1);
    const cookie = cookies[0]!;
    expect(cookie).toMatch(/^session=/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/;");
    expect(cookie.includes("; Secure")).toBe(getSessionCookieOptions().secure);
    expect(cookie).not.toMatch(/Max-Age|Expires=/);
    const credential = cookie.split(";")[0]!;
    const rawToken = credential.slice("session=".length);
    const stored = (await sessions(customer.id)).find((row) => row.id === result.body.session.id)!;
    expect(stored.token_hash).toBe(hashSessionToken(rawToken));
    expect(stored.token_hash).not.toBe(rawToken);
    expect(stored.user_agent).toBe("Customer login test");
    expect(stored.absolute_expires_at.toISOString()).toBe(result.body.session.absoluteExpiresAt);
    expect(JSON.stringify(result.body)).not.toContain(rawToken);
    expect(JSON.stringify(result.body)).not.toContain(stored.token_hash);

    const me = await request(app).get("/auth/me").set("Cookie", credential).expect(200);
    expect(me.body.user).toMatchObject({ id: customer.id, organizationId: own.organization.id, role: "CUSTOMER" });
    const second = await login().expect(200);
    expect(second.body.session.id).not.toBe(stored.id);
    expect(await sessions(customer.id)).toHaveLength(2);
    await request(app).post("/auth/logout").set("Cookie", credential).expect(403);
    const csrf = await request(app).get("/auth/csrf").set("Cookie", credential).expect(200);
    await request(app).post("/auth/logout").set("Cookie", credential)
      .set("X-CSRF-Token", csrf.body.csrfToken).expect(204);
    await request(app).get("/auth/me").set("Cookie", credential).expect(401);
  });

  it("selects the account by slug when both organizations have the same email", async () => {
    const first = await login().expect(200);
    const second = await login({ email, password: otherPassword }, other.organization.slug).expect(200);
    expect(first.body.user.id).toBe(customer.id);
    expect(second.body.user).toMatchObject({ id: otherCustomer.id, organizationId: other.organization.id });
    const before = await sessions(customer.id);
    const otherBefore = await sessions(otherCustomer.id, other.organization.id);
    for (const [slug, wrongPassword] of [
      [own.organization.slug, otherPassword], [other.organization.slug, password],
    ]) {
      const result = await login({ email, password: wrongPassword }, slug).expect(401);
      expect(result.body).toEqual(invalidCredentials);
      expect(result.headers["set-cookie"]).toBeUndefined();
    }
    expect(await sessions(customer.id)).toEqual(before);
    expect(await sessions(otherCustomer.id, other.organization.id)).toEqual(otherBefore);
  });

  it.each(["AGENT", "ORGANIZATION_ADMIN"] as const)(
    "rejects valid %s credentials generically before session creation while preserving internal login", async (role) => {
      let account: { id: string; email: string } = own.admin;
      if (role === "AGENT") {
        const general = await findGeneralTeam(db, own.organization.id);
        account = await createUser(db, {
          organizationId: own.organization.id, name: "Agent", email: `${randomUUID()}@example.com`,
          passwordHash: await argon2.hash(password, { type: argon2.argon2id }), role, teamId: general!.id,
        });
      }
      const credentials = { email: account.email, password };
      const result = await login(credentials).expect(401);
      expect(result.body).toEqual(invalidCredentials);
      expect(result.headers["set-cookie"]).toBeUndefined();
      expect(await sessions(account.id)).toEqual([]);
      expect((await throttle(account.email))!.failed_attempts).toBe(1);
      const internal = await request(app).post("/auth/login").set("X-Helpdesk-Client", "web")
        .send({ ...credentials, organizationSlug: own.organization.slug }).expect(200);
      expect(internal.body.user).toMatchObject({ id: account.id, role });
      expect(await throttle(account.email)).toBeUndefined();
    },
  );

  it.each(["unknown slug", "unknown email", "wrong password", "inactive customer", "inactive organization"])(
    "uses generic failures and password verification for %s", async (state) => {
      const owner = await tenant();
      const data = { name: "Customer", email: `${randomUUID()}@example.com`, password };
      const account = await registerCustomer(owner.organization.slug, data);
      if (state === "inactive customer") {
        await db.updateTable("users").set({ deactivated_at: new Date() })
          .where("organization_id", "=", owner.organization.id).where("id", "=", account.id).execute();
      }
      if (state === "inactive organization") {
        await db.updateTable("organizations").set({ deactivated_at: new Date() })
          .where("id", "=", owner.organization.id).execute();
      }
      const slug = state === "unknown slug" ? `missing-${randomUUID()}` : owner.organization.slug;
      const submittedEmail = state === "unknown email" ? `${randomUUID()}@example.com` : data.email;
      const verify = vi.spyOn(argon2, "verify");
      const result = await login({ email: submittedEmail, password: state === "wrong password" ? "x" : password }, slug).expect(401);
      expect(result.body).toEqual(invalidCredentials);
      expect(result.headers["set-cookie"]).toBeUndefined();
      expect(verify).toHaveBeenCalledOnce();
      expect((await throttle(submittedEmail, slug))!.failed_attempts).toBe(1);
      expect(await sessions(account.id, owner.organization.id)).toEqual([]);
    },
  );

  it("shares the existing throttle key across entry points and skips verification while blocked", async () => {
    const data = { name: "Customer", email: `${randomUUID()}@example.com`, password };
    const account = await registerCustomer(own.organization.slug, data);
    for (let attempt = 1; attempt <= 5; attempt++) {
      const credentials = { email: ` ${data.email.toUpperCase()} `, password: "incorrect" };
      const result = await (attempt % 2 === 1
        ? login(credentials)
        : request(app).post("/auth/login").set("X-Helpdesk-Client", "web")
          .send({ ...credentials, organizationSlug: own.organization.slug }))
        .expect(attempt < 5 ? 401 : 429);
      expect(result.body).toEqual({ error: attempt < 5 ? "Invalid credentials" : "Too many login attempts" });
    }
    expect((await throttle(data.email))!.failed_attempts).toBe(5);
    const verify = vi.spyOn(argon2, "verify");
    expect((await login({ email: data.email, password }).expect(429)).body).toEqual({ error: "Too many login attempts" });
    expect(verify).not.toHaveBeenCalled();
    expect(await sessions(account.id)).toEqual([]);
  });

  it("clears prior failures on successful public login", async () => {
    const data = { name: "Customer", email: `${randomUUID()}@example.com`, password };
    await registerCustomer(own.organization.slug, data);
    await login({ email: data.email, password: "incorrect" }).expect(401);
    expect((await throttle(data.email))!.failed_attempts).toBe(1);
    await login({ email: data.email, password }).expect(200);
    expect(await throttle(data.email)).toBeUndefined();
  });

  it("uses the login browser guard and rejects invalid/client-controlled input before authentication", async () => {
    const credentials = { email: `${randomUUID()}@example.com`, password };
    const verify = vi.spyOn(argon2, "verify");
    expect((await request(app).post(path()).send(credentials).expect(403)).body).toEqual({ error: "Request forbidden" });
    expect((await request(app).post(path()).set("X-Helpdesk-Client", "other").send(credentials).expect(403)).body)
      .toEqual({ error: "Request forbidden" });
    for (const body of [
      {}, { ...credentials, organizationId: own.organization.id }, { ...credentials, organizationSlug: own.organization.slug },
      { ...credentials, userId: customer.id }, { ...credentials, role: "CUSTOMER" },
      { ...credentials, requiredRole: "AGENT" }, { ...credentials, absoluteExpiresAt: new Date().toISOString() },
      { ...credentials, email: "invalid" }, { ...credentials, password: "" }, { ...credentials, password: "a".repeat(129) },
    ]) {
      expect((await login(body).expect(400)).body).toEqual({ error: "Invalid login data" });
    }
    for (const slug of ["invalid_slug", "a".repeat(101)]) {
      expect((await login(credentials, slug).expect(400)).body).toEqual({ error: "Invalid login data" });
    }
    expect(verify).not.toHaveBeenCalled();
    expect(await throttle(credentials.email)).toBeUndefined();
  });
});
