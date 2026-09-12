import { pgTable, uuid, timestamp, unique, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { groups } from './groups.js';

/**
 * An owner or admin asking someone into a group. The invitee decides:
 * accepting makes them a member, declining deletes the invite. Nobody is
 * added to a group they did not agree to be in.
 */
export const groupInvites = pgTable('group_invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  groupId: uuid('group_id').references(() => groups.id, { onDelete: 'cascade' }).notNull(),
  inviteeId: uuid('invitee_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  // Nullable so deleting the inviter's account does not take the invite with it.
  invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  unique('uq_group_invite').on(table.groupId, table.inviteeId),
  index('idx_group_invites_invitee_id').on(table.inviteeId),
]);
