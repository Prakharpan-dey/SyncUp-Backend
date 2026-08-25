import { z } from 'zod';
import { isoDateSchema } from '../../core/validation/params.js';

export const createSubjectSchema = z.object({
  name: z.string().min(1).max(150),
  code: z.string().max(30).optional(),
  threshold_pct: z.number().int().min(0).max(100).default(75),
});

export const updateSubjectSchema = createSubjectSchema.partial();

export const logSessionSchema = z.object({
  session_date: isoDateSchema,
  status: z.enum(['present', 'absent']),
});
