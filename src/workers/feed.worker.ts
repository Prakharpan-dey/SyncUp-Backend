import { Worker, Job } from 'bullmq';
import { createWorkerConnection, workerPollingOptions } from '../core/redis/redis.js';
import { eq } from 'drizzle-orm';

import { db } from '../core/db/drizzle.js';
import { feedItems, groupMembers } from '../core/db/schema/index.js';

const worker = new Worker('feed', async (job: Job) => {
  const { userId, actorName, type, title, summary, metadata } = job.data;

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

  // Fan out one row per group the author belongs to. getFeed's groups tab
  // filters on (visibility = 'group' AND group_id IN <my groups>), and group_id
  // holds a single value, so one row cannot serve several groups. Nothing wrote
  // these before, which left the groups tab permanently empty.
  const memberships = await db
    .select({ groupId: groupMembers.groupId })
    .from(groupMembers)
    .where(eq(groupMembers.userId, userId));

  for (const { groupId } of memberships) {
    rows.push({ ...base, visibility: 'group', groupId });
  }

  await db.insert(feedItems).values(rows);

  console.log(
    `[FeedWorker] Created feed item for ${userId}: ${title} ` +
      `(friends + ${memberships.length} group${memberships.length === 1 ? '' : 's'})`,
  );
}, { connection: createWorkerConnection(), ...workerPollingOptions });

worker.on('failed', (job, err) => {
  console.error(`[FeedWorker] Job ${job?.id} failed:`, err);
});

export default worker;
