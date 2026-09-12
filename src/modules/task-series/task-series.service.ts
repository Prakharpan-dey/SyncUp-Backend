import { and, desc, eq } from 'drizzle-orm';

import { AppError } from '../../core/errors/app-errors.js';
import { db } from '../../core/db/drizzle.js';
import { taskSeries, tasks } from '../../core/db/schema/index.js';

/**
 * Module-level, not a method.
 *
 * `TasksService.serialize` is a private method used as a bare `.map(this.serialize)`
 * callback, which works only because it happens to touch nothing on `this`. A
 * plain function makes that safe by construction rather than by luck.
 */
export function serializeSeries(row: typeof taskSeries.$inferSelect) {
  return {
    id: row.id,
    user_id: row.userId,
    title: row.title,
    description: row.description,
    priority: row.priority,
    tags: row.tags ?? [],
    weekdays: row.weekdays,
    due_time: row.dueTime,
    starts_on: row.startsOn,
    ends_on: row.endsOn,
    active: row.active,
    generated_through: row.generatedThrough,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

interface SeriesInput {
  id?: string;
  title?: string;
  description?: string;
  priority?: string;
  tags?: string[];
  weekdays?: string;
  due_time?: string;
  starts_on?: string;
  ends_on?: string;
  active?: boolean;
  generated_through?: string;
}

export class TaskSeriesService {
  async listSeries(userId: string) {
    const rows = await db
      .select()
      .from(taskSeries)
      .where(eq(taskSeries.userId, userId))
      .orderBy(desc(taskSeries.createdAt));
    return rows.map(serializeSeries);
  }

  async createSeries(userId: string, data: SeriesInput) {
    const [created] = await db
      .insert(taskSeries)
      .values({
        ...(data.id ? { id: data.id } : {}),
        userId,
        title: data.title!,
        description: data.description,
        priority: data.priority as 'high' | 'medium' | 'low' | undefined,
        tags: data.tags,
        weekdays: data.weekdays!,
        dueTime: data.due_time,
        startsOn: data.starts_on!,
        endsOn: data.ends_on,
        generatedThrough: data.generated_through,
      })
      // The offline outbox retries, so the same create can arrive twice. Same
      // contract as tasks: a replay is a success, someone else's id is a 409.
      .onConflictDoNothing()
      .returning();

    if (created) return serializeSeries(created);

    const [existing] = await db
      .select()
      .from(taskSeries)
      .where(and(eq(taskSeries.id, data.id!), eq(taskSeries.userId, userId)))
      .limit(1);
    if (!existing) throw new AppError(409, 'Series id already in use', 'CONFLICT');
    return serializeSeries(existing);
  }

  async updateSeries(seriesId: string, userId: string, data: SeriesInput) {
    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (data.title !== undefined) updateData.title = data.title;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.priority !== undefined) updateData.priority = data.priority;
    if (data.tags !== undefined) updateData.tags = data.tags;
    if (data.weekdays !== undefined) updateData.weekdays = data.weekdays;
    if (data.due_time !== undefined) updateData.dueTime = data.due_time;
    if (data.starts_on !== undefined) updateData.startsOn = data.starts_on;
    if (data.ends_on !== undefined) updateData.endsOn = data.ends_on;
    if (data.active !== undefined) updateData.active = data.active;
    if (data.generated_through !== undefined) updateData.generatedThrough = data.generated_through;

    const [updated] = await db
      .update(taskSeries)
      .set(updateData)
      .where(and(eq(taskSeries.id, seriesId), eq(taskSeries.userId, userId)))
      .returning();
    if (!updated) throw new AppError(404, 'Series not found', 'NOT_FOUND');
    return serializeSeries(updated);
  }

  /**
   * Removes a series and detaches the occurrences it produced.
   *
   * `tasks.series_id` deliberately has no foreign key — occurrences reach the
   * server through an outbox that can deliver them before their series, and a
   * constraint violation there is parked as permanent. The cost is that nothing
   * cleaned up after a delete, so occurrences were left pointing at a series row
   * that no longer existed.
   *
   * They are detached rather than deleted: they record days the user actually
   * completed, and losing that history to remove a rule would be the worse
   * outcome. They simply become ordinary one-off tasks.
   *
   * The delete runs first so an attempt on someone else's series 404s before
   * anything is touched.
   */
  /**
   * Deletes the rule. With [deletePending], its pending days go too — missed
   * past ones included — while completed days are kept and detached below, so
   * history and streaks survive. Without it, every day is detached and kept.
   */
  async deleteSeries(
    seriesId: string,
    userId: string,
    { deletePending = false }: { deletePending?: boolean } = {},
  ) {
    const [deleted] = await db
      .delete(taskSeries)
      .where(and(eq(taskSeries.id, seriesId), eq(taskSeries.userId, userId)))
      .returning();
    if (!deleted) throw new AppError(404, 'Series not found', 'NOT_FOUND');

    if (deletePending) {
      await db.delete(tasks).where(and(
        eq(tasks.seriesId, seriesId),
        eq(tasks.userId, userId),
        eq(tasks.status, 'pending'),
      ));
    }

    await db
      .update(tasks)
      .set({ seriesId: null, updatedAt: new Date() })
      .where(and(eq(tasks.seriesId, seriesId), eq(tasks.userId, userId)));
  }
}
