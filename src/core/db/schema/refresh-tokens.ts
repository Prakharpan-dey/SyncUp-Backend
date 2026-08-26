import { pgTable, uuid, varchar, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const refreshTokens = pgTable('refresh_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  tokenHash: varchar('token_hash', { length: 255 }).notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  isRevoked: boolean('is_revoked').default(false).notNull(),
  /**
   * Groups every token in one device's rotation chain.
   *
   * Rotation replaces the row on each refresh, so the row id is not a stable
   * handle on a session. This is: it is generated once at sign-in and carried
   * forward, which is what makes "sign out this device only" and a session
   * list possible.
   */
  sessionId: uuid('session_id').defaultRandom().notNull(),
  /** Best-effort label for a session list, e.g. "Pixel 8 Pro". */
  deviceLabel: varchar('device_label', { length: 120 }),
  /** Set when this token is rotated away, for the reuse grace window. */
  revokedAt: timestamp('revoked_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('idx_refresh_tokens_user_id').on(table.userId),
  index('idx_refresh_tokens_session_id').on(table.sessionId),
  // The refresh endpoint looks rows up by hash, and every client hits it every
  // 15 minutes against a table that grows unboundedly — without this it is a
  // sequential scan. Unique also rules out duplicate-hash rows, which the
  // `.limit(1)` in refresh() would otherwise resolve arbitrarily.
  uniqueIndex('uq_refresh_tokens_token_hash').on(table.tokenHash),
]);
