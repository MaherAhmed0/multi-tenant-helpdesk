import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "../database/db.js";
import {
  AUTH_CHALLENGE_LIFETIME_MS,
  AUTH_CHALLENGE_MAX_FAILED_ATTEMPTS,
} from "./auth-challenge.constants.js";
import {
  generateAuthChallengeToken,
  hashAuthChallengeToken,
} from "./auth-challenge-token.js";
import {
  consumeAuthChallenge,
  createAuthChallenge,
  findActiveAuthChallenge,
  recordAuthChallengeFailure,
} from "./auth-challenge.repository.js";
import { createSystemAdmin } from "./system-admin.repository.js";

let systemAdminId: string;

beforeAll(async () => {
  // Prepared placeholders satisfy the parent schema; no credential verification here.
  const admin = await createSystemAdmin(db, {
    email: `challenge-${randomUUID()}@example.com`,
    passwordHash: "test-only-password-hash",
    totpSecretCiphertext: "test-only-ciphertext",
    totpSecretIv: "test-only-iv",
    totpSecretAuthTag: "test-only-auth-tag",
  });
  systemAdminId = admin.id;
});

afterAll(async () => {
  await db.destroy();
});

async function createChallenge(
  expiresAt = new Date(Date.now() + AUTH_CHALLENGE_LIFETIME_MS),
) {
  const credential = generateAuthChallengeToken();
  const challenge = await createAuthChallenge(db, {
    systemAdminId,
    tokenHash: credential.tokenHash,
    expiresAt,
  });
  return { challenge, credential };
}

describe("SYSTEM_ADMIN MFA challenges", () => {
  it("generates distinct 32-byte opaque tokens and lowercase SHA-256 hashes", () => {
    const first = generateAuthChallengeToken();
    const second = generateAuthChallengeToken();

    expect(first.token === second.token).toBe(false);
    expect(first.tokenHash === second.tokenHash).toBe(false);
    expect(/^[A-Za-z0-9_-]{43}$/.test(first.token)).toBe(true);
    expect(Buffer.from(first.token, "base64url").length).toBe(32);
    expect(/^[0-9a-f]{64}$/.test(first.tokenHash)).toBe(true);
    expect(first.token === first.tokenHash).toBe(false);
    expect(first.tokenHash === createHash("sha256")
      .update(first.token, "utf8").digest("hex")).toBe(true);
    expect(hashAuthChallengeToken(first.token) === first.tokenHash).toBe(true);
  });

  it("persists only the hash and finds the active challenge by that hash", async () => {
    const { challenge, credential } = await createChallenge();
    expect(challenge.failedAttempts).toBe(0);
    expect(challenge.consumedAt).toBeNull();
    expect(challenge.systemAdminId).toBe(systemAdminId);
    expect(await findActiveAuthChallenge(db, credential.tokenHash)).toEqual(challenge);
    expect(await findActiveAuthChallenge(db, credential.token)).toBeUndefined();

    const stored = await db.selectFrom("system_admin_auth_challenges")
      .selectAll().where("id", "=", challenge.id).executeTakeFirstOrThrow();
    expect(stored.token_hash === credential.tokenHash).toBe(true);
    expect(JSON.stringify(stored).includes(credential.token)).toBe(false);
  });

  it("does not find, increment, or consume an expired challenge", async () => {
    const { challenge, credential } = await createChallenge(new Date(Date.now() - 1000));
    expect(await findActiveAuthChallenge(db, credential.tokenHash)).toBeUndefined();
    expect(await recordAuthChallengeFailure(db, challenge.id)).toBeUndefined();
    expect(await consumeAuthChallenge(db, challenge.id)).toBeUndefined();
  });

  it("increments failures until the threshold and then rejects further use", async () => {
    const { challenge, credential } = await createChallenge();
    for (let count = 1; count <= AUTH_CHALLENGE_MAX_FAILED_ATTEMPTS; count++) {
      expect(await recordAuthChallengeFailure(db, challenge.id)).toEqual({
        id: challenge.id,
        failedAttempts: count,
      });
      const active = await findActiveAuthChallenge(db, credential.tokenHash);
      if (count < AUTH_CHALLENGE_MAX_FAILED_ATTEMPTS) {
        expect(active?.failedAttempts).toBe(count);
      } else {
        expect(active).toBeUndefined();
      }
    }
    expect(await recordAuthChallengeFailure(db, challenge.id)).toBeUndefined();
    expect(await consumeAuthChallenge(db, challenge.id)).toBeUndefined();
  });

  it("consumes once and prevents further lookup, failure recording, or consumption", async () => {
    const { challenge, credential } = await createChallenge();
    expect(await consumeAuthChallenge(db, challenge.id)).toEqual({
      id: challenge.id,
      systemAdminId,
      consumedAt: expect.any(Date),
    });
    expect(await findActiveAuthChallenge(db, credential.tokenHash)).toBeUndefined();
    expect(await recordAuthChallengeFailure(db, challenge.id)).toBeUndefined();
    expect(await consumeAuthChallenge(db, challenge.id)).toBeUndefined();
  });

  it("allows only one of two concurrent consumers to succeed", async () => {
    const { challenge, credential } = await createChallenge();
    const results = await Promise.all([
      consumeAuthChallenge(db, challenge.id),
      consumeAuthChallenge(db, challenge.id),
    ]);
    expect(results.filter((result) => result !== undefined).length).toBe(1);
    expect(await findActiveAuthChallenge(db, credential.tokenHash)).toBeUndefined();
  });

  it("does not lose concurrent increments or exceed the attempt threshold", async () => {
    const { challenge, credential } = await createChallenge();
    const results = await Promise.all(
      Array.from({ length: AUTH_CHALLENGE_MAX_FAILED_ATTEMPTS + 3 }, () =>
        recordAuthChallengeFailure(db, challenge.id),
      ),
    );
    expect(results.flatMap((result) => result ? [result.failedAttempts] : [])
      .sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(await findActiveAuthChallenge(db, credential.tokenHash)).toBeUndefined();
  });

  it.each([
    { overrides: { failed_attempts: -1 }, code: "23514" },
    { overrides: { token_hash: "not-a-sha256-hash" }, code: "23514" },
    { overrides: {}, code: "23505" },
  ])("enforces structural integrity (case %#)", async ({ overrides, code }) => {
    const { credential } = await createChallenge();
    await expect(db.insertInto("system_admin_auth_challenges").values({
      system_admin_id: systemAdminId,
      token_hash: credential.tokenHash,
      expires_at: new Date(Date.now() + AUTH_CHALLENGE_LIFETIME_MS),
      ...overrides,
    }).execute()).rejects.toMatchObject({ code });
  });
});
