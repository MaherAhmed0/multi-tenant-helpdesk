import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FileMigrationProvider, Migrator } from "kysely/migration";

import { migrationDb } from "./migration-db.js";

type MigrationCommand = "latest" | "up" | "down";

function isMigrationCommand(value: string): value is MigrationCommand {
  return value === "latest" || value === "up" || value === "down";
}

async function runMigrations(command: MigrationCommand): Promise<void> {
  const migrationFolder = fileURLToPath(
    new URL("./migrations/", import.meta.url),
  );

  const migrator = new Migrator({
    db: migrationDb,

    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder,
    }),
  });

  const result =
    command === "latest"
      ? await migrator.migrateToLatest()
      : command === "up"
        ? await migrator.migrateUp()
        : await migrator.migrateDown();

  for (const migration of result.results ?? []) {
    console.log(
      `${migration.direction} ${migration.migrationName}: ${migration.status}`,
    );
  }

  if (result.error) {
    throw result.error;
  }

  if (!result.results?.length) {
    console.log("No migrations to execute.");
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "latest";

  if (!isMigrationCommand(command)) {
    throw new Error(
      `Unknown migration command "${command}". Expected latest, up, or down.`,
    );
  }

  try {
    await runMigrations(command);
  } finally {
    await migrationDb.destroy();
  }
}

main().catch((error: unknown) => {
  console.error("Migration failed.", error);
  process.exitCode = 1;
});
