import { getRequiredEnv, parsePort } from "./env-utils.js";

export const migrationEnv = {
  database: {
    host: getRequiredEnv("DATABASE_HOST"),
    port: parsePort(getRequiredEnv("DATABASE_PORT"), "DATABASE_PORT"),
    name: getRequiredEnv("DATABASE_NAME"),
    user: getRequiredEnv("MIGRATION_DATABASE_USER"),
    password: getRequiredEnv("MIGRATION_DATABASE_PASSWORD"),
  },
};
