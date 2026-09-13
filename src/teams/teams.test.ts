import { randomUUID } from "node:crypto";

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { app } from "../app.js";
import { db } from "../database/db.js";
import { registerOrganization } from "../organization-registration/registration.service.js";
import { createUser } from "../organization-registration/user.repository.js";
import { createSession } from "../auth/sessions/session.repository.js";
import { generateSessionToken, hashSessionToken } from "../auth/sessions/session-token.js";
import { SESSION_ABSOLUTE_LIFETIME_MS } from "../auth/auth.constants.js";
import { createNormalTeam } from "./team.repository.js";

async function sessionCookie(organizationId: string, userId: string) {
  const token = generateSessionToken();
  await createSession(db, {
    organizationId, userId, tokenHash: hashSessionToken(token), userAgent: null,
    absoluteExpiresAt: new Date(Date.now() + SESSION_ABSOLUTE_LIFETIME_MS),
  });
  return `session=${token}`;
}

async function tenant() {
  const unique = randomUUID();
  const { organization, admin } = await registerOrganization({
    organizationName: "Team administration test", organizationSlug: `teams-${unique}`,
    adminName: "Team admin", adminEmail: `${unique}@example.com`,
    adminPassword: "a sufficiently long password",
  });
  const general = await db.selectFrom("teams").select("id")
    .where("organization_id", "=", organization.id).where("is_general", "=", true)
    .executeTakeFirstOrThrow();
  const cookie = await sessionCookie(organization.id, admin.id);
  const csrf = await request(app).get("/auth/csrf").set("Cookie", cookie).expect(200);
  return { organizationId: organization.id, generalId: general.id, cookie, csrf: csrf.body.csrfToken as string };
}

let own: Awaited<ReturnType<typeof tenant>>;
let other: Awaited<ReturnType<typeof tenant>>;
let normalId: string;
let inactiveId: string;
let foreignId: string;
const roleCookies: Record<string, string> = {};

beforeAll(async () => {
  own = await tenant();
  other = await tenant();
  normalId = (await createNormalTeam(db, own.organizationId, "alpha")).id;
  inactiveId = (await createNormalTeam(db, own.organizationId, "Zebra")).id;
  await db.updateTable("teams").set({ deactivated_at: new Date() }).where("id", "=", inactiveId).execute();
  foreignId = (await createNormalTeam(db, other.organizationId, "Foreign")).id;
  for (const role of ["AGENT", "CUSTOMER"] as const) {
    const user = await createUser(db, {
      organizationId: own.organizationId, name: role, email: `${randomUUID()}@example.com`,
      passwordHash: "test-only-hash", role, teamId: role === "AGENT" ? own.generalId : null,
    });
    roleCookies[role] = await sessionCookie(own.organizationId, user.id);
  }
});

afterAll(async () => { await db.destroy(); });

const routes = [["get", ""], ["get", "/id"], ["post", ""], ["patch", "/id"]] as const;

