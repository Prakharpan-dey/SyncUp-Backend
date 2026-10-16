import { pgTable, uuid, text, timestamp, pgEnum, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';
import { feedItems } from './feed-items.js';

export const reportReasonEnum = pgEnum('report_reason', [
  'spam', 'harassment', 'inappropriate', 'impersonation', 'other',
]);
export const reportStatusEnum = pgEnum('report_status', ['open', 'actioned', 'dismissed']);

/**
 * Someone flagging a person, or one of their posts, for review.
 *
 * Play requires apps with user-generated content to offer this in-app. Reports
 * are reviewed by hand from the support inbox, so a row is a record of what was
 * said and whether it was dealt with, nothing more.
 */
export const reports = pgTable('reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  reporterId: uuid('reporter_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  reportedUserId: uuid('reported_user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  // Feed posts expire with retention; the report outlives them.
  feedItemId: uuid('feed_item_id').references(() => feedItems.id, { onDelete: 'set null' }),
  reason: reportReasonEnum('reason').notNull(),
  details: text('details'),
  status: reportStatusEnum('status').default('open').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  // Reporting the same post twice is a no-op. There is deliberately no unique
  // index for person reports: when a reported post expires its feed_item_id
  // goes NULL, and a (reporter, reported) index over NULL rows would then make
  // the retention delete fail. The service dedupes those instead.
  uniqueIndex('uq_reports_item')
    .on(table.reporterId, table.feedItemId)
    .where(sql`${table.feedItemId} IS NOT NULL`),
  index('idx_reports_reported_user_id').on(table.reportedUserId),
]);
