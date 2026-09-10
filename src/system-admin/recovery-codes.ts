import { createHash, randomBytes } from "node:crypto";

const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_BYTES = 16;

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

export function generateRecoveryCodes() {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const code = randomBytes(RECOVERY_CODE_BYTES).toString("base64url");
    const hash = hashRecoveryCode(code);

    return { code, hash };
  });
}
