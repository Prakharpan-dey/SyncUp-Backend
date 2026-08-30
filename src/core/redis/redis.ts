import Redis, { type RedisOptions } from 'ioredis';
import { env } from '../config/env.js';

const baseOptions: RedisOptions = {
  maxRetriesPerRequest: null, // Required by BullMQ
  enableReadyCheck: false,
  // TCP keepalive. Workers sit on blocking reads for long stretches, and an
  // idle socket is exactly what proxies and load balancers reap — Railway's
  // public TCP proxy resets them (ECONNRESET). Keepalives make the connection
  // visibly alive so it survives the wait.
  keepAlive: 15_000,
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
  /**
   * Seconds to block waiting for a job. The 5s default is the expensive part.
   *
   * Kept at 30 rather than pushed higher: a blocking read holds the socket idle
   * for its whole duration, and proxies commonly reap idle connections at
   * around 60s. 60 produced ECONNRESET against Railway's public TCP proxy. 30
   * still cuts idle reads 6x while staying comfortably inside that window.
   */
  drainDelay: 30,
  /** How often to reclaim jobs from crashed workers. Default is 30s. */
  stalledInterval: 300_000,
} as const;
