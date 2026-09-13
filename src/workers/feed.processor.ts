import { and, eq, sql } from 'drizzle-orm';

import { db } from '../core/db/drizzle.js';
import { feedItems, groupMembers, tasks } from '../core/db/schema/index.js';

export type FeedJob = {
  userId: string;
  actorName: string;
  type: 'task_completed' | 'streak_milestone' | 'attendance_milestone';
  title: string;
  summary?: string;
  metadata?: Record<string, unknown>;
};

/**
 * Writes one feed post, plus a copy for each group the author is in.
 *
 * For a completed task it first checks the task is still done and has no post
 * yet. Ticking and un-ticking used to add a post every time — and a job can run
 * after the task was already un-ticked. Returns how many rows went in.
 */
export async function createFeedItems(job: FeedJob): Promise<number> {
  const { userId, actorName, type, title, summary, metadata } = job;
  const taskId = typeof metadata?.task_id === 'string' ? metadata.task_id : null;

  if (type === 'task_completed' && taskId) {
    const [task] = await db.select({ status: tasks.status }).from(tasks)
      .where(eq(tasks.id, taskId)).limit(1);
    if (!task || task.status !== 'completed') return 0;

    const [already] = await db.select({ id: feedItems.id }).from(feedItems)
      .where(and(
        eq(feedItems.userId, userId),
        eq(feedItems.type, 'task_completed'),
        sql`${feedItems.metadata}->>'task_id' = ${taskId}`,
      ))
      .limit(1);
    if (already) return 0;
  }

  const base = {
    userId,
    actorName,
    type,
    title,
    summary,
    metadata: metadata ?? {},
  };

  // The sharing preference was already applied upstream in publishCompletion —
  // 'none' never reaches the queue and 'summary' has already dropped the task
  // name — so every row here inherits the same treatment.
  const rows: (typeof feedItems.$inferInsert)[] = [
    { ...base, visibility: 'friends', groupId: null },
  ];

  // One row per group the author belongs to. getFeed's groups tab filters on
  // (visibility = 'group' AND group_id IN <my groups>), and group_id holds a
  // single value, so one row cannot serve several groups.
  const memberships = await db
    .select({ groupId: groupMembers.groupId })
    .from(groupMembers)
    .where(eq(groupMembers.userId, userId));

  for (const { groupId } of memberships) {
    rows.push({ ...base, visibility: 'group', groupId });
  }

  await db.insert(feedItems).values(rows);
  return rows.length;
}
