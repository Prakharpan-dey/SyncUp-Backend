import { describe, it, expect, beforeEach, vi } from 'vitest';

import { createDbMock } from '../helpers/db-mock.js';

const dbMock = createDbMock();

vi.mock('../../src/core/db/drizzle.js', () => ({ db: dbMock.db }));
vi.mock('../../src/core/queues/notification.queue.js', () => ({
  enqueueNotification: vi.fn().mockResolvedValue(undefined),
}));

const { FeedService } = await import('../../src/modules/feed/feed.service.js');
const { enqueueNotification } = await import(
  '../../src/core/queues/notification.queue.js'
);
const { feedItems, feedReactions } = await import('../../src/core/db/schema/index.js');

const AUTHOR = 'aaaaaaaa-0000-0000-0000-000000000001';
const VIEWER = 'bbbbbbbb-0000-0000-0000-000000000002';
const ITEM = 'dddddddd-0000-0000-0000-000000000004';

/**
 * Queues the reads `react()` makes before it writes:
 *   1. the access check — one row means "you may see this post"
 *   2. your own reaction row on it, if any (locked)
 */
function arrangeReact(mine: { emoji: string } | null) {
  dbMock.reset();
  dbMock.queueMany([{ '?column?': 1 }], mine ? [mine] : []);
}

/** Which table each write in the trace was aimed at. */
const writesTo = (method: 'insert' | 'update' | 'delete') =>
  dbMock.trace.filter((c) => c.method === method).map((c) => c.args[0]);

/** notifyOwner is fire-and-forget; yield so it lands before asserting. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('FeedService.react — one reaction per person', () => {
  let feed: InstanceType<typeof FeedService>;
  beforeEach(() => {
    vi.clearAllMocks();
    feed = new FeedService();
  });

  it('records the first reaction as a row and bumps the count', async () => {
    arrangeReact(null);
    dbMock.queueMany([{ userId: VIEWER }], [{ reactionCount: 1 }]);

    expect(await feed.react(ITEM, VIEWER, '❤️')).toEqual({ reacted: true, reaction_count: 1 });
    expect(writesTo('insert')).toEqual([feedReactions]);
    expect(writesTo('update')).toEqual([feedItems]);
  });

  it('removes the row when the same emoji is sent again', async () => {
    arrangeReact({ emoji: '❤️' });
    dbMock.queueMany([{ userId: VIEWER }], [{ reactionCount: 0 }]);

    expect(await feed.react(ITEM, VIEWER, '❤️')).toEqual({ reacted: false, reaction_count: 0 });
    expect(writesTo('delete')).toEqual([feedReactions]);
    expect(dbMock.called('insert')).toBe(false);
  });

  it('swaps the emoji without counting a second vote', async () => {
    arrangeReact({ emoji: '❤️' });
    dbMock.queueMany([], [{ reactionCount: 1 }]);

    expect(await feed.react(ITEM, VIEWER, '🔥')).toEqual({ reacted: true, reaction_count: 1 });
    // Only the emoji changes; the post's count is not touched.
    expect(writesTo('update')).toEqual([feedReactions]);
    expect(dbMock.called('insert')).toBe(false);
  });

  it('locks your reaction row inside a transaction', async () => {
    arrangeReact(null);
    dbMock.queueMany([{ userId: VIEWER }], [{ reactionCount: 1 }]);

    await feed.react(ITEM, VIEWER, '❤️');
    expect(dbMock.called('transaction')).toBe(true);
    expect(dbMock.called('for')).toBe(true);
  });

  /** Reacting used to read and rewrite the post's whole reactions array. */
  it('never writes the old reactions array', async () => {
    arrangeReact(null);
    dbMock.queueMany([{ userId: VIEWER }], [{ reactionCount: 1 }]);

    await feed.react(ITEM, VIEWER, '❤️');
    const setKeys = dbMock.trace
      .filter((c) => c.method === 'set')
      .flatMap((c) => Object.keys(c.args[0] as object));
    expect(setKeys).not.toContain('reactions');
  });
});

describe('FeedService.react — notifications', () => {
  beforeEach(() => vi.clearAllMocks());

  /** notifyOwner's owner and actor lookups, queued behind react's own reads. */
  const arrangeNotify = (ownerId: string) =>
    dbMock.queueMany([{ ownerId }], [{ displayName: 'Viewer' }]);

  it('notifies the author of a genuinely new reaction', async () => {
    arrangeReact(null);
    dbMock.queueMany([{ userId: VIEWER }], [{ reactionCount: 1 }]);
    arrangeNotify(AUTHOR);

    await new FeedService().react(ITEM, VIEWER, '❤️');
    await settle();

    expect(enqueueNotification).toHaveBeenCalledTimes(1);
    expect(enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: AUTHOR, type: 'reaction' }),
    );
  });

  /** The double-tap race: the second insert hits the primary key. */
  it('stays quiet when the insert lost a race, and counts nothing', async () => {
    arrangeReact(null);
    dbMock.queueMany([], [{ reactionCount: 1 }]);

    expect(await new FeedService().react(ITEM, VIEWER, '❤️'))
      .toEqual({ reacted: true, reaction_count: 1 });
    await settle();
    expect(enqueueNotification).not.toHaveBeenCalled();
  });

  it('stays quiet when the reaction is being withdrawn', async () => {
    arrangeReact({ emoji: '❤️' });
    dbMock.queueMany([{ userId: VIEWER }], [{ reactionCount: 0 }]);
    await new FeedService().react(ITEM, VIEWER, '❤️');
    await settle();
    expect(enqueueNotification).not.toHaveBeenCalled();
  });

  it('stays quiet when only the emoji changed', async () => {
    arrangeReact({ emoji: '❤️' });
    dbMock.queueMany([], [{ reactionCount: 1 }]);
    await new FeedService().react(ITEM, VIEWER, '🔥');
    await settle();
    expect(enqueueNotification).not.toHaveBeenCalled();
  });

  it('does not notify you about your own reaction', async () => {
    arrangeReact(null);
    dbMock.queueMany([{ userId: VIEWER }], [{ reactionCount: 1 }]);
    // The post's owner is the actor, so notifyOwner must bail out.
    arrangeNotify(VIEWER);

    await new FeedService().react(ITEM, VIEWER, '❤️');
    await settle();
    expect(enqueueNotification).not.toHaveBeenCalled();
  });
});

describe('FeedService.react — access control', () => {
  beforeEach(() => vi.clearAllMocks());

  // One query answers both "no such post" and "not yours to see", and both get
  // 404 rather than 403 so post ids cannot be probed for existence.
  it('404s when the post is unknown or not visible to this viewer', async () => {
    dbMock.reset();
    dbMock.queueRows([]);

    await expect(new FeedService().react(ITEM, VIEWER, '❤️'))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(dbMock.called('transaction')).toBe(false);
  });

  it('checks access in a single query', async () => {
    arrangeReact(null);
    dbMock.queueMany([{ userId: VIEWER }], [{ reactionCount: 1 }]);

    await new FeedService().react(ITEM, VIEWER, '❤️');
    const beforeTx = dbMock.trace.slice(0, dbMock.trace.findIndex((c) => c.method === 'transaction'));
    expect(beforeTx.map((c) => c.method)).toEqual(['execute']);
  });
});
