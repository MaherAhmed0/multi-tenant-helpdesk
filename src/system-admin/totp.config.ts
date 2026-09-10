export const TOTP_OPTIONS = {
  strategy: "totp",
  algorithm: "sha1",
  digits: 6,
  period: 30,
  epochTolerance: 5,
} as const;
