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
  completedAt: timestamp('completed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('idx_tasks_user_id').on(table.userId),
]);
