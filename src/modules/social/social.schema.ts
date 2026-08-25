import { z } from 'zod';

export const sendFriendRequestSchema = z.object({ addressee_id: z.string().uuid() });
export const respondFriendRequestSchema = z.object({ status: z.enum(['accepted', 'blocked']) });
export const createGroupSchema = z.object({ name: z.string().min(1).max(100), is_public: z.boolean().default(false) });
