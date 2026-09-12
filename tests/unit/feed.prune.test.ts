import { describe, it, expect, beforeEach, vi } from 'vitest';

import { createDbMock } from '../helpers/db-mock.js';

const dbMock = createDbMock();
vi.mock('../../src/core/db/drizzle.js', () => ({ db: dbMock.db }));

const { pruneFeedItems, FEED_PRUNE_BATCH } = await import('../../src/workers/cleanup.worker.js');

const deleted = (n: number) => Array.from({ length: n }, () => ({ '?column?': 1 }));
const executes = () => dbMock.trace.filter((c) => c.method === 'execute').length;

beforeEach(() => {
  dbMock.reset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('the 30-day feed prune', () => {
  it('deletes in batches until a short one', async () => {
    dbMock.queueMany(deleted(FEED_PRUNE_BATCH), deleted(FEED_PRUNE_BATCH), deleted(3));

    expect(await pruneFeedItems({ pauseMs: 0 })).toBe(2 * FEED_PRUNE_BATCH + 3);
    expect(executes()).toBe(3);
  });

  it('stops after one statement when nothing is old enough', async () => {
    dbMock.queueRows([]);

    expect(await pruneFeedItems({ pauseMs: 0 })).toBe(0);
    expect(executes()).toBe(1);
  });

  it('never runs away, however much is waiting', async () => {
    dbMock.queueMany(deleted(FEED_PRUNE_BATCH), deleted(FEED_PRUNE_BATCH), deleted(FEED_PRUNE_BATCH));

    expect(await pruneFeedItems({ pauseMs: 0, maxBatches: 2 })).toBe(2 * FEED_PRUNE_BATCH);
    expect(executes()).toBe(2);
  });
});
