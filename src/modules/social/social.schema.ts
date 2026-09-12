import { z } from 'zod';

export const sendFriendRequestSchema = z.object({ addressee_id: z.string().uuid() });
export const respondFriendRequestSchema = z.object({ status: z.enum(['accepted', 'blocked']) });
export const createGroupSchema = z.object({ name: z.string().min(1).max(100), is_public: z.boolean().default(false) });

/**
 * Exactly one way to name the person: a typed username (exact case, like
 * search), a typed email, or a friend picked from the list by id.
 */
export const createGroupInviteSchema = z.object({
  username: z.string().trim().min(1).max(40).optional(),
  email: z.string().trim().toLowerCase().pipe(z.string().email('Invalid email')).optional(),
  user_id: z.string().uuid().optional(),
}).refine(
  (b) => [b.username, b.email, b.user_id].filter((v) => v !== undefined).length === 1,
  { message: 'Provide exactly one of username, email or user_id' },
);
