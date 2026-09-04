import { z } from 'zod';

/**
 * Shared path-parameter schemas.
 *
 * Route handlers previously used `request.params as { id: string }`, which is a
 * compile-time cast with no runtime effect. A malformed UUID would reach Postgres
 * and raise `22P02 invalid input syntax for type uuid`, surfacing as a 500 where
 * a 400 is correct. Parsing with these schemas turns that into a clean 422.
 */

export const idParamSchema = z.object({
  id: z.string().uuid(),
});

export const sessionParamsSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
});

export const groupMemberParamsSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
});

export const tokenParamSchema = z.object({
  token: z.string().min(1).max(100),
});

/** ISO calendar date, e.g. 2026-08-25. */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected date in YYYY-MM-DD format')
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Invalid calendar date');

/**
 * Local wall-clock time of day, e.g. 21:30.
 *
 * Carries no timezone. Nothing server-side may combine it with a date into an
 * instant — no table stores a user's timezone, so the result would be wrong for
 * everyone outside UTC. The device turns this into an alarm; the server only
 * stores and returns it.
 */
export const isoTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected time in HH:MM format');

/**
 * ISO weekday numbers a series repeats on: `'1,3,5'` for Mon/Wed/Fri.
 *
 * Ascending, no duplicates, at least one. "Daily" is all seven rather than a
 * separate mode, so expansion never special-cases it.
 */
export const weekdaysSchema = z
  .string()
  .regex(/^[1-7](,[1-7])*$/, 'Expected comma-separated weekday numbers, 1-7')
  .refine((value) => {
    const days = value.split(',').map(Number);
    return days.every((d, i) => i === 0 || d > days[i - 1]);
  }, 'Weekdays must be ascending and unique');
