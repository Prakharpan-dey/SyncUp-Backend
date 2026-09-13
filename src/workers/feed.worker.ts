import { Worker, Job } from 'bullmq';
import { createWorkerConnection, workerPollingOptions } from '../core/redis/redis.js';

import { createFeedItems, type FeedJob } from './feed.processor.js';

const worker = new Worker('feed', async (job: Job<FeedJob>) => {
  const written = await createFeedItems(job.data);
  console.log(
    `[FeedWorker] ${job.data.type} for ${job.data.userId}: ` +
      (written === 0 ? 'skipped (already posted, or no longer done)' : `${written} row(s)`),
  );
}, { connection: createWorkerConnection(), ...workerPollingOptions });

worker.on('failed', (job, err) => {
  console.error(`[FeedWorker] Job ${job?.id} failed:`, err);
});

export default worker;
