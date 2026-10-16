import { describe, it, expect, beforeEach, vi } from 'vitest';

import { createDbMock } from '../helpers/db-mock.js';

const dbMock = createDbMock();
vi.mock('../../src/core/db/drizzle.js', () => ({ db: dbMock.db }));

const { AttendanceService } = await import('../../src/modules/attendance/attendance.service.js');
const { createSubjectSchema, updateSubjectSchema, logSessionSchema } = await import(
  '../../src/modules/attendance/attendance.schema.js'
);

const ME = '11111111-0000-0000-0000-000000000001';
const SUBJECT = '2f1c3a4e-8b7d-4c2a-9e1f-0a1b2c3d4e5f';
const SESSION = '7a9e2b10-3c4d-4e5f-8a6b-1c2d3e4f5a6b';

const subjectRow = (over: Record<string, unknown> = {}) => ({
  id: SUBJECT, userId: ME, name: 'DBMS', code: 'CS301', thresholdPct: 75,
  createdAt: new Date('2026-10-01'), updatedAt: new Date('2026-10-01'), ...over,
});

const valuesOf = () => dbMock.trace.find((c) => c.method === 'values')!.args[0] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.reset();
});

/**
 * The server minted its own ids, so every later request from the app named a
 * subject it had never heard of: no logged class ever reached the server.
 */
describe('subjects keep the id the app gave them', () => {
  it('accepts an id in the body, and not on update', () => {
    expect(createSubjectSchema.parse({ id: SUBJECT, name: 'DBMS' }).id).toBe(SUBJECT);
    expect(updateSubjectSchema.parse({ id: SUBJECT, name: 'DBMS' })).not.toHaveProperty('id');
  });

  // The app sends null for a subject with no code; that was a 422, and the
  // app drops a 422 for good.
  it('accepts the null code the app sends, on create and update', () => {
    expect(createSubjectSchema.parse({ id: SUBJECT, name: 'DBMS', code: null }).code).toBeNull();
    expect(updateSubjectSchema.parse({ code: null }).code).toBeNull();
  });

  it('inserts with that id', async () => {
    dbMock.queueRows([subjectRow()]);
    const created = await new AttendanceService().createSubject(ME, { id: SUBJECT, name: 'DBMS' });
    expect(valuesOf().id).toBe(SUBJECT);
    expect(created.id).toBe(SUBJECT);
  });

  it('treats a replayed create as done', async () => {
    dbMock.queueMany([], [subjectRow()]); // insert does nothing, then the existing row
    const created = await new AttendanceService().createSubject(ME, { id: SUBJECT, name: 'DBMS' });
    expect(created.id).toBe(SUBJECT);
  });

  it("refuses an id that belongs to someone else's subject", async () => {
    dbMock.queueMany([], []);
    await expect(new AttendanceService().createSubject(ME, { id: SUBJECT, name: 'DBMS' }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it('still mints an id when none is sent', async () => {
    dbMock.queueRows([subjectRow()]);
    await new AttendanceService().createSubject(ME, { name: 'DBMS' });
    expect(valuesOf()).not.toHaveProperty('id');
  });
});

describe('logged classes keep the id the app gave them', () => {
  const sessionRow = {
    id: SESSION, subjectId: SUBJECT, sessionDate: '2026-10-16', status: 'present',
    createdAt: new Date('2026-10-16'), updatedAt: new Date('2026-10-16'),
  };

  it('accepts an id in the body', () => {
    expect(logSessionSchema.parse({ id: SESSION, session_date: '2026-10-16', status: 'present' }).id)
      .toBe(SESSION);
  });

  it('inserts with it, and adopts it when the day was already marked', async () => {
    dbMock.queueMany([{ id: SUBJECT }], [sessionRow]);
    const logged = await new AttendanceService().logSession(SUBJECT, ME, {
      id: SESSION, session_date: '2026-10-16', status: 'present',
    });
    expect(valuesOf().id).toBe(SESSION);
    const upsert = dbMock.trace.find((c) => c.method === 'onConflictDoUpdate')!.args[0] as { set: Record<string, unknown> };
    expect(upsert.set.id).toBe(SESSION);
    expect(logged.updated_at).toBe(sessionRow.updatedAt.toISOString());
  });

  it('lists classes with updated_at, which the app merges on', async () => {
    dbMock.queueMany([{ id: SUBJECT }], [sessionRow]);
    const [s] = await new AttendanceService().getSessions(SUBJECT, ME);
    expect(s.updated_at).toBe(sessionRow.updatedAt.toISOString());
  });
});
