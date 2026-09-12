import { pgTable, uuid, varchar, text, integer, timestamp, pgEnum, jsonb, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

// 'daily_plan' is a snapshot of what someone had on for a day, posted
// deliberately. The other three are events the app emits on the user's behalf —
// and of those, only 'task_completed' currently has a producer.
export const feedItemTypeEnum = pgEnum('feed_item_type', [
  'task_completed', 'streak_milestone', 'attendance_milestone', 'daily_plan',
]);
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
  // One friend's newest posts, already in page order: the feed walks this per
  // friend and stops after a page. Its user_id prefix also serves the account
  // delete cascade and the same-day plan lookup, so it replaces the old
  // single-column index.
  index('idx_feed_items_user_created').on(table.userId, table.createdAt.desc(), table.id.desc()),
  // The Groups tab. Nothing indexed group_id before, so it scanned the table.
  index('idx_feed_items_group_created')
    .on(table.groupId, table.createdAt.desc(), table.id.desc())
    .where(sql`${table.groupId} IS NOT NULL`),
  // Retention deletes by age.
  index('idx_feed_items_created_at').on(table.createdAt),
]);
