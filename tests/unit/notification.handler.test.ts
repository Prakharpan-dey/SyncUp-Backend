import { describe, it, expect, beforeEach, vi } from 'vitest';

import { createDbMock } from '../helpers/db-mock.js';

const dbMock = createDbMock();
vi.mock('../../src/core/db/drizzle.js', () => ({ db: dbMock.db }));

// Firebase is never configured in tests, so the real loader would report "not
// configured" and mask the difference between muted and undeliverable. A stub
// messaging client makes the push itself observable.
const sendEachForMulticast = vi.fn(async () => ({
  successCount: 1,
  responses: [{ success: true }],
}));
vi.mock('../../src/workers/messaging.js', () => ({
  getMessaging: async () => ({ sendEachForMulticast }),
}));

const { handleNotificationJob, pushAllowed } = await import(
  '../../src/workers/notification.handler.js'
);

/** Queues the reads the handler makes: the preference row, then the devices. */
function arrange(settings: Record<string, unknown>, tokens = ['tok-1']) {
  dbMock.queueMany(
    [],                                   // insert into notifications
    [{ settings }],                       // preference lookup
    tokens.map((token) => ({ token })),   // registered devices
  );
}

const job = (type: string, over: Record<string, unknown> = {}) => ({
  userId: 'u1',
  type,
  title: 'Rhea sent you a friend request',
  body: 'Tap to respond',
  ...over,
}) as Parameters<typeof handleNotificationJob>[0];

beforeEach(() => {
  dbMock.reset();
  sendEachForMulticast.mockClear();
});

describe('a muted category', () => {
  it('sends no push', async () => {
    arrange({ friend_requests: false });
    await handleNotificationJob(job('friend_request'));

    expect(sendEachForMulticast).not.toHaveBeenCalled();
  });

  // The whole point of "suppress push only": the event still happened, and the
  // user must be able to find it in the notification centre.
  it('still writes the notification row', async () => {
    arrange({ friend_requests: false });
    await handleNotificationJob(job('friend_request'));

    expect(dbMock.called('insert')).toBe(true);
    expect(dbMock.trace[0].method).toBe('insert');
  });

  it('does not even look up the devices', async () => {
    arrange({ friend_requests: false });
    await handleNotificationJob(job('friend_request'));

    const selects = dbMock.trace.filter((c) => c.method === 'select');
    expect(selects).toHaveLength(1); // the preference read, and nothing after
  });

  it('mutes only the category named', async () => {
    arrange({ friend_requests: false });
    await handleNotificationJob(job('reaction'));

    expect(sendEachForMulticast).toHaveBeenCalledTimes(1);
  });
});

describe('an enabled category', () => {
  it('pushes to every registered device', async () => {
    arrange({ friend_requests: true }, ['tok-1', 'tok-2']);
    await handleNotificationJob(job('friend_request'));

    expect(sendEachForMulticast).toHaveBeenCalledTimes(1);
    expect(sendEachForMulticast.mock.calls[0][0]).toMatchObject({
      tokens: ['tok-1', 'tok-2'],
    });
  });

  // Someone who has never opened the preferences screen must still be reached.
  it('pushes when the user has no settings at all', async () => {
    arrange({});
    await handleNotificationJob(job('friend_request'));

    expect(sendEachForMulticast).toHaveBeenCalledTimes(1);
  });

  it('pushes when a different category is the one muted', async () => {
    arrange({ reactions: false, daily_digest: false });
    await handleNotificationJob(job('task_reminder'));

    expect(sendEachForMulticast).toHaveBeenCalledTimes(1);
  });
});

describe('the preference lookup itself', () => {
  it.each([
    ['task_reminder', 'task_reminders'],
    ['attendance_warning', 'attendance_warnings'],
    ['friend_request', 'friend_requests'],
    ['reaction', 'reactions'],
    ['comment', 'comments'],
    ['daily_digest', 'daily_digest'],
  ])('%s is muted by %s', async (type, key) => {
    dbMock.queueRows([{ settings: { [key]: false } }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await pushAllowed('u1', type as any)).toBe(false);
  });

  it('allows the category when the row is missing entirely', async () => {
    dbMock.queueRows([]);
    expect(await pushAllowed('u1', 'reaction')).toBe(true);
  });

  // A value that is not exactly `false` — null, undefined, a stray string from
  // an older client — must not read as "muted".
  it('treats a non-false value as enabled', async () => {
    for (const value of [true, null, undefined, 'false', 0]) {
      dbMock.reset();
      dbMock.queueRows([{ settings: { reactions: value } }]);
      expect(await pushAllowed('u1', 'reaction'), String(value)).toBe(true);
    }
  });
});
