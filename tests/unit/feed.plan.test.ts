import { describe, it, expect, beforeEach, vi } from 'vitest';

import { createDbMock } from '../helpers/db-mock.js';

const dbMock = createDbMock();
vi.mock('../../src/core/db/drizzle.js', () => ({ db: dbMock.db }));

const enqueueNotification = vi.fn(async () => undefined);
vi.mock('../../src/core/queues/notification.queue.js', () => ({ enqueueNotification }));

const { FeedService } = await import('../../src/modules/feed/feed.service.js');
const service = new FeedService();

/** serializePlan reads this off the row it returns. */
const STAMPS = { createdAt: new Date() };

const author = (sharing = 'all') => ({ displayName: 'Rhea', sharing });

const storedRow = (over: Record<string, unknown> = {}) => ({
  id: 'f1', userId: 'u1', actorName: 'Rhea', type: 'daily_plan',
  title: "Shared today's plan", summary: '1 of 2 done', metadata: {},
  visibility: 'friends', groupId: null, reactionCount: 0, ...STAMPS, ...over,
});

const plan = (items: { title: string; done: boolean }[]) => ({
  date: '2026-09-05',
  items,
});

const twoTasks = [
  { title: 'Finish DBMS assignment', done: true },
  { title: 'Take medicine', done: false },
];

const valuesArg = () =>
  dbMock.trace.find((c) => c.method === 'values')?.args[0] as Record<string, unknown>;

beforeEach(() => dbMock.reset());

describe('who a shared plan reaches', () => {
  /**
   * The single most important assertion here. The feed worker fans out one row
   * per group the author belongs to, so publishing a plan through the queue
   * would put the user's whole day in front of every group they are in. This
   * writes one row directly, and it must stay friends-only.
   */
  it('is written friends-only, never to a group', async () => {
    dbMock.queueMany([author()], [], [storedRow()]);
    await service.shareDailyPlan('u1', plan(twoTasks));

    expect(valuesArg()).toMatchObject({ visibility: 'friends', groupId: null });
  });

  it('writes exactly one row', async () => {
    dbMock.queueMany([author()], [], [storedRow()]);
    await service.shareDailyPlan('u1', plan(twoTasks));

    expect(dbMock.trace.filter((c) => c.method === 'insert')).toHaveLength(1);
  });
});

describe('what the card carries', () => {
  it('records the tasks and how many are done', async () => {
    dbMock.queueMany([author()], [], [storedRow()]);
    await service.shareDailyPlan('u1', plan(twoTasks));

    expect(valuesArg()).toMatchObject({
      type: 'daily_plan',
      summary: '1 of 2 done',
      metadata: {
        date: '2026-09-05',
        total: 2,
        done: 1,
        items: twoTasks,
      },
    });
  });

  it('names the author so the card reads without a join', async () => {
    dbMock.queueMany([author()], [], [storedRow()]);
    await service.shareDailyPlan('u1', plan(twoTasks));

    expect(valuesArg()).toMatchObject({ actorName: 'Rhea' });
  });

  // Cut at ten, friends saw "+2 more" on a twelve-task day shared in full.
  it('carries every task, not the first ten', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      title: `Task $${i}`,
      done: false,
    }));
    dbMock.queueMany([author()], [], [storedRow()]);
    await service.shareDailyPlan('u1', plan(many));

    const metadata = valuesArg().metadata as Record<string, unknown>;
    expect(metadata.items).toEqual(many);
    expect(metadata.total).toBe(25);
  });
});

describe('re-sharing the same day', () => {
  /// Otherwise a feed fills up with one person refreshing their plan.
  it('updates the existing card instead of posting a second', async () => {
    dbMock.queueMany([author()], [{ id: 'f1' }], [storedRow({ summary: '2 of 2 done' })]);
    await service.shareDailyPlan('u1', plan(twoTasks));

    expect(dbMock.called('update')).toBe(true);
    expect(dbMock.called('insert')).toBe(false);
  });

  it('refreshes the counts on the existing card', async () => {
    dbMock.queueMany([author()], [{ id: 'f1' }], [storedRow()]);
    await service.shareDailyPlan('u1', plan([
      { title: 'Finish DBMS assignment', done: true },
      { title: 'Take medicine', done: true },
    ]));

    const set = dbMock.trace.find((c) => c.method === 'set')?.args[0] as Record<string, unknown>;
    expect(set).toMatchObject({ summary: '2 of 2 done' });
  });

  it('posts a new card when no plan exists for that day', async () => {
    dbMock.queueMany([author()], [], [storedRow()]);
    await service.shareDailyPlan('u1', plan(twoTasks));

    expect(dbMock.called('insert')).toBe(true);
    expect(dbMock.called('update')).toBe(false);
  });
});

describe('privacy', () => {
  /// Someone who chose to share nothing should not be able to publish a whole
  /// day, even deliberately — the client also hides the action.
  it('refuses when sharing is turned off', async () => {
    dbMock.queueRows([author('none')]);

    await expect(service.shareDailyPlan('u1', plan(twoTasks)))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  /**
   * 'summary' hides task titles on *automatic* completion posts. Sharing a plan
   * is explicit and previewed — the user is looking at the titles as they
   * confirm — so it publishes them.
   */
  it('keeps the titles under summary sharing, because this is opt-in', async () => {
    dbMock.queueMany([author('summary')], [], [storedRow()]);
    await service.shareDailyPlan('u1', plan(twoTasks));

    const metadata = valuesArg().metadata as Record<string, unknown>;
    expect(JSON.stringify(metadata)).toContain('Finish DBMS assignment');
  });

  it('404s for a user that does not exist', async () => {
    dbMock.queueRows([]);

    await expect(service.shareDailyPlan('nobody', plan(twoTasks)))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('the request shape', () => {
  it('rejects an empty plan and an oversized one', async () => {
    const { sharePlanSchema } = await import('../../src/modules/feed/feed.schema.js');

    expect(sharePlanSchema.safeParse({ date: '2026-09-05', items: [] }).success).toBe(false);
    expect(sharePlanSchema.safeParse({
      date: '2026-09-05',
      items: Array.from({ length: 201 }, () => ({ title: 'x', done: false })),
    }).success).toBe(false);
  });

  it('rejects a malformed date', async () => {
    const { sharePlanSchema } = await import('../../src/modules/feed/feed.schema.js');

    expect(sharePlanSchema.safeParse({ date: '05-09-2026', items: twoTasks }).success)
      .toBe(false);
  });

  it('accepts a well-formed plan', async () => {
    const { sharePlanSchema } = await import('../../src/modules/feed/feed.schema.js');

    expect(sharePlanSchema.safeParse(plan(twoTasks)).success).toBe(true);
    // A busy day of more than fifty tasks was rejected outright.
    const busyDay = Array.from({ length: 60 }, (_, i) => ({ title: `Task ${i}`, done: false }));
    expect(sharePlanSchema.safeParse(plan(busyDay)).success).toBe(true);
  });
});
