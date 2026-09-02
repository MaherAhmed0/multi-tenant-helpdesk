import { sql } from "kysely";

import { db } from "./db.js";

interface ConnectionInfo {
  current_user: string;
  current_database: string;
}

export async function checkDatabaseConnection(): Promise<void> {
  const result = await sql<ConnectionInfo>`
    SELECT
      current_user,
      current_database() AS current_database
  `.execute(db);

  const connection = result.rows[0];

  if (!connection) {
    throw new Error("Database connection check returned no result.");
  }

  console.log(
    `Connected to database "${connection.current_database}" as "${connection.current_user}".`,
  );
}
