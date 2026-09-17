import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";

import { db } from "../database/db.js";
import { createOrganization } from "../organization-registration/organization.repository.js";
import { createUser } from "../organization-registration/user.repository.js";
import { login } from "../auth/login/login.service.js";
import * as loginRepository from "../auth/login/login.repository.js";
import { logout } from "../auth/sessions/logout.service.js";
import {
  logoutAll,
  revokeOwnedSession,
} from "../auth/sessions/session-management.service.js";
import * as sessions from "../auth/sessions/session.repository.js";
import {
  generateSessionToken,
  hashSessionToken,
} from "../auth/sessions/session-token.js";
import { createSystemAdmin } from "../system-admin/system-admin.repository.js";
import { startSystemAdminLogin } from "../system-admin/login/login.service.js";
import { completeSystemAdminMfa } from "../system-admin/mfa/mfa.service.js";
import { completeSystemAdminRecovery } from "../system-admin/recovery/recovery.service.js";
import { generateRecoveryCodes } from "../system-admin/recovery-codes.js";
import { createRecoveryCodeHashes } from "../system-admin/recovery-code.repository.js";
import {
  logoutSystemAdmin,
  logoutAllSystemAdminSessions,
} from "../system-admin/sessions/session-management.service.js";
import * as adminSessions from "../system-admin/sessions/session.repository.js";
import { generateSystemAdminSessionToken } from "../system-admin/sessions/session-token.js";
import {
  deactivateOrganization,
  reactivateOrganization,
} from "../system-admin/organizations/organizations.service.js";
import * as organizationSessions from "../system-admin/organizations/platform-organization-sessions.repository.js";
import { createLogger, logger } from "./logger.js";
import { runWithRequestContext } from "./request-context.js";

const password = "Security-events-test-password!";
let passwordHash: string;
let records: Array<Record<string, unknown>>;
beforeAll(async () => {
  passwordHash = await argon2.hash(password, { type: argon2.argon2id });
});
beforeEach(() => {
  records = [];
  const captured = createLogger({
    write: (line) => {
      records.push(JSON.parse(line));
    },
  });
  vi.spyOn(logger, "info").mockImplementation(captured.info.bind(captured));
  vi.spyOn(logger, "warn").mockImplementation(captured.warn.bind(captured));
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await db.destroy();
});

async function tenant() {
  const org = await createOrganization(db, {
    name: "Security events",
    slug: `events-${randomUUID()}`,
  });
  const user = await createUser(db, {
    organizationId: org.id,
    name: "Customer",
    email: `${randomUUID()}@example.com`,
    role: "CUSTOMER",
    passwordHash,
    teamId: null,
  });
  return { org, user };
}
async function administrator() {
  return createSystemAdmin(db, {
    email: `${randomUUID()}@example.com`,
    passwordHash,
    totpSecretCiphertext: "test-only-ciphertext",
    totpSecretIv: "test-only-iv",
    totpSecretAuthTag: "test-only-tag",
  });
}
async function session(owner: Awaited<ReturnType<typeof tenant>>) {
  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token);
  const row = await sessions.createSession(db, {
    organizationId: owner.org.id,
    userId: owner.user.id,
    tokenHash,
    absoluteExpiresAt: new Date(Date.now() + 3600000),
    userAgent: null,
  });
  return { ...row, token, tokenHash };
}

