import { z } from "zod";

const count = z.number().int().nonnegative();
const durationSeconds = z.number().nonnegative().nullable();

export const statisticsOverviewSchema = z
  .object({
    generatedAt: z.iso.datetime(),
    tickets: z
      .object({
        active: count,
        unassigned: count,
        urgent: count,
        oldestActiveTicketAgeSeconds: durationSeconds,
        byStatus: z
          .object({
            OPEN: count,
            IN_PROGRESS: count,
            RESOLVED: count,
            CLOSED: count,
          })
          .strict(),
        byPriority: z
          .object({
            LOW: count,
            NORMAL: count,
            HIGH: count,
            URGENT: count,
          })
          .strict(),
      })
      .strict(),
    today: z.object({ created: count, closed: count }).strict(),
    resolution: z.object({ averageCloseTimeSeconds: durationSeconds }).strict(),
  })
  .strict();

export type StatisticsOverview = z.infer<typeof statisticsOverviewSchema>;

export function isStatisticsOverview(
  value: unknown,
): value is StatisticsOverview {
  return statisticsOverviewSchema.safeParse(value).success;
}
