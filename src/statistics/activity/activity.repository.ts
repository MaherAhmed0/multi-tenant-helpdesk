import { sql, type Kysely, type Transaction } from "kysely";

import type { Database } from "../../database/types.js";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

interface ActivityRow {
  generatedAt: Date;
  from: string;
  to: string;
  date: string;
  created: string;
  closed: string;
}

export async function aggregateStatisticsActivity(
  executor: DatabaseExecutor,
  organizationId: string,
  days: number,
): Promise<ActivityRow[]> {
  // Integer date offsets avoid session-timezone/DST effects in the date series.
  // Aggregate tickets before joining the calendar, retaining zero-activity dates.
  const result = await sql<ActivityRow>`
    WITH clock AS (
      SELECT statement_timestamp() AS generated_at
    ), bounds AS (
      SELECT generated_at,
        (generated_at AT TIME ZONE 'UTC')::date - (${days}::integer - 1) AS from_date,
        (generated_at AT TIME ZONE 'UTC')::date AS to_date
      FROM clock
    ), calendar AS (
      SELECT bounds.*, bounds.from_date + series.day_offset AS day
      FROM bounds
      CROSS JOIN generate_series(0, ${days}::integer - 1) AS series(day_offset)
    ), created_counts AS (
      SELECT (tickets.created_at AT TIME ZONE 'UTC')::date AS day,
        count(*) AS created
      FROM tickets CROSS JOIN bounds
      WHERE tickets.organization_id = ${organizationId}
        AND tickets.voided_at IS NULL
        AND tickets.created_at >= (bounds.from_date::timestamp AT TIME ZONE 'UTC')
        AND tickets.created_at < ((bounds.to_date + 1)::timestamp AT TIME ZONE 'UTC')
      GROUP BY (tickets.created_at AT TIME ZONE 'UTC')::date
    ), closed_counts AS (
      SELECT (tickets.closed_at AT TIME ZONE 'UTC')::date AS day,
        count(*) AS closed
      FROM tickets CROSS JOIN bounds
      WHERE tickets.organization_id = ${organizationId}
        AND tickets.voided_at IS NULL
        AND tickets.closed_at IS NOT NULL
        AND tickets.closed_at >= (bounds.from_date::timestamp AT TIME ZONE 'UTC')
        AND tickets.closed_at < ((bounds.to_date + 1)::timestamp AT TIME ZONE 'UTC')
      GROUP BY (tickets.closed_at AT TIME ZONE 'UTC')::date
    )
    SELECT calendar.generated_at AS "generatedAt",
      to_char(calendar.from_date::timestamp, 'YYYY-MM-DD') AS "from",
      to_char(calendar.to_date::timestamp, 'YYYY-MM-DD') AS "to",
      to_char(calendar.day::timestamp, 'YYYY-MM-DD') AS date,
      coalesce(created_counts.created, 0) AS created,
      coalesce(closed_counts.closed, 0) AS closed
    FROM calendar
    LEFT JOIN created_counts ON created_counts.day = calendar.day
    LEFT JOIN closed_counts ON closed_counts.day = calendar.day
    ORDER BY calendar.day ASC
  `.execute(executor);
  return result.rows;
}
