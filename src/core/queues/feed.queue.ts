import { Queue } from 'bullmq';
import { redis } from '../redis/redis.js';

export const feedQueue = new Queue('feed', { connection: redis });

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
