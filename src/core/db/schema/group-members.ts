import { pgTable, uuid, timestamp, pgEnum, unique, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { groups } from './groups.js';

export const groupRoleEnum = pgEnum('group_role', ['owner', 'admin', 'member']);

export const groupMembers = pgTable('group_members', {
  id: uuid('id').primaryKey().defaultRandom(),
  groupId: uuid('group_id').references(() => groups.id, { onDelete: 'cascade' }).notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  role: groupRoleEnum('role').default('member').notNull(),
  joinedAt: timestamp('joined_at').defaultNow().notNull(),
}, (table) => [
  unique('uq_group_user').on(table.groupId, table.userId),
  index('idx_group_members_user_id').on(table.userId),
  index('idx_group_members_group_id').on(table.groupId),
]);
