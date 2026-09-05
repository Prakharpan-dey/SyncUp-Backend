import { db } from '../../core/db/drizzle.js';
import { tasks, users } from '../../core/db/schema/index.js';
import { eq, and, desc, asc, sql } from 'drizzle-orm';
import { enqueueFeedItem } from '../../core/queues/feed.queue.js';
import { AppError } from '../../core/errors/app-errors.js';

type TaskInsert = typeof tasks.$inferInsert;

/**
 * How a single task is shared: its own override wins, otherwise the account
 * default.
 *
 * `inherit` and null both mean "use the account setting". `selected` is a
 * retired value that never had a per-task selection model behind it, so it is
 * treated as `all` — which is what it always did in practice — rather than
 * silently becoming something stricter or looser.
 */
export function effectiveSharing(
  override: string | null | undefined,
  accountDefault: string,
): 'none' | 'summary' | 'all' {
  const chosen = !override || override === 'inherit' ? accountDefault : override;
  if (chosen === 'none') return 'none';
  if (chosen === 'summary') return 'summary';
  return 'all';
}

export class TasksService {
  async listTasks(userId: string, filters?: { status?: string; priority?: string }) {
    const conditions = [eq(tasks.userId, userId)];
    if (filters?.status) conditions.push(eq(tasks.status, filters.status as 'pending' | 'completed'));
    if (filters?.priority) conditions.push(eq(tasks.priority, filters.priority as 'high' | 'medium' | 'low'));

    const result = await db
      .select()
      .from(tasks)
      .where(and(...conditions))
      .orderBy(desc(tasks.createdAt));

    return result.map(this.serialize);
  }

  async createTask(userId: string, data: {
    id?: string;
    title: string; description?: string; due_date?: string;
    priority?: string; tags?: string[]; sharing_override?: string;
    due_time?: string; series_id?: string;
  }) {
    const [task] = await db.insert(tasks).values({
      // Absent leaves the column default, which generates one.
      ...(data.id ? { id: data.id } : {}),
      userId,
      title: data.title,
      description: data.description,
      dueDate: data.due_date,
      priority: (data.priority as 'high' | 'medium' | 'low') ?? 'medium',
      tags: data.tags,
      sharingOverride: data.sharing_override as any,
      dueTime: data.due_time,
      seriesId: data.series_id,
    })
      // The offline outbox retries a create whose response was lost, so the
      // same id arrives twice. Doing nothing on conflict makes that a no-op
      // instead of a primary key violation.
      .onConflictDoNothing()
      .returning();

    if (task) return this.serialize(task);

    // Nothing inserted: the id already exists. Return the caller's own row so
    // the retry is idempotent — and refuse if the id belongs to someone else,
    // rather than disclosing that it is taken.
    const [existing] = await db.select().from(tasks)
      .where(and(eq(tasks.id, data.id!), eq(tasks.userId, userId))).limit(1);
    if (!existing) throw new AppError(409, 'Task id already in use', 'CONFLICT');
    return this.serialize(existing);
  }

