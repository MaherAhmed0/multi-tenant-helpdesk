import { randomUUID } from "node:crypto";

import argon2 from "argon2";
import { sql } from "kysely";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { app } from "../app.js";
import { db } from "../database/db.js";
import { registerOrganization } from "../organization-registration/registration.service.js";
import * as userRepository from "../organization-registration/user.repository.js";
import * as teamRepository from "../teams/team.repository.js";
import { deactivateTeam } from "../teams/teams.service.js";
import { deactivateOrganization } from "../system-admin/organizations/organizations.service.js";
import * as organizationRepository from "../system-admin/organizations/platform-organizations.repository.js";
import { generateInvitationToken } from "../agent-invitations/invitation-token.js";
import * as invitationRepository from "../agent-invitations/invitation.repository.js";
import { revokeInvitation } from "../agent-invitations/invitations.service.js";
import * as acceptanceRepository from "./acceptance.repository.js";
import { acceptInvitation } from "./acceptance.service.js";

const password = "a sufficiently long acceptance password";

async function tenant() {
  const unique = randomUUID();
  const result = await registerOrganization({
    organizationName: "Acceptance", organizationSlug: `acceptance-${unique}`,
    adminName: "Admin", adminEmail: `${unique}@example.com`, adminPassword: password,
  });
  const general = await teamRepository.findGeneralTeam(db, result.organization.id);
  return { id: result.organization.id, generalId: general!.id, admin: result.admin };
}

let own: Awaited<ReturnType<typeof tenant>>;
let other: typeof own;
beforeAll(async () => { own = await tenant(); other = await tenant(); });
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await db.destroy(); });

async function invite(options: {
  owner?: typeof own; teamId?: string; role?: "AGENT" | "ORGANIZATION_ADMIN";
  state?: "expired" | "revoked" | "consumed"; email?: string;
} = {}) {
  const owner = options.owner ?? own;
  const credential = generateInvitationToken();
  const row = await db.insertInto("tenant_user_invitations").values({
    organization_id: owner.id, name: "Invited Agent", email: options.email ?? `${randomUUID()}@example.com`,
    role: options.role ?? "AGENT", target_team_id: options.teamId ?? null,
    token_hash: credential.tokenHash, created_at: new Date("2020-01-01T00:00:00Z"),
    expires_at: options.state === "expired" ? new Date("2020-01-02T00:00:00Z") : new Date(Date.now() + 86400000),
    consumed_at: options.state === "consumed" ? new Date() : null,
    revoked_at: options.state === "revoked" ? new Date() : null,
  }).returningAll().executeTakeFirstOrThrow();
  return { ...row, token: credential.token };
}

type Invitation = Awaited<ReturnType<typeof invite>>;
function accept(token: string, extra: object = {}) {
  return request(app).post("/invitations/accept").send({ token, password, ...extra });
}
function users(invitation: Invitation) {
  return db.selectFrom("users").selectAll().where("organization_id", "=", invitation.organization_id)
    .where("email", "=", invitation.email).execute();
}
function storedInvitation(invitation: Invitation) {
  return db.selectFrom("tenant_user_invitations").selectAll()
    .where("organization_id", "=", invitation.organization_id).where("id", "=", invitation.id)
    .executeTakeFirstOrThrow();
}
async function expectUnchanged(invitation: Invitation) {
  expect(await users(invitation)).toEqual([]);
  const { token: _token, ...before } = invitation;
  expect(await storedInvitation(invitation)).toEqual(before);
}
async function waitForLock(table: string, clause: string) {
  await vi.waitFor(async () => {
    const waiting = await sql<{ count: string }>`
      SELECT count(*) AS count FROM pg_stat_activity
      WHERE datname = current_database() AND usename = current_user AND wait_event_type = 'Lock'
        AND query LIKE ${`%${table}%`} AND query LIKE ${`%${clause}%`}
    `.execute(db);
    expect(Number(waiting.rows[0]!.count)).toBe(1);
  }, { timeout: 5000, interval: 20 });
}

