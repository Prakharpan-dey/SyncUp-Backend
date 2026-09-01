import { Queue } from 'bullmq';

import { redis } from '../redis/redis.js';
import type { NotificationJobData } from '../../workers/notification.handler.js';

export const notificationQueue = new Queue('notifications', { connection: redis });

/**
 * Typed against the handler's own job shape so `type` cannot drift from the
 * `notification_type` enum — an unrecognised value would be inserted, fail the
 * column constraint, and have no preference key to be muted by.
 */
export async function enqueueNotification(data: NotificationJobData) {
  await notificationQueue.add('send-notification', data);
}
