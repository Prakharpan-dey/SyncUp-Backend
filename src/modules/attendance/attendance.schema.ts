import { z } from 'zod';
import { isoDateSchema } from '../../core/validation/params.js';

export const createSubjectSchema = z.object({
  // The app creates subjects offline and names them itself; keeping its id is
  // what lets later edits, deletes and logged classes find the row.
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(150),
  code: z.string().max(30).optional(),
  threshold_pct: z.number().int().min(0).max(100).default(75),
});

export const updateSubjectSchema = createSubjectSchema.omit({ id: true }).partial();

export const logSessionSchema = z.object({
  id: z.string().uuid().optional(),
  session_date: isoDateSchema,
  status: z.enum(['present', 'absent']),
});
