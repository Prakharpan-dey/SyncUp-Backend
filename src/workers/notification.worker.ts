import { Worker, Job } from 'bullmq';
import { redis } from '../core/redis/redis.js';
import { db } from '../core/db/drizzle.js';
import { notifications, users } from '../core/db/schema/index.js';
import { eq } from 'drizzle-orm';

const worker = new Worker('notifications', async (job: Job) => {
  const { userId, type, title, body, metadata, deepLink } = job.data;

  // Insert notification into DB
  await db.insert(notifications).values({
    userId, type, title, body,
    metadata: metadata ?? {},
    deepLink,
  });

  // TODO: Send FCM push notification via firebase-admin
  // const [user] = await db.select().from(users).where(eq(users.id, userId));
  // if (user?.fcmToken) {
  //   await admin.messaging().send({
  //     token: user.fcmToken,
  //     notification: { title, body },
  //     data: { deep_link: deepLink ?? '' },
  //   });
  // }

  console.log(`[NotificationWorker] Sent to ${userId}: ${title}`);
}, { connection: redis });

worker.on('failed', (job, err) => {
  console.error(`[NotificationWorker] Job ${job?.id} failed:`, err);
});

export default worker;
