import { describe, expect, it } from "vitest";

import { parseTotpEncryptionKey } from "../config/env-utils.js";
import { decryptTotpSecret, encryptTotpSecret } from "./totp-secret-crypto.js";

const plaintext = "unit-test-totp-secret";

describe("TOTP secret encryption", () => {
  it("round-trips a secret with the expected persisted representation", () => {
    const encrypted = encryptTotpSecret(plaintext);

    expect(decryptTotpSecret(encrypted)).toBe(plaintext);
    expect(Object.keys(encrypted).sort()).toEqual([
      "authTag",
      "ciphertext",
      "iv",
    ]);
    for (const value of Object.values(encrypted)) {
      expect(value).toMatch(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
      );
      expect(Buffer.from(value, "base64").toString("base64")).toBe(value);
    }
    expect(Buffer.from(encrypted.iv, "base64")).toHaveLength(12);
    expect(Buffer.from(encrypted.authTag, "base64")).toHaveLength(16);
  });

  it("uses a fresh IV when encrypting the same secret again", () => {
    const first = encryptTotpSecret(plaintext);
    const second = encryptTotpSecret(plaintext);

    expect(second.iv).not.toBe(first.iv);
    expect(second.ciphertext).not.toBe(first.ciphertext);
    expect(decryptTotpSecret(first)).toBe(plaintext);
    expect(decryptTotpSecret(second)).toBe(plaintext);
  });

  it.each(["ciphertext", "authTag", "iv"] as const)(
    "rejects tampering with %s",
    (field) => {
      const encrypted = encryptTotpSecret(plaintext);
      const modified = Buffer.from(encrypted[field], "base64");
      modified[0] = modified[0]! ^ 1;

      expect(() =>
        decryptTotpSecret({
          ...encrypted,
          [field]: modified.toString("base64"),
        }),
      ).toThrow();
    },
  );

  it.each([
    { ciphertext: "not-base64!" },
    { ciphertext: "" },
    { iv: "not-base64!" },
    { iv: Buffer.alloc(11).toString("base64") },
    { authTag: "not-base64!" },
    { authTag: Buffer.alloc(15).toString("base64") },
  ])("rejects malformed encrypted values: %o", (invalid) => {
    const encrypted = encryptTotpSecret(plaintext);

    expect(() => decryptTotpSecret({ ...encrypted, ...invalid })).toThrow();
  });

  it("rejects empty plaintext instead of producing an empty persistence field", () => {
    expect(() => encryptTotpSecret("")).toThrow(
      "TOTP secret must not be empty",
    );
  });
});

describe("TOTP encryption key validation", () => {
  it("decodes a canonical Base64 key to a 32-byte Buffer", () => {
    const bytes = Buffer.alloc(32, 255);

    expect(parseTotpEncryptionKey(bytes.toString("base64"))).toEqual(bytes);
  });

  it.each([
    "<replace_me>",
    "",
    Buffer.alloc(31).toString("base64"),
    Buffer.alloc(33).toString("base64"),
    Buffer.alloc(32).toString("base64").replace(/=$/, ""),
    Buffer.alloc(32, 255).toString("base64url"),
    Buffer.alloc(32).toString("base64") + "!",
    Buffer.alloc(32).toString("base64").replace(/^AAAA/, "AA AA"),
    // Nonzero padding bits decode successfully in Node but are not canonical.
    Buffer.alloc(32).toString("base64").replace(/A=$/, "B="),
  ])("rejects an invalid encoded key (case %#)", (value) => {
    expect(() => parseTotpEncryptionKey(value)).toThrow(/TOTP_ENCRYPTION_KEY/);
  });
});
