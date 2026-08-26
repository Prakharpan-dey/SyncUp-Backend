import { pgTable, uuid, varchar, timestamp, pgEnum, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const devicePlatformEnum = pgEnum('device_platform', ['android', 'ios', 'web']);

/**
 * Push notification targets, one row per device.
 *
 * Replaces the single `users.fcm_token` column, which had three problems:
 *
 *  - Only one device could ever receive push. Signing in elsewhere overwrote
 *    the token and the earlier device went silently dark.
 *  - It was never cleared on logout or account deletion, so a signed-out phone
 *    kept receiving notifications — and on a shared device they leaked to
 *    whoever logged in next.
 *  - Nothing proved the submitting user owned the token, so anyone could claim
 *    a victim's token and push arbitrary notifications to their phone.
 *
 * The unique index on `token` is what fixes the third: claiming a token that
 * already exists reassigns that single row rather than creating a duplicate, so
 * a token can only ever belong to one account at a time.
 */
export const userDevices = pgTable('user_devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  /** FCM registration token. */
  token: varchar('token', { length: 255 }).notNull(),
  platform: devicePlatformEnum('platform').notNull(),
  /** Refreshed on each claim, so stale devices can be pruned later. */
  lastSeenAt: timestamp('last_seen_at').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  // A device belongs to exactly one account; re-registering moves it.
  uniqueIndex('uq_user_devices_token').on(table.token),
  // Fan-out reads every device for a user when sending a notification.
  index('idx_user_devices_user_id').on(table.userId),
]);
