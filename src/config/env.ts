import { getRequiredEnv, parseBoolean, parsePort } from "./env-utils.js";

const port = parsePort(process.env.PORT ?? "3000", "PORT");

const csrfSecret = getRequiredEnv("CSRF_SECRET");

if (Buffer.byteLength(csrfSecret, "utf8") < 32) {
  throw new Error("CSRF_SECRET must be at least 32 bytes");
}

export const env = {
  port,

  csrfSecret,

  database: {
    host: getRequiredEnv("DATABASE_HOST"),
    port: parsePort(getRequiredEnv("DATABASE_PORT"), "DATABASE_PORT"),
    name: getRequiredEnv("DATABASE_NAME"),
    user: getRequiredEnv("DATABASE_USER"),
    password: getRequiredEnv("DATABASE_PASSWORD"),
  },

  sessionCookieSecure: parseBoolean(
    process.env.SESSION_COOKIE_SECURE,
    "SESSION_COOKIE_SECURE",
  ),
};
