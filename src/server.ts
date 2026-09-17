import { app } from "./app.js";
import { env } from "./config/env.js";
import { checkDatabaseConnection } from "./database/check-connection.js";
import { db } from "./database/db.js";
import {
  startRedisConnection,
  closeRedisConnection,
} from "./cache/redis.client.js";
import { logger } from "./observability/logger.js";

async function closeResources(): Promise<void> {
  try {
    await closeRedisConnection();
  } finally {
    await db.destroy();
  }
}

async function startServer(): Promise<void> {
  try {
    await checkDatabaseConnection();
    startRedisConnection();

    const server = app.listen(env.port, () => {
      console.log(`Server listening on port ${env.port}`);
    });

    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      // Stop accepting requests and drain HTTP before closing shared clients.
      server.close((error) => {
        if (error) {
          logger.error({ event: "http_shutdown_failed" });
          process.exitCode = 1;
        }
        void closeResources().catch(() => {
          logger.error({ event: "application_shutdown_failed" });
          process.exitCode = 1;
        });
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    console.error("Failed to start application.", error);

    await closeResources();

    process.exit(1);
  }
}

void startServer();
