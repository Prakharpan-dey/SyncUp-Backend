import { Queue } from 'bullmq';
import { redis } from '../redis/redis.js';

export const feedQueue = new Queue('feed', {
  connection: redis,
  // See email.queue.ts: finished jobs were kept forever. One attempt is right
  // here — a missed feed row is cosmetic, and retrying a bad payload would
  // cost more than the post is worth.
  defaultJobOptions: {
    removeOnComplete: { age: 3600, count: 100 },
    removeOnFail: { age: 24 * 3600 },
  },
});

export async function enqueueFeedItem(data: {
  userId: string;
  actorName: string;
  type: 'task_completed' | 'streak_milestone' | 'attendance_milestone';
  title: string;
  summary?: string;
  metadata?: Record<string, unknown>;
}) {
  await feedQueue.add('create-feed-item', data);
}
