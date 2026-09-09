import { generateSecret, generateURI, verify } from "otplib";
import { z } from "zod";

const ISSUER = "Multi-Tenant Helpdesk";
const TOTP_OPTIONS = {
  strategy: "totp",
  algorithm: "sha1",
  digits: 6,
  period: 30,
} as const;

const accountSchema = z
  .email()
  .max(254)
  .refine((value) => value === value.trim().toLowerCase());

export function startTotpEnrollment(email: string): {
  secret: string;
  uri: string;
} {
  const account = accountSchema.safeParse(email);
  if (!account.success) {
    throw new Error(
      "A normalized SYSTEM_ADMIN email is required for TOTP enrollment",
    );
  }

  const secret = generateSecret({ length: 20 });
  const uri = generateURI({
    ...TOTP_OPTIONS,
    issuer: ISSUER,
    label: account.data,
    secret,
  });

  return { secret, uri };
}

export async function confirmTotpEnrollment(
  pendingSecret: string,
  code: string,
): Promise<boolean> {
  // Enrollment secrets are the 20-byte, unpadded Base32 values generated above.
  if (
    typeof pendingSecret !== "string" ||
    !/^[A-Z2-7]{32}$/.test(pendingSecret) ||
    typeof code !== "string" ||
    !/^[0-9]{6}$/.test(code)
  ) {
    return false;
  }

  const result = await verify({
    ...TOTP_OPTIONS,
    secret: pendingSecret,
    token: code,
    epochTolerance: 5,
  });

  return result.valid;
}
