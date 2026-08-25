import { Queue } from 'bullmq';
import { redis } from '../redis/redis.js';

export const notificationQueue = new Queue('notifications', { connection: redis });

export async function enqueueNotification(data: {
  userId: string;
  type: string;
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
  deepLink?: string;
}) {
  await notificationQueue.add('send-notification', data);
}
