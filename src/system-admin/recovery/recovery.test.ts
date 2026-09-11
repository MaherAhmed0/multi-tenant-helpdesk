import { randomUUID } from "node:crypto";

import { sql } from "kysely";
import request from "supertest";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { app } from "../../app.js";
import { db } from "../../database/db.js";
import { env } from "../../config/env.js";
import { provisionSystemAdmin } from "../provisioning/provisioning.service.js";
import { hashRecoveryCode } from "../recovery-codes.js";
import { AUTH_CHALLENGE_COOKIE_NAME } from "../challenge/auth-challenge-cookie.js";
import { AUTH_CHALLENGE_MAX_FAILED_ATTEMPTS } from "../challenge/auth-challenge.constants.js";
import { hashAuthChallengeToken } from "../challenge/auth-challenge-token.js";
import * as challengeRepository from "../challenge/auth-challenge.repository.js";
import * as sessionRepository from "../sessions/session.repository.js";
import { SYSTEM_ADMIN_SESSION_COOKIE_NAME } from "../sessions/session-cookie.js";
import { hashSystemAdminSessionToken } from "../sessions/session-token.js";
import { completeSystemAdminRecovery } from "./recovery.service.js";

const password = "a sufficiently long password";
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await db.destroy(); });

async function passwordLogin(email: string) {
  const response = await request(app).post("/system-admin/auth/login")
    .send({ email, password }).expect(200);
  const cookie = response.headers["set-cookie"]?.[0]?.split(";")[0];
  if (!cookie?.startsWith(`${AUTH_CHALLENGE_COOKIE_NAME}=`)) {
    throw new Error("Password login did not set a challenge cookie");
  }
  const token = cookie.slice(AUTH_CHALLENGE_COOKIE_NAME.length + 1);
  const challenge = await challengeRepository.findActiveAuthChallenge(db, hashAuthChallengeToken(token));
  if (!challenge) throw new Error("Password login did not persist an active challenge");
  return { cookie, token, challenge };
}

async function beginRecovery() {
  const { systemAdmin: admin, recoveryCodes } = await provisionSystemAdmin({
    email: `recovery-${randomUUID()}@example.com`,
    password,
    confirmedTotpSecret: "test-only-confirmed-secret",
  });
  return { admin, code: recoveryCodes[0]!, recoveryCodes, ...await passwordLogin(admin.email) };
}

async function readState(adminId: string, challengeId: string) {
  const admin = await db.selectFrom("system_admins").select("last_totp_time_step")
    .where("id", "=", adminId).executeTakeFirstOrThrow();
  const challenge = await db.selectFrom("system_admin_auth_challenges")
    .select(["consumed_at", "failed_attempts"])
    .where("id", "=", challengeId).executeTakeFirstOrThrow();
  const codes = await db.selectFrom("system_admin_recovery_codes").selectAll()
    .where("system_admin_id", "=", adminId).orderBy("id").execute();
  const sessions = await db.selectFrom("system_admin_sessions").selectAll()
    .where("system_admin_id", "=", adminId).execute();
  return { lastStep: admin.last_totp_time_step, ...challenge, codes, sessions };
}

