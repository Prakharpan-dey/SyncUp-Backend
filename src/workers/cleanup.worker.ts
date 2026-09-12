import { and, eq, lt, or, sql } from 'drizzle-orm';

import { db } from '../core/db/drizzle.js';
import { refreshTokens, authTokens } from '../core/db/schema/index.js';

/**
 * Revoked rows are kept briefly so reuse detection can still recognise a
 * replayed token as *this user's*. Past that they are noise.
 */
const REVOKED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const RUN_EVERY_MS = 24 * 60 * 60 * 1000;
/** Let the process finish booting before the first sweep. */
const FIRST_RUN_DELAY_MS = 60_000;

/**
 * Prunes token tables. Deliberately a plain timer rather than a BullMQ queue.
 *
 * A queue would mean a fourth Worker blocking on Redis around the clock purely
 * to deliver one job a day — on a per-command Redis plan that costs far more
 * than the work. The sweep is idempotent (it deletes rows that are already
 * past their expiry), so it is harmless if two replicas both run it, which is
 * the only thing the queue was buying.
 *
 * Nothing pruned these tables before. With 15-minute access tokens over a
 * 30-day refresh window, one active device leaves roughly 2,800 dead
 * `refresh_tokens` rows a month — on the table with the hottest query.
 */
export async function pruneTokens(): Promise<void> {
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
    `[Cleanup] Pruned ${prunedRefresh.length} refresh token(s), ` +
      `${prunedAuth.length} auth token(s)`,
  );
}

/** Feed posts older than this are deleted. */
export const FEED_RETENTION_DAYS = 30;
/** Rows per DELETE, so no single statement holds locks or floods the WAL. */
export const FEED_PRUNE_BATCH = 10_000;
/** A backstop so one run can never loop forever (5M rows). */
const FEED_PRUNE_MAX_BATCHES = 500;

/**
 * Deletes feed posts past the retention window, in batches.
 *
 * Nothing pruned `feed_items` before, and at scale it takes in over a million
 * rows a day. Deleting in id-bounded batches with a short pause keeps each
 * statement small; reactions go with the cascade. Idempotent like
 * `pruneTokens`, so two replicas running it at once is harmless.
 *
 * Returns how many rows went.
 */
export async function pruneFeedItems(
  { pauseMs = 200, maxBatches = FEED_PRUNE_MAX_BATCHES } = {},
): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const deleted = (await db.execute(sql`
      DELETE FROM feed_items WHERE id IN (
        SELECT id FROM feed_items
        WHERE created_at < now() - make_interval(days => ${FEED_RETENTION_DAYS})
        LIMIT ${FEED_PRUNE_BATCH}
      )
      RETURNING 1
    `)) as unknown as unknown[];

    total += deleted.length;
    if (deleted.length < FEED_PRUNE_BATCH) break;
    await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }

  console.log(`[Cleanup] Pruned ${total} feed item(s) older than ${FEED_RETENTION_DAYS} days`);
  return total;
}

let timer: NodeJS.Timeout | null = null;

export function startCleanupSchedule(): void {
  const run = () => {
    void pruneTokens().catch((err) => {
      console.error('[Cleanup] Sweep failed:', err instanceof Error ? err.message : err);
    });
    // Separate, so a failure in one sweep never skips the other.
    void pruneFeedItems().catch((err) => {
      console.error('[Cleanup] Feed prune failed:', err instanceof Error ? err.message : err);
    });
  };

  setTimeout(run, FIRST_RUN_DELAY_MS).unref();
  timer = setInterval(run, RUN_EVERY_MS);
  // Do not hold the process open on this timer alone.
  timer.unref();
}

export function stopCleanupSchedule(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
