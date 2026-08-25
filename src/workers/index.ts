/**
 * Worker entrypoint.
 *
 * The three workers were written but never started by any process — `main.ts`
 * boots only the HTTP server — so every queued job sat in Redis forever. That
 * meant no emails, no notifications, and no feed items in production.
 *
 * Run alongside the API with `npm run worker`, or as its own service so it can
 * scale independently of request traffic.
 */
import { env } from '../core/config/env.js';
import { redis } from '../core/redis/redis.js';

import emailWorker from './email.worker.js';
import feedWorker from './feed.worker.js';
import notificationWorker from './notification.worker.js';

const workers = [
  { name: 'email', worker: emailWorker },
  { name: 'feed', worker: feedWorker },
  { name: 'notifications', worker: notificationWorker },
];

console.log(
  `[Workers] Started: ${workers.map((w) => w.name).join(', ')} [${env.NODE_ENV}]`,
);

if (!env.SMTP_HOST) {
  console.warn(
    '[Workers] SMTP_HOST is not set — email jobs will be consumed and skipped. ' +
      'Verification and password-reset emails will not be delivered.',
  );
}

async function shutdown(signal: string) {
  console.log(`[Workers] Received ${signal}, closing...`);
  // Let in-flight jobs finish so a deploy doesn't drop a half-sent email.
  await Promise.allSettled(workers.map(({ worker }) => worker.close()));
  await redis.quit().catch(() => {});
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => void shutdown(signal));
}

// A worker that throws outside a job handler would otherwise die silently.
process.on('unhandledRejection', (reason) => {
  console.error('[Workers] Unhandled rejection:', reason);
});
