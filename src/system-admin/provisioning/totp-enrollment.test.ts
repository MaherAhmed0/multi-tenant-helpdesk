import { generate } from "otplib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  confirmTotpEnrollment,
  startTotpEnrollment,
} from "./totp-enrollment.js";

const email = "platform-admin@example.com";

describe("SYSTEM_ADMIN TOTP enrollment", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 8, 9, 12, 0, 15));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a secret and the library-generated issuer/account URI", () => {
    const enrollment = startTotpEnrollment(email);

    expect(Object.keys(enrollment).sort()).toEqual(["secret", "uri"]);
    expect(enrollment.secret.length).toBeGreaterThan(0);
    const uri = new URL(enrollment.uri);
    expect(uri.protocol).toBe("otpauth:");
    expect(uri.hostname).toBe("totp");
    expect(decodeURIComponent(uri.pathname)).toBe(
      `/Multi-Tenant Helpdesk:${email}`,
    );
    expect(uri.searchParams.get("issuer")).toBe("Multi-Tenant Helpdesk");
    expect(uri.searchParams.get("secret") === enrollment.secret).toBe(true);
  });

  it("confirms a code generated from the pending secret", async () => {
    const { secret } = startTotpEnrollment(email);
    const code = await generate({ secret });

    expect(await confirmTotpEnrollment(secret, code)).toBe(true);
  });

  it("rejects an incorrect six-digit code", async () => {
    const { secret } = startTotpEnrollment(email);
    const code = await generate({ secret });
    const incorrect = (code[0] === "0" ? "1" : "0") + code.slice(1);

    expect(await confirmTotpEnrollment(secret, incorrect)).toBe(false);
  });

  it("rejects a code generated for another enrollment", async () => {
    const { secret } = startTotpEnrollment(email);
    const ownCode = await generate({ secret });
    let otherCode: string;
    do {
      const other = startTotpEnrollment("other-admin@example.com");
      otherCode = await generate({ secret: other.secret });
      // Six-digit codes can coincide; avoid a probabilistic test failure.
    } while (otherCode === ownCode);

    expect(await confirmTotpEnrollment(secret, otherCode)).toBe(false);
  });

  it.each([
    "",
    " ",
    "not-an-email",
    "Admin@example.com",
    " admin@example.com ",
  ])("rejects an invalid account label (case %#)", (account) => {
    expect(() => startTotpEnrollment(account)).toThrow(
      /normalized SYSTEM_ADMIN email/,
    );
  });

  it.each(["", "12345", "1234567", "abcdef", " 123456", "123 456"])(
    "returns false for a malformed code (case %#)",
    async (code) => {
      const { secret } = startTotpEnrollment(email);

      expect(await confirmTotpEnrollment(secret, code)).toBe(false);
    },
  );

  it("returns false for a malformed pending secret", async () => {
    expect(await confirmTotpEnrollment("", "123456")).toBe(false);
    expect(await confirmTotpEnrollment("invalid-secret", "123456")).toBe(false);
  });
});
