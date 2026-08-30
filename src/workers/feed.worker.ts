import { Worker, Job } from 'bullmq';
import { createWorkerConnection, workerPollingOptions } from '../core/redis/redis.js';
import { db } from '../core/db/drizzle.js';
import { feedItems } from '../core/db/schema/index.js';

const worker = new Worker('feed', async (job: Job) => {
  const { userId, actorName, type, title, summary, metadata } = job.data;

  await db.insert(feedItems).values({
    userId,
    actorName,
    type,
    title,
    summary,
    metadata: metadata ?? {},
    visibility: 'friends',
  });

  console.log(`[FeedWorker] Created feed item for ${userId}: ${title}`);
}, { connection: createWorkerConnection(), ...workerPollingOptions });

worker.on('failed', (job, err) => {
  console.error(`[FeedWorker] Job ${job?.id} failed:`, err);
});

export default worker;
