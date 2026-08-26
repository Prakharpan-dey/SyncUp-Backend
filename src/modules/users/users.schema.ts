import { z } from 'zod';

export const updateProfileSchema = z.object({
  display_name: z.string().min(1).max(80).optional(),
  college: z.string().max(150).optional(),
  department: z.string().max(150).optional(),
  // Nullable, not just optional — otherwise a user who sets one of these can
  // never clear it back to blank, only change it to another value.
  semester: z.number().int().min(1).max(12).nullable().optional(),
  graduation_year: z.number().int().min(2020).max(2040).nullable().optional(),
  privacy_searchable: z.enum(['everyone', 'friends', 'none']).optional(),
  privacy_sharing_default: z.enum(['none', 'summary', 'selected', 'all']).optional(),
  notification_settings: z.record(z.string(), z.boolean()).optional(),
  // fcm_token deliberately absent: push tokens are registered via
  // POST /auth/devices, which takes ownership of the token. Accepting one here
  // let a user claim someone else's device and push notifications to it.
}).refine(data => Object.keys(data).length > 0, { message: 'At least one field required' });

export const searchUsersSchema = z.object({
  q: z.string().min(1).max(100),
});

export const blockUserSchema = z.object({
  user_id: z.string().uuid(),
});
