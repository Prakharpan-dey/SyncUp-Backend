import { z } from 'zod';

import { isoDateSchema } from '../../core/validation/params.js';

export const feedQuerySchema = z.object({
  tab: z.enum(['friends', 'groups']).default('friends'),
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(50).default(20),
});

export const reactSchema = z.object({ emoji: z.string().min(1).max(10) });

/**
 * A snapshot of one day's tasks, as the user previewed it.
 *
 * The client sends the list rather than the server deriving it from `tasks`:
 * the app is local-first, so a task may not have synced yet and a server-derived
 * list could differ from what the user just confirmed. Posting something other
 * than what was previewed is the one outcome worth designing against.
 */
export const sharePlanSchema = z.object({
  date: isoDateSchema,
  items: z
    .array(z.object({
      title: z.string().min(1).max(255),
      done: z.boolean(),
    }))
    .min(1)
    .max(200),
});
