import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { env } from "../config/env.js";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export interface EncryptedTotpSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
}

export function encryptTotpSecret(plaintext: string): EncryptedTotpSecret {
  if (plaintext.length === 0) {
    throw new Error("TOTP secret must not be empty");
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, env.totpEncryptionKey, iv, {
    authTagLength: AUTH_TAG_BYTES,
  });
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

function decodeEncryptedValue(value: string): Buffer {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Invalid encrypted TOTP secret");
  }

  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error("Invalid encrypted TOTP secret");
  }

  return decoded;
}

export function decryptTotpSecret(encrypted: EncryptedTotpSecret): string {
  const ciphertext = decodeEncryptedValue(encrypted.ciphertext);
  const iv = decodeEncryptedValue(encrypted.iv);
  const authTag = decodeEncryptedValue(encrypted.authTag);

  if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
    throw new Error("Invalid encrypted TOTP secret");
  }

  const decipher = createDecipheriv(ALGORITHM, env.totpEncryptionKey, iv, {
    authTagLength: AUTH_TAG_BYTES,
  });
  decipher.setAuthTag(authTag);

  // Return plaintext only after final() has authenticated the complete message.
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}
