import { pgTable, uuid, varchar, text, boolean, timestamp, pgEnum, jsonb, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const notificationTypeEnum = pgEnum('notification_type', [
  'task_reminder', 'attendance_warning', 'friend_request',
  'reaction', 'comment', 'daily_digest',
]);

export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  type: notificationTypeEnum('type').notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  body: text('body'),
  metadata: jsonb('metadata').default({}),
  isRead: boolean('is_read').default(false).notNull(),
  deepLink: varchar('deep_link', { length: 500 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('idx_notifications_user_read').on(table.userId, table.isRead),
]);
