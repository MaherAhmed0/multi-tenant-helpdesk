import { randomUUID } from "node:crypto";

import argon2 from "argon2";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { app } from "../../app.js";
import { env } from "../../config/env.js";
import { db } from "../../database/db.js";
import { AUTH_CHALLENGE_COOKIE_NAME } from "../challenge/auth-challenge-cookie.js";
import { AUTH_CHALLENGE_LIFETIME_MS } from "../challenge/auth-challenge.constants.js";
import { hashAuthChallengeToken } from "../challenge/auth-challenge-token.js";
import { findActiveAuthChallenge } from "../challenge/auth-challenge.repository.js";
import { createSystemAdmin } from "../system-admin.repository.js";

const password = "a sufficiently long password";
let passwordHash: string;

beforeAll(async () => {
  passwordHash = await argon2.hash(password, { type: argon2.argon2id });
});

afterAll(async () => {
  await db.destroy();
});

async function createAccount() {
  // Password login must not read or decrypt these test-only MFA fields.
  return createSystemAdmin(db, {
    email: `password-login-${randomUUID()}@example.com`,
    passwordHash,
    totpSecretCiphertext: "test-only-ciphertext",
    totpSecretIv: "test-only-iv",
    totpSecretAuthTag: "test-only-auth-tag",
  });
}

function tokenFromCookie(cookie: string | undefined): string {
  const prefix = `${AUTH_CHALLENGE_COOKIE_NAME}=`;
  if (!cookie?.startsWith(prefix)) {
    throw new Error("Login did not set the expected challenge cookie");
  }
  return cookie.split(";")[0]!.slice(prefix.length);
}

describe("SYSTEM_ADMIN password login", () => {
  it.each([false, true])(
    "creates only a pending challenge (normalize email=%s)",
    async (normalizeEmail) => {
      const account = await createAccount();
      const startedAt = Date.now();
      const response = await request(app)
        .post("/system-admin/auth/login")
        .send({
          email: normalizeEmail ? ` ${account.email.toUpperCase()} ` : account.email,
          password,
        })
        .expect(200);

      expect(response.body).toEqual({ mfaRequired: true });
      expect(response.headers["cache-control"]).toBe("no-store");
      const cookies = response.headers["set-cookie"] as string[] | undefined;
      expect(cookies?.length).toBe(1);
      const cookie = cookies?.[0];
      const token = tokenFromCookie(cookie);
      // Boolean assertions avoid printing raw credentials on assertion failures.
      expect(cookie?.includes("; HttpOnly")).toBe(true);
      expect(cookie?.includes("; SameSite=Strict")).toBe(true);
      expect(cookie?.includes("; Path=/system-admin/auth;")).toBe(true);
      expect(cookie?.includes("; Secure")).toBe(env.sessionCookieSecure);

      const rows = await db
        .selectFrom("system_admin_auth_challenges")
        .selectAll()
        .where("system_admin_id", "=", account.id)
        .execute();
      expect(rows.length).toBe(1);
      const challenge = rows[0]!;
      expect(challenge.failed_attempts).toBe(0);
      expect(challenge.consumed_at).toBeNull();
      expect(/^[0-9a-f]{64}$/.test(challenge.token_hash)).toBe(true);
      expect(challenge.token_hash === token).toBe(false);
      expect(challenge.token_hash === hashAuthChallengeToken(token)).toBe(true);
      expect(challenge.expires_at.getTime()).toBeGreaterThanOrEqual(
        startedAt + AUTH_CHALLENGE_LIFETIME_MS,
      );
      expect(challenge.expires_at.getTime()).toBeLessThanOrEqual(
        Date.now() + AUTH_CHALLENGE_LIFETIME_MS,
      );
      const cookieExpiry = cookie?.match(/; Expires=([^;]+)/)?.[1];
      expect(cookieExpiry).toBeDefined();
      expect(Math.abs(Date.parse(cookieExpiry!) - challenge.expires_at.getTime()))
        .toBeLessThan(1000);
      expect(await findActiveAuthChallenge(db, hashAuthChallengeToken(token)))
        .toMatchObject({ id: challenge.id, systemAdminId: account.id });

      // Even if submitted as a tenant session credential, a challenge grants no access.
      await request(app).get("/auth/me")
        .set("Cookie", `session=${token}`).expect(401);
    },
  );

  it.each(["wrong password", "unknown email", "deactivated"])(
    "returns the same generic failure and creates no challenge for %s",
    async (state) => {
      const account = await createAccount();
      if (state === "deactivated") {
        await db.updateTable("system_admins")
          .set({ deactivated_at: new Date() })
          .where("id", "=", account.id).execute();
      }
      const before = await db.selectFrom("system_admin_auth_challenges")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .executeTakeFirstOrThrow();
      const verification = vi.spyOn(argon2, "verify");
      try {
        const response = await request(app)
          .post("/system-admin/auth/login")
          .send({
            email: state === "unknown email"
              ? `unknown-${randomUUID()}@example.com` : account.email,
            password: state === "wrong password" ? "incorrect password" : password,
          })
          .expect(401);
        expect(response.body).toEqual({ error: "Invalid credentials" });
        expect(response.headers["set-cookie"]).toBeUndefined();
        expect(verification.mock.calls.length).toBe(1);
        const verifiedHash = verification.mock.calls[0]?.[0];
        expect(verifiedHash === passwordHash).toBe(state === "wrong password");
        expect(typeof verifiedHash === "string" && verifiedHash.startsWith("$argon2id$"))
          .toBe(true);
      } finally {
        verification.mockRestore();
      }
      const after = await db.selectFrom("system_admin_auth_challenges")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .executeTakeFirstOrThrow();
      expect(after.count).toBe(before.count);
    },
  );

  it("allows repeated successful logins to create independent active challenges", async () => {
    const account = await createAccount();
    const first = await request(app).post("/system-admin/auth/login")
      .send({ email: account.email, password }).expect(200);
    const second = await request(app).post("/system-admin/auth/login")
      .send({ email: account.email, password }).expect(200);
    const firstToken = tokenFromCookie(first.headers["set-cookie"]?.[0]);
    const secondToken = tokenFromCookie(second.headers["set-cookie"]?.[0]);
    expect(firstToken === secondToken).toBe(false);
    const firstChallenge = await findActiveAuthChallenge(db, hashAuthChallengeToken(firstToken));
    const secondChallenge = await findActiveAuthChallenge(db, hashAuthChallengeToken(secondToken));
    expect(firstChallenge?.systemAdminId).toBe(account.id);
    expect(secondChallenge?.systemAdminId).toBe(account.id);
    expect(firstChallenge?.id === secondChallenge?.id).toBe(false);
    const rows = await db.selectFrom("system_admin_auth_challenges").select("id")
      .where("system_admin_id", "=", account.id).execute();
    expect(rows.length).toBe(2);
  });

  it.each([
    { email: "invalid-email" },
    { password: "" },
    { password: "x".repeat(129) },
    { organizationId: randomUUID() },
  ])("rejects invalid or extra input before authentication (case %#)", async (invalid) => {
    const account = await createAccount();
    const verification = vi.spyOn(argon2, "verify");
    try {
      const response = await request(app).post("/system-admin/auth/login")
        .send({ email: account.email, password, ...invalid }).expect(400);
      expect(response.body.error).toBe("Invalid login data");
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(verification.mock.calls.length).toBe(0);
    } finally {
      verification.mockRestore();
    }
    const rows = await db.selectFrom("system_admin_auth_challenges").select("id")
      .where("system_admin_id", "=", account.id).execute();
    expect(rows.length).toBe(0);
  });
});
