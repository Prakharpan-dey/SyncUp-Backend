import { Queue } from 'bullmq';

import { redis } from '../redis/redis.js';
import type { NotificationJobData } from '../../workers/notification.handler.js';

export const notificationQueue = new Queue('notifications', {
  connection: redis,
  // See email.queue.ts: finished jobs were kept forever.
  defaultJobOptions: {
    removeOnComplete: { age: 3600, count: 100 },
    removeOnFail: { age: 24 * 3600 },
  },
});

/**
 * Typed against the handler's own job shape so `type` cannot drift from the
 * `notification_type` enum — an unrecognised value would be inserted, fail the
 * column constraint, and have no preference key to be muted by.
 */
export async function enqueueNotification(data: NotificationJobData) {
  await notificationQueue.add('send-notification', data);
}
