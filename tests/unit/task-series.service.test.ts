import { describe, it, expect, beforeEach, vi } from 'vitest';

import { createDbMock } from '../helpers/db-mock.js';

const dbMock = createDbMock();
vi.mock('../../src/core/db/drizzle.js', () => ({ db: dbMock.db }));

const { TaskSeriesService, serializeSeries } = await import(
  '../../src/modules/task-series/task-series.service.js'
);
const service = new TaskSeriesService();

const STAMPS = { createdAt: new Date(), updatedAt: new Date() };

const row = (over: Record<string, unknown> = {}) => ({
  id: 's1', userId: 'u1', title: 'Take medicine', description: null,
  priority: 'medium', tags: null, weekdays: '1,2,3,4,5,6,7', dueTime: '09:00',
  startsOn: '2026-09-04', endsOn: null, active: true, generatedThrough: null,
  ...STAMPS, ...over,
});

beforeEach(() => dbMock.reset());

describe('serializeSeries', () => {
  /**
   * It is a module-level function precisely so this holds. `TasksService.serialize`
   * is a private method used as a bare `.map(this.serialize)` callback and works
   * only because it happens to touch nothing on `this` — a helper that did would
   * throw here.
   */
  it('survives being used as a bare callback', () => {
    expect(() => [row(), row({ id: 's2' })].map(serializeSeries)).not.toThrow();
  });

  it('renames every field to the wire shape', () => {
    expect(serializeSeries(row() as never)).toMatchObject({
      id: 's1',
      user_id: 'u1',
      weekdays: '1,2,3,4,5,6,7',
      due_time: '09:00',
      starts_on: '2026-09-04',
      active: true,
    });
  });

  it('defaults absent tags to an empty list rather than null', () => {
    expect(serializeSeries(row() as never).tags).toEqual([]);
  });
});

describe('creating a series', () => {
  it('stores the rule against the caller', async () => {
    dbMock.queueRows([row()]);
    await service.createSeries('u1', {
      title: 'Take medicine', weekdays: '1,2,3,4,5,6,7',
      due_time: '09:00', starts_on: '2026-09-04',
    });

    const values = dbMock.trace.find((c) => c.method === 'values')?.args[0] as Record<string, unknown>;
    expect(values).toMatchObject({
      userId: 'u1', weekdays: '1,2,3,4,5,6,7', dueTime: '09:00', startsOn: '2026-09-04',
    });
  });

  // The offline outbox retries, so the same create arrives twice.
  it('treats a replayed create as success, not a conflict', async () => {
    dbMock.queueMany([], [row()]);

    const result = await service.createSeries('u1', {
      id: 's1', title: 'Take medicine', weekdays: '1', starts_on: '2026-09-04',
    });
    expect(result.id).toBe('s1');
    expect(dbMock.called('onConflictDoNothing')).toBe(true);
  });

  it('refuses an id that belongs to someone else', async () => {
    dbMock.queueMany([], []);

    await expect(service.createSeries('u1', {
      id: 's1', title: 'Take medicine', weekdays: '1', starts_on: '2026-09-04',
    })).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('changing a series', () => {
  it('copies only the fields supplied', async () => {
    dbMock.queueRows([row({ weekdays: '1,3,5' })]);
    await service.updateSeries('s1', 'u1', { weekdays: '1,3,5' });

    const set = dbMock.trace.find((c) => c.method === 'set')?.args[0] as Record<string, unknown>;
    expect(set).toHaveProperty('weekdays', '1,3,5');
    expect(set).not.toHaveProperty('title');
  });

  // Stopping a series keeps the row, so completed occurrences still point at
  // something that explains where they came from.
  it('can deactivate without deleting', async () => {
    dbMock.queueRows([row({ active: false })]);
    const updated = await service.updateSeries('s1', 'u1', { active: false });

    expect(updated.active).toBe(false);
  });

  it('404s on someone else\u2019s series', async () => {
    dbMock.queueRows([]);
    await expect(service.updateSeries('s1', 'u2', { title: 'x' }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('404s when deleting a series that is not yours', async () => {
    dbMock.queueRows([]);
    await expect(service.deleteSeries('s1', 'u2')).rejects.toMatchObject({ statusCode: 404 });
  });
});
