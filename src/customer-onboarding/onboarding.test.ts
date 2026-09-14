import { randomUUID } from "node:crypto";

import argon2 from "argon2";
import { sql } from "kysely";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { app } from "../app.js";
import { db } from "../database/db.js";
import { registerOrganization } from "../organization-registration/registration.service.js";
import * as userRepository from "../organization-registration/user.repository.js";
import { findGeneralTeam } from "../teams/team.repository.js";
import * as invitationRepository from "../agent-invitations/invitation.repository.js";
import { deactivateOrganization } from "../system-admin/organizations/organizations.service.js";
import * as platformOrganizations from "../system-admin/organizations/platform-organizations.repository.js";
import * as organizationRepository from "./organization.repository.js";
import { registerCustomer } from "./onboarding.service.js";

const password = "a sufficiently long customer password";
const unavailable = { error: "Support organization not found" };
const duplicate = { error: "An account with this email already exists" };

async function tenant() {
  const unique = randomUUID();
  return registerOrganization({
    organizationName: "Customer support", organizationSlug: `support-${unique}`,
    adminName: "Admin", adminEmail: `${unique}@example.com`, adminPassword: password,
  });
}

let own: Awaited<ReturnType<typeof tenant>>;
let other: typeof own;
beforeAll(async () => { own = await tenant(); other = await tenant(); });
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await db.destroy(); });

function input() { return { name: "Customer", email: `${randomUUID()}@example.com`, password }; }
function lookup(slug: string) { return request(app).get(`/public/organizations/${encodeURIComponent(slug)}`); }
function register(body: object = input(), slug = own.organization.slug) {
  return request(app).post(`/public/organizations/${encodeURIComponent(slug)}/customers/register`).send(body);
}
function users(email: string, owner = own) {
  return db.selectFrom("users").selectAll().where("organization_id", "=", owner.organization.id)
    .where("email", "=", email).execute();
}
async function waitForOrganizationLock(clause: string) {
  await vi.waitFor(async () => {
    const result = await sql<{ waiting: string }>`
      SELECT count(*) AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND usename = current_user AND wait_event_type = 'Lock'
        AND query LIKE '%organizations%' AND query LIKE ${`%${clause}%`}
    `.execute(db);
    expect(Number(result.rows[0]!.waiting)).toBe(1);
  }, { timeout: 5000, interval: 20 });
}

