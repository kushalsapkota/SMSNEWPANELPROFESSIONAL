import { z } from 'zod';
import { AppError } from '../common/errors';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Query date: `YYYY-MM-DD` (UTC day) or an ISO-8601 date-time with offset/Z. */
export const dateParam = z
  .string()
  .trim()
  .refine((v) => (DATE_ONLY.test(v) || z.string().datetime({ offset: true }).safeParse(v).success) && !Number.isNaN(Date.parse(v)), 'must be YYYY-MM-DD or an ISO-8601 date-time');

const DAY_MS = 86_400_000;

/**
 * [from, to) range for CDR/stat queries. Date-only `to` is inclusive of that whole day.
 * Defaults: to = now, from = to - defaultDays. Ranges longer than maxDays are refused so
 * every query stays bounded (partition pruning on message_logs).
 */
export function resolveRange(fromRaw: string | undefined, toRaw: string | undefined, defaultDays: number, maxDays: number): { from: Date; to: Date } {
  const to = toRaw ? (DATE_ONLY.test(toRaw) ? new Date(Date.parse(`${toRaw}T00:00:00Z`) + DAY_MS) : new Date(toRaw)) : new Date();
  const from = fromRaw ? (DATE_ONLY.test(fromRaw) ? new Date(`${fromRaw}T00:00:00Z`) : new Date(fromRaw)) : new Date(to.getTime() - defaultDays * DAY_MS);
  if (!(from.getTime() < to.getTime())) throw AppError.invalid('from must be before to', { field: 'from' });
  if (to.getTime() - from.getTime() > maxDays * DAY_MS) throw AppError.invalid(`date range must be at most ${maxDays} days`, { max_days: maxDays });
  return { from, to };
}