it("authentication failures are generic and contain no credentials or account-existence information", async () => {
  const owner = await tenant();
  const admin = await administrator();
  const unknownEmail = `${randomUUID()}@example.com`;
  await runWithRequestContext({ requestId: "login-request" }, async () => {
    for (const email of [owner.user.email, unknownEmail]) {
      await expect(
        login(
          {
            organizationSlug: owner.org.slug,
            email,
            password: "incorrect-password",
          },
          { userAgent: null },
        ),
      ).rejects.toMatchObject({
        statusCode: 401,
        message: "Invalid credentials",
      });
    }
    for (const email of [admin.email, unknownEmail]) {
      await expect(
        startSystemAdminLogin({ email, password: "incorrect-password" }),
      ).rejects.toMatchObject({
        statusCode: 401,
        message: "Invalid credentials",
      });
    }
    for (const complete of [
      completeSystemAdminMfa,
      completeSystemAdminRecovery,
    ]) {
      await expect(
        complete({
          challengeToken: "unknown-challenge",
          code: "123456",
          userAgent: null,
        }),
      ).rejects.toMatchObject({
        statusCode: 401,
        message: "MFA authentication failed",
      });
    }
  });
  expect(records).toHaveLength(6);
  for (const record of records) {
    expect(record).toMatchObject({
      event: "authentication_failed",
      reason: "invalid_credentials",
      requestId: "login-request",
    });
    expect(Object.keys(record).sort()).toEqual([
      "event",
      "hostname",
      "level",
      "pid",
      "reason",
      "requestId",
      "scope",
      "time",
    ]);
  }
  // Check call-site payloads too: Pino redaction must not mask unsafe inputs.
  for (const [payload] of vi.mocked(logger.warn).mock.calls)
    expect(Object.keys(payload as object).sort()).toEqual([
      "event",
      "reason",
      "scope",
    ]);
  const serialized = JSON.stringify(records);
  for (const sensitive of [
    password,
    passwordHash,
    owner.user.email,
    owner.org.slug,
    admin.email,
    unknownEmail,
    "incorrect-password",
    "unknown-challenge",
    "123456",
  ])
    expect(serialized).not.toContain(sensitive);

  records.length = 0;
  await login(
    { organizationSlug: owner.org.slug, email: owner.user.email, password },
    { userAgent: null },
  );
  const challenge = await startSystemAdminLogin({
    email: admin.email,
    password,
  });
  const codes = generateRecoveryCodes();
  await createRecoveryCodeHashes(
    db,
    admin.id,
    codes.map((code) => code.hash),
  );
  await completeSystemAdminRecovery({
    challengeToken: challenge.token,
    code: codes[0]!.code,
    userAgent: null,
  });
  expect(records).toEqual([]);
  vi.spyOn(loginRepository, "findLoginAccount").mockRejectedValueOnce(
    new Error("Database failure"),
  );
  await expect(
    login(
      { organizationSlug: owner.org.slug, email: owner.user.email, password },
      { userAgent: null },
    ),
  ).rejects.toThrow("Database failure");
  expect(records).toEqual([]);
}, 15000);

it("session events follow successful revocation and exclude failed or unowned single-session operations", async () => {
  const owner = await tenant();
  const first = await session(owner);
  const second = await session(owner);
  const foreign = await session(await tenant());
  const auth = {
    userId: owner.user.id,
    organizationId: owner.org.id,
    sessionId: first.id,
    role: "CUSTOMER" as const,
  };
  await runWithRequestContext(
    {
      requestId: "logout-request",
      organizationId: owner.org.id,
      actorId: owner.user.id,
      actorRole: "CUSTOMER",
    },
    async () => {
      await revokeOwnedSession(auth, foreign.id);
      await revokeOwnedSession(auth, randomUUID());
      expect(records).toEqual([]);
      const revoke = sessions.revokeSession;
      vi.spyOn(sessions, "revokeSession").mockImplementationOnce(
        async (...args) => {
          const result = await revoke(...args);
          expect(records).toEqual([]);
          return result;
        },
      );
      await logout(first.id);
      await logout(first.id);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        event: "session_revoked",
        scope: "tenant_session",
        targetSessionId: first.id,
        requestId: "logout-request",
        actorId: owner.user.id,
        organizationId: owner.org.id,
      });
      vi.spyOn(sessions, "revokeAccountSessions").mockRejectedValueOnce(
        new Error("Revocation failed"),
      );
      await expect(logoutAll(auth)).rejects.toThrow("Revocation failed");
      expect(records).toHaveLength(1);
      expect(
        (await sessions.findSessionForAuthentication(db, second.tokenHash))!
          .revokedAt,
      ).toBeNull();
      await logoutAll(auth);
      expect(records).toHaveLength(2);
      expect(records[1]).toMatchObject({
        event: "sessions_revoked",
        scope: "tenant_account",
      });
      expect(
        (await sessions.findSessionForAuthentication(db, second.tokenHash))!
          .revokedAt,
      ).toBeInstanceOf(Date);
    },
  );
  const admin = await administrator();
  const credential = generateSystemAdminSessionToken();
  const adminSession = await adminSessions.createSystemAdminSession(db, {
    systemAdminId: admin.id,
    tokenHash: credential.tokenHash,
    absoluteExpiresAt: new Date(Date.now() + 3600000),
    userAgent: null,
  });
  await runWithRequestContext(
    { requestId: "admin-logout", actorId: admin.id, actorRole: "SYSTEM_ADMIN" },
    async () => {
      const adminAuth = {
        systemAdminId: admin.id,
        sessionId: adminSession.id,
        email: admin.email,
      };
      await logoutSystemAdmin(adminAuth);
      await logoutAllSystemAdminSessions(adminAuth);
    },
  );
  expect(records).toHaveLength(4);
  expect(records[2]).toMatchObject({
    event: "session_revoked",
    scope: "system_admin_session",
    targetSessionId: adminSession.id,
    actorId: admin.id,
  });
  expect(records[3]).toMatchObject({
    event: "sessions_revoked",
    scope: "system_admin_account",
    actorId: admin.id,
  });
  expect(records[3]).not.toHaveProperty("organizationId");
  const payloads = JSON.stringify(vi.mocked(logger.info).mock.calls);
  for (const sensitive of [
    first.token,
    first.tokenHash,
    second.token,
    credential.token,
    credential.tokenHash,
    owner.user.email,
    admin.email,
    passwordHash,
  ])
    expect(payloads).not.toContain(sensitive);
  for (const [payload] of vi.mocked(logger.info).mock.calls) {
    expect(payload).not.toHaveProperty("actorId");
    expect(payload).not.toHaveProperty("organizationId");
    expect(payload).not.toHaveProperty("requestId");
  }
});

