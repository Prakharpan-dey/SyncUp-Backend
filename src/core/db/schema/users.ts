import { sql } from 'drizzle-orm';
import { pgTable, uuid, varchar, smallint, timestamp, pgEnum, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';

export const privacySearchableEnum = pgEnum('privacy_searchable', ['everyone', 'friends', 'none']);
export const privacySharingEnum = pgEnum('privacy_sharing', ['none', 'summary', 'selected', 'all']);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Stored as the user typed it so their preferred capitalization shows in the
  // UI; uniqueness is enforced case-insensitively by the index below.
  username: varchar('username', { length: 40 }).unique().notNull(),
  displayName: varchar('display_name', { length: 80 }).notNull(),
  // Normalized to lowercase by the Zod schema before it ever reaches here.
  email: varchar('email', { length: 255 }).unique().notNull(),
  passwordHash: varchar('password_hash', { length: 255 }), // NULL for Google OAuth
  emailVerifiedAt: timestamp('email_verified_at'),
  photoUrl: varchar('photo_url', { length: 500 }),
  college: varchar('college', { length: 150 }),
  department: varchar('department', { length: 150 }),
  semester: smallint('semester'),
  graduationYear: smallint('graduation_year'),
  privacySearchable: privacySearchableEnum('privacy_searchable').default('everyone').notNull(),
  privacySharingDefault: privacySharingEnum('privacy_sharing_default').default('summary').notNull(),
  notificationSettings: jsonb('notification_settings').default({}),
  // Push targets live in `user_devices`, not here. A single column meant only
  // the most recently signed-in device could receive notifications.
  // No is_deleted column: deletion is a real DELETE. A soft-delete flag has to
  // be remembered at every read site, and five of them had already forgotten it
  // — leaving deleted users visible in group member lists, pending requests and
  // friends' feeds.
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  // Without this, `satyam`, `Satyam` and `SATYAM` are three separate accounts —
  // and since user search uses ILIKE they all surface in the same result list,
  // which is a ready-made impersonation setup.
  uniqueIndex('uq_users_username_lower').on(sql`lower(${table.username})`),
]);
