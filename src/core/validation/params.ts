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
