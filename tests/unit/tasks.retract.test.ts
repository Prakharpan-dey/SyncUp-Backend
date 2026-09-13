import { describe, it, expect, beforeEach, vi } from 'vitest';

import { createDbMock } from '../helpers/db-mock.js';

const dbMock = createDbMock();
vi.mock('../../src/core/db/drizzle.js', () => ({ db: dbMock.db }));

const enqueueFeedItem = vi.fn(async () => undefined);
vi.mock('../../src/core/queues/feed.queue.js', () => ({ enqueueFeedItem }));

const { TasksService } = await import('../../src/modules/tasks/tasks.service.js');

const STAMPS = { createdAt: new Date(), updatedAt: new Date() };
const row = (status: string) => ({ id: 't1', userId: 'u1', title: 'Revise DBMS', status, ...STAMPS });
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  dbMock.reset();
  enqueueFeedItem.mockClear();
});

/** Ticking a task on and off used to add a "Completed a task" post every time. */
describe('one feed post per task', () => {
  it('tags the post with its task, so there can only be one', async () => {
    dbMock.queueMany([row('pending')], [row('completed')], [{ displayName: 'Rhea', sharing: 'summary' }]);

    await new TasksService().toggleTask('t1', 'u1');
    await settle();

    expect(enqueueFeedItem).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { task_id: 't1' } }),
    );
  });

  it('takes the post down when the task is un-ticked', async () => {
    dbMock.queueMany([row('completed')], [row('pending')]);

    await new TasksService().toggleTask('t1', 'u1');

    expect(dbMock.called('execute')).toBe(true);
    expect(enqueueFeedItem).not.toHaveBeenCalled();
  });

  it('still un-ticks when taking the post down fails', async () => {
    dbMock.queueMany([row('completed')], [row('pending')]);
    const execute = dbMock.db.execute as unknown as () => unknown;
    (dbMock.db as Record<string, unknown>).execute = () => Promise.reject(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(new TasksService().toggleTask('t1', 'u1')).resolves.toMatchObject({ status: 'pending' });
    } finally {
      (dbMock.db as Record<string, unknown>).execute = execute;
    }
  });
});
