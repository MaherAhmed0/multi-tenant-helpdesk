import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

import { migrationEnv } from "../config/migration-env.js";

const migrationPool = new Pool({
  host: migrationEnv.database.host,
  port: migrationEnv.database.port,
  database: migrationEnv.database.name,
  user: migrationEnv.database.user,
  password: migrationEnv.database.password,
});

export const migrationDb = new Kysely<Record<string, never>>({
  dialect: new PostgresDialect({
    pool: migrationPool,
  }),
});
