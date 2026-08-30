import Redis, { type RedisOptions } from 'ioredis';
import { env } from '../config/env.js';

const baseOptions: RedisOptions = {
  maxRetriesPerRequest: null, // Required by BullMQ
  enableReadyCheck: false,
};

/**
 * Shared connection for request-path work — the rate limiter and the auth
 * guard's account cache. Safe to share because none of those issue blocking
 * commands.
 */
export const redis = new Redis(env.REDIS_URL, baseOptions);

/**
 * A dedicated connection for one BullMQ Worker.
 *
 * BullMQ requires this: a Worker waits on blocking commands (`BZPOPMIN`), which
 * monopolise whatever connection they run on. Sharing a single connection
 * across several workers makes them contend for it, and the resulting retries
 * generate far more Redis traffic than the work itself.
 */
export function createWorkerConnection(): Redis {
  return new Redis(env.REDIS_URL, baseOptions);
}

/**
 * Polling settings shared by every worker.
 *
 * BullMQ's defaults assume Redis you own, where command count costs nothing. On
 * a per-command plan an idle worker is surprisingly expensive: at the default
 * 5s `drainDelay` a single worker issues ~17k blocking reads a day doing
 * nothing, before stalled-job checks on top. Four workers put that comfortably
 * into six figures.
 *
 * Raising `drainDelay` costs no latency — the blocking read still returns the
 * instant a job is enqueued; it just waits longer between empty polls.
 */
export const workerPollingOptions = {
  /** Seconds to block waiting for a job. 5s default → ~12x fewer idle reads. */
  drainDelay: 60,
  /** How often to reclaim jobs from crashed workers. Default is 30s. */
  stalledInterval: 300_000,
} as const;
