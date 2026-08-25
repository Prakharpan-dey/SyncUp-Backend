import { z } from 'zod';
import { isoDateSchema } from '../../core/validation/params.js';

export const createTaskSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().optional(),
  due_date: isoDateSchema.optional(),
  priority: z.enum(['high', 'medium', 'low']).default('medium'),
  tags: z.array(z.string()).optional(),
  sharing_override: z.enum(['inherit', 'none', 'summary', 'selected', 'all']).optional(),
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
