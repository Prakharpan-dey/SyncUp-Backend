import { pgTable, uuid, varchar, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const refreshTokens = pgTable('refresh_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  tokenHash: varchar('token_hash', { length: 255 }).notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  isRevoked: boolean('is_revoked').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('idx_refresh_tokens_user_id').on(table.userId),
  // The refresh endpoint looks rows up by hash, and every client hits it every
  // 15 minutes against a table that grows unboundedly — without this it is a
  // sequential scan. Unique also rules out duplicate-hash rows, which the
  // `.limit(1)` in refresh() would otherwise resolve arbitrarily.
  uniqueIndex('uq_refresh_tokens_token_hash').on(table.tokenHash),
]);
