import { pgTable, uuid, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const friendshipStatusEnum = pgEnum('friendship_status', ['pending', 'accepted', 'blocked']);

export const friendships = pgTable('friendships', {
  id: uuid('id').primaryKey().defaultRandom(),
  requesterId: uuid('requester_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  addresseeId: uuid('addressee_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  status: friendshipStatusEnum('status').default('pending').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('idx_friendships_requester_id').on(table.requesterId),
  index('idx_friendships_addressee_id').on(table.addresseeId),
]);
