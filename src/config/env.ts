import { getRequiredEnv, parseBoolean, parsePort } from "./env-utils.js";

const port = parsePort(process.env.PORT ?? "3000", "PORT");

export const env = {
  port,

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
