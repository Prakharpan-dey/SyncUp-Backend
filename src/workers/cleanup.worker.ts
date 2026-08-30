import { and, eq, lt, or } from 'drizzle-orm';

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

let timer: NodeJS.Timeout | null = null;

export function startCleanupSchedule(): void {
  const run = () => {
    void pruneTokens().catch((err) => {
      console.error('[Cleanup] Sweep failed:', err instanceof Error ? err.message : err);
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
