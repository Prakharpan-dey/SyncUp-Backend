import { describe, it, expect, beforeEach, vi } from 'vitest';

import { createDbMock } from '../helpers/db-mock.js';

const dbMock = createDbMock();
vi.mock('../../src/core/db/drizzle.js', () => ({ db: dbMock.db }));

const { createFeedItems } = await import('../../src/workers/feed.processor.js');
const { feedItems } = await import('../../src/core/db/schema/index.js');

const USER = '11111111-0000-0000-0000-000000000001';
const TASK = '22222222-0000-0000-0000-000000000002';

const job = (over: Record<string, unknown> = {}) => ({
  userId: USER,
  actorName: 'Rhea',
  type: 'task_completed' as const,
  title: 'Completed a task',
  metadata: { task_id: TASK },
  ...over,
});

const inserts = () => dbMock.trace.filter((c) => c.method === 'insert').map((c) => c.args[0]);

beforeEach(() => dbMock.reset());

/** Ticking and un-ticking used to add a post every time. */
describe('posting a completed task', () => {
  it('posts once, plus a copy for each group', async () => {
    dbMock.queueMany(
      [{ status: 'completed' }], // the task is still done
      [],                        // no post for it yet
      [{ groupId: 'g1' }],       // one group
    );

    expect(await createFeedItems(job())).toBe(2);
    expect(inserts()).toEqual([feedItems]);
  });

  it('skips a task that already has its post', async () => {
    dbMock.queueMany([{ status: 'completed' }], [{ id: 'post-1' }]);

    expect(await createFeedItems(job())).toBe(0);
    expect(dbMock.called('insert')).toBe(false);
  });

  /** The job can run after the task was already un-ticked. */
  it('skips a task that is no longer done', async () => {
    dbMock.queueRows([{ status: 'pending' }]);

    expect(await createFeedItems(job())).toBe(0);
    expect(dbMock.called('insert')).toBe(false);
  });

  it('skips a task that has since been deleted', async () => {
    dbMock.queueRows([]);
    expect(await createFeedItems(job())).toBe(0);
  });

  it('posts other kinds without the task checks', async () => {
    dbMock.queueRows([]); // no groups
    expect(await createFeedItems(job({ type: 'streak_milestone', metadata: { days: 7 } }))).toBe(1);
    expect(dbMock.trace.filter((c) => c.method === 'select')).toHaveLength(1);
  });
});
