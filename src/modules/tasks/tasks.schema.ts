import { z } from 'zod';
import { isoDateSchema, isoTimeSchema } from '../../core/validation/params.js';

export const createTaskSchema = z.object({
  // The client owns the id. Tasks are created offline and referenced by that
  // id immediately — by the toggle, the edit and the delete — so a
  // server-assigned id would leave the device holding one the server has never
  // seen, and every later write would 404. Optional: callers that do not
  // supply one still get a generated id.
  id: z.string().uuid().optional(),
  title: z.string().min(1).max(255),
  description: z.string().optional(),
  due_date: isoDateSchema.optional(),
  priority: z.enum(['high', 'medium', 'low']).default('medium'),
  tags: z.array(z.string()).optional(),
  sharing_override: z.enum(['inherit', 'none', 'summary', 'selected', 'all']).optional(),
  due_time: isoTimeSchema.optional(),
  series_id: z.string().uuid().optional(),
});

export const updateTaskSchema = createTaskSchema.partial().refine(
  data => Object.keys(data).length > 0, { message: 'At least one field required' },
);

// Note: no `user_id` here on purpose. Tasks are always scoped to the
// authenticated caller — accepting a user_id would look like an impersonation
// parameter and become one the moment someone wired it into the service.
export const taskQuerySchema = z.object({
  status: z.enum(['pending', 'completed']).optional(),
  priority: z.enum(['high', 'medium', 'low']).optional(),
});
