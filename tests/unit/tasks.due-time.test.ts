import { describe, it, expect, beforeEach, vi } from 'vitest';

import { createDbMock } from '../helpers/db-mock.js';

const dbMock = createDbMock();
vi.mock('../../src/core/db/drizzle.js', () => ({ db: dbMock.db }));

const enqueueFeedItem = vi.fn(async () => undefined);
vi.mock('../../src/core/queues/feed.queue.js', () => ({ enqueueFeedItem }));

const { TasksService } = await import('../../src/modules/tasks/tasks.service.js');
const tasksService = new TasksService();

/** serialize() reads these off every row it returns. */
const STAMPS = { createdAt: new Date(), updatedAt: new Date() };

const valuesArg = () =>
  dbMock.trace.find((c) => c.method === 'values')?.args[0] as Record<string, unknown>;

beforeEach(() => dbMock.reset());

describe('a due time on the way in', () => {
  it('is persisted on create', async () => {
    dbMock.queueRows([{ id: 't1', title: 'Take medicine', ...STAMPS }]);
    await tasksService.createTask('u1', { title: 'Take medicine', due_time: '09:00' });

    expect(valuesArg()).toMatchObject({ dueTime: '09:00' });
  });

  it('carries the series it came from', async () => {
    dbMock.queueRows([{ id: 't1', title: 'Take medicine', ...STAMPS }]);
    await tasksService.createTask('u1', {
      title: 'Take medicine', due_time: '09:00', series_id: 's1',
    });

    expect(valuesArg()).toMatchObject({ dueTime: '09:00', seriesId: 's1' });
  });

  // The allowlist in updateTask uses `!== undefined` for these, not a truthy
  // check, so a client can clear a time rather than only ever setting one.
  it('is copied by the update allowlist', async () => {
    dbMock.queueRows([{ id: 't1', title: 'Take medicine', ...STAMPS }]);
    await tasksService.updateTask('t1', 'u1', { due_time: '21:30' });

    const set = dbMock.trace.find((c) => c.method === 'set')?.args[0] as Record<string, unknown>;
    expect(set).toMatchObject({ dueTime: '21:30' });
  });
});

describe('a due time on the way out', () => {
  it('is serialized for the client', async () => {
    dbMock.queueRows([{
      id: 't1', userId: 'u1', title: 'Take medicine',
      dueDate: '2026-09-04', dueTime: '09:00', seriesId: 's1',
      priority: 'medium', status: 'pending', ...STAMPS,
    }]);

    const [task] = await tasksService.listTasks('u1');
    expect(task).toMatchObject({ due_time: '09:00', series_id: 's1' });
  });

  it('is null on a task that has none', async () => {
    dbMock.queueRows([{
      id: 't1', userId: 'u1', title: 'Pay rent',
      dueTime: null, seriesId: null,
      priority: 'medium', status: 'pending', ...STAMPS,
    }]);

    const [task] = await tasksService.listTasks('u1');
    expect(task.due_time).toBeNull();
    expect(task.series_id).toBeNull();
  });
});
