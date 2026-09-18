import { sql, type Kysely, type Transaction } from "kysely";

import type { Database, TicketStatus } from "../../database/types.js";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

const activeStatuses: TicketStatus[] = ["OPEN", "IN_PROGRESS", "RESOLVED"];

export async function aggregateStatisticsOverview(
  executor: DatabaseExecutor,
  organizationId: string,
) {
  // One statement timestamp keeps generatedAt, age, and UTC day boundaries aligned.
  const utcDayStart = sql<Date>`
    date_trunc('day', statement_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
  `;
  const utcDayEnd = sql<Date>`${utcDayStart} + interval '24 hours'`;

  return executor
    .selectFrom("tickets")
    .where("organization_id", "=", organizationId)
    .where("voided_at", "is", null)
    .select((eb) => [
      sql<Date>`statement_timestamp()`.as("generatedAt"),
      eb.fn
        .countAll<string>()
        .filterWhere("status", "in", activeStatuses)
        .as("active"),
      eb.fn
        .countAll<string>()
        .filterWhere("status", "in", activeStatuses)
        .filterWhere("assigned_team_id", "is", null)
        .filterWhere("assigned_agent_id", "is", null)
        .as("unassigned"),
      eb.fn
        .countAll<string>()
        .filterWhere("status", "in", activeStatuses)
        .filterWhere("priority", "=", "URGENT")
        .as("urgent"),
      eb.fn.countAll<string>().filterWhere("status", "=", "OPEN").as("open"),
      eb.fn
        .countAll<string>()
        .filterWhere("status", "=", "IN_PROGRESS")
        .as("inProgress"),
      eb.fn
        .countAll<string>()
        .filterWhere("status", "=", "RESOLVED")
        .as("resolved"),
      eb.fn
        .countAll<string>()
        .filterWhere("status", "=", "CLOSED")
        .as("closed"),
      eb.fn
        .countAll<string>()
        .filterWhere("status", "in", activeStatuses)
        .filterWhere("priority", "=", "LOW")
        .as("lowPriority"),
      eb.fn
        .countAll<string>()
        .filterWhere("status", "in", activeStatuses)
        .filterWhere("priority", "=", "NORMAL")
        .as("normalPriority"),
      eb.fn
        .countAll<string>()
        .filterWhere("status", "in", activeStatuses)
        .filterWhere("priority", "=", "HIGH")
        .as("highPriority"),
      eb.fn
        .countAll<string>()
        .filterWhere("created_at", ">=", utcDayStart)
        .filterWhere("created_at", "<", utcDayEnd)
        .as("createdToday"),
      eb.fn
        .countAll<string>()
        .filterWhere("closed_at", ">=", utcDayStart)
        .filterWhere("closed_at", "<", utcDayEnd)
        .as("closedToday"),
      sql<string | null>`extract(epoch from (statement_timestamp() - ${eb.fn
        .min("created_at")
        .filterWhere("status", "in", activeStatuses)}))`.as(
        "oldestActiveTicketAgeSeconds",
      ),
      sql<string | null>`
        avg(extract(epoch from (closed_at - created_at))) filter (where status = 'CLOSED')
      `.as("averageCloseTimeSeconds"),
    ])
    .executeTakeFirstOrThrow();
}
