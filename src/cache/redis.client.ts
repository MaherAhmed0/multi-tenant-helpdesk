import { createClient } from "redis";

import { env } from "../config/env.js";
import { logger } from "../observability/logger.js";

export const redisClient = createClient({
  url: env.redisUrl,
  disableOfflineQueue: true,
  commandOptions: {
    timeout: 500,
  },
  // Keep the client's automatic reconnection policy.
});

let redisConnectionStarted = false;

redisClient.on("error", (error: unknown) => {
  // Connection errors can contain credentials/URLs;
  // log only the error category.
  logger.warn({
    event: "redis_error",
    errorType: error instanceof Error ? error.name : "UnknownError",
  });
});

export function startRedisConnection(): void {
  if (redisConnectionStarted) return;

  redisConnectionStarted = true;

  // Redis is an optional dependency, so application startup
  // must not wait for Redis to become available.
  void redisClient.connect().catch(() => {
    logger.warn({
      event: "redis_connection_failed",
    });
  });
}

export async function closeRedisConnection(): Promise<void> {
  if (!redisConnectionStarted) return;

  redisConnectionStarted = false;

  if (redisClient.isOpen) {
    await redisClient.close();
    return;
  }

  // The client may be connecting/reconnecting even though
  // there is currently no open socket.
  redisClient.destroy();
}
