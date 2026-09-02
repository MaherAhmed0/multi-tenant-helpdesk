import { app } from "./app.js";
import { env } from "./config/env.js";
import { checkDatabaseConnection } from "./database/check-connection.js";
import { db } from "./database/db.js";

async function startServer(): Promise<void> {
  try {
    await checkDatabaseConnection();

    app.listen(env.port, () => {
      console.log(`Server listening on port ${env.port}`);
    });
  } catch (error) {
    console.error("Failed to start application.", error);

    await db.destroy();

    process.exit(1);
  }
}

void startServer();
