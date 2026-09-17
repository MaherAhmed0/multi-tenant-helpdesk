import { redisClient } from "../cache/redis.client.js";
import { logger } from "../observability/logger.js";

const STATISTICS_CACHE_TTL_SECONDS = {
  overview: 30,
  workload: 30,
  activity: 60,
} as const;

// Callers must supply the organization ID from trusted tenant request context.
const statisticsKeys = {
  overview: (organizationId: string) => `statistics:overview:${organizationId}`,
  workload: (organizationId: string) => `statistics:workload:${organizationId}`,
  activity: (organizationId: string, days: number) =>
    `statistics:activity:${organizationId}:${days}`,
};

export type StatisticsCacheRead<T> =
  | { status: "HIT"; value: T }
  | { status: "MISS" }
  | { status: "BYPASS" };

// Future statistics response schemas plug in here. Parsing JSON alone is not validation.
type StatisticsValidator<T> = (value: unknown) => value is T;

async function readStatistics<T>(
  key: string,
  validate: StatisticsValidator<T>,
): Promise<StatisticsCacheRead<T>> {
  if (!redisClient.isReady) return { status: "BYPASS" };

  let serialized: string | null;
  try {
    serialized = await redisClient.get(key);
  } catch {
    logger.warn({ event: "statistics_cache_read_failed" });
    return { status: "BYPASS" };
  }
  if (serialized === null) return { status: "MISS" };

  try {
    const value: unknown = JSON.parse(serialized);
    if (validate(value)) return { status: "HIT", value };
  } catch {
    // Malformed JSON or a rejecting/throwing validator must not break statistics reads.
  }
  logger.warn({ event: "statistics_cache_invalid_value" });
  return { status: "BYPASS" };
}

async function writeStatistics(
  key: string,
  value: unknown,
  ttlSeconds: number,
): Promise<void> {
  if (!redisClient.isReady) return;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("Unserializable statistics");
    await redisClient.set(key, serialized, {
      expiration: { type: "EX", value: ttlSeconds },
    });
  } catch {
    // Neither Redis errors nor serialization errors may fail the business operation.
    logger.warn({ event: "statistics_cache_write_failed" });
  }
}

export function readOverviewCache<T>(organizationId: string, validate: StatisticsValidator<T>) {
  return readStatistics(statisticsKeys.overview(organizationId), validate);
}

export function writeOverviewCache(organizationId: string, value: unknown) {
  return writeStatistics(statisticsKeys.overview(organizationId), value, STATISTICS_CACHE_TTL_SECONDS.overview);
}

export function readWorkloadCache<T>(organizationId: string, validate: StatisticsValidator<T>) {
  return readStatistics(statisticsKeys.workload(organizationId), validate);
}

export function writeWorkloadCache(organizationId: string, value: unknown) {
  return writeStatistics(statisticsKeys.workload(organizationId), value, STATISTICS_CACHE_TTL_SECONDS.workload);
}

export function readActivityCache<T>(organizationId: string, days: number, validate: StatisticsValidator<T>) {
  return readStatistics(statisticsKeys.activity(organizationId, days), validate);
}

export function writeActivityCache(organizationId: string, days: number, value: unknown) {
  return writeStatistics(statisticsKeys.activity(organizationId, days), value, STATISTICS_CACHE_TTL_SECONDS.activity);
}
