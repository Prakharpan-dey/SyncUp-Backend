import { pgTable, uuid, varchar, timestamp, primaryKey, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { feedItems } from './feed-items.js';

/**
 * One reaction per person per post.
 *
 * Reactions used to be a JSONB array on the post: reacting rewrote the whole
 * array under a row lock, every feed page shipped the array just to answer "did
 * I react", and deleting an account scanned every post to scrub it. A row per
 * reaction makes all three an index lookup. `feed_items.reaction_count` stays
 * as the count the feed shows.
 */
export const feedReactions = pgTable('feed_reactions', {
  feedItemId: uuid('feed_item_id').references(() => feedItems.id, { onDelete: 'cascade' }).notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  emoji: varchar('emoji', { length: 10 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  primaryKey({ columns: [table.feedItemId, table.userId] }),
  // Account deletion finds everything a person reacted to.
  index('idx_feed_reactions_user_id').on(table.userId),
]);
