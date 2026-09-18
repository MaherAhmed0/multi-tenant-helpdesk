import { db } from "../../database/db.js";
import { aggregateStatisticsOverview } from "./overview.repository.js";
import {
  isStatisticsOverview,
  statisticsOverviewSchema,
} from "./overview.schema.js";
import { readOverviewCache, writeOverviewCache } from "../statistics.cache.js";

export async function getStatisticsOverview(organizationId: string) {
  const cached = await readOverviewCache(organizationId, isStatisticsOverview);
  if (cached.status === "HIT") {
    return { overview: cached.value, cacheStatus: cached.status };
  }

  const row = await aggregateStatisticsOverview(db, organizationId);
  // PostgreSQL count/numeric aggregates arrive as strings; preserve null durations.
  const overview = statisticsOverviewSchema.parse({
    generatedAt: row.generatedAt.toISOString(),
    tickets: {
      active: Number(row.active),
      unassigned: Number(row.unassigned),
      urgent: Number(row.urgent),
      oldestActiveTicketAgeSeconds:
        row.oldestActiveTicketAgeSeconds === null
          ? null
          : Number(row.oldestActiveTicketAgeSeconds),
      byStatus: {
        OPEN: Number(row.open),
        IN_PROGRESS: Number(row.inProgress),
        RESOLVED: Number(row.resolved),
        CLOSED: Number(row.closed),
      },
      byPriority: {
        LOW: Number(row.lowPriority),
        NORMAL: Number(row.normalPriority),
        HIGH: Number(row.highPriority),
        URGENT: Number(row.urgent),
      },
    },
    today: {
      created: Number(row.createdToday),
      closed: Number(row.closedToday),
    },
    resolution: {
      averageCloseTimeSeconds:
        row.averageCloseTimeSeconds === null
          ? null
          : Number(row.averageCloseTimeSeconds),
    },
  });

  if (cached.status === "MISS") {
    await writeOverviewCache(organizationId, overview);
  }
  return { overview, cacheStatus: cached.status };
}
