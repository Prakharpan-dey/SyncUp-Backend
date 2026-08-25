import { pgTable, uuid, varchar, smallint, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const subjects = pgTable('subjects', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  name: varchar('name', { length: 150 }).notNull(),
  code: varchar('code', { length: 30 }),
  thresholdPct: smallint('threshold_pct').default(75).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('idx_subjects_user_id').on(table.userId),
]);
