import { pgTable, uuid, varchar, text, date, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const taskPriorityEnum = pgEnum('task_priority', ['high', 'medium', 'low']);
export const taskStatusEnum = pgEnum('task_status', ['pending', 'completed']);
export const sharingOverrideEnum = pgEnum('sharing_override', ['inherit', 'none', 'summary', 'selected', 'all']);

export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description'),
  dueDate: date('due_date'),
  priority: taskPriorityEnum('priority').default('medium').notNull(),
  status: taskStatusEnum('status').default('pending').notNull(),
  tags: text('tags').array(),
  sharingOverride: sharingOverrideEnum('sharing_override'),

  /**
   * The repeating rule this task was generated from, or null for a one-off.
   *
   * Intentionally not a foreign key. Occurrences reach the server through a
   * fire-and-forget outbox that pushes immediately when online but queues on
   * failure, so an occurrence can arrive before the series that spawned it. A
   * constraint violation is a 4xx, which the client's sync queue treats as
   * permanent and parks forever — losing the row silently.
   */
  seriesId: uuid('series_id'),

  /**
   * Local wall-clock time the task is due, `'HH:MM'`. See `task_series.dueTime`:
   * this carries no timezone and must never be combined with `dueDate` into an
   * instant server-side.
   */
  dueTime: varchar('due_time', { length: 5 }),
  completedAt: timestamp('completed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('idx_tasks_user_id').on(table.userId),
  index('idx_tasks_series_id').on(table.seriesId),
]);
