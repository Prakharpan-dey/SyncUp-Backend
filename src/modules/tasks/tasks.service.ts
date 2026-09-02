import { db } from '../../core/db/drizzle.js';
import { tasks, users } from '../../core/db/schema/index.js';
import { eq, and, desc, asc } from 'drizzle-orm';
import { enqueueFeedItem } from '../../core/queues/feed.queue.js';
import { AppError } from '../../core/errors/app-errors.js';

type TaskInsert = typeof tasks.$inferInsert;

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
      void this.publishCompletion(userId, updated.title);
    }

    return this.serialize(updated);
  }

  /**
   * Publishes a completed task to the owner's friends' feeds.
   *
   * Respects the user's default sharing preference — `none` means the
   * completion stays private. Fire-and-forget: a queue hiccup must not fail the
   * toggle the user just made.
   */
  private async publishCompletion(userId: string, title: string) {
    try {
      const [user] = await db
        .select({
          displayName: users.displayName,
          sharing: users.privacySharingDefault,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      if (!user || user.sharing === 'none') return;

      await enqueueFeedItem({
        userId,
        actorName: user.displayName,
        type: 'task_completed',
        // 'summary' sharing announces the event without naming the task.
        title: user.sharing === 'summary' ? 'Completed a task' : title,
      });
    } catch (err) {
      console.error('[Tasks] Failed to enqueue feed item:', err);
    }
  }

  async getStats(userId: string) {
    const allTasks = await db.select().from(tasks).where(eq(tasks.userId, userId));
    const now = new Date();
    return {
      total: allTasks.length,
      completed: allTasks.filter(t => t.status === 'completed').length,
      pending: allTasks.filter(t => t.status === 'pending').length,
      overdue: allTasks.filter(t => t.status === 'pending' && t.dueDate && new Date(t.dueDate) < now).length,
      by_priority: {
        high: allTasks.filter(t => t.priority === 'high').length,
        medium: allTasks.filter(t => t.priority === 'medium').length,
        low: allTasks.filter(t => t.priority === 'low').length,
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
      completed_at: task.completedAt?.toISOString() ?? null,
      created_at: task.createdAt.toISOString(),
      updated_at: task.updatedAt.toISOString(),
    };
  }
}
