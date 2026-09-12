import { describe, it, expect, beforeEach, vi } from 'vitest';

import { createDbMock } from '../helpers/db-mock.js';

const dbMock = createDbMock();
vi.mock('../../src/core/db/drizzle.js', () => ({ db: dbMock.db }));
vi.mock('../../src/core/queues/notification.queue.js', () => ({
  enqueueNotification: vi.fn().mockResolvedValue(undefined),
}));

const { FeedService, encodeFeedCursor, decodeFeedCursor } = await import(
  '../../src/modules/feed/feed.service.js'
);

const VIEWER = 'bbbbbbbb-0000-0000-0000-000000000002';

/** A row as the page query returns it. */
const row = (i: number, over: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  user_id: 'aaaaaaaa-0000-0000-0000-000000000001',
  actor_name: 'Rhea',
  actor_photo_url: null,
  type: 'task_completed',
  title: 'Completed a task',
  summary: null,
  metadata: {},
  visibility: 'friends',
  group_id: null,
  group_name: null,
  reaction_count: 2,
  reacted: true,
  created_at_iso: `2026-09-12T07:17:${String(59 - i).padStart(2, '0')}.798Z`,
  created_at_raw: `2026-09-12 07:17:${String(59 - i).padStart(2, '0')}.798123`,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.reset();
});

describe('a feed page', () => {
  /** It used to be two or three round trips: friend ids, posts, group names. */
  it('is one database round trip', async () => {
    dbMock.queueRows([row(1)]);
    await new FeedService().getFeed(VIEWER, 'friends');

    expect(dbMock.trace.map((c) => c.method)).toEqual(['execute']);
  });

  it('keeps the response shape the app reads', async () => {
    dbMock.queueRows([row(1)]);
    const { items } = await new FeedService().getFeed(VIEWER, 'friends');

    expect(items[0]).toEqual({
      id: row(1).id,
      actor_id: row(1).user_id,
      actor_name: 'Rhea',
      actor_photo_url: null,
      type: 'task_completed',
      title: 'Completed a task',
      summary: null,
      metadata: {},
      visibility: 'friends',
      group_id: null,
      group_name: null,
      reaction_count: 2,
      reacted: true,
      created_at: '2026-09-12T07:17:58.798Z',
    });
  });

  it('has no next page when the extra row is not there', async () => {
    dbMock.queueRows([row(1), row(2)]);
    const page = await new FeedService().getFeed(VIEWER, 'friends', undefined, 20);

    expect(page.items).toHaveLength(2);
    expect(page.next_cursor).toBeNull();
  });

  it('points the next page at the last row shown, at full precision', async () => {
    dbMock.queueRows(Array.from({ length: 21 }, (_, i) => row(i + 1)));
    const page = await new FeedService().getFeed(VIEWER, 'friends', undefined, 20);

    expect(page.items).toHaveLength(20);
    expect(decodeFeedCursor(page.next_cursor!)).toEqual({
      at: row(20).created_at_raw,
      id: row(20).id,
    });
  });

  it('serves the groups tab the same way, with the group name', async () => {
    dbMock.queueRows([row(1, { visibility: 'group', group_id: 'g1', group_name: 'DBMS Study Group' })]);
    const { items } = await new FeedService().getFeed(VIEWER, 'groups');

    expect(dbMock.trace.map((c) => c.method)).toEqual(['execute']);
    expect(items[0]).toMatchObject({ group_id: 'g1', group_name: 'DBMS Study Group' });
  });
});

describe('the page cursor', () => {
  it('round-trips a microsecond timestamp and id', () => {
    const at = '2026-09-12 07:17:27.798123';
    const id = '3281affc-eb6f-4e62-93a0-60218304d243';
    expect(decodeFeedCursor(encodeFeedCursor(at, id))).toEqual({ at, id });
  });

  /** An app on the old build sends the bare timestamp mid-deploy. */
  it('still accepts the old bare-timestamp cursor', () => {
    expect(decodeFeedCursor('2026-09-12T07:17:27.798Z')).toEqual({
      at: '2026-09-12T07:17:27.798Z',
      id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
    });
  });

  it('rejects a cursor it did not issue with a 400, not a 500', async () => {
    const tampered = Buffer.from("2026-09-12 07:17:27|'; drop table feed_items;--").toString('base64url');
    expect(() => decodeFeedCursor('not-a-cursor')).toThrow(expect.objectContaining({ statusCode: 400 }));
    await expect(new FeedService().getFeed(VIEWER, 'friends', tampered))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(dbMock.called('execute')).toBe(false);
  });
});
