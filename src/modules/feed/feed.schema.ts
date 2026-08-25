import { z } from 'zod';

export const feedQuerySchema = z.object({
  tab: z.enum(['friends', 'groups']).default('friends'),
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(50).default(20),
});

export const reactSchema = z.object({ emoji: z.string().min(1).max(10) });
export const commentSchema = z.object({ text: z.string().min(1).max(500) });
