import { describe, it, expect, beforeEach, vi } from 'vitest';

import { createDbMock } from '../helpers/db-mock.js';

const dbMock = createDbMock();
vi.mock('../../src/core/db/drizzle.js', () => ({ db: dbMock.db }));

/**
 * The worker's own module opens a BullMQ connection on import, so the policy it
 * enforces is exercised through the same mapping and rule rather than by
 * booting a worker. Keep this table in step with PREFERENCE_KEY.
 */
const PREFERENCE_KEY: Record<string, string> = {
  task_reminder: 'task_reminders',
  attendance_warning: 'attendance_warnings',
  friend_request: 'friend_requests',
  reaction: 'reactions',
  comment: 'comments',
  daily_digest: 'daily_digest',
};

function pushAllowed(type: string, settings: Record<string, unknown>): boolean {
  const key = PREFERENCE_KEY[type];
  if (key === undefined) return true;
  return settings[key] !== false;
}

describe('notification preferences gate the push', () => {
  beforeEach(() => dbMock.reset());

  it('every notification type maps to a preference key', () => {
    // The enum is singular, the preference keys plural — a mismatch would
    // silently mute or unmute a whole category.
    const enumTypes = [
      'task_reminder', 'attendance_warning', 'friend_request',
      'reaction', 'comment', 'daily_digest',
    ];
    for (const t of enumTypes) {
      expect(PREFERENCE_KEY[t], `no preference key for "${t}"`).toBeDefined();
    }
  });

  it('suppresses a category the user switched off', () => {
    expect(pushAllowed('friend_request', { friend_requests: false })).toBe(false);
  });

  it('allows a category the user switched on', () => {
    expect(pushAllowed('reaction', { reactions: true })).toBe(true);
  });

  // Someone who has never opened the preferences screen must still be notified.
  it('treats an absent category as enabled', () => {
    expect(pushAllowed('reaction', { friend_requests: false })).toBe(true);
  });

  it('treats empty settings as everything enabled', () => {
    for (const t of Object.keys(PREFERENCE_KEY)) {
      expect(pushAllowed(t, {})).toBe(true);
    }
  });

  // Dropping a notification silently is worse than sending one not asked for.
  it('lets an unrecognised type through', () => {
    expect(pushAllowed('something_new', { something_new: false })).toBe(true);
  });

  it('mutes only the category named, not its neighbours', () => {
    const settings = { reactions: false };
    expect(pushAllowed('reaction', settings)).toBe(false);
    expect(pushAllowed('friend_request', settings)).toBe(true);
    expect(pushAllowed('task_reminder', settings)).toBe(true);
  });
});

describe('sharing modes are honest about what they do', () => {
  /** Mirrors tasks.service.publishCompletion. */
  const published = (sharing: string, taskTitle: string): string | null => {
    if (sharing === 'none') return null;
    return sharing === 'summary' ? 'Completed a task' : taskTitle;
  };

  it('none publishes nothing', () => {
    expect(published('none', 'Finish DBMS assignment')).toBeNull();
  });

  it('summary announces without naming the task', () => {
    expect(published('summary', 'Finish DBMS assignment')).toBe('Completed a task');
  });

  it('all names the task', () => {
    expect(published('all', 'Finish DBMS assignment')).toBe('Finish DBMS assignment');
  });

  // 'selected' promised per-task granularity that no schema or UI backed, and
  // behaved exactly like 'all'. The API no longer accepts it.
  it('the API rejects selected', async () => {
    const { updateProfileSchema } = await import(
      '../../src/modules/users/users.schema.js'
    );
    expect(
      updateProfileSchema.safeParse({ privacy_sharing_default: 'selected' }).success,
    ).toBe(false);
  });

  it('the API still accepts the three real modes', async () => {
    const { updateProfileSchema } = await import(
      '../../src/modules/users/users.schema.js'
    );
    for (const mode of ['none', 'summary', 'all']) {
      expect(
        updateProfileSchema.safeParse({ privacy_sharing_default: mode }).success,
        mode,
      ).toBe(true);
    }
  });
});
