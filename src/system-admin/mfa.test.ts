import { randomUUID } from "node:crypto";

import argon2 from "argon2";
import { generate, verify } from "otplib";
import { sql } from "kysely";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { app } from "../app.js";
import { db } from "../database/db.js";
import { env } from "../config/env.js";
import { AUTH_CHALLENGE_COOKIE_NAME } from "./auth-challenge-cookie.js";
import { AUTH_CHALLENGE_MAX_FAILED_ATTEMPTS } from "./auth-challenge.constants.js";
import { hashAuthChallengeToken } from "./auth-challenge-token.js";
import * as challengeRepository from "./auth-challenge.repository.js";
import { createSystemAdmin } from "./system-admin.repository.js";
import { startTotpEnrollment } from "./totp-enrollment.js";
import { encryptTotpSecret } from "./totp-secret-crypto.js";
import { TOTP_OPTIONS } from "./totp.config.js";
import * as sessionRepository from "./session.repository.js";
import { hashSystemAdminSessionToken } from "./session-token.js";
import { SYSTEM_ADMIN_SESSION_COOKIE_NAME } from "./session-cookie.js";
import { completeSystemAdminMfa } from "./mfa.service.js";

const password = "a sufficiently long password";
let passwordHash: string;

beforeAll(async () => {
  passwordHash = await argon2.hash(password, { type: argon2.argon2id });
});
beforeEach(() => {
  // Freeze only the application clock, near real time for database challenge expiry.
  const midpoint = Math.floor(Date.now() / 30_000) * 30_000 + 15_000;
  vi.spyOn(Date, "now").mockReturnValue(midpoint);
});
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

async function beginMfa(previousPeriod = false) {
  const email = `mfa-${randomUUID()}@example.com`;
  if (previousPeriod) {
    vi.mocked(Date.now).mockReturnValue(Math.floor(Date.now() / 30_000) * 30_000 + 2000);
  }
  const epoch = Math.floor(Date.now() / 1000);
  let secret: string;
  let code: string;
  do {
    secret = startTotpEnrollment(email).secret;
    code = await generate({ ...TOTP_OPTIONS, secret, epoch: epoch - (previousPeriod ? 30 : 0) });
    // Avoid coincident adjacent-period codes in the tolerance test.
  } while (previousPeriod && code === await generate({ ...TOTP_OPTIONS, secret, epoch }));
  const encrypted = encryptTotpSecret(secret);
  const admin = await createSystemAdmin(db, {
    email, passwordHash,
    totpSecretCiphertext: encrypted.ciphertext,
    totpSecretIv: encrypted.iv,
    totpSecretAuthTag: encrypted.authTag,
  });
  const accepted = await verify({ ...TOTP_OPTIONS, secret, token: code });
  if (!accepted.valid || !("timeStep" in accepted)) throw new Error("Test TOTP was not accepted");
  return { admin, code, timeStep: accepted.timeStep, ...await passwordLogin(email) };
}

async function readState(adminId: string, challengeId: string) {
  const admin = await db.selectFrom("system_admins").select("last_totp_time_step")
    .where("id", "=", adminId).executeTakeFirstOrThrow();
  const challenge = await db.selectFrom("system_admin_auth_challenges")
    .select(["consumed_at", "failed_attempts"])
    .where("id", "=", challengeId).executeTakeFirstOrThrow();
  const sessions = await db.selectFrom("system_admin_sessions").selectAll()
    .where("system_admin_id", "=", adminId).execute();
  return { lastStep: admin.last_totp_time_step, ...challenge, sessions };
}

