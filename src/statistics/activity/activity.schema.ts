import { z } from "zod";

const activityDays = z.number().int().min(7).max(90);
const count = z.number().int().nonnegative();

export const activityQuerySchema = z.object({
  days: z.string()
    .regex(/^[1-9][0-9]*$/)
    .transform(Number)
    .pipe(activityDays)
    .default(30),
}).strict();

export const statisticsActivitySchema = z.object({
  generatedAt: z.iso.datetime(),
  days: activityDays,
  from: z.iso.date(),
  to: z.iso.date(),
  totals: z.object({ created: count, closed: count }).strict(),
  points: z.array(z.object({
    date: z.iso.date(),
    created: count,
    closed: count,
  }).strict()).min(7).max(90),
}).strict().refine((value) => {
  const from = Date.parse(`${value.from}T00:00:00.000Z`);
  const to = Date.parse(`${value.to}T00:00:00.000Z`);
  const dayMs = 86_400_000;
  return value.points.length === value.days
    && to === from + (value.days - 1) * dayMs
    && value.to === value.generatedAt.slice(0, 10)
    && value.points.every((point, index) =>
      Date.parse(`${point.date}T00:00:00.000Z`) === from + index * dayMs,
    );
}, { message: "Activity points must cover the complete UTC date range in order", path: ["points"] });

export type StatisticsActivity = z.infer<typeof statisticsActivitySchema>;

export function isStatisticsActivity(value: unknown): value is StatisticsActivity {
  return statisticsActivitySchema.safeParse(value).success;
}
