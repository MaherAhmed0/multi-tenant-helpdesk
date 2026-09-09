import { createHash, randomUUID } from "node:crypto";

import argon2 from "argon2";
import { describe, expect, it, vi } from "vitest";

import { db } from "../database/db.js";
import { AppError } from "../errors/app-error.js";
import { provisionSystemAdmin } from "./provisioning.service.js";
import * as recoveryCodeRepository from "./recovery-code.repository.js";
import { decryptTotpSecret } from "./totp-secret-crypto.js";

function provisioningInput() {
  return {
    email: `system-admin-${randomUUID()}@example.com`,
    password: "a sufficiently long password",
    confirmedTotpSecret: "unit-test-confirmed-totp-secret",
  };
}

describe("SYSTEM_ADMIN provisioning", () => {
  it("persists an admin and ten hashed recovery codes with safe return fields", async () => {
    const input = provisioningInput();
    const result = await provisionSystemAdmin(input);

    expect(Object.keys(result).sort()).toEqual(["recoveryCodes", "systemAdmin"]);
    expect(result.systemAdmin).toEqual({
      id: expect.any(String),
      email: input.email,
      createdAt: expect.any(Date),
    });
    expect(result.recoveryCodes.length).toBe(10);
    expect(new Set(result.recoveryCodes).size).toBe(10);

    const admins = await db.selectFrom("system_admins").selectAll()
      .where("email", "=", input.email).execute();
    expect(admins.length).toBe(1);
    const admin = admins[0]!;
    expect(admin.id).toBe(result.systemAdmin.id);
    expect(admin.last_totp_time_step).toBeNull();
    expect(admin.deactivated_at).toBeNull();
    expect(admin.password_hash.startsWith("$argon2id$")).toBe(true);
    expect(admin.password_hash === input.password).toBe(false);
    expect(await argon2.verify(admin.password_hash, input.password)).toBe(true);
    for (const value of [admin.totp_secret_ciphertext, admin.totp_secret_iv, admin.totp_secret_auth_tag]) {
      expect(value === input.confirmedTotpSecret).toBe(false);
    }
    expect(decryptTotpSecret({
      ciphertext: admin.totp_secret_ciphertext,
      iv: admin.totp_secret_iv,
      authTag: admin.totp_secret_auth_tag,
    }) === input.confirmedTotpSecret).toBe(true);

    const rows = await db.selectFrom("system_admin_recovery_codes")
      .select(["code_hash", "used_at"])
      .where("system_admin_id", "=", admin.id).execute();
    expect(rows.length).toBe(10);
    for (const row of rows) {
      expect(/^[0-9a-f]{64}$/.test(row.code_hash)).toBe(true);
      expect(result.recoveryCodes.includes(row.code_hash)).toBe(false);
      expect(row.used_at).toBeNull();
    }
    for (const code of result.recoveryCodes) {
      expect(/^[A-Za-z0-9_-]{22}$/.test(code)).toBe(true);
      expect(Buffer.from(code, "base64url").length).toBe(16);
      expect(Buffer.from(code, "base64url").toString("base64url") === code).toBe(true);
      const hash = createHash("sha256").update(code, "utf8").digest("hex");
      expect(rows.some((row) => row.code_hash === hash)).toBe(true);
    }
  });

  it("maps duplicate normalized email to a conflict without another code set", async () => {
    const input = provisioningInput();
    const first = await provisionSystemAdmin(input);
    const originalCodes = await db.selectFrom("system_admin_recovery_codes").selectAll()
      .where("system_admin_id", "=", first.systemAdmin.id).orderBy("id").execute();

    const duplicate = provisionSystemAdmin({
      ...input,
      email: ` ${input.email.toUpperCase()} `,
    });
    await expect(duplicate).rejects.toBeInstanceOf(AppError);
    await expect(duplicate).rejects.toMatchObject({
      statusCode: 409,
      message: "System administrator email already exists",
    });

    const admins = await db.selectFrom("system_admins").select("id")
      .where("email", "=", input.email).execute();
    expect(admins).toEqual([{ id: first.systemAdmin.id }]);
    const codes = await db.selectFrom("system_admin_recovery_codes").selectAll()
      .where("system_admin_id", "=", first.systemAdmin.id).orderBy("id").execute();
    expect(codes).toEqual(originalCodes);
    expect(codes.length).toBe(10);
  });

  it("rolls back the admin when recovery-code persistence fails", async () => {
    const input = provisioningInput();
    const insertHashes = recoveryCodeRepository.createRecoveryCodeHashes;
    let insertedAdminId: string | undefined;
    const insertion = vi.spyOn(recoveryCodeRepository, "createRecoveryCodeHashes")
      .mockImplementationOnce(async (executor, adminId, hashes) => {
        insertedAdminId = adminId;
        const inserted = await executor.selectFrom("system_admins").select("id")
          .where("id", "=", adminId).executeTakeFirstOrThrow();
        expect(inserted.id).toBe(adminId);
        // Real PostgreSQL uniqueness failure after the admin insert, without test hooks.
        await insertHashes(executor, adminId, [...hashes, hashes[0]!]);
      });

    try {
      await expect(provisionSystemAdmin(input)).rejects.toMatchObject({
        code: "23505",
        constraint: "system_admin_recovery_codes_admin_hash_unique",
      });
    } finally {
      insertion.mockRestore();
    }

    expect(insertedAdminId).toBeDefined();
    const admin = await db.selectFrom("system_admins").select("id")
      .where("email", "=", input.email).executeTakeFirst();
    expect(admin).toBeUndefined();
    const codes = await db.selectFrom("system_admin_recovery_codes").select("id")
      .where("system_admin_id", "=", insertedAdminId!).execute();
    expect(codes.length).toBe(0);
  });

  it.each([
    { email: "invalid-email" },
    { password: "too short" },
    { confirmedTotpSecret: " " },
  ])("rejects invalid provisioning input (case %#)", async (invalid) => {
    const input = { ...provisioningInput(), ...invalid };

    await expect(provisionSystemAdmin(input)).rejects.toMatchObject({ statusCode: 400 });
    const admin = await db.selectFrom("system_admins").select("id")
      .where("email", "=", input.email).executeTakeFirst();
    expect(admin).toBeUndefined();
  });
});
