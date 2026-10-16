import { z } from 'zod';

export const createReportSchema = z.object({
  user_id: z.string().uuid(),
  // Set when a post is reported; absent when the person is.
  feed_item_id: z.string().uuid().optional(),
  reason: z.enum(['spam', 'harassment', 'inappropriate', 'impersonation', 'other']),
  details: z.string().trim().max(500).optional(),
});

export type CreateReportInput = z.infer<typeof createReportSchema>;
