import { Queue } from 'bullmq';
import { redis } from '../redis/redis.js';

export const emailQueue = new Queue('email', { connection: redis });

export async function enqueueEmail(data: {
  to: string;
  subject: string;
  html: string;
}) {
  await emailQueue.add('send-email', data);
}