  async getTask(taskId: string, userId: string) {
    const [task] = await db.select().from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId))).limit(1);
    if (!task) throw new AppError(404, 'Task not found', 'NOT_FOUND');
    return this.serialize(task);
  }

  async updateTask(taskId: string, userId: string, data: Record<string, unknown>) {
    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (data.title) updateData.title = data.title;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.due_date !== undefined) updateData.dueDate = data.due_date;
    if (data.priority) updateData.priority = data.priority;
    if (data.tags) updateData.tags = data.tags;
    if (data.sharing_override !== undefined) updateData.sharingOverride = data.sharing_override;
    if (data.due_time !== undefined) updateData.dueTime = data.due_time;
    if (data.series_id !== undefined) updateData.seriesId = data.series_id;

    const [updated] = await db.update(tasks).set(updateData)
      .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId))).returning();
    if (!updated) throw new AppError(404, 'Task not found', 'NOT_FOUND');
    return this.serialize(updated);
  }

  async deleteTask(taskId: string, userId: string) {
    const [deleted] = await db.delete(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId))).returning();
    if (!deleted) throw new AppError(404, 'Task not found', 'NOT_FOUND');
  }

  async toggleTask(taskId: string, userId: string) {
    const [task] = await db.select().from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId))).limit(1);
    if (!task) throw new AppError(404, 'Task not found', 'NOT_FOUND');

    const newStatus = task.status === 'pending' ? 'completed' : 'pending';
    const [updated] = await db.update(tasks).set({
      status: newStatus,
      completedAt: newStatus === 'completed' ? new Date() : null,
      updatedAt: new Date(),
    }).where(eq(tasks.id, taskId)).returning();

    if (newStatus === 'completed') {
      void this.publishCompletion(userId, updated);
    }

    return this.serialize(updated);
  }

  /**
   * Publishes a completed task to the owner's friends' feeds.
   *
   * Honours the task's own `sharing_override` first, falling back to the
   * account default. The override was accepted on create and update, returned
   * by the API and modelled in the client, but never read here — so marking a
   * single task "don't share this" did nothing at all and it was published like
   * any other. That is the bug this fixes.
   *
   * Fire-and-forget: a queue hiccup must not fail the toggle the user just made.
   */
  private async publishCompletion(
    userId: string,
    task: { title: string; sharingOverride: string | null },
  ) {
    try {
      const [user] = await db
        .select({
          displayName: users.displayName,
          sharing: users.privacySharingDefault,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      if (!user) return;

      const sharing = effectiveSharing(task.sharingOverride, user.sharing);
      if (sharing === 'none') return;

      await enqueueFeedItem({
        userId,
        actorName: user.displayName,
        type: 'task_completed',
        // 'summary' sharing announces the event without naming the task.
        title: sharing === 'summary' ? 'Completed a task' : task.title,
      });
    } catch (err) {
      console.error('[Tasks] Failed to enqueue feed item:', err);
    }
  }

  /**
   * Counts, computed in Postgres.
   *
   * This used to `select()` every task row for the user with no projection and
   * no limit, then filter the array five times in Node. For an account with a
   * daily habit that is a few thousand rows pulled across the wire on every
   * call, to produce six integers.
   */
  async getStats(userId: string) {
    const result = await db.execute(sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
        COUNT(*) FILTER (
          WHERE status = 'pending' AND due_date IS NOT NULL AND due_date < CURRENT_DATE
        )::int AS overdue,
        COUNT(*) FILTER (WHERE priority = 'high')::int AS high,
        COUNT(*) FILTER (WHERE priority = 'medium')::int AS medium,
        COUNT(*) FILTER (WHERE priority = 'low')::int AS low
      FROM tasks
      WHERE user_id = ${userId}
    `);

    // postgres.js returns a RowList, which is already an array.
    const [row] = result as unknown as {
      total: number; completed: number; pending: number; overdue: number;
      high: number; medium: number; low: number;
    }[];

    return {
      total: row?.total ?? 0,
      completed: row?.completed ?? 0,
      pending: row?.pending ?? 0,
      // Strictly before today, so a task due later today is not already counted
      // against the user. The old check compared a date column against a
      // timestamp, which made everything due today read as overdue.
      overdue: row?.overdue ?? 0,
      by_priority: {
        high: row?.high ?? 0,
        medium: row?.medium ?? 0,
        low: row?.low ?? 0,
      },
    };
  }

  private serialize(task: typeof tasks.$inferSelect) {
    return {
      id: task.id,
      user_id: task.userId,
      title: task.title,
      description: task.description,
      due_date: task.dueDate,
      priority: task.priority,
      status: task.status,
      tags: task.tags ?? [],
      sharing_override: task.sharingOverride,
      series_id: task.seriesId,
      due_time: task.dueTime,
      completed_at: task.completedAt?.toISOString() ?? null,
      created_at: task.createdAt.toISOString(),
      updated_at: task.updatedAt.toISOString(),
    };
  }
}
