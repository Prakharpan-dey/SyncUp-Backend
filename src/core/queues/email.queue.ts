import { Queue } from 'bullmq';
import { redis } from '../redis/redis.js';

export const emailQueue = new Queue('email', {
  connection: redis,
  defaultJobOptions: {
    // Nothing removed finished jobs, so every one ever run stayed in Redis as
    // its own hash — hundreds of keys with no expiry, growing without bound.
    // A short window is still enough to inspect a recent failure.
    removeOnComplete: { age: 3600, count: 100 },
    removeOnFail: { age: 24 * 3600 },
    // Retried, unlike the other queues: a dropped verification or reset mail
    // locks someone out of their own account, and a single attempt meant one
    // transient Resend error lost it silently and for good.
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  },
});

export async function enqueueEmail(data: {
  to: string;
  subject: string;
  html: string;
}) {
  await emailQueue.add('send-email', data);
}
