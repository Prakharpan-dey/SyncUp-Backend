import { describe, it, expect, beforeEach, vi } from 'vitest';

import { createDbMock } from '../helpers/db-mock.js';

const dbMock = createDbMock();
vi.mock('../../src/core/db/drizzle.js', () => ({ db: dbMock.db }));

const enqueueNotification = vi.fn(async () => undefined);
vi.mock('../../src/core/queues/notification.queue.js', () => ({ enqueueNotification }));

const { sendTaskReminders, sendAttendanceWarnings, serverShouldRemind } = await import(
  '../../src/workers/reminder.worker.js'
);

/** A one-off, date-only task: the only kind the server still reminds about. */
const PLAIN = { seriesId: null, dueTime: null };

const day = (offset: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

const enqueued = () =>
  enqueueNotification.mock.calls.map((c) => c[0] as unknown as Record<string, unknown>);

beforeEach(() => {
  dbMock.reset();
  enqueueNotification.mockClear();
});

describe('task reminders', () => {
  it('reminds about a task due today', async () => {
    dbMock.queueMany(
      [{ id: 't1', userId: 'u1', title: 'Finish DBMS assignment', dueDate: day(0), ...PLAIN }],
      [], // nothing reminded yet
    );

    expect(await sendTaskReminders()).toBe(1);
    expect(enqueued()[0]).toMatchObject({
      userId: 'u1',
      type: 'task_reminder',
      title: 'Due today',
      body: 'Finish DBMS assignment',
      metadata: { task_id: 't1' },
    });
  });

  it('distinguishes tomorrow from today in the title', async () => {
    dbMock.queueMany(
      [{ id: 't2', userId: 'u1', title: 'Lab report', dueDate: day(1), ...PLAIN }],
      [],
    );

    await sendTaskReminders();
    expect(enqueued()[0]).toMatchObject({ title: 'Due tomorrow' });
  });

  /// The sweep runs every few hours; without this it would re-notify each time.
  it('never reminds twice about the same task', async () => {
    dbMock.queueMany(
      [{ id: 't1', userId: 'u1', title: 'Finish DBMS assignment', dueDate: day(0), ...PLAIN }],
      [{ taskId: 't1' }], // already sent
    );

    expect(await sendTaskReminders()).toBe(0);
    expect(enqueueNotification).not.toHaveBeenCalled();
  });

  it('reminds only the tasks not already covered', async () => {
    dbMock.queueMany(
      [
        { id: 't1', userId: 'u1', title: 'Already told', dueDate: day(0), ...PLAIN },
        { id: 't2', userId: 'u1', title: 'Not yet told', dueDate: day(0), ...PLAIN },
      ],
      [{ taskId: 't1' }],
    );

    expect(await sendTaskReminders()).toBe(1);
    expect(enqueued()[0]).toMatchObject({ body: 'Not yet told' });
  });

  it('does no work and issues no dedupe query when nothing is due', async () => {
    dbMock.queueRows([]);

    expect(await sendTaskReminders()).toBe(0);
    expect(enqueueNotification).not.toHaveBeenCalled();
    // The early return matters: otherwise the `inArray` below runs on an empty
    // list, which Postgres rejects.
    expect(dbMock.trace.filter((c) => c.method === 'select')).toHaveLength(1);
  });

  // The `where` predicate itself is not assertable: Drizzle builds a circular
  // SQL object that neither serialises nor exposes its operands. What the
  // filter selects is covered behaviourally above — a task dated today is
  // reminded as "Due today", one dated tomorrow as "Due tomorrow".
});

describe('attendance warnings', () => {
  const low = {
    id: 's1', user_id: 'u1', name: 'Thermodynamics',
    threshold_pct: 75, attended_pct: 62,
  };

  it('warns about a subject below its threshold', async () => {
    dbMock.queueMany([low], []);

    expect(await sendAttendanceWarnings()).toBe(1);
    expect(enqueued()[0]).toMatchObject({
      userId: 'u1',
      type: 'attendance_warning',
      title: 'Thermodynamics attendance is low',
      metadata: { subject_id: 's1' },
    });
  });

  it('names both the current and target percentage', async () => {
    dbMock.queueMany([low], []);
    await sendAttendanceWarnings();

    expect(enqueued()[0].body).toBe('You are at 62%, below your 75% target.');
  });

  // Attendance climbs slowly; warning every sweep would be nagging.
  it('stays quiet while the subject is in cooldown', async () => {
    dbMock.queueMany([low], [{ subjectId: 's1' }]);

    expect(await sendAttendanceWarnings()).toBe(0);
    expect(enqueueNotification).not.toHaveBeenCalled();
  });

  it('warns about other subjects while one is cooling down', async () => {
    dbMock.queueMany(
      [low, { ...low, id: 's2', name: 'Signals' }],
      [{ subjectId: 's1' }],
    );

    expect(await sendAttendanceWarnings()).toBe(1);
    expect(enqueued()[0]).toMatchObject({ metadata: { subject_id: 's2' } });
  });

  it('does nothing when every subject is above its threshold', async () => {
    dbMock.queueRows([]);

    expect(await sendAttendanceWarnings()).toBe(0);
    expect(enqueueNotification).not.toHaveBeenCalled();
  });
});

describe('who reminds about what', () => {
  /**
   * The device schedules an exact local notification for anything with a due
   * time. The server has no timezone, so it covers only what the device does
   * not — otherwise a timed task gets both, at different moments.
   */
  it('reminds about a plain one-off task', () => {
    expect(serverShouldRemind({ seriesId: null, dueTime: null })).toBe(true);
  });

  it('stays out of the way of a task with a due time', () => {
    expect(serverShouldRemind({ seriesId: null, dueTime: '09:00' })).toBe(false);
  });

  it('stays out of the way of a recurring occurrence', () => {
    expect(serverShouldRemind({ seriesId: 's1', dueTime: null })).toBe(false);
  });

  // Every occurrence is its own row with its own id, so the `task_id` dedupe
  // suppresses nothing across days — without this filter a daily habit would
  // earn two server pushes a day on top of its exact local one.
  it('stays out of the way of a timed recurring occurrence', () => {
    expect(serverShouldRemind({ seriesId: 's1', dueTime: '09:00' })).toBe(false);
  });

  it('drops occurrences even if the query returned them', async () => {
    dbMock.queueMany(
      [
        { id: 't1', userId: 'u1', title: 'Take medicine', dueDate: day(0), seriesId: 's1', dueTime: '09:00' },
        { id: 't2', userId: 'u1', title: 'Pay rent', dueDate: day(0), ...PLAIN },
      ],
      [],
    );

    expect(await sendTaskReminders()).toBe(1);
    expect(enqueueNotification.mock.calls[0][0]).toMatchObject({ body: 'Pay rent' });
  });
});
