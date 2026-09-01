import { describe, it, expect, beforeEach, vi } from 'vitest';

import { createDbMock } from '../helpers/db-mock.js';

const dbMock = createDbMock();
vi.mock('../../src/core/db/drizzle.js', () => ({ db: dbMock.db }));

const enqueueFeedItem = vi.fn(async () => undefined);
vi.mock('../../src/core/queues/feed.queue.js', () => ({ enqueueFeedItem }));

const { TasksService } = await import('../../src/modules/tasks/tasks.service.js');
const tasksService = new TasksService();

const TITLE = 'Finish DBMS assignment';

/** serialize() reads these off every row it returns. */
const STAMPS = { createdAt: new Date(), updatedAt: new Date() };

/**
 * Queues the reads a completing toggle makes: the task, the updated row, then
 * the owner's sharing preference.
 */
function arrangeCompletion(sharing: string) {
  dbMock.queueMany(
    [{ id: 't1', userId: 'u1', title: TITLE, status: 'pending', ...STAMPS }],
    [{ id: 't1', userId: 'u1', title: TITLE, status: 'completed', ...STAMPS }],
    [{ displayName: 'Rhea', sharing }],
  );
}

/** publishCompletion is fire-and-forget, so let its microtasks drain. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  dbMock.reset();
  enqueueFeedItem.mockClear();
});

describe('what each sharing mode publishes', () => {
  it('none publishes nothing at all', async () => {
    arrangeCompletion('none');
    await tasksService.toggleTask('t1', 'u1');
    await settle();

    expect(enqueueFeedItem).not.toHaveBeenCalled();
  });

  it('summary announces the completion without naming the task', async () => {
    arrangeCompletion('summary');
    await tasksService.toggleTask('t1', 'u1');
    await settle();

    expect(enqueueFeedItem).toHaveBeenCalledTimes(1);
    const item = enqueueFeedItem.mock.calls[0][0] as Record<string, unknown>;
    expect(item.title).toBe('Completed a task');
    expect(JSON.stringify(item)).not.toContain('DBMS');
  });

  it('all names the task', async () => {
    arrangeCompletion('all');
    await tasksService.toggleTask('t1', 'u1');
    await settle();

    expect(enqueueFeedItem).toHaveBeenCalledTimes(1);
    expect(enqueueFeedItem.mock.calls[0][0]).toMatchObject({
      title: TITLE,
      actorName: 'Rhea',
      type: 'task_completed',
    });
  });
});

describe('the removed mode', () => {
  /**
   * This is why it was dropped: 'selected' promised per-task granularity, but
   * publishCompletion only branches on 'none' and 'summary', so it fell through
   * and leaked the full title exactly as 'all' does. Anyone who picked it was
   * sharing more than the label implied.
   */
  it('behaved identically to all, which is what made it misleading', async () => {
    arrangeCompletion('selected');
    await tasksService.toggleTask('t1', 'u1');
    await settle();

    expect(enqueueFeedItem.mock.calls[0][0]).toMatchObject({ title: TITLE });
  });

  it('can no longer be set through the API', async () => {
    const { updateProfileSchema } = await import(
      '../../src/modules/users/users.schema.js'
    );
    expect(
      updateProfileSchema.safeParse({ privacy_sharing_default: 'selected' }).success,
    ).toBe(false);
  });

  it('leaves the three real modes accepted', async () => {
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

describe('completion publishing in general', () => {
  it('publishes nothing when un-completing a task', async () => {
    dbMock.queueMany(
      [{ id: 't1', userId: 'u1', title: TITLE, status: 'completed', ...STAMPS }],
      [{ id: 't1', userId: 'u1', title: TITLE, status: 'pending', ...STAMPS }],
    );
    await tasksService.toggleTask('t1', 'u1');
    await settle();

    expect(enqueueFeedItem).not.toHaveBeenCalled();
  });

  // The toggle is the user's action; the feed item is a side effect of it.
  it('does not fail the toggle when the queue is down', async () => {
    arrangeCompletion('all');
    enqueueFeedItem.mockRejectedValueOnce(new Error('redis unreachable'));

    const result = await tasksService.toggleTask('t1', 'u1');
    await settle();

    expect(result).toMatchObject({ id: 't1' });
  });
});
