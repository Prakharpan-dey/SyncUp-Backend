import { z } from 'zod';

import { isoDateSchema, isoTimeSchema, weekdaysSchema } from '../../core/validation/params.js';

export const createSeriesSchema = z.object({
  // Client-owned, like tasks: the device mints the id so an offline create and
  // its retry land on the same row.
  id: z.string().uuid().optional(),
  title: z.string().min(1).max(255),
  description: z.string().optional(),
  priority: z.enum(['high', 'medium', 'low']).default('medium'),
  tags: z.array(z.string()).optional(),
  weekdays: weekdaysSchema,
  due_time: isoTimeSchema.optional(),
  starts_on: isoDateSchema,
  ends_on: isoDateSchema.optional(),
  generated_through: isoDateSchema.optional(),
});

export const updateSeriesSchema = createSeriesSchema
  .partial()
  .extend({
    // Stopping a series clears this rather than deleting the row, so completed
    // occurrences keep pointing at something that explains them.
    active: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'At least one field required' });