describe("SYSTEM_ADMIN TOTP MFA completion", () => {
  it.each([false, true])("commits authentication and transitions cookies (previous period=%s)", async (previous) => {
    const input = await beginMfa(previous);
    const response = await request(app).post("/system-admin/auth/mfa")
      .set("Cookie", input.cookie).set("User-Agent", "MFA test client")
      .send({ code: input.code }).expect(200);
    expect(response.body).toEqual({ authenticated: true });
    expect(response.headers["cache-control"]).toBe("no-store");
    const cookies = response.headers["set-cookie"] as string[] | undefined;
    if (!cookies) throw new Error("MFA did not return the cookie transition");
    expect(cookies.length).toBe(2);
    const cleared = cookies.find((cookie) => cookie.startsWith(`${AUTH_CHALLENGE_COOKIE_NAME}=`));
    expect(cleared?.startsWith(`${AUTH_CHALLENGE_COOKIE_NAME}=;`)).toBe(true);
    expect(cleared?.includes("; Path=/system-admin/auth;")).toBe(true);
    const clearExpiry = cleared?.match(/; Expires=([^;]+)/)?.[1];
    expect(Date.parse(clearExpiry!)).toBeLessThan(Date.now());
    const sessionCookie = cookies.find((cookie) => cookie.startsWith(`${SYSTEM_ADMIN_SESSION_COOKIE_NAME}=`));
    if (!sessionCookie) throw new Error("MFA did not set a session cookie");
    expect(sessionCookie.includes("; HttpOnly")).toBe(true);
    expect(sessionCookie.includes("; SameSite=Strict")).toBe(true);
    expect(sessionCookie.includes("; Path=/system-admin;")).toBe(true);
    expect(sessionCookie.includes("; Secure")).toBe(env.sessionCookieSecure);
    expect(/; (Expires|Max-Age)=/.test(sessionCookie)).toBe(false);
    const token = sessionCookie.split(";")[0]!.slice(SYSTEM_ADMIN_SESSION_COOKIE_NAME.length + 1);
    const state = await readState(input.admin.id, input.challenge.id);
    expect(state.lastStep).toBe(input.timeStep);
    expect(state.consumed_at).toBeInstanceOf(Date);
    expect(state.failed_attempts).toBe(0);
    expect(state.sessions.length).toBe(1);
    expect(state.sessions[0]!.token_hash === hashSystemAdminSessionToken(token)).toBe(true);
    expect(state.sessions[0]!.token_hash === token).toBe(false);
    expect(/^[0-9a-f]{64}$/.test(state.sessions[0]!.token_hash)).toBe(true);
    expect(state.sessions[0]!.user_agent).toBe("MFA test client");
  });

  it("counts wrong codes and prevents completion after attempt exhaustion", async () => {
    const input = await beginMfa();
    const wrongCode = (input.code[0] === "0" ? "1" : "0") + input.code.slice(1);
    for (let count = 1; count <= AUTH_CHALLENGE_MAX_FAILED_ATTEMPTS; count++) {
      const response = await request(app).post("/system-admin/auth/mfa")
        .set("Cookie", input.cookie).send({ code: wrongCode }).expect(401);
      expect(response.body).toEqual({ error: "MFA authentication failed" });
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(await readState(input.admin.id, input.challenge.id)).toEqual({
        lastStep: null, consumed_at: null, failed_attempts: count, sessions: [],
      });
    }
    await request(app).post("/system-admin/auth/mfa")
      .set("Cookie", input.cookie).send({ code: input.code }).expect(401);
    expect(await readState(input.admin.id, input.challenge.id)).toEqual({
      lastStep: null, consumed_at: null,
      failed_attempts: AUTH_CHALLENGE_MAX_FAILED_ATTEMPTS, sessions: [],
    });
  });

  it.each(["missing", "unknown", "expired", "consumed", "deactivated"])(
    "rejects a %s challenge/account without successful authentication state",
    async (condition) => {
      const input = await beginMfa();
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
      const req = request(app).post("/system-admin/auth/mfa");
      if (condition !== "missing") {
        req.set("Cookie", condition === "unknown" ? `${AUTH_CHALLENGE_COOKIE_NAME}=unknown` : input.cookie);
      }
      const response = await req.send({ code: input.code }).expect(401);
      expect(response.body).toEqual({ error: "MFA authentication failed" });
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(await readState(input.admin.id, input.challenge.id)).toEqual(before);
      expect(before.lastStep).toBeNull();
      expect(before.sessions.length).toBe(0);
    },
  );

  it.each([false, true])("allows only one use of a time-step across challenges (concurrent=%s)", async (concurrent) => {
    const input = await beginMfa();
    const other = await passwordLogin(input.admin.email);
    const submit = (cookie: string) => request(app).post("/system-admin/auth/mfa")
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
    expect(first.lastStep).toBe(input.timeStep);
    expect(first.sessions.length).toBe(1);
    expect([first, second].filter((state) => state.consumed_at !== null).length).toBe(1);
    expect(first.failed_attempts + second.failed_attempts).toBe(0);
  });

  it("rolls back the time-step claim when the challenge was consumed after lookup", async () => {
    const input = await beginMfa();
    const find = challengeRepository.findActiveAuthChallenge;
    vi.spyOn(challengeRepository, "findActiveAuthChallenge").mockImplementationOnce(async (executor, hash) => {
      const stale = await find(executor, hash);
      await challengeRepository.consumeAuthChallenge(db, input.challenge.id);
      return stale;
    });
    const response = await request(app).post("/system-admin/auth/mfa")
      .set("Cookie", input.cookie).send({ code: input.code }).expect(401);
    expect(response.headers["set-cookie"]).toBeUndefined();
    const state = await readState(input.admin.id, input.challenge.id);
    expect(state.lastStep).toBeNull();
    expect(state.consumed_at).toBeInstanceOf(Date); // Only the other consumer's commit remains.
    expect(state.sessions.length).toBe(0);
  });

  it("rolls back both prior transitions if the session insert fails", async () => {
    const input = await beginMfa();
    const create = sessionRepository.createSystemAdminSession;
    vi.spyOn(sessionRepository, "createSystemAdminSession").mockImplementationOnce(async (executor, values) => {
      const admin = await executor.selectFrom("system_admins").select("last_totp_time_step")
        .where("id", "=", input.admin.id).executeTakeFirstOrThrow();
      const challenge = await executor.selectFrom("system_admin_auth_challenges").select("consumed_at")
        .where("id", "=", input.challenge.id).executeTakeFirstOrThrow();
      expect(admin.last_totp_time_step).toBe(input.timeStep);
      expect(challenge.consumed_at).toBeInstanceOf(Date);
      // Real PostgreSQL constraint failure after both preceding updates.
      return create(executor, { ...values, tokenHash: "invalid-hash" });
    });
    await expect(completeSystemAdminMfa({
      challengeToken: input.token, code: input.code, userAgent: null,
    })).rejects.toMatchObject({ code: "23514" });
    expect(await readState(input.admin.id, input.challenge.id)).toEqual({
      lastStep: null, consumed_at: null, failed_attempts: 0, sessions: [],
    });
  });

  it.each([{ code: "12345" }, { code: " 123456" }, { code: 123456 }, { challengeToken: "body-token" }])(
    "rejects malformed or extra input without counting an attempt (case %#)", async (invalid) => {
      const input = await beginMfa();
      const response = await request(app).post("/system-admin/auth/mfa")
        .set("Cookie", input.cookie).send({ code: input.code, ...invalid }).expect(400);
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(await readState(input.admin.id, input.challenge.id)).toEqual({
        lastStep: null, consumed_at: null, failed_attempts: 0, sessions: [],
      });
    },
  );
});
