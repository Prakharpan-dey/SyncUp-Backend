import { describe, it, expect, beforeEach, vi } from 'vitest';

import { createDbMock } from '../helpers/db-mock.js';

const dbMock = createDbMock();
vi.mock('../../src/core/db/drizzle.js', () => ({ db: dbMock.db }));

const enqueueNotification = vi.fn(async () => undefined);
vi.mock('../../src/core/queues/notification.queue.js', () => ({ enqueueNotification }));

const { sendTaskReminders, sendAttendanceWarnings } = await import(
  '../../src/workers/reminder.worker.js'
);

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
      [{ id: 't1', userId: 'u1', title: 'Finish DBMS assignment', dueDate: day(0) }],
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
      [{ id: 't2', userId: 'u1', title: 'Lab report', dueDate: day(1) }],
      [],
    );

    await sendTaskReminders();
    expect(enqueued()[0]).toMatchObject({ title: 'Due tomorrow' });
  });

  /// The sweep runs every few hours; without this it would re-notify each time.
  it('never reminds twice about the same task', async () => {
    dbMock.queueMany(
      [{ id: 't1', userId: 'u1', title: 'Finish DBMS assignment', dueDate: day(0) }],
      [{ taskId: 't1' }], // already sent
    );

    expect(await sendTaskReminders()).toBe(0);
    expect(enqueueNotification).not.toHaveBeenCalled();
  });

  it('reminds only the tasks not already covered', async () => {
    dbMock.queueMany(
      [
        { id: 't1', userId: 'u1', title: 'Already told', dueDate: day(0) },
        { id: 't2', userId: 'u1', title: 'Not yet told', dueDate: day(0) },
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