describe("public customer onboarding", () => {
  it("resolves an active public slug and returns only name and slug", async () => {
    const result = await lookup(` ${own.organization.slug.toUpperCase()} `).expect(200);
    expect(result.body).toEqual({ name: own.organization.name, slug: own.organization.slug });
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.headers["set-cookie"]).toBeUndefined();
  });

  it("makes missing and inactive organizations equally unavailable without password hashing", async () => {
    const inactive = await tenant();
    await deactivateOrganization(inactive.organization.id);
    const hash = vi.spyOn(argon2, "hash");
    for (const slug of [`unknown-${randomUUID()}`, inactive.organization.slug]) {
      expect((await lookup(slug).expect(404)).body).toEqual(unavailable);
      const result = await register(input(), slug).expect(404);
      expect(result.body).toEqual(unavailable);
      expect(result.headers["cache-control"]).toBe("no-store");
    }
    expect(hash).not.toHaveBeenCalled();
  });

  it("creates an active CUSTOMER in the URL organization, hashes the password and creates no session or invitation", async () => {
    const data = input();
    const result = await register({
      ...data, name: " Customer ", email: ` ${data.email.toUpperCase()} `,
    }, ` ${own.organization.slug.toUpperCase()} `).expect(201);
    expect(result.body).toEqual({ id: expect.any(String), name: data.name, email: data.email, role: "CUSTOMER" });
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.headers["set-cookie"]).toBeUndefined();
    const [customer] = await users(data.email);
    expect(customer!.id[14]).toBe("7");
    expect(customer).toMatchObject({
      id: result.body.id, organization_id: own.organization.id, role: "CUSTOMER",
      team_id: null, deactivated_at: null, name: data.name, email: data.email,
    });
    expect(customer!.password_hash).toMatch(/^\$argon2id\$/);
    expect(await argon2.verify(customer!.password_hash, password)).toBe(true);
    expect(JSON.stringify(result.body)).not.toContain(customer!.password_hash);
    expect(await db.selectFrom("sessions").select("id")
      .where("organization_id", "=", own.organization.id).where("user_id", "=", customer!.id).execute()).toEqual([]);
    expect(await db.selectFrom("tenant_user_invitations").select("id")
      .where("organization_id", "=", own.organization.id).where("email", "=", data.email).execute()).toEqual([]);
    expect(await users(data.email, other)).toEqual([]);
    await request(app).get("/auth/me").expect(401);
  });

  it("rejects same-organization emails across every role without revealing or changing the role", async () => {
    const general = await findGeneralTeam(db, own.organization.id);
    const emails = [own.admin.email];
    for (const role of ["CUSTOMER", "AGENT"] as const) {
      const data = input();
      const user = await userRepository.createUser(db, {
        organizationId: own.organization.id, name: data.name, email: data.email,
        passwordHash: "test-only-hash", role, teamId: role === "AGENT" ? general!.id : null,
      });
      if (role === "CUSTOMER") {
        await db.updateTable("users").set({ deactivated_at: new Date() })
          .where("organization_id", "=", own.organization.id).where("id", "=", user.id).execute();
      }
      emails.push(data.email);
    }
    for (const email of emails) {
      const before = await users(email);
      expect((await register({ ...input(), email: ` ${email.toUpperCase()} ` }).expect(409)).body).toEqual(duplicate);
      expect(await users(email)).toEqual(before);
    }
    const data = input();
    await register(data).expect(201);
    expect((await register(data).expect(409)).body).toEqual(duplicate);
    expect(await users(data.email)).toHaveLength(1);
  });

  it("allows the same customer email in different organizations", async () => {
    const data = input();
    const first = await register(data).expect(201);
    const second = await register(data, other.organization.slug).expect(201);
    expect(first.body.id).not.toBe(second.body.id);
    expect((await users(data.email))[0]!.organization_id).toBe(own.organization.id);
    expect((await users(data.email, other))[0]!.organization_id).toBe(other.organization.id);
  });

  it("rejects client-controlled identity/state and malformed input before hashing", async () => {
    const data = input();
    const hash = vi.spyOn(argon2, "hash");
    for (const body of [
      {}, { ...data, role: "AGENT" }, { ...data, role: "ORGANIZATION_ADMIN" },
      { ...data, organizationId: other.organization.id }, { ...data, teamId: randomUUID() },
      { ...data, teamId: null }, { ...data, deactivated_at: null }, { ...data, deactivatedAt: null },
      { ...data, passwordConfirmation: password }, { ...data, name: " " }, { ...data, name: "a".repeat(256) },
      { ...data, email: "invalid" }, { ...data, password: "short" }, { ...data, password: "a".repeat(129) },
      { ...data, [password]: true },
    ]) {
      expect((await register(body).expect(400)).body).toEqual({ error: "Invalid customer registration data" });
    }
    for (const slug of ["invalid_slug", "a".repeat(101)]) {
      expect((await lookup(slug).expect(400)).body).toEqual({ error: "Invalid organization slug" });
      await register(data, slug).expect(400);
    }
    expect(hash).not.toHaveBeenCalled();
    expect(await users(data.email)).toEqual([]);
  });

  it("hashes outside the transaction and revalidates deactivation after preflight", async () => {
    const owner = await tenant();
    const data = input();
    const hash = argon2.hash;
    const transaction = vi.spyOn(db, "transaction");
    vi.spyOn(argon2, "hash").mockImplementationOnce(async (...args) => {
      expect(transaction).not.toHaveBeenCalled();
      await deactivateOrganization(owner.organization.id);
      return hash(...args);
    });
    expect((await register(data, owner.organization.slug).expect(404)).body).toEqual(unavailable);
    expect(await users(data.email, owner)).toEqual([]);
  });

  it("does not trust preflight if the authoritative lookup no longer resolves the organization", async () => {
    const data = input();
    vi.spyOn(organizationRepository, "findRegistrationOrganizationForShare").mockResolvedValueOnce(undefined);
    expect((await register(data).expect(404)).body).toEqual(unavailable);
    expect(await users(data.email)).toEqual([]);
  });

  it("maps database uniqueness when concurrent registrations both pass the user check", async () => {
    const data = input();
    const find = invitationRepository.findExistingUser;
    let arrived = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(invitationRepository, "findExistingUser").mockImplementation(async (...args) => {
      const result = await find(...args);
      if (++arrived === 2) release();
      await bothRead;
      return result;
    });
    const responses = await Promise.all([register(data), register(data)]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(responses.find((response) => response.status === 409)!.body).toEqual(duplicate);
    expect(await users(data.email)).toHaveLength(1);
  });

  it("rolls back an inserted customer if persistence subsequently fails", async () => {
    const data = input();
    const create = userRepository.createUser;
    vi.spyOn(userRepository, "createUser").mockImplementationOnce(async (...args) => {
      await create(...args);
      throw new Error("Test customer persistence failure");
    });
    await expect(registerCustomer(own.organization.slug, data)).rejects.toThrow("Test customer persistence failure");
    expect(await users(data.email)).toEqual([]);
  });

  it("holds the organization share lock until registration commits before deactivation", async () => {
    const owner = await tenant();
    const data = input();
    const create = userRepository.createUser;
    let deactivation: Promise<void> | undefined;
    vi.spyOn(userRepository, "createUser").mockImplementationOnce(async (...args) => {
      deactivation = deactivateOrganization(owner.organization.id);
      await waitForOrganizationLock("update");
      return create(...args);
    });
    try {
      await register(data, owner.organization.slug).expect(201);
      await deactivation;
      expect(await users(data.email, owner)).toHaveLength(1);
      expect((await lookup(owner.organization.slug).expect(404)).body).toEqual(unavailable);
    } finally { if (deactivation) await Promise.allSettled([deactivation]); }
  }, 15_000);

  it("observes inactive organization state if deactivation holds the row lock first", async () => {
    const owner = await tenant();
    const data = input();
    const deactivate = platformOrganizations.deactivatePlatformOrganization;
    let registration: Promise<unknown> | undefined;
    vi.spyOn(platformOrganizations, "deactivatePlatformOrganization").mockImplementationOnce(async (...args) => {
      const result = await deactivate(...args);
      registration = registerCustomer(owner.organization.slug, data).catch((error: unknown) => error);
      await waitForOrganizationLock("for share");
      return result;
    });
    try {
      await deactivateOrganization(owner.organization.id);
      expect(await registration).toMatchObject({ statusCode: 404, message: unavailable.error });
      expect(await users(data.email, owner)).toEqual([]);
    } finally { if (registration) await Promise.allSettled([registration]); }
  }, 15_000);
});