describe("public AGENT invitation acceptance", () => {
  it("creates the stored AGENT identity in General, consumes the invitation and never signs in", async () => {
    const invitation = await invite();
    const response = await accept(invitation.token).expect(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.body).toEqual({
      id: expect.any(String), name: invitation.name, email: invitation.email, role: "AGENT",
      team: { id: own.generalId, name: "General", isGeneral: true, deactivatedAt: null, createdAt: expect.any(String) },
    });
    const [user] = await users(invitation);
    expect(user!.id[14]).toBe("7");
    expect(user).toMatchObject({
      organization_id: own.id, name: invitation.name, email: invitation.email,
      role: "AGENT", team_id: own.generalId, deactivated_at: null,
    });
    expect(user!.password_hash).toMatch(/^\$argon2id\$/);
    expect(await argon2.verify(user!.password_hash, password)).toBe(true);
    expect(await db.selectFrom("sessions").select("id")
      .where("organization_id", "=", own.id).where("user_id", "=", user!.id).execute()).toEqual([]);
    const { token: _token, ...before } = invitation;
    expect(await storedInvitation(invitation)).toEqual({ ...before, consumed_at: expect.any(Date) });
    for (const secret of [invitation.token, invitation.token_hash, password, user!.password_hash]) {
      expect(JSON.stringify(response.body)).not.toContain(secret);
    }
  });

  it("rejects unknown and unsupported-role credentials before Argon2", async () => {
    const adminInvitation = await invite({ role: "ORGANIZATION_ADMIN" });
    const hash = vi.spyOn(argon2, "hash");
    expect((await accept(generateInvitationToken().token).expect(400)).body).toEqual({ error: "Invalid invitation token" });
    expect((await accept(adminInvitation.token).expect(400)).body).toEqual({ error: "Invalid invitation token" });
    expect(hash).not.toHaveBeenCalled();
    await expectUnchanged(adminInvitation);
  });

  it.each([
    ["expired", 410, "Invitation has expired"],
    ["revoked", 410, "Invitation has been revoked"],
    ["consumed", 409, "Invitation has already been used"],
  ] as const)("rejects a %s invitation without changing it", async (state, status, error) => {
    const invitation = await invite({ state });
    const response = await accept(invitation.token).expect(status);
    expect(response.body).toEqual({ error });
    await expectUnchanged(invitation);
  });

  it("validates only token/password without echoing secrets or accepting identity overrides", async () => {
    const invitation = await invite();
    const hash = vi.spyOn(argon2, "hash");
    for (const extra of [
      { organizationId: other.id }, { role: "ORGANIZATION_ADMIN" }, { email: other.admin.email },
      { name: "Override" }, { teamId: other.generalId }, { passwordConfirmation: password },
      { password: "short" }, { password: "a".repeat(129) }, { token: "malformed-secret" },
      { token: { sensitive: invitation.token } }, { [invitation.token]: true },
    ]) {
      const response = await accept(invitation.token, extra).expect(400);
      expect(response.body).toEqual({ error: "Invalid invitation acceptance data" });
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(hash).not.toHaveBeenCalled();
    await expectUnchanged(invitation);
  });

  it("hashes outside the transaction and revalidates a revocation occurring after preflight", async () => {
    const invitation = await invite();
    const hash = argon2.hash;
    const transaction = vi.spyOn(db, "transaction");
    vi.spyOn(argon2, "hash").mockImplementationOnce(async (...args) => {
      expect(transaction).not.toHaveBeenCalled();
      await revokeInvitation(own.id, invitation.id);
      return hash(...args);
    });
    expect((await accept(invitation.token).expect(410)).body).toEqual({ error: "Invitation has been revoked" });
    expect(await users(invitation)).toEqual([]);
    expect((await storedInvitation(invitation)).consumed_at).toBeNull();
  });

  it("rejects an inactive organization inside acceptance", async () => {
    const owner = await tenant();
    const invitation = await invite({ owner });
    await deactivateOrganization(owner.id);
    expect((await accept(invitation.token).expect(409)).body).toEqual({ error: "Organization is deactivated" });
    await expectUnchanged(invitation);
  });

  it("rechecks existing users within the invitation's tenant only", async () => {
    const blocked = await invite({ email: own.admin.email });
    expect((await accept(blocked.token).expect(409)).body).toEqual({ error: "A user with this email already exists" });
    expect((await storedInvitation(blocked)).consumed_at).toBeNull();
    const allowed = await invite({ email: other.admin.email });
    await accept(allowed.token).expect(201);
    expect(await users(allowed)).toHaveLength(1);
  });

  it.each(["active", "deactivated"] as const)("resolves an %s target team without rewriting historical target metadata", async (state) => {
    const team = await teamRepository.createNormalTeam(db, own.id, `Target-${randomUUID()}`);
    const invitation = await invite({ teamId: team.id });
    if (state === "deactivated") await deactivateTeam(own.id, team.id);
    const response = await accept(invitation.token).expect(201);
    expect(response.body.team.id).toBe(state === "active" ? team.id : own.generalId);
    expect((await storedInvitation(invitation)).target_team_id).toBe(team.id);
    expect((await users(invitation))[0]!.team_id).toBe(response.body.team.id);
  });

  it("treats a missing retained team or General as integrity failure", async () => {
    const team = await teamRepository.createNormalTeam(db, own.id, `Integrity-${randomUUID()}`);
    const targeted = await invite({ teamId: team.id });
    vi.spyOn(teamRepository, "findTeamForShare").mockResolvedValueOnce(undefined);
    await expect(acceptInvitation({ token: targeted.token, password })).rejects.toThrow("Invitation target team is missing");
    await expectUnchanged(targeted);
    const general = await invite();
    vi.spyOn(teamRepository, "findGeneralTeam").mockResolvedValueOnce(undefined);
    await expect(acceptInvitation({ token: general.token, password })).rejects.toThrow("Organization General team is missing");
    await expectUnchanged(general);
  });

  it("maps the database identity conflict if another creator wins after the user precheck", async () => {
    const invitation = await invite();
    const create = userRepository.createUser;
    vi.spyOn(userRepository, "createUser").mockImplementationOnce(async (trx, input) => {
      await create(db, input);
      return create(trx, input);
    });
    expect((await accept(invitation.token).expect(409)).body).toEqual({ error: "A user with this email already exists" });
    expect(await users(invitation)).toHaveLength(1);
    expect((await storedInvitation(invitation)).consumed_at).toBeNull();
  });

  it("rolls back user creation when consumption cannot complete", async () => {
    const invitation = await invite();
    vi.spyOn(acceptanceRepository, "consumeAgentInvitation").mockResolvedValueOnce(undefined);
    await accept(invitation.token).expect(410);
    await expectUnchanged(invitation);
  });

  it("rolls back both the inserted user and actual consumption if a later operation fails", async () => {
    const invitation = await invite();
    const consume = acceptanceRepository.consumeAgentInvitation;
    vi.spyOn(acceptanceRepository, "consumeAgentInvitation").mockImplementationOnce(async (...args) => {
      expect(await args[0].selectFrom("users").select("id")
        .where("organization_id", "=", own.id).where("email", "=", invitation.email).execute()).toHaveLength(1);
      expect(await consume(...args)).toEqual({ id: invitation.id });
      throw new Error("Test failure after consumption");
    });
    await expect(acceptInvitation({ token: invitation.token, password })).rejects.toThrow("Test failure after consumption");
    await expectUnchanged(invitation);
  });

  it("serializes concurrent double acceptance into one user and one consumed invitation", async () => {
    const invitation = await invite();
    const responses = await Promise.all([accept(invitation.token), accept(invitation.token)]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(responses.find((response) => response.status === 409)!.body).toEqual({ error: "Invitation has already been used" });
    expect(await users(invitation)).toHaveLength(1);
    expect((await storedInvitation(invitation)).consumed_at).toBeInstanceOf(Date);
  });

  it("acceptance first makes a concurrent revoke observe consumption", async () => {
    const invitation = await invite();
    const find = acceptanceRepository.findAgentInvitationForAcceptance;
    let revocation: Promise<unknown> | undefined;
    vi.spyOn(acceptanceRepository, "findAgentInvitationForAcceptance").mockImplementationOnce(async (...args) => {
      const row = await find(...args);
      revocation = revokeInvitation(own.id, invitation.id).catch((error: unknown) => error);
      await waitForLock("tenant_user_invitations", "for update");
      return row;
    });
    try {
      await accept(invitation.token).expect(201);
      expect(await revocation).toMatchObject({ statusCode: 409, message: "Invitation has already been used" });
      expect(await users(invitation)).toHaveLength(1);
      expect((await storedInvitation(invitation)).revoked_at).toBeNull();
    } finally { if (revocation) await Promise.allSettled([revocation]); }
  }, 15_000);

  it("revocation first makes a concurrent acceptance observe revocation", async () => {
    const invitation = await invite();
    const revoke = invitationRepository.revokeOpenInvitation;
    let acceptance: Promise<unknown> | undefined;
    vi.spyOn(invitationRepository, "revokeOpenInvitation").mockImplementationOnce(async (...args) => {
      const result = await revoke(...args);
      acceptance = acceptInvitation({ token: invitation.token, password }).catch((error: unknown) => error);
      await waitForLock("tenant_user_invitations", "for update");
      return result;
    });
    try {
      await revokeInvitation(own.id, invitation.id);
      expect(await acceptance).toMatchObject({ statusCode: 410, message: "Invitation has been revoked" });
      expect(await users(invitation)).toEqual([]);
      expect((await storedInvitation(invitation)).consumed_at).toBeNull();
    } finally { if (acceptance) await Promise.allSettled([acceptance]); }
  }, 15_000);

  it("holds the active team share lock until insertion commits, then deactivation moves the new agent", async () => {
    const team = await teamRepository.createNormalTeam(db, own.id, `Race-${randomUUID()}`);
    const invitation = await invite({ teamId: team.id });
    const create = userRepository.createUser;
    let deactivation: Promise<void | unknown> | undefined;
    vi.spyOn(userRepository, "createUser").mockImplementationOnce(async (...args) => {
      deactivation = deactivateTeam(own.id, team.id);
      await waitForLock("teams", "for update");
      return create(...args);
    });
    try {
      const result = await accept(invitation.token).expect(201);
      expect(result.body.team.id).toBe(team.id);
      await deactivation;
      expect((await users(invitation))[0]).toMatchObject({ deactivated_at: null, team_id: own.generalId });
      expect((await teamRepository.findTeam(db, own.id, team.id))!.deactivatedAt).not.toBeNull();
    } finally { if (deactivation) await Promise.allSettled([deactivation]); }
  }, 15_000);

  it("team deactivation first makes acceptance use General after waiting for the shared lock", async () => {
    const team = await teamRepository.createNormalTeam(db, own.id, `Race-${randomUUID()}`);
    const invitation = await invite({ teamId: team.id });
    const mark = teamRepository.markTeamDeactivated;
    let acceptance: ReturnType<typeof acceptInvitation> | undefined;
    vi.spyOn(teamRepository, "markTeamDeactivated").mockImplementationOnce(async (...args) => {
      const result = await mark(...args);
      acceptance = acceptInvitation({ token: invitation.token, password });
      await waitForLock("teams", "for share");
      return result;
    });
    try {
      await deactivateTeam(own.id, team.id);
      expect((await acceptance)!.team.id).toBe(own.generalId);
      expect((await users(invitation))[0]).toMatchObject({ deactivated_at: null, team_id: own.generalId });
    } finally { if (acceptance) await Promise.allSettled([acceptance]); }
  }, 15_000);

  it("holds the organization share lock through acceptance before organization deactivation proceeds", async () => {
    const owner = await tenant();
    const invitation = await invite({ owner });
    const create = userRepository.createUser;
    let deactivation: Promise<void> | undefined;
    vi.spyOn(userRepository, "createUser").mockImplementationOnce(async (...args) => {
      deactivation = deactivateOrganization(owner.id);
      await waitForLock("organizations", "update");
      return create(...args);
    });
    try {
      await accept(invitation.token).expect(201);
      await deactivation;
      expect(await users(invitation)).toHaveLength(1);
      expect((await storedInvitation(invitation)).consumed_at).not.toBeNull();
      expect((await db.selectFrom("organizations").select("deactivated_at")
        .where("id", "=", owner.id).executeTakeFirstOrThrow()).deactivated_at).not.toBeNull();
    } finally { if (deactivation) await Promise.allSettled([deactivation]); }
  }, 15_000);

  it("organization deactivation first makes waiting acceptance fail without consuming", async () => {
    const owner = await tenant();
    const invitation = await invite({ owner });
    const mark = organizationRepository.deactivatePlatformOrganization;
    let acceptance: Promise<unknown> | undefined;
    vi.spyOn(organizationRepository, "deactivatePlatformOrganization").mockImplementationOnce(async (...args) => {
      const result = await mark(...args);
      acceptance = acceptInvitation({ token: invitation.token, password }).catch((error: unknown) => error);
      await waitForLock("organizations", "for share");
      return result;
    });
    try {
      await deactivateOrganization(owner.id);
      expect(await acceptance).toMatchObject({ statusCode: 409, message: "Organization is deactivated" });
      await expectUnchanged(invitation);
    } finally { if (acceptance) await Promise.allSettled([acceptance]); }
  }, 15_000);
});