it("organization lifecycle events follow commit and never report rolled-back or missing targets as success", async () => {
  const owner = await tenant();
  const credential = await session(owner);
  await runWithRequestContext(
    {
      requestId: "lifecycle-request",
      actorId: randomUUID(),
      actorRole: "SYSTEM_ADMIN",
    },
    async () => {
      const revoke = organizationSessions.revokePlatformOrganizationSessions;
      vi.spyOn(
        organizationSessions,
        "revokePlatformOrganizationSessions",
      ).mockImplementationOnce(async (...args) => {
        await revoke(...args);
        expect(records).toEqual([]);
        throw new Error("Rollback after revocation");
      });
      await expect(deactivateOrganization(owner.org.id)).rejects.toThrow(
        "Rollback after revocation",
      );
      expect(records).toEqual([]);
      expect(
        (
          await db
            .selectFrom("organizations")
            .select("deactivated_at")
            .where("id", "=", owner.org.id)
            .executeTakeFirstOrThrow()
        ).deactivated_at,
      ).toBeNull();
      expect(
        (await sessions.findSessionForAuthentication(db, credential.tokenHash))!
          .revokedAt,
      ).toBeNull();

      const transaction = db.transaction();
      const execute = transaction.execute.bind(transaction);
      vi.spyOn(transaction, "execute").mockImplementationOnce(
        async (callback) => {
          const result = await execute(callback);
          expect(records).toEqual([]); // Commit completed, service has not resumed yet.
          return result;
        },
      );
      vi.spyOn(db, "transaction").mockReturnValueOnce(transaction);
      await deactivateOrganization(owner.org.id);
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({
        event: "organization_deactivated",
        action: "deactivate",
        targetOrganizationId: owner.org.id,
        requestId: "lifecycle-request",
        actorRole: "SYSTEM_ADMIN",
      });
      expect(records[1]).toMatchObject({
        event: "sessions_revoked",
        scope: "tenant_organization",
        targetOrganizationId: owner.org.id,
      });
      await reactivateOrganization(owner.org.id);
      expect(records[2]).toMatchObject({
        event: "organization_reactivated",
        action: "reactivate",
        targetOrganizationId: owner.org.id,
      });
      await expect(deactivateOrganization(randomUUID())).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(reactivateOrganization(randomUUID())).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(records).toHaveLength(3);
    },
  );
  const payloads = JSON.stringify(vi.mocked(logger.info).mock.calls);
  for (const sensitive of [
    credential.token,
    credential.tokenHash,
    passwordHash,
    owner.user.email,
    owner.org.slug,
  ])
    expect(payloads).not.toContain(sensitive);
  for (const [payload] of vi.mocked(logger.info).mock.calls)
    expect(Object.keys(payload as object).sort()).toEqual(
      [
        "action" in (payload as object) ? "action" : "scope",
        "event",
        "targetOrganizationId",
      ].sort(),
    );
});
