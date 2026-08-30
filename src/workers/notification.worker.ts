import { Worker, Job } from 'bullmq';
import { inArray } from 'drizzle-orm';

import { createWorkerConnection, workerPollingOptions } from '../core/redis/redis.js';
import { db } from '../core/db/drizzle.js';
import { notifications, userDevices } from '../core/db/schema/index.js';
import { eq } from 'drizzle-orm';

/**
 * Firebase Admin, loaded once and only if credentials exist.
 *
 * Import is dynamic so the worker runs fine without Firebase configured — the
 * notification row is still written, it simply is not pushed.
 */
let messagingPromise: Promise<import('firebase-admin').messaging.Messaging | null> | null = null;

function getMessaging() {
  messagingPromise ??= (async () => {
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.FIREBASE_SERVICE_ACCOUNT) {
      return null;
    }
    try {
      // `.default`, not the namespace: firebase-admin is CommonJS, and under a
      // dynamic ESM import every named export comes back undefined. Reading
      // `admin.apps` off the namespace threw a TypeError that this catch
      // swallowed, so push silently degraded to "not configured" even with
      // credentials present.
      const { default: admin } = await import('firebase-admin');
      if (admin.apps.length === 0) {
        admin.initializeApp({
          credential: process.env.FIREBASE_SERVICE_ACCOUNT
            ? admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
            : admin.credential.applicationDefault(),
        });
      }
      return admin.messaging();
    } catch (err) {
      console.error('[NotificationWorker] Firebase init failed:', err);
      return null;
    }
  })();
  return messagingPromise;
}

const worker = new Worker('notifications', async (job: Job) => {
  const { userId, type, title, body, metadata, deepLink } = job.data;

  // The in-app notification centre reads from this table, so it is written
  // whether or not a push can be delivered.
  await db.insert(notifications).values({
    userId, type, title, body,
    metadata: metadata ?? {},
    deepLink,
  });

  const messaging = await getMessaging();
  if (!messaging) {
    console.log(`[NotificationWorker] Stored for ${userId}: ${title} (push not configured)`);
    return;
  }

  // Fan out to every registered device. Previously this was a single column on
  // `users`, so only the most recently signed-in device could be reached.
  const devices = await db
    .select({ token: userDevices.token })
    .from(userDevices)
    .where(eq(userDevices.userId, userId));

  if (devices.length === 0) {
    console.log(`[NotificationWorker] Stored for ${userId}: ${title} (no devices)`);
    return;
  }

  const response = await messaging.sendEachForMulticast({
    tokens: devices.map((d) => d.token),
    notification: { title, body },
    data: { deep_link: deepLink ?? '' },
  });

  // Uninstalls and reinstalls leave dead tokens behind; FCM tells us which, and
  // keeping them would mean retrying failures forever.
  const stale = response.responses.flatMap((r, i) => {
    const code = r.error?.code;
    const gone = code === 'messaging/registration-token-not-registered'
      || code === 'messaging/invalid-registration-token';
    return gone ? [devices[i].token] : [];
  });

  if (stale.length > 0) {
    await db.delete(userDevices).where(inArray(userDevices.token, stale));
  }

  console.log(
    `[NotificationWorker] Pushed to ${userId}: ${title} ` +
      `(${response.successCount}/${devices.length} delivered, ${stale.length} stale removed)`,
  );
}, { connection: createWorkerConnection(), ...workerPollingOptions });

worker.on('failed', (job, err) => {
  console.error(`[NotificationWorker] Job ${job?.id} failed:`, err?.message ?? err);
});

export default worker;
