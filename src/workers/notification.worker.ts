import { Worker, Job } from 'bullmq';

import { createWorkerConnection, workerPollingOptions } from '../core/redis/redis.js';
import { handleNotificationJob, type NotificationJobData } from './notification.handler.js';

const worker = new Worker(
  'notifications',
  async (job: Job) => handleNotificationJob(job.data as NotificationJobData),
  { connection: createWorkerConnection(), ...workerPollingOptions },
);

worker.on('failed', (job, err) => {
  console.error(`[NotificationWorker] Job ${job?.id} failed:`, err?.message ?? err);
});

export default worker;
