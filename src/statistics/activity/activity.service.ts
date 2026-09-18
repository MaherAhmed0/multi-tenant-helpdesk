import { db } from "../../database/db.js";
import { aggregateStatisticsActivity } from "./activity.repository.js";
import {
  isStatisticsActivity,
  statisticsActivitySchema,
  type StatisticsActivity,
} from "./activity.schema.js";
import { readActivityCache, writeActivityCache } from "../statistics.cache.js";

export async function getStatisticsActivity(
  organizationId: string,
  days: number,
) {
  const cached = await readActivityCache(
    organizationId,
    days,
    (value): value is StatisticsActivity =>
      isStatisticsActivity(value) && value.days === days,
  );
  if (cached.status === "HIT") {
    return { activity: cached.value, cacheStatus: cached.status };
  }

  const rows = await aggregateStatisticsActivity(db, organizationId, days);
  const first = rows[0];
  if (!first) throw new Error("Statistics activity date series is missing");
  const points = rows.map((row) => ({
    date: row.date,
    created: Number(row.created),
    closed: Number(row.closed),
  }));
  const totals = points.reduce(
    (sum, point) => ({
      created: sum.created + point.created,
      closed: sum.closed + point.closed,
    }),
    { created: 0, closed: 0 },
  );
  const activity = statisticsActivitySchema.parse({
    generatedAt: first.generatedAt.toISOString(),
    days,
    from: first.from,
    to: first.to,
    totals,
    points,
  });

  if (cached.status === "MISS") {
    await writeActivityCache(organizationId, days, activity);
  }
  return { activity, cacheStatus: cached.status };
}
