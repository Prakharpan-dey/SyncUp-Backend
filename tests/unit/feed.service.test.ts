import { describe, it, expect, beforeEach, vi } from 'vitest';

import { createDbMock, type Row } from '../helpers/db-mock.js';

const dbMock = createDbMock();

vi.mock('../../src/core/db/drizzle.js', () => ({ db: dbMock.db }));
vi.mock('../../src/core/queues/notification.queue.js', () => ({
  enqueueNotification: vi.fn().mockResolvedValue(undefined),
}));

const { FeedService } = await import('../../src/modules/feed/feed.service.js');
const { enqueueNotification } = await import(
  '../../src/core/queues/notification.queue.js'
);

const AUTHOR = 'aaaaaaaa-0000-0000-0000-000000000001';
const VIEWER = 'bbbbbbbb-0000-0000-0000-000000000002';
const OTHER = 'cccccccc-0000-0000-0000-000000000003';
const ITEM = 'dddddddd-0000-0000-0000-000000000004';

/**
 * Queues the reads `react()` performs before it writes:
 *   1. assertCanAccessItem  — the feed item's owner and visibility
 *   2. visibleFriendIds     — the viewer's accepted friendships
 *   3. the locked re-read of the item's reactions array
 */
function arrangeReact(existingReactions: Row[]) {
  dbMock.reset();
  dbMock.queueMany(
    [{ userId: AUTHOR, visibility: 'friends', groupId: null }],
    [{ requesterId: AUTHOR, addresseeId: VIEWER, status: 'accepted' }],
    [{ reactions: existingReactions }],
  );
}

const reaction = (userId: string, emoji: string) => ({
  user_id: userId,
  emoji,
  created_at: '2026-08-31T00:00:00.000Z',
});

describe('FeedService.react — one reaction per user', () => {
  let feed: InstanceType<typeof FeedService>;

  beforeEach(() => {
    vi.clearAllMocks();
    feed = new FeedService();
  });

  it('records the first reaction', async () => {
    arrangeReact([]);
    const result = await feed.react(ITEM, VIEWER, '❤️');
    expect(result).toEqual({ reacted: true, reaction_count: 1 });
  });

  it('removes the reaction when the same emoji is sent again', async () => {
    arrangeReact([reaction(VIEWER, '❤️')]);
    expect(await feed.react(ITEM, VIEWER, '❤️')).toEqual({
      reacted: false,
      reaction_count: 0,
    });
  });

  it('replaces rather than adds when the emoji changes', async () => {
    arrangeReact([reaction(VIEWER, '❤️')]);
    // Still reacted, still one entry — swapping emoji is not a second vote.
    expect(await feed.react(ITEM, VIEWER, '🔥')).toEqual({
      reacted: true,
      reaction_count: 1,
    });
  });

  it('leaves other people’s reactions untouched', async () => {
    arrangeReact([reaction(OTHER, '❤️')]);
    expect(await feed.react(ITEM, VIEWER, '❤️')).toEqual({
      reacted: true,
      reaction_count: 2,
    });
  });

  it('removing yours keeps everyone else’s', async () => {
    arrangeReact([reaction(OTHER, '❤️'), reaction(VIEWER, '❤️')]);
    expect(await feed.react(ITEM, VIEWER, '❤️')).toEqual({
      reacted: false,
      reaction_count: 1,
    });
  });

  // The regression this whole change exists for: reacting used to append
  // unconditionally, so one user tapping five times scored 5.
  it('never lets one user drive the count above 1 on their own', async () => {
    const seen = new Set<number>();
    let stored: Row[] = [];

    for (let i = 0; i < 10; i++) {
      arrangeReact(stored);
      const r = await feed.react(ITEM, VIEWER, '❤️');
      seen.add(r.reaction_count);
      stored = r.reacted ? [reaction(VIEWER, '❤️')] : [];
    }

    expect([...seen].sort()).toEqual([0, 1]);
  });

  it('writes a count equal to the number of stored reactions', async () => {
    arrangeReact([reaction(OTHER, '❤️')]);
    await feed.react(ITEM, VIEWER, '❤️');

    const update = dbMock.trace.find((c) => c.method === 'set');
    const payload = update?.args[0] as { reactions: Row[]; reactionCount: number };
    expect(payload.reactionCount).toBe(payload.reactions.length);
  });

  // The count is derived from the array, so two concurrent reactions must not
  // both compute it from the same stale copy.
  it('takes a row lock before the read-modify-write', async () => {
    arrangeReact([]);
    await feed.react(ITEM, VIEWER, '❤️');
    expect(dbMock.called('transaction')).toBe(true);
    expect(dbMock.called('for')).toBe(true);
  });
});

describe('FeedService.react — notifications', () => {
  beforeEach(() => vi.clearAllMocks());

  /**
   * notifyOwner is deliberately fire-and-forget — a queue hiccup must not fail
   * the reaction the user just made — so the call happens after react()
   * resolves. Yielding the event loop lets it land before we assert.
   *
   * It reads the item's owner and the actor's display name, so both rows have
   * to be queued behind the reaction reads — and behind the UPDATE, which is
   * awaited and therefore drains a slot of its own.
   */
  const settle = () => new Promise((r) => setTimeout(r, 0));

  /** The awaited UPDATE, then notifyOwner's owner and actor lookups. */
  const arrangeNotify = (ownerId: string) =>
    dbMock.queueMany([], [{ ownerId }], [{ displayName: 'Viewer' }]);

  it('notifies the author of a genuinely new reaction', async () => {
    arrangeReact([]);
    arrangeNotify(AUTHOR);

    await new FeedService().react(ITEM, VIEWER, '❤️');
    await settle();

    expect(enqueueNotification).toHaveBeenCalledTimes(1);
    expect(enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: AUTHOR, type: 'reaction' }),
    );
  });

  it('stays quiet when the reaction is being withdrawn', async () => {
    arrangeReact([reaction(VIEWER, '❤️')]);
    await new FeedService().react(ITEM, VIEWER, '❤️');
    await settle();
    expect(enqueueNotification).not.toHaveBeenCalled();
  });

  it('stays quiet when only the emoji changed', async () => {
    arrangeReact([reaction(VIEWER, '❤️')]);
    await new FeedService().react(ITEM, VIEWER, '🔥');
    await settle();
    expect(enqueueNotification).not.toHaveBeenCalled();
  });

  it('does not notify you about your own reaction', async () => {
    arrangeReact([]);
    // The item's owner is the actor, so notifyOwner must bail out.
    arrangeNotify(VIEWER);

    await new FeedService().react(ITEM, VIEWER, '❤️');
    await settle();

    expect(enqueueNotification).not.toHaveBeenCalled();
  });
});

describe('FeedService.react — access control', () => {
  beforeEach(() => vi.clearAllMocks());

  it('404s on an unknown feed item', async () => {
    dbMock.reset();
    dbMock.queueRows([]);
    await expect(new FeedService().react(ITEM, VIEWER, '❤️')).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  // 404 rather than 403 so feed item ids cannot be probed for existence.
  it('404s — not 403 — when the item is not visible to this viewer', async () => {
    dbMock.reset();
    dbMock.queueMany(
      [{ userId: AUTHOR, visibility: 'friends', groupId: null }],
      [], // no friendship between viewer and author
    );
    await expect(new FeedService().react(ITEM, VIEWER, '❤️')).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
