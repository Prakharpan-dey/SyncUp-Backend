import { pgTable, uuid, timestamp, unique, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { groups } from './groups.js';

/**
 * Someone who opened a group's invite link and is waiting for an owner or
 * admin to let them in.
 *
 * A separate table rather than a status on `group_members`: every query that
 * reads membership — member counts, group feed visibility, "is this person in
 * the group" checks — would otherwise need a status filter, and one missed
 * filter would leak a group's feed to someone who was never admitted.
 *
 * A row is deleted when the request is answered either way; approval inserts
 * the `group_members` row in the same transaction.
 */
export const groupJoinRequests = pgTable('group_join_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  groupId: uuid('group_id').references(() => groups.id, { onDelete: 'cascade' }).notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  unique('uq_group_join_request').on(table.groupId, table.userId),
  index('idx_group_join_requests_group_id').on(table.groupId),
]);
