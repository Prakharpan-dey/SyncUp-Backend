import { describe, it, expect, beforeEach, vi } from 'vitest';

import { createDbMock } from '../helpers/db-mock.js';

const dbMock = createDbMock();
vi.mock('../../src/core/db/drizzle.js', () => ({ db: dbMock.db }));

const enqueueFeedItem = vi.fn(async () => undefined);
vi.mock('../../src/core/queues/feed.queue.js', () => ({ enqueueFeedItem }));

const { TasksService, effectiveSharing } = await import(
  '../../src/modules/tasks/tasks.service.js'
);
const tasksService = new TasksService();

const TITLE = 'Therapy appointment';
const STAMPS = { createdAt: new Date(), updatedAt: new Date() };

/**
 * Queues the reads a completing toggle makes: the task, the updated row, then
 * the owner's account default.
 */
function arrange(accountDefault: string, sharingOverride: string | null) {
  const row = {
    id: 't1', userId: 'u1', title: TITLE, sharingOverride, ...STAMPS,
  };
  dbMock.queueMany(
    [{ ...row, status: 'pending' }],
    [{ ...row, status: 'completed' }],
    [{ displayName: 'Rhea', sharing: accountDefault }],
  );
}

/** publishCompletion is fire-and-forget, so let its microtasks drain. */
const settle = () => new Promise((r) => setTimeout(r, 0));

const published = () =>
  enqueueFeedItem.mock.calls[0]?.[0] as unknown as Record<string, unknown>;

beforeEach(() => {
  dbMock.reset();
  enqueueFeedItem.mockClear();
});

describe('a per-task sharing override', () => {
  /**
   * The bug this fixes. `sharing_override` was accepted on create and update,
   * returned by the API and modelled in the client — but publishCompletion only
   * ever read the account default, so marking one task "do not share" did
   * nothing and it was published like any other.
   */
  it('keeps a task private even when the account shares everything', async () => {
    arrange('all', 'none');
    await tasksService.toggleTask('t1', 'u1');
    await settle();

    expect(enqueueFeedItem).not.toHaveBeenCalled();
  });

  it('hides the title when the task asks for summary only', async () => {
    arrange('all', 'summary');
    await tasksService.toggleTask('t1', 'u1');
    await settle();

    expect(published().title).toBe('Completed a task');
    expect(JSON.stringify(published())).not.toContain('Therapy');
  });

  /// An override can also loosen: a private-by-default account can still choose
  /// to share one particular thing.
  it('can share one task from an otherwise summary-only account', async () => {
    arrange('summary', 'all');
    await tasksService.toggleTask('t1', 'u1');
    await settle();

    expect(published().title).toBe(TITLE);
  });

  it('publishes nothing when the account shares nothing and the task inherits',
    async () => {
      arrange('none', 'inherit');
      await tasksService.toggleTask('t1', 'u1');
      await settle();

      expect(enqueueFeedItem).not.toHaveBeenCalled();
    });
});

describe('falling back to the account default', () => {
  it('inherits when the override is null', async () => {
    arrange('summary', null);
    await tasksService.toggleTask('t1', 'u1');
    await settle();

    expect(published().title).toBe('Completed a task');
  });

  it('inherits when the override is the literal inherit', async () => {
    arrange('all', 'inherit');
    await tasksService.toggleTask('t1', 'u1');
    await settle();

    expect(published().title).toBe(TITLE);
  });
});

describe('the resolution rule itself', () => {
  it.each([
    ['none', 'all', 'none'],
    ['summary', 'all', 'summary'],
    ['all', 'none', 'all'],
    ['inherit', 'summary', 'summary'],
    [null, 'none', 'none'],
    [undefined, 'all', 'all'],
  ])('override %s over default %s resolves to %s', (override, def, expected) => {
    expect(effectiveSharing(override as string | null, def)).toBe(expected);
  });

  /**
   * A retired value with no per-task selection model behind it. It always
   * behaved as `all`; resolving it to anything else would silently change what
   * existing rows publish.
   */
  it('treats the retired selected value as all, as it always behaved', () => {
    expect(effectiveSharing('selected', 'none')).toBe('all');
  });

  it('never returns anything outside the three real modes', () => {
    for (const v of ['nonsense', '', 'ALL', 'Summary']) {
      expect(['none', 'summary', 'all']).toContain(effectiveSharing(v, 'summary'));
    }
  });
});