describe("SYSTEM_ADMIN recovery-code MFA completion", () => {
  it("uses a provisioned code once, commits authentication, and transitions cookies", async () => {
    const input = await beginRecovery();
    // Recovery neither needs a decryptable TOTP secret nor changes replay state.
    await db.updateTable("system_admins").set({
      last_totp_time_step: 123, totp_secret_ciphertext: "not-encrypted-data",
    }).where("id", "=", input.admin.id).execute();
    const response = await request(app).post("/system-admin/auth/recovery")
      .set("Cookie", input.cookie).set("User-Agent", "Recovery test client")
      .send({ code: ` ${input.code} ` }).expect(200);
    expect(response.body).toEqual({ authenticated: true });
    expect(response.headers["cache-control"]).toBe("no-store");
    const cookies = response.headers["set-cookie"] as string[] | undefined;
    if (!cookies) throw new Error("Recovery did not return the cookie transition");
    expect(cookies.length).toBe(2);
    const cleared = cookies.find((cookie) => cookie.startsWith(`${AUTH_CHALLENGE_COOKIE_NAME}=`));
    expect(cleared?.startsWith(`${AUTH_CHALLENGE_COOKIE_NAME}=;`)).toBe(true);
    expect(cleared?.includes("; Path=/system-admin/auth;")).toBe(true);
    expect(Date.parse(cleared?.match(/; Expires=([^;]+)/)?.[1]!)).toBeLessThan(Date.now());
    const sessionCookie = cookies.find((cookie) => cookie.startsWith(`${SYSTEM_ADMIN_SESSION_COOKIE_NAME}=`));
    if (!sessionCookie) throw new Error("Recovery did not set a session cookie");
    expect(sessionCookie.includes("; HttpOnly")).toBe(true);
    expect(sessionCookie.includes("; SameSite=Strict")).toBe(true);
    expect(sessionCookie.includes("; Path=/system-admin;")).toBe(true);
    expect(sessionCookie.includes("; Secure")).toBe(env.sessionCookieSecure);
    expect(/; (Expires|Max-Age)=/.test(sessionCookie)).toBe(false);
    const token = sessionCookie.split(";")[0]!.slice(SYSTEM_ADMIN_SESSION_COOKIE_NAME.length + 1);
    const state = await readState(input.admin.id, input.challenge.id);
    expect(state.lastStep).toBe(123);
    expect(state.consumed_at).toBeInstanceOf(Date);
    expect(state.failed_attempts).toBe(0);
    expect(state.sessions.length).toBe(1);
    expect(state.sessions[0]!.token_hash === hashSystemAdminSessionToken(token)).toBe(true);
    expect(JSON.stringify(state.sessions).includes(token)).toBe(false);
    expect(state.sessions[0]!.user_agent).toBe("Recovery test client");
    expect(state.codes.length).toBe(10);
    expect(state.codes.filter((code) => code.used_at !== null).length).toBe(1);
    expect(state.codes.find((code) => code.code_hash === hashRecoveryCode(input.code))?.used_at)
      .toBeInstanceOf(Date);
    expect(state.codes.every((code) => /^[0-9a-f]{64}$/.test(code.code_hash))).toBe(true);
    expect(input.recoveryCodes.some((code) => JSON.stringify(state).includes(code))).toBe(false);
    await request(app).get("/system-admin/auth/me")
      .set("Cookie", sessionCookie.split(";")[0]!).expect(200);
  });

  it("counts wrong case-sensitive codes and prevents completion after five failures", async () => {
    const input = await beginRecovery();
    const changedCase = input.code.replace(/[A-Za-z]/, (letter) =>
      letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase());
    const wrongCode = changedCase !== input.code ? changedCase
      : (input.code[0] === "0" ? "1" : "0") + input.code.slice(1);
    const before = await readState(input.admin.id, input.challenge.id);
    for (let count = 1; count <= AUTH_CHALLENGE_MAX_FAILED_ATTEMPTS; count++) {
      const response = await request(app).post("/system-admin/auth/recovery")
        .set("Cookie", input.cookie).send({ code: wrongCode }).expect(401);
      expect(response.body).toEqual({ error: "MFA authentication failed" });
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(await readState(input.admin.id, input.challenge.id))
        .toEqual({ ...before, failed_attempts: count });
    }
    await request(app).post("/system-admin/auth/recovery")
      .set("Cookie", input.cookie).send({ code: input.code }).expect(401);
    expect(await readState(input.admin.id, input.challenge.id))
      .toEqual({ ...before, failed_attempts: AUTH_CHALLENGE_MAX_FAILED_ATTEMPTS });
  });

  it("does not accept or consume another administrator's recovery code", async () => {
    const input = await beginRecovery();
    const foreign = await beginRecovery();
    const before = await readState(input.admin.id, input.challenge.id);
    const foreignBefore = await readState(foreign.admin.id, foreign.challenge.id);
    const response = await request(app).post("/system-admin/auth/recovery")
      .set("Cookie", input.cookie).send({ code: foreign.code }).expect(401);
    expect(response.body).toEqual({ error: "MFA authentication failed" });
    expect(await readState(input.admin.id, input.challenge.id))
      .toEqual({ ...before, failed_attempts: 1 });
    expect(await readState(foreign.admin.id, foreign.challenge.id)).toEqual(foreignBefore);
  });

  it.each([false, true])("permits only one use across challenges (concurrent=%s)", async (concurrent) => {
    const input = await beginRecovery();
    const other = await passwordLogin(input.admin.email);
    const submit = (cookie: string) => request(app).post("/system-admin/auth/recovery")
      .set("Cookie", cookie).send({ code: input.code });
    const responses = concurrent
      ? await Promise.all([submit(input.cookie), submit(other.cookie)])
      : [await submit(input.cookie), await submit(other.cookie)];
    expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
    const failed = responses.find((response) => response.status === 401)!;
    expect(failed.body).toEqual({ error: "MFA authentication failed" });
    expect(failed.headers["set-cookie"]).toBeUndefined();
    const first = await readState(input.admin.id, input.challenge.id);
    const second = await readState(input.admin.id, other.challenge.id);
    expect(first.lastStep).toBeNull();
    expect(first.sessions.length).toBe(1);
    expect(first.codes.filter((code) => code.used_at !== null).length).toBe(1);
    expect([first, second].filter((state) => state.consumed_at !== null).length).toBe(1);
    expect(first.failed_attempts + second.failed_attempts).toBe(1);
  });

  it.each(["missing", "unknown", "expired", "consumed", "deactivated"])(
    "rejects a %s challenge/account without consuming a recovery code", async (condition) => {
      const input = await beginRecovery();
      if (condition === "expired") {
        await sql`UPDATE system_admin_auth_challenges
          SET expires_at = clock_timestamp() - interval '1 second'
          WHERE id = ${input.challenge.id}`.execute(db);
      } else if (condition === "consumed") {
        await challengeRepository.consumeAuthChallenge(db, input.challenge.id);
      } else if (condition === "deactivated") {
        await db.updateTable("system_admins").set({ deactivated_at: new Date() })
          .where("id", "=", input.admin.id).execute();
      }
      const before = await readState(input.admin.id, input.challenge.id);
      const req = request(app).post("/system-admin/auth/recovery");
      if (condition !== "missing") {
        req.set("Cookie", condition === "unknown" ? `${AUTH_CHALLENGE_COOKIE_NAME}=unknown` : input.cookie);
      }
      const response = await req.send({ code: input.code }).expect(401);
      expect(response.body).toEqual({ error: "MFA authentication failed" });
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(await readState(input.admin.id, input.challenge.id)).toEqual(before);
      expect(before.sessions.length).toBe(0);
      expect(before.codes.every((code) => code.used_at === null)).toBe(true);
    },
  );

  it("rolls back recovery consumption when challenge consumption fails after lookup", async () => {
    const input = await beginRecovery();
    const find = challengeRepository.findActiveAuthChallenge;
    vi.spyOn(challengeRepository, "findActiveAuthChallenge").mockImplementationOnce(async (executor, hash) => {
      const stale = await find(executor, hash);
      await challengeRepository.consumeAuthChallenge(db, input.challenge.id);
      return stale;
    });
    const consume = challengeRepository.consumeAuthChallenge;
    const consumption = vi.spyOn(challengeRepository, "consumeAuthChallenge")
      .mockImplementation(async (executor, id) => {
        if (executor.isTransaction) {
          const code = await executor.selectFrom("system_admin_recovery_codes").select("used_at")
            .where("system_admin_id", "=", input.admin.id)
            .where("code_hash", "=", hashRecoveryCode(input.code)).executeTakeFirstOrThrow();
          expect(code.used_at).toBeInstanceOf(Date);
        }
        return consume(executor, id);
      });
    const response = await request(app).post("/system-admin/auth/recovery")
      .set("Cookie", input.cookie).send({ code: input.code }).expect(401);
    expect(response.body).toEqual({ error: "MFA authentication failed" });
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(consumption).toHaveBeenCalledTimes(2);
    const state = await readState(input.admin.id, input.challenge.id);
    expect(state.codes.every((code) => code.used_at === null)).toBe(true);
    expect(state.consumed_at).toBeInstanceOf(Date); // Only the other consumer's commit remains.
    expect(state.failed_attempts).toBe(0);
    expect(state.lastStep).toBeNull();
    expect(state.sessions.length).toBe(0);
  });

  it("rolls back both consumptions if the session insert fails", async () => {
    const input = await beginRecovery();
    const before = await readState(input.admin.id, input.challenge.id);
    const create = sessionRepository.createSystemAdminSession;
    vi.spyOn(sessionRepository, "createSystemAdminSession").mockImplementationOnce(async (executor, values) => {
      const code = await executor.selectFrom("system_admin_recovery_codes").select("used_at")
        .where("system_admin_id", "=", input.admin.id)
        .where("code_hash", "=", hashRecoveryCode(input.code)).executeTakeFirstOrThrow();
      const challenge = await executor.selectFrom("system_admin_auth_challenges").select("consumed_at")
        .where("id", "=", input.challenge.id).executeTakeFirstOrThrow();
      expect(code.used_at).toBeInstanceOf(Date);
      expect(challenge.consumed_at).toBeInstanceOf(Date);
      return create(executor, { ...values, tokenHash: "invalid-hash" });
    });
    await expect(completeSystemAdminRecovery({
      challengeToken: input.token, code: input.code, userAgent: null,
    })).rejects.toMatchObject({ code: "23514" });
    expect(await readState(input.admin.id, input.challenge.id)).toEqual(before);
  });

  it.each([
    { code: "too-short" }, { code: "!".repeat(22) }, { code: "A".repeat(23) },
    { code: 123456 }, { systemAdminId: "client-id" }, { email: "client@example.com" },
    { challengeId: "client-id" }, { challengeToken: "body-token" }, { sessionId: "client-id" },
  ])("rejects malformed or extra input without counting an attempt (case %#)", async (invalid) => {
    const input = await beginRecovery();
    const before = await readState(input.admin.id, input.challenge.id);
    const response = await request(app).post("/system-admin/auth/recovery")
      .set("Cookie", input.cookie).send({ code: input.code, ...invalid }).expect(400);
    expect(response.body.error).toBe("Invalid MFA data");
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(await readState(input.admin.id, input.challenge.id)).toEqual(before);
  });
});