describe("organization-admin team API", () => {
  it.each(routes)("requires tenant authentication for %s /teams%s", async (method, suffix) => {
    const response = await request(app)[method](`/teams${suffix}`).send({}).expect(401);
    expect(response.body).toEqual({ error: "Authentication required" });
  });

  it.each(["AGENT", "CUSTOMER"])("forbids %s before CSRF/input validation on every team route", async (role) => {
    for (const [method, suffix] of routes) {
      const response = await request(app)[method](`/teams${suffix}`)
        .set("Cookie", roleCookies[role]!).send({}).expect(403);
      expect(response.body).toEqual({ error: "Request forbidden" });
    }
  });

  it("lists only own teams in deterministic order with safe metadata and optional status", async () => {
    const response = await request(app).get("/teams").set("Cookie", own.cookie).expect(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.teams.map((team: { id: string }) => team.id)).toEqual([own.generalId, normalId, inactiveId]);
    for (const team of response.body.teams) {
      expect(Object.keys(team).sort()).toEqual(["createdAt", "deactivatedAt", "id", "isGeneral", "name"]);
    }
    const active = await request(app).get("/teams?status=active").set("Cookie", own.cookie).expect(200);
    expect(active.body.teams.map((team: { id: string }) => team.id)).toEqual([own.generalId, normalId]);
    const inactive = await request(app).get("/teams?status=deactivated").set("Cookie", own.cookie).expect(200);
    expect(inactive.body.teams.map((team: { id: string }) => team.id)).toEqual([inactiveId]);
  });

  it("allows viewing General without CSRF", async () => {
    const response = await request(app).get(`/teams/${own.generalId}`).set("Cookie", own.cookie).expect(200);
    expect(response.body).toEqual({
      id: own.generalId, name: "General", isGeneral: true, deactivatedAt: null, createdAt: expect.any(String),
    });
  });

  it("makes foreign and unknown IDs indistinguishable for reads and renames", async () => {
    for (const id of [foreignId, other.generalId, randomUUID()]) {
      for (const method of ["get", "patch"] as const) {
        const response = await request(app)[method](`/teams/${id}`).set("Cookie", own.cookie)
          .set("X-CSRF-Token", own.csrf).send({ name: "Stolen" }).expect(404);
        expect(response.body).toEqual({ error: "Team not found" });
      }
    }
    const foreign = await db.selectFrom("teams").select("name").where("id", "=", foreignId).executeTakeFirstOrThrow();
    expect(foreign.name).toBe("Foreign");
  });

  it("creates an active normal team, trims its name, and derives ownership from the session", async () => {
    const response = await request(app).post("/teams").query({ organizationId: other.organizationId })
      .set("Cookie", own.cookie).set("X-CSRF-Token", own.csrf).send({ name: "  Billing  " }).expect(201);
    expect(response.body).toEqual({
      id: expect.any(String), name: "Billing", isGeneral: false, deactivatedAt: null, createdAt: expect.any(String),
    });
    const stored = await db.selectFrom("teams").select("organization_id")
      .where("id", "=", response.body.id).executeTakeFirstOrThrow();
    expect(stored.organization_id).toBe(own.organizationId);
    await request(app).post("/teams").set("Cookie", other.cookie).set("X-CSRF-Token", other.csrf)
      .send({ name: "billing" }).expect(201);
  });

  it.each(["  ALPHA  ", " zebra ", " general "])("rejects reserved normalized name %s", async (name) => {
    const response = await request(app).post("/teams").set("Cookie", own.cookie)
      .set("X-CSRF-Token", own.csrf).send({ name }).expect(409);
    expect(response.body).toEqual({ error: "Team name already exists" });
  });

  it("allows only one of two concurrent duplicate creates", async () => {
    const name = `Concurrent-${randomUUID()}`;
    const responses = await Promise.all([name, ` ${name.toUpperCase()} `].map((value) =>
      request(app).post("/teams").set("Cookie", own.cookie).set("X-CSRF-Token", own.csrf).send({ name: value }),
    ));
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
  });

  it("renames a normal team without changing its other fields, including inactive state", async () => {
    for (const id of [normalId, inactiveId]) {
      const before = await request(app).get(`/teams/${id}`).set("Cookie", own.cookie).expect(200);
      const name = `Renamed-${id}`;
      const response = await request(app).patch(`/teams/${id}`).set("Cookie", own.cookie)
        .set("X-CSRF-Token", own.csrf).send({ name: ` ${name} ` }).expect(200);
      expect(response.body).toEqual({ ...before.body, name });
    }
  });

  it("rejects General rename and conflicting normal-team rename without changing either", async () => {
    const general = await request(app).patch(`/teams/${own.generalId}`).set("Cookie", own.cookie)
      .set("X-CSRF-Token", own.csrf).send({ name: "Other name" }).expect(409);
    expect(general.body).toEqual({ error: "General team cannot be renamed" });
    const response = await request(app).patch(`/teams/${normalId}`).set("Cookie", own.cookie)
      .set("X-CSRF-Token", own.csrf).send({ name: " GENERAL " }).expect(409);
    expect(response.body).toEqual({ error: "Team name already exists" });
    const unchanged = await request(app).get(`/teams/${normalId}`).set("Cookie", own.cookie).expect(200);
    expect(unchanged.body.name).toBe(`Renamed-${normalId}`);
  });

  it.each(["post", "patch"] as const)("requires valid session-bound CSRF for %s before validation", async (method) => {
    const path = method === "post" ? "/teams" : `/teams/${normalId}`;
    const before = await db.selectFrom("teams").selectAll().where("organization_id", "=", own.organizationId).orderBy("id").execute();
    for (const token of [undefined, "invalid", other.csrf]) {
      const operation = request(app)[method](path).set("Cookie", own.cookie).send({});
      if (token) operation.set("X-CSRF-Token", token);
      const response = await operation.expect(403);
      expect(response.body).toEqual({ error: "Invalid CSRF token" });
    }
    expect(await db.selectFrom("teams").selectAll().where("organization_id", "=", own.organizationId).orderBy("id").execute()).toEqual(before);
  });

  it.each(["post", "patch"] as const)("rejects invalid names and extra fields for %s", async (method) => {
    const path = method === "post" ? "/teams" : `/teams/${normalId}`;
    for (const body of [
      {}, { name: "   " }, { name: "a".repeat(256) }, { name: 12 },
      { name: "Valid", is_general: true }, { name: "Valid", isGeneral: true },
      { name: "Valid", organization_id: other.organizationId },
      { name: "Valid", organizationId: other.organizationId },
      { name: "Valid", deactivated_at: null },
    ]) {
      const response = await request(app)[method](path).set("Cookie", own.cookie)
        .set("X-CSRF-Token", own.csrf).send(body).expect(400);
      expect(response.body.error).toBe("Invalid team data");
    }
  });

  it("rejects malformed IDs and unsupported query values", async () => {
    for (const method of ["get", "patch"] as const) {
      await request(app)[method]("/teams/not-a-uuid").set("Cookie", own.cookie)
        .set("X-CSRF-Token", own.csrf).send({ name: "Valid" }).expect(400);
    }
    for (const query of [{ status: "unknown" }, { organizationId: other.organizationId }]) {
      await request(app).get("/teams").query(query).set("Cookie", own.cookie).expect(400);
    }
  });
});
