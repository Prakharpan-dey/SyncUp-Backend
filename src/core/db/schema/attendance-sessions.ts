import { pgTable, uuid, date, timestamp, pgEnum, unique, index } from 'drizzle-orm/pg-core';
import { subjects } from './subjects.js';

export const attendanceStatusEnum = pgEnum('attendance_status', ['present', 'absent']);

export const attendanceSessions = pgTable('attendance_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  subjectId: uuid('subject_id').references(() => subjects.id, { onDelete: 'cascade' }).notNull(),
  sessionDate: date('session_date').notNull(),
  status: attendanceStatusEnum('status').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  unique('uq_subject_date').on(table.subjectId, table.sessionDate),
  index('idx_attendance_sessions_subject_id').on(table.subjectId),
]);
