import { randomUUID } from "node:crypto";

import type { Selectable } from "kysely";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { app } from "../app.js";
import { db } from "../database/db.js";
import type { UsersTable } from "../database/types.js";
import { registerOrganization } from "../organization-registration/registration.service.js";
import { createUser } from "../organization-registration/user.repository.js";
import { createSession } from "../auth/sessions/session.repository.js";
import {
  generateSessionToken,
  hashSessionToken,
} from "../auth/sessions/session-token.js";
import { SESSION_ABSOLUTE_LIFETIME_MS } from "../auth/auth.constants.js";
import { createNormalTeam, findGeneralTeam } from "../teams/team.repository.js";
import * as agentRepository from "./agent.repository.js";
import { getAgent, listAgents } from "./agents.service.js";

async function sessionCookie(organizationId: string, userId: string) {
  const token = generateSessionToken();
  await createSession(db, {
    organizationId,
    userId,
    tokenHash: hashSessionToken(token),
    userAgent: null,
    absoluteExpiresAt: new Date(Date.now() + SESSION_ABSOLUTE_LIFETIME_MS),
  });
  return `session=${token}`;
}

async function tenant() {
  const unique = randomUUID();
  const { organization, admin } = await registerOrganization({
    organizationName: "Agent reads",
    organizationSlug: `agents-${unique}`,
    adminName: "Organization admin",
    adminEmail: `${unique}@example.com`,
    adminPassword: "a sufficiently long password",
  });
  const general = await findGeneralTeam(db, organization.id);
  if (!general) throw new Error("Expected registered General team");
  return {
    organizationId: organization.id,
    adminId: admin.id,
    generalId: general.id,
    cookie: await sessionCookie(organization.id, admin.id),
  };
}

let own: Awaited<ReturnType<typeof tenant>>;
let other: Awaited<ReturnType<typeof tenant>>;
let agents: Selectable<UsersTable>[];
let customerId: string;
let foreignAgentId: string;
let activeTeamId: string;
let inactiveTeamId: string;
let agentCookie: string;
let customerCookie: string;
const inactiveAt = new Date("2025-01-01T00:00:00Z");
const emailMarker = randomUUID();

beforeAll(async () => {
  own = await tenant();
  other = await tenant();
  activeTeamId = (await createNormalTeam(db, own.organizationId, "Billing")).id;
  inactiveTeamId = (
    await createNormalTeam(db, own.organizationId, "Archived team")
  ).id;
  await db
    .updateTable("teams")
    .set({ deactivated_at: inactiveAt })
    .where("organization_id", "=", own.organizationId)
    .where("id", "=", inactiveTeamId)
    .execute();
  agents = await db
    .insertInto("users")
    .values([
      {
        organization_id: own.organizationId,
        name: "Alice",
        email: `${randomUUID()}@example.com`,
        password_hash: "test-only-hash",
        role: "AGENT",
        team_id: own.generalId,
        created_at: new Date("2020-01-01T00:00:00Z"),
      },
      {
        organization_id: own.organizationId,
        name: "Bob",
        email: `${emailMarker}-email-only@example.com`,
        password_hash: "test-only-hash",
        role: "AGENT",
        team_id: activeTeamId,
        created_at: new Date("2021-01-01T00:00:00Z"),
      },
      {
        organization_id: own.organizationId,
        name: "Literal_%\\Agent",
        email: `${randomUUID()}@example.com`,
        password_hash: "test-only-hash",
        role: "AGENT",
        team_id: inactiveTeamId,
        deactivated_at: inactiveAt,
        created_at: new Date("2021-01-01T00:00:00Z"),
      },
    ])
    .returningAll()
    .execute();
  customerId = (
    await createUser(db, {
      organizationId: own.organizationId,
      name: "Alice",
      email: `${randomUUID()}@example.com`,
      passwordHash: "test-only-hash",
      role: "CUSTOMER",
    })
  ).id;
  foreignAgentId = (
    await createUser(db, {
      organizationId: other.organizationId,
      name: "Alice",
      email: `${randomUUID()}@example.com`,
      passwordHash: "test-only-hash",
      role: "AGENT",
      teamId: other.generalId,
    })
  ).id;
  agentCookie = await sessionCookie(own.organizationId, agents[0]!.id);
  customerCookie = await sessionCookie(own.organizationId, customerId);
});

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await db.destroy();
});

