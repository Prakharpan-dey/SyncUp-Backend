import { Worker, Queue, Job } from 'bullmq';
import { and, eq, lt, or } from 'drizzle-orm';

import { redis } from '../core/redis/redis.js';
import { db } from '../core/db/drizzle.js';
import { refreshTokens, authTokens } from '../core/db/schema/index.js';

const QUEUE = 'cleanup';

/**
 * Revoked rows are kept briefly so reuse detection can still recognise a
 * replayed token as *this user's*. Past that they are noise.
 */
const REVOKED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const cleanupQueue = new Queue(QUEUE, { connection: redis });

/**
 * Nothing pruned these tables before, and both grow with every session.
 *
 * With 15-minute access tokens over a 30-day refresh window, one active device
 * produces roughly 2,800 dead `refresh_tokens` rows a month — on a table whose
 * hottest query runs on every refresh.
 */
export async function scheduleCleanup() {
  await cleanupQueue.add(
    'prune-tokens',
    {},
    {
      repeat: { pattern: '0 4 * * *' }, // daily, 04:00
      jobId: 'prune-tokens', // stable id: re-registering will not stack duplicates
      removeOnComplete: true,
      removeOnFail: 50,
    },
  );
}

const worker = new Worker(QUEUE, async (_job: Job) => {
  const now = new Date();
  const revokedCutoff = new Date(now.getTime() - REVOKED_RETENTION_MS);

  const prunedRefresh = await db
    .delete(refreshTokens)
    .where(or(
      lt(refreshTokens.expiresAt, now),
      and(
        eq(refreshTokens.isRevoked, true),
        lt(refreshTokens.revokedAt, revokedCutoff),
      ),
    ))
    .returning({ id: refreshTokens.id });

  // Verification and reset tokens are single-use and short-lived; once spent or
  // expired they serve no purpose.
  const prunedAuth = await db
    .delete(authTokens)
    .where(lt(authTokens.expiresAt, now))
    .returning({ id: authTokens.id });

  console.log(
    `[CleanupWorker] Pruned ${prunedRefresh.length} refresh token(s), ` +
      `${prunedAuth.length} auth token(s)`,
  );
}, { connection: redis });

worker.on('failed', (job, err) => {
  console.error(`[CleanupWorker] Job ${job?.id} failed:`, err?.message ?? err);
});

export default worker;
