import { pgTable, uuid, varchar, text, integer, timestamp, pgEnum, jsonb, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const feedItemTypeEnum = pgEnum('feed_item_type', ['task_completed', 'streak_milestone', 'attendance_milestone']);
export const feedVisibilityEnum = pgEnum('feed_visibility', ['friends', 'group']);

export const feedItems = pgTable('feed_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  actorName: varchar('actor_name', { length: 80 }).notNull(),
  actorPhotoUrl: varchar('actor_photo_url', { length: 500 }),
  type: feedItemTypeEnum('type').notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  summary: text('summary'),
  metadata: jsonb('metadata').default({}),
  visibility: feedVisibilityEnum('visibility').default('friends').notNull(),
  groupId: uuid('group_id'),
  reactionCount: integer('reaction_count').default(0).notNull(),
  commentCount: integer('comment_count').default(0).notNull(),
  reactions: jsonb('reactions').default([]),
  comments: jsonb('comments').default([]),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('idx_feed_items_user_id').on(table.userId),
  index('idx_feed_items_created_at').on(table.createdAt),
]);