function agentJson(agent: Selectable<UsersTable>) {
  const isGeneral = agent.team_id === own.generalId;
  const inactiveTeam = agent.team_id === inactiveTeamId;
  return {
    id: agent.id,
    name: agent.name,
    email: agent.email,
    deactivatedAt: agent.deactivated_at?.toISOString() ?? null,
    createdAt: agent.created_at.toISOString(),
    team: {
      id: agent.team_id,
      name: isGeneral ? "General" : inactiveTeam ? "Archived team" : "Billing",
      isGeneral,
      deactivatedAt: inactiveTeam ? inactiveAt.toISOString() : null,
    },
  };
}

function ordered(rows: Selectable<UsersTable>[]) {
  return [...rows].sort(
    (a, b) =>
      b.created_at.getTime() - a.created_at.getTime() ||
      b.id.localeCompare(a.id),
  );
}

describe("organization-admin agent reads", () => {
  it.each(["/agents", "/agents/not-a-uuid"])(
    "requires authentication for %s",
    async (path) => {
      expect((await request(app).get(path).expect(401)).body).toEqual({
        error: "Authentication required",
      });
    },
  );

  it.each(["AGENT", "CUSTOMER"])(
    "rejects %s before validation on both routes",
    async (role) => {
      const cookie = role === "AGENT" ? agentCookie : customerCookie;
      for (const path of ["/agents", "/agents/not-a-uuid"]) {
        const response = await request(app)
          .get(path)
          .set("Cookie", cookie)
          .expect(403);
        expect(response.body).toEqual({ error: "Request forbidden" });
      }
    },
  );

  it("lists only own AGENT users, with exact safe fields and nested teams, without CSRF", async () => {
    const response = await request(app)
      .get("/agents")
      .set("Cookie", own.cookie)
      .set("X-Organization-Id", other.organizationId)
      .send({ organizationId: other.organizationId })
      .expect(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      agents: ordered(agents).map(agentJson),
      pagination: { page: 1, limit: 20, total: 3, totalPages: 1 },
    });
  });

  it("paginates with stable ID ordering for equal creation timestamps", async () => {
    const expected = ordered(agents).map(agentJson);
    for (const page of [1, 2, 3]) {
      const response = await request(app)
        .get("/agents")
        .set("Cookie", own.cookie)
        .query({ page, limit: 2 })
        .expect(200);
      expect(response.body).toEqual({
        agents: expected.slice((page - 1) * 2, page * 2),
        pagination: { page, limit: 2, total: 3, totalPages: 2 },
      });
    }
  });

  it.each(["active", "deactivated"])(
    "filters by the agent's %s state",
    async (status) => {
      const expected = ordered(
        agents.filter(
          (agent) => (agent.deactivated_at === null) === (status === "active"),
        ),
      );
      const response = await request(app)
        .get("/agents")
        .set("Cookie", own.cookie)
        .query({ status })
        .expect(200);
      expect(response.body.agents).toEqual(expected.map(agentJson));
      expect(response.body.pagination.total).toBe(expected.length);
    },
  );

  it("filters current team membership, including agents on inactive teams", async () => {
    for (const teamId of [own.generalId, activeTeamId, inactiveTeamId]) {
      const expected = agents.filter((agent) => agent.team_id === teamId);
      const response = await request(app)
        .get("/agents")
        .set("Cookie", own.cookie)
        .query({ teamId })
        .expect(200);
      expect(response.body.agents).toEqual(expected.map(agentJson));
      expect(response.body.pagination.total).toBe(expected.length);
    }
    const combined = await request(app)
      .get("/agents")
      .set("Cookie", own.cookie)
      .query({ teamId: inactiveTeamId, status: "active" })
      .expect(200);
    expect(combined.body).toEqual({
      agents: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });
  });

  it("returns indistinguishable empty lists for unknown or foreign team filters", async () => {
    for (const teamId of [randomUUID(), other.generalId]) {
      const response = await request(app)
        .get("/agents")
        .set("Cookie", own.cookie)
        .query({ teamId })
        .expect(200);
      expect(response.body).toEqual({
        agents: [],
        pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
      });
    }
  });

  it.each(["name", "email", "wildcards"])(
    "searches %s case-insensitively with literal wildcards",
    async (field) => {
      const index = field === "name" ? 0 : field === "email" ? 1 : 2;
      const search =
        field === "name"
          ? " ALICE "
          : field === "email"
            ? `${emailMarker.toUpperCase()}-EMAIL-ONLY`
            : "_%\\";
      const response = await request(app)
        .get("/agents")
        .set("Cookie", own.cookie)
        .query({ search })
        .expect(200);
      expect(response.body.agents).toEqual([agentJson(agents[index]!)]);
      expect(response.body.pagination.total).toBe(1);
    },
  );

  it("uses the list representation for each agent, including inactive assignments", async () => {
    for (const agent of agents) {
      const response = await request(app)
        .get(`/agents/${agent.id}`)
        .set("Cookie", own.cookie)
        .expect(200);
      expect(response.body).toEqual(agentJson(agent));
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });

  it("returns the same 404 for unknown, foreign and same-tenant non-AGENT users", async () => {
    for (const id of [randomUUID(), foreignAgentId, own.adminId, customerId]) {
      const response = await request(app)
        .get(`/agents/${id}`)
        .set("Cookie", own.cookie)
        .set("X-Organization-Id", other.organizationId)
        .send({ organizationId: other.organizationId })
        .expect(404);
      expect(response.body).toEqual({ error: "Agent not found" });
    }
  });

  it.each([
    { status: "invalid" },
    { teamId: "not-a-uuid" },
    { page: "0" },
    { page: "-1" },
    { page: "1.5" },
    { page: "1000001" },
    { page: "1e2" },
    { page: ["1", "2"] },
    { limit: "0" },
    { limit: "101" },
    { limit: "" },
    { search: " " },
    { search: "a".repeat(256) },
    { organizationId: "client-scope" },
  ])("rejects invalid list input (case %#)", async (query) => {
    const response = await request(app)
      .get("/agents")
      .set("Cookie", own.cookie)
      .query(query)
      .expect(400);
    expect(response.body.error).toBe("Invalid agent query");
  });

  it("rejects malformed agent IDs", async () => {
    const response = await request(app)
      .get("/agents/not-a-uuid")
      .set("Cookie", own.cookie)
      .expect(400);
    expect(response.body.error).toBe("Invalid agent ID");
  });

  it("fails on missing team material rather than returning an incomplete agent", async () => {
    const row = await agentRepository.findAgent(
      db,
      own.organizationId,
      agents[0]!.id,
    );
    if (!row) throw new Error("Expected fixture agent");
    // Exercise the integrity guard without disabling PostgreSQL constraints.
    const corrupted = {
      ...row,
      teamId: null,
      teamName: null,
      teamIsGeneral: null,
      teamDeactivatedAt: null,
    };
    vi.spyOn(agentRepository, "findAgent").mockResolvedValueOnce(corrupted);
    await expect(getAgent(own.organizationId, row.id)).rejects.toThrow(
      "Agent team is missing",
    );
    vi.spyOn(agentRepository, "listAgents").mockResolvedValueOnce({
      agents: [corrupted],
      total: 1,
    });
    await expect(
      listAgents(own.organizationId, { page: 1, limit: 20 }),
    ).rejects.toThrow("Agent team is missing");
  });
});
