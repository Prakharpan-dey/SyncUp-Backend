import { pgTable, uuid, varchar, text, boolean, date, timestamp, index } from 'drizzle-orm/pg-core';

import { taskPriorityEnum } from './tasks.js';
import { users } from './users.js';

/**
 * The rule behind a repeating task. Individual occurrences are ordinary rows in
 * `tasks`, carrying `series_id`.
 *
 * A separate table rather than a hidden "template" row inside `tasks`: every
 * read site there is unfiltered (the client returns every task it holds, and the
 * server's list, stats and reminder sweep all select broadly), so a template row
 * would have to be excluded in seven places and would leak the moment one was
 * forgotten.
 */
export const taskSeries = pgTable('task_series', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description'),
  priority: taskPriorityEnum('priority').default('medium').notNull(),
  tags: text('tags').array(),

  /**
   * ISO weekday numbers the task repeats on, ascending and comma-separated:
   * `'1,3,5'` for Mon/Wed/Fri. Matches Dart's `DateTime.weekday` (Mon = 1).
   *
   * "Daily" is stored as all seven rather than as a separate mode, so expansion
   * has one branch and daily is not a special case anywhere.
   */
  weekdays: varchar('weekdays', { length: 13 }).notNull(),

  /**
   * Local wall-clock time of day, `'HH:MM'`.
   *
   * Deliberately a string, not a `time` column: no table stores a timezone, so
   * this cannot be combined with a date into an instant. Keeping it opaque stops
   * anything server-side from trying. The device, which does know its zone, is
   * what turns this into an alarm.
   */
  dueTime: varchar('due_time', { length: 5 }),

  startsOn: date('starts_on').notNull(),
  /** Null means open-ended. */
  endsOn: date('ends_on'),

  /**
   * Cleared rather than deleted when the user stops a series, so occurrences
   * they already completed keep pointing at a row that explains them.
   */
  active: boolean('active').default(true).notNull(),

  /**
   * The last day occurrences have been materialized through.
   *
   * Only ever moves forward, which is what makes deleting a single occurrence
   * permanent — expansion never looks back past this date, so nothing it
   * already generated can be resurrected.
   */
  generatedThrough: date('generated_through'),

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('idx_task_series_user_id').on(table.userId),
]);
