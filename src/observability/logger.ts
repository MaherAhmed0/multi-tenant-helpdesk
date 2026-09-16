import { pino, type DestinationStream } from "pino";

import { getRequestContext } from "./request-context.js";

// Defense in depth only. Call sites must never pass request/auth/credential objects.
const sensitiveFields = [
  "req",
  "res",
  "headers",
  "cookies",
  "body",
  "auth",
  "session",
  "authorization",
  "cookie",
  "password",
  "passwordHash",
  "password_hash",
  "token",
  "tokenHash",
  "token_hash",
  "sessionToken",
  "csrfToken",
  "csrfSecret",
  "CSRF_SECRET",
  "invitationToken",
  "challengeToken",
  "totpSecret",
  "secret",
  "recoveryCode",
  "recoveryCodes",
  "code",
  "TOTP_ENCRYPTION_KEY",
];

export function createLogger(destination?: DestinationStream) {
  return pino(
    {
      redact: {
        paths: sensitiveFields.flatMap((field) => [field, `*.${field}`]),
        remove: true,
      },
      // Pino may mutate its mixin result; never give it the actual ALS store.
      mixin: () => ({ ...getRequestContext() }),
      mixinMergeStrategy: (fields, context) => ({ ...fields, ...context }),
    },
    destination,
  );
}

export const logger = createLogger();
