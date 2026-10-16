import { db } from '../../core/db/drizzle.js';
import { subjects, attendanceSessions } from '../../core/db/schema/index.js';
import { eq, and, inArray } from 'drizzle-orm';
import { classesNeeded, safeToSkip } from '../../core/utils/attendance.js';
import { AppError } from '../../core/errors/app-errors.js';

export class AttendanceService {
  async listSubjects(userId: string) {
    const subjectList = await db.select().from(subjects)
      .where(eq(subjects.userId, userId));

    if (subjectList.length === 0) return [];

    const subjectIds = subjectList.map(s => s.id);
    const allSessions = await db.select().from(attendanceSessions)
      .where(inArray(attendanceSessions.subjectId, subjectIds));

    const sessionsBySubject = new Map<string, typeof allSessions>();
    for (const session of allSessions) {
      const list = sessionsBySubject.get(session.subjectId) ?? [];
      list.push(session);
      sessionsBySubject.set(session.subjectId, list);
    }

    return subjectList.map(s => {
      const sessions = sessionsBySubject.get(s.id) ?? [];
      const total = sessions.length;
      const attended = sessions.filter(se => se.status === 'present').length;
      const threshold = s.thresholdPct / 100;

      return {
        id: s.id, user_id: s.userId, name: s.name, code: s.code,
        threshold_pct: s.thresholdPct,
        total_classes: total, attended_classes: attended,
        percentage: total > 0 ? Math.round((attended / total) * 10000) / 100 : 0,
        classes_needed: classesNeeded(attended, total, threshold),
        safe_to_skip: safeToSkip(attended, total, threshold),
        created_at: s.createdAt.toISOString(),
        updated_at: s.updatedAt.toISOString(),
      };
    });
  }

  async createSubject(userId: string, data: { id?: string; name: string; code?: string | null; threshold_pct?: number }) {
    // The server used to ignore the app's id and mint its own, so every later
    // request from the app (log a class, rename, delete) named a subject the
    // server had never heard of and failed with 404. No logged class ever
    // reached the server, and a reinstall lost all of them.
    const [subject] = await db.insert(subjects).values({
      ...(data.id ? { id: data.id } : {}),
      userId, name: data.name, code: data.code ?? null,
      thresholdPct: data.threshold_pct ?? 75,
    }).onConflictDoNothing({ target: subjects.id }).returning();

    // Nothing inserted: a replay of a create that already landed. Hand back the
    // caller's own row so the retry is idempotent, and refuse if the id is
    // someone else's.
    const row = subject ?? (await db.select().from(subjects)
      .where(and(eq(subjects.id, data.id!), eq(subjects.userId, userId))).limit(1))[0];
    if (!row) throw new AppError(409, 'Subject id already in use', 'CONFLICT');

    return { id: row.id, user_id: row.userId, name: row.name, code: row.code,
      threshold_pct: row.thresholdPct, total_classes: 0, attended_classes: 0,
      percentage: 0, classes_needed: 0, safe_to_skip: 0,
      created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString() };
  }

  async updateSubject(subjectId: string, userId: string, data: Record<string, unknown>) {
    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (data.name) updateData.name = data.name;
    if (data.code !== undefined) updateData.code = data.code;
    if (data.threshold_pct !== undefined) updateData.thresholdPct = data.threshold_pct;

    const [updated] = await db.update(subjects).set(updateData)
      .where(and(eq(subjects.id, subjectId), eq(subjects.userId, userId))).returning();
    if (!updated) throw new AppError(404, 'Subject not found', 'NOT_FOUND');
    return updated;
  }

  async deleteSubject(subjectId: string, userId: string) {
    const [deleted] = await db.delete(subjects)
      .where(and(eq(subjects.id, subjectId), eq(subjects.userId, userId))).returning();
    if (!deleted) throw new AppError(404, 'Subject not found', 'NOT_FOUND');
  }

  /**
   * Verifies the subject exists and belongs to the caller.
   * Throws 404 (not 403) so subject IDs cannot be enumerated.
   */
  private async assertSubjectOwnership(subjectId: string, userId: string) {
    const [subject] = await db.select({ id: subjects.id }).from(subjects)
      .where(and(eq(subjects.id, subjectId), eq(subjects.userId, userId))).limit(1);
    if (!subject) throw new AppError(404, 'Subject not found', 'NOT_FOUND');
  }

  async getSessions(subjectId: string, userId: string) {
    await this.assertSubjectOwnership(subjectId, userId);

    const sessions = await db.select().from(attendanceSessions)
      .where(eq(attendanceSessions.subjectId, subjectId));
    return sessions.map(s => ({
      id: s.id, subject_id: s.subjectId, session_date: s.sessionDate,
      status: s.status, created_at: s.createdAt.toISOString(),
      updated_at: s.updatedAt.toISOString(),
    }));
  }

  async logSession(subjectId: string, userId: string, data: { id?: string; session_date: string; status: 'present' | 'absent' }) {
    await this.assertSubjectOwnership(subjectId, userId);

    // One row per subject per day. Marking a day again changes its status,
    // and takes the app's id for it so a later delete from the app finds it.
    const [session] = await db.insert(attendanceSessions).values({
      ...(data.id ? { id: data.id } : {}),
      subjectId, sessionDate: data.session_date, status: data.status,
    }).onConflictDoUpdate({
      target: [attendanceSessions.subjectId, attendanceSessions.sessionDate],
      set: { status: data.status, updatedAt: new Date(), ...(data.id ? { id: data.id } : {}) },
    }).returning();
    return { id: session.id, subject_id: session.subjectId, session_date: session.sessionDate,
      status: session.status, created_at: session.createdAt.toISOString(),
      updated_at: session.updatedAt.toISOString() };
  }

  async deleteSession(subjectId: string, sessionId: string, userId: string) {
    await this.assertSubjectOwnership(subjectId, userId);

    const [deleted] = await db.delete(attendanceSessions)
      .where(and(eq(attendanceSessions.id, sessionId), eq(attendanceSessions.subjectId, subjectId)))
      .returning();
    if (!deleted) throw new AppError(404, 'Session not found', 'NOT_FOUND');
  }
}
