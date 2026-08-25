import { pgTable, uuid, varchar, timestamp, pgEnum, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const authTokenTypeEnum = pgEnum('auth_token_type', [
  'email_verify',
  'password_reset',
]);

/**
 * Single-use, expiring tokens delivered by email.
 *
 * Follows the same shape as `refresh_tokens`: only the SHA-256 hash is stored,
 * so a database leak does not hand out working verification or reset links.
 * One table serves both flows — they differ only in TTL and what confirming
 * them does.
 */
export const authTokens = pgTable('auth_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  tokenHash: varchar('token_hash', { length: 255 }).notNull(),
  type: authTokenTypeEnum('type').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  /** Set on first use. A non-null value means the token is spent. */
  usedAt: timestamp('used_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  // Confirmation looks rows up by hash alone.
  uniqueIndex('uq_auth_tokens_token_hash').on(table.tokenHash),
  // Issuing a new token invalidates the user's outstanding ones of that type.
  index('idx_auth_tokens_user_type').on(table.userId, table.type),
]);
